"""Regression tests for the audit-2 hardening fixes.

Covers: the sliding-window rate limiter (unit + live 429 through TestClient),
the llm_spend daily cap fail-closed wiring, the prod AUTH_SECRET boot guard,
the GoalCreateRequest field bounds, and the Dhaka-date 30-day actions window.

Order-tolerance: limiter unit tests drive their own SlidingWindowLimiter with
explicit timestamps, and an autouse fixture resets the shared process limiter
before AND after every test here — so neither earlier nor later tests can
interfere through leftover window state, whatever the execution order.
"""
from __future__ import annotations

import datetime as dt
import sqlite3
from types import SimpleNamespace

import numpy as np
import pytest
from fastapi.testclient import TestClient

import sathi_config
from api.config import _DEV_AUTH_SECRET, Settings
from api.db import SCHEMA
from api.main import app
from api.ratelimit import SlidingWindowLimiter, get_limiter
from api.repositories import spend
from api.services.actions_service import get_actions
from llm.orchestrator import _today_dhaka, handle_message


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        yield c


@pytest.fixture(scope="module")
def auth_headers(client):
    users = client.get("/v1/demo-users").json()
    assert users, "demo users must exist"
    login = client.post("/v1/auth/demo-login", json={"user_id": users[0]["user_id"]})
    assert login.status_code == 200
    return {"Authorization": f"Bearer {login.json()['token']}"}


@pytest.fixture(autouse=True)
def _clean_limiter():
    """Isolate the shared limiter: clean before, clean after (no window bleed
    in either direction, regardless of test order)."""
    get_limiter().reset()
    yield
    get_limiter().reset()


# --- helpers -----------------------------------------------------------

def _memory_db() -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA)
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def _actions_db_with_food_spend(ts_utc: str) -> sqlite3.Connection:
    """In-memory DB with one user and one ৳10,000 food PAYMENT at `ts_utc`."""
    conn = _memory_db()
    conn.execute(
        "INSERT INTO users VALUES('u1','student','18-24','dhaka','low','2025-01-01T00:00:00Z')"
    )
    conn.execute(
        "INSERT INTO transactions (txn_id, user_id, ts, type, amount_paisa, fee_paisa,"
        " counterparty_id, counterparty_type, counterparty_category,"
        " counterparty_accepts_digital, channel, balance_after_paisa)"
        " VALUES('t1','u1',?,'payment',1000000,0,'eatery-1','merchant','food',1,'wallet',9000000)",
        (ts_utc,),
    )
    conn.commit()
    return conn


# --- (a) limiter unit tests --------------------------------------------

def test_rate_limiter_sliding_window_expiry():
    lim = SlidingWindowLimiter(window_s=60, limits={"chat": 2})
    assert lim.allow("chat", "u1", now=0.0) is True
    assert lim.allow("chat", "u1", now=1.0) is True
    assert lim.allow("chat", "u1", now=30.0) is False   # window full
    # Timestamps age out individually: at t=61 both earlier hits are outside
    # the window (cutoff = 1.0), so new requests pass again.
    assert lim.allow("chat", "u1", now=61.0) is True
    assert lim.allow("chat", "u1", now=61.5) is True
    assert lim.allow("chat", "u1", now=62.0) is False   # full again


def test_rate_limiter_per_key_and_bucket_isolation():
    lim = SlidingWindowLimiter(window_s=60, limits={"chat": 1, "parse_amount": 1})
    assert lim.allow("chat", "user:a", now=0.0) is True
    assert lim.allow("chat", "user:a", now=1.0) is False    # key a exhausted
    assert lim.allow("chat", "user:b", now=1.0) is True     # other key unaffected
    assert lim.allow("parse_amount", "user:a", now=1.0) is True   # other bucket unaffected
    assert lim.allow("parse_amount", "user:a", now=2.0) is False


def test_rate_limiter_limit_enforcement_boundary():
    lim = SlidingWindowLimiter(window_s=60, limits={"demo_login": 3})
    verdicts = [lim.allow("demo_login", "ip:x", now=float(i)) for i in range(6)]
    # Exactly `limit` requests pass inside one window — the (N+1)th is the
    # first denial, and denials do not extend the window.
    assert verdicts == [True, True, True, False, False, False]
    # Unconfigured buckets are unbounded by definition.
    assert SlidingWindowLimiter(window_s=60, limits={}).allow("chat", "k", now=0.0) is True


# --- (b) live 429 through the FastAPI TestClient ------------------------

def test_live_429_returns_stable_error_schema(client):
    lim = get_limiter()
    rl = sathi_config.load_config().section("rate_limits")
    # The wired limiter carries the app.yaml values, not hardcoded ones.
    assert lim.window_s == rl["window_s"]
    assert lim.limits == {
        "chat": rl["chat_per_window"],
        "parse_amount": rl["parse_amount_per_window"],
        "demo_login": rl["demo_login_per_window"],
    }

    limit = lim.limits["parse_amount"]
    statuses = []
    error_body = None
    for _ in range(limit + 3):
        resp = client.post("/v1/parse-amount", json={"text": "10 taka"})
        statuses.append(resp.status_code)
        if resp.status_code == 429:
            error_body = resp.json()
            break
    assert 429 in statuses, "sliding window must trip within limit+3 rapid requests"
    assert statuses[0] == 200

    # The violation returns the SAME stable error schema as every other error.
    assert set(error_body.keys()) == {"error"}
    err = error_body["error"]
    assert err["code"] == "RATE_LIMITED"
    for field in ("code", "message_bn", "message_en", "request_id"):
        assert isinstance(err[field], str) and err[field], f"missing {field}"


# --- (c) prod AUTH_SECRET boot guard ------------------------------------

def test_prod_default_auth_secret_rejected_dev_unaffected():
    with pytest.raises(RuntimeError, match="AUTH_SECRET"):
        Settings(app_env="prod", auth_secret=_DEV_AUTH_SECRET)
    with pytest.raises(RuntimeError, match="AUTH_SECRET"):
        Settings(app_env="Production", auth_secret=_DEV_AUTH_SECRET)  # case-insensitive
    # Dev mode keeps working with the default secret...
    assert Settings(app_env="dev", auth_secret=_DEV_AUTH_SECRET).auth_secret == _DEV_AUTH_SECRET
    # ...and prod boots fine once a real secret is provided.
    assert Settings(app_env="prod", auth_secret="a-real-secret-32-bytes-long!!").app_env == "prod"


# --- (d) LLM daily cap: fail closed + attempt counting -------------------

def test_llm_daily_cap_fails_closed_and_counts_attempts(monkeypatch):
    import llm.orchestrator as orch

    settings = Settings(
        llm_enabled=True,
        llm_provider="openai-compatible",
        llm_api_key="test-key",
        llm_daily_cap=1,
    )
    ctx = {"balance_paisa": 500000, "safe_to_spend_paisa": 200000,
           "daily_safe_budget_paisa": 14000}
    msg = "আমি কত টাকা খরচ করতে পারব?"

    provider_calls = []
    monkeypatch.setattr(
        orch, "_call_openrouter",
        lambda *a, **k: provider_calls.append(1) or "নিরাপদে {{f2}} খরচ করতে পারেন।",
    )

    day = _today_dhaka().isoformat()
    at_cap = _memory_db()
    spend.increment(at_cap, day)  # cap is 1: the day is already spent

    resp = handle_message(msg, ctx, settings, locale="bn", spend_conn=at_cap)
    assert provider_calls == []                 # provider NEVER called at the cap
    assert resp.fallback_used is True           # deterministic template answered
    assert resp.generated_text is False
    assert resp.intent == "safe_spend"
    assert "নিরাপদে খরচ" in resp.reply

    # Below the cap: the provider IS attempted and the attempt is counted.
    fresh = _memory_db()
    resp2 = handle_message(msg, ctx, settings, locale="bn", spend_conn=fresh)
    assert len(provider_calls) == 1
    assert resp2.generated_text is True
    assert spend.get_calls(fresh, day) == 1

    # ...and once the counted attempt reaches the cap, the next call fails closed.
    resp3 = handle_message(msg, ctx, settings, locale="bn", spend_conn=fresh)
    assert len(provider_calls) == 1             # still only the one attempt
    assert resp3.fallback_used is True
    assert resp3.generated_text is False


# --- goal-create field bounds --------------------------------------------

def test_goal_create_rejects_out_of_bounds(client, auth_headers):
    base = {
        "goal_type": "emergency_fund",
        "months": 6,
        "plan_option_key": "extend_timeline",
        "monthly_contribution_paisa": 100000,
    }
    for bad_target in (0, -500000, 10_000_000_000_001):
        resp = client.post("/v1/me/goals", headers=auth_headers,
                           json={**base, "target_paisa": bad_target})
        assert resp.status_code == 400, bad_target
        assert resp.json()["error"]["code"] == "VALIDATION_FAILED"

    resp = client.post("/v1/me/goals", headers=auth_headers,
                       json={**base, "target_paisa": 1000000, "months": 0})
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "VALIDATION_FAILED"

    # The boundary itself is accepted (positive and at the ceiling).
    ok = client.post("/v1/me/goals", headers=auth_headers,
                     json={**base, "target_paisa": 10_000_000_000_000})
    assert ok.status_code == 200
    assert ok.json()["target_paisa"] == 10_000_000_000_000


# --- actions 30-day window uses Dhaka dates (ADR-10) ---------------------

def test_actions_window_uses_dhaka_dates(monkeypatch):
    cfg = sathi_config.load_config()
    as_of = dt.date.fromisoformat(cfg.section("dataset")["as_of_date"])  # 2026-09-30
    cutoff = as_of - dt.timedelta(days=30)                               # 2026-08-31

    fake_forecast = SimpleNamespace(
        paths=np.full((8, 15), 5_000_000, dtype=np.int64),
        window_days=14,
        floor_paisa=0,
        p_shortfall=0.25,
        safe_to_spend_paisa=500_000,
    )
    monkeypatch.setattr(
        "api.services.forecast_service.user_forecast",
        lambda conn, cfg, user_id: fake_forecast,
    )

    # 21:00Z on the day before the UTC cutoff is ALREADY cutoff-day in Dhaka
    # (UTC+6): the spend is inside the 30-day window (old UTC-date code
    # wrongly skipped it) and a 20% trim on ৳10,000 clears the ৳50 floor.
    inside = get_actions(_actions_db_with_food_spend("2026-08-30T21:00:00Z"), cfg, "u1")
    assert "trim_discretionary" in {a.action_id for a in inside.actions}

    # Same wall-clock time two days earlier is outside the window in Dhaka too.
    outside = get_actions(_actions_db_with_food_spend("2026-08-28T21:00:00Z"), cfg, "u1")
    assert "trim_discretionary" not in {a.action_id for a in outside.actions}
    assert cutoff == dt.date(2026, 8, 31)  # guard the fixture's arithmetic
