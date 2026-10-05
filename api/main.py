"""FastAPI entry point for Sathi (সাথী).

Base path: /v1 (plus /healthz at root).
All personal-data routes live under /v1/me/* and require a verified token.
No personal-data route accepts a user_id parameter.
"""
from __future__ import annotations

import datetime as dt
import json
import sqlite3
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Depends, FastAPI, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

import sathi_config
from api.auth import create_access_token, get_current_user_id
from api.config import get_settings
from api.db import connect, get_db, init_db, path_from_url
from api.errors import NotFoundError, SathiError, ValidationFailedError
from api.ratelimit import rate_limit
from api.repositories import goals as goals_repo
from api.repositories import transactions as tx_repo
from api.repositories import users as users_repo
from api.schemas.common import Envelope, ErrorBody, ErrorEnvelope
from api.schemas.extended import (ActionsData, ChatData, ChatRequest, DemoLoginRequest,
                                  DemoLoginResponse, DemoUserItem, ForecastData,
                                  GoalPlanData, GoalPlanRequest, ParseAmountData,
                                  ParseAmountRequest, UserInputsData, UserInputsRequest)
from api.schemas.me import (BenchmarkComparisonOut, CategoryTrace,
                            CounterpartyOut, GoalCreateRequest, GoalRecord,
                            GoalsData, SummaryData, TransactionItem,
                            TransactionsData)
from api.services.actions_service import get_actions
from api.services.cashout_service import get_cashout_insights
from api.services.convert import row_to_txn
from api.services.evidence import as_of_date, build_evidence
from api.services.forecast_service import get_forecast
from api.services.goal_service import create_goal_plan
from api.services.inputs_service import get_inputs, update_inputs
from api.services.summary_service import get_summary
from core.amounts import parse_amount
from core.categorizer import categorize
from core.formatting import format_date, format_taka
from llm.orchestrator import handle_message
from ml.benchmark import load_benchmark_metrics
from ml.inference import load_latest_version, load_metadata

BASE_DIR = Path(__file__).parent.parent
DATA_DIR = BASE_DIR / "data"

# Module-level dependency singleton: `Depends(get_db)` is an immutable
# marker, so one shared instance is safe (and keeps argument defaults
# call-free, per ruff B008). Every handler using it receives its OWN
# fresh per-request connection.
DB_DEP = Depends(get_db)

_app_state: dict = {}


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    cfg = sathi_config.load_config()
    db_path = path_from_url(settings.database_url)
    init_db(db_path, DATA_DIR)

    # Startup self-check: prove the DB is reachable with a short-lived
    # connection. Every request handler now gets its OWN connection via the
    # get_db dependency — no sqlite3 object is shared across handler threads.
    conn = connect(db_path)
    conn.close()

    forecast_v = load_latest_version()
    meta = load_metadata()
    _app_state["cfg"] = cfg
    _app_state["forecast_version"] = forecast_v
    _app_state["metadata"] = meta
    _app_state["db_healthy"] = True
    yield


app = FastAPI(
    title="Sathi (সাথী) API",
    description="Bangla-first AI financial coach for mobile-wallet customers",
    version="1.0.0",
    lifespan=lifespan,
)

settings = get_settings()
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# --- Error handlers matching stable error schema ---
@app.exception_handler(SathiError)
async def sathi_error_handler(request: Request, exc: SathiError):
    req_id = request.headers.get("x-request-id", str(uuid.uuid4()))
    body = ErrorBody(
        code=exc.code,
        message_bn=exc.message_bn,
        message_en=exc.message_en,
        request_id=req_id,
    )
    return JSONResponse(status_code=exc.status, content=ErrorEnvelope(error=body).model_dump())


@app.exception_handler(RequestValidationError)
async def validation_error_handler(request: Request, exc: RequestValidationError):
    req_id = request.headers.get("x-request-id", str(uuid.uuid4()))
    body = ErrorBody(
        code="VALIDATION_FAILED",
        message_bn="দেওয়া তথ্য ঠিক নেই। আবার দেখে চেষ্টা করুন।",
        message_en="Input validation failed. Please check the values provided.",
        request_id=req_id,
    )
    return JSONResponse(status_code=400, content=ErrorEnvelope(error=body).model_dump())


@app.exception_handler(Exception)
async def generic_error_handler(request: Request, exc: Exception):
    req_id = request.headers.get("x-request-id", str(uuid.uuid4()))
    body = ErrorBody(
        code="INTERNAL",
        message_bn="একটি অপ্রত্যাশিত সমস্যা হয়েছে।",
        message_en="An unexpected error occurred.",
        request_id=req_id,
    )
    return JSONResponse(status_code=500, content=ErrorEnvelope(error=body).model_dump())


# --- Root / Health ---
@app.get("/healthz")
def healthz():
    """Startup self-check and liveness check (architecture §7 / §11)."""
    cfg = _app_state.get("cfg")
    return {
        "status": "ok",
        "api_version": "1.0.0",
        "git_commit": settings.git_commit,
        "config_hash": cfg.config_hash if cfg else "none",
        "model_versions": {
            "forecast": _app_state.get("forecast_version", "unknown"),
            "categorizer": "rules-v1",
        },
        "self_check": {
            "database": _app_state.get("db_healthy", False),
            "config_loaded": cfg is not None,
            "models_loaded": _app_state.get("metadata") is not None,
        },
    }


# --- Auth & Demo Users ---
@app.get("/v1/demo-users", response_model=list[DemoUserItem])
def list_demo_users(conn: sqlite3.Connection = DB_DEP):
    """List one canonical synthetic demo user per persona."""
    cfg = _app_state["cfg"]
    personas_cfg = cfg.section("personas")
    rows = users_repo.demo_users(conn)
    result = []
    for r in rows:
        p_info = personas_cfg.get(r["persona"], {})
        u_full = users_repo.get_user(conn, r["user_id"]) or {}
        result.append(
            DemoUserItem(
                user_id=r["user_id"],
                persona=r["persona"],
                persona_label_bn=p_info.get("label_bn", r["persona"]),
                persona_label_en=p_info.get("label_en", r["persona"]),
                age_band=u_full.get("age_band", "unknown"),
                region=u_full.get("region", "unknown"),
                income_band=u_full.get("income_band", "unknown"),
            )
        )
    return result


@app.post("/v1/auth/demo-login", response_model=DemoLoginResponse)
def demo_login(
    req: DemoLoginRequest,
    _rate_limited: None = Depends(rate_limit("demo_login")),
    conn: sqlite3.Connection = DB_DEP,
):
    """Obtain JWT access token for a synthetic demo user."""
    user = users_repo.get_user(conn, req.user_id)
    if user is None:
        raise NotFoundError()
    token = create_access_token(user["user_id"], user["persona"])
    return DemoLoginResponse(
        token=token,
        expires_in_minutes=settings.token_ttl_minutes,
        user_id=user["user_id"],
        persona=user["persona"],
    )


# --- Scoped Personal Routes (/v1/me/*) ---
@app.get("/v1/me/summary", response_model=Envelope[SummaryData])
def get_user_summary(
    user_id: str = Depends(get_current_user_id),
    conn: sqlite3.Connection = DB_DEP,
):
    cfg = _app_state["cfg"]
    forecast_v = _app_state["forecast_version"]
    data, evidence = get_summary(conn, cfg, forecast_v, user_id)
    return Envelope(data=data, evidence=evidence)


@app.get("/v1/me/transactions", response_model=Envelope[TransactionsData])
def get_user_transactions(
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=100),
    user_id: str = Depends(get_current_user_id),
    conn: sqlite3.Connection = DB_DEP,
):
    cfg = _app_state["cfg"]
    rows, total = tx_repo.list_page(conn, user_id, page, page_size)
    as_of = as_of_date(cfg)
    items = []
    sec = cfg.section("categories")
    labels = sec.get("categories", sec)

    for r in rows:
        t = row_to_txn(r)
        cat_res = categorize(t)
        cat_key = cat_res.category.value
        cat_label = labels.get(cat_key, {})
        items.append(
            TransactionItem(
                txn_id=t.txn_id,
                ts=t.ts.isoformat(),
                type=t.type.value,
                direction="in" if t.is_inflow else "out",
                amount_paisa=t.amount_paisa,
                amount_display=format_taka(t.amount_paisa, "bn"),
                fee_paisa=t.fee_paisa,
                fee_display=format_taka(t.fee_paisa, "bn"),
                counterparty=CounterpartyOut(
                    id=t.counterparty_id,
                    type=t.counterparty_type,
                    category=t.counterparty_category,
                    accepts_digital=t.counterparty_accepts_digital,
                ),
                category=CategoryTrace(
                    category=cat_key,
                    label_bn=cat_label.get("label_bn", cat_key),
                    label_en=cat_label.get("label_en", cat_key),
                    rule_id=cat_res.rule_id,
                    reason_bn=cat_res.reason_bn,
                    reason_en=cat_res.reason_en,
                ),
                balance_after_paisa=t.balance_after_paisa,
                balance_after_display=format_taka(t.balance_after_paisa, "bn"),
            )
        )

    data = TransactionsData(
        items=items,
        page=page,
        page_size=page_size,
        total=total,
        as_of_date=as_of.isoformat(),
    )
    evidence = build_evidence(
        cfg,
        n_transactions=total,
        labels={"transactions": "Data"},
        forecast_version=_app_state["forecast_version"],
    )
    return Envelope(data=data, evidence=evidence)


@app.get("/v1/me/forecast", response_model=Envelope[ForecastData])
def get_user_forecast(
    user_id: str = Depends(get_current_user_id),
    conn: sqlite3.Connection = DB_DEP,
):
    cfg = _app_state["cfg"]
    data, evidence = get_forecast(conn, cfg, user_id)
    return Envelope(data=data, evidence=evidence)


# --- User Inputs (liquidity corrections: cash on hand, income day, rent) ---
@app.get("/v1/me/inputs", response_model=Envelope[UserInputsData])
def get_user_inputs(
    user_id: str = Depends(get_current_user_id),
    conn: sqlite3.Connection = DB_DEP,
):
    """Current user-declared liquidity inputs (defaults when never set)."""
    cfg = _app_state["cfg"]
    data = get_inputs(conn, user_id)
    evidence = build_evidence(
        cfg,
        n_transactions=tx_repo.count_for_user(conn, user_id),
        labels={"user_inputs": "Data", "cash_on_hand": "Data"},
        forecast_version=_app_state["forecast_version"],
    )
    return Envelope(data=data, evidence=evidence)


@app.post("/v1/me/inputs", response_model=Envelope[UserInputsData])
def post_user_inputs(
    req: UserInputsRequest,
    user_id: str = Depends(get_current_user_id),
    conn: sqlite3.Connection = DB_DEP,
):
    """Correct the liquidity estimates: cash on hand, income day, rent, other
    liquid funds. A declared cash amount decays forward at the observed daily
    cash burn, so it never overstates liquidity as it ages."""
    cfg = _app_state["cfg"]
    if not any(v is not None for v in (
        req.cash_on_hand_taka, req.income_day, req.rent_amount_taka,
        req.rent_confirmed, req.other_liquid_taka,
    )):
        raise ValidationFailedError(
            message_bn="অন্তত একটি ইনপুট দিন।",
            message_en="Provide at least one input field.",
        )
    data = update_inputs(conn, user_id, req)
    evidence = build_evidence(
        cfg,
        n_transactions=tx_repo.count_for_user(conn, user_id),
        labels={"user_inputs": "Data", "cash_on_hand": "Data",
                "decay": "Assumption"},
        forecast_version=_app_state["forecast_version"],
    )
    return Envelope(data=data, evidence=evidence)


# --- Counterfactual Actions ---
@app.get("/v1/me/actions")
def get_user_actions(
    user_id: str = Depends(get_current_user_id),
    conn: sqlite3.Connection = DB_DEP,
):
    """Ranked candidate actions with counterfactual shortfall-probability
    deltas, recomputed over the same simulated liquidity paths."""
    cfg = _app_state["cfg"]
    data = get_actions(conn, cfg, user_id)
    evidence = build_evidence(
        cfg,
        n_transactions=tx_repo.count_for_user(conn, user_id),
        labels={"actions": "Prediction", "delta_shortfall_prob": "Prediction",
                "fee_tariff": "Assumption"},
        forecast_version=_app_state["forecast_version"],
    )
    return {"data": data.model_dump(), "evidence": evidence.model_dump()}


@app.post("/v1/me/goal-plan", response_model=Envelope[GoalPlanData])
def plan_user_goal(
    req: GoalPlanRequest,
    user_id: str = Depends(get_current_user_id),
    conn: sqlite3.Connection = DB_DEP,
):
    cfg = _app_state["cfg"]
    data, evidence = create_goal_plan(
        conn=conn,
        cfg=cfg,
        user_id=user_id,
        goal_type=req.goal_type,
        target_paisa=req.target_paisa,
        months=req.months,
    )
    return Envelope(data=data, evidence=evidence)


@app.get("/v1/me/cashout-insights")
def get_user_cashout(
    user_id: str = Depends(get_current_user_id),
    conn: sqlite3.Connection = DB_DEP,
):
    cfg = _app_state["cfg"]
    data, evidence = get_cashout_insights(conn, cfg, user_id)
    return {"data": data.model_dump(), "evidence": evidence.model_dump()}


@app.post("/v1/me/goals", response_model=GoalRecord)
def save_user_goal(
    req: GoalCreateRequest,
    user_id: str = Depends(get_current_user_id),
    conn: sqlite3.Connection = DB_DEP,
):
    now_iso = dt.datetime.now(dt.timezone.utc).isoformat()
    goal_id = goals_repo.insert_goal(
        conn=conn,
        user_id=user_id,
        goal_type=req.goal_type,
        target_amount_paisa=req.target_paisa,
        months=req.months,
        plan_option_key=req.plan_option_key,
        monthly_contribution_paisa=req.monthly_contribution_paisa,
        created_at=now_iso,
    )
    return GoalRecord(
        goal_id=goal_id,
        goal_type=req.goal_type,
        target_paisa=req.target_paisa,
        target_display=format_taka(req.target_paisa, "bn"),
        months=req.months,
        plan_option_key=req.plan_option_key,
        monthly_contribution_paisa=req.monthly_contribution_paisa,
        monthly_contribution_display=format_taka(req.monthly_contribution_paisa, "bn"),
        created_at=now_iso,
        note_bn="লক্ষ্য সংরক্ষিত হয়েছে। এটি কোনো স্বয়ংক্রিয় টাকা স্থানান্তর করে না।",
        note_en="Goal plan saved. This stores a plan only and never moves funds.",
    )


@app.get("/v1/me/goals", response_model=GoalsData)
def list_user_goals(
    user_id: str = Depends(get_current_user_id),
    conn: sqlite3.Connection = DB_DEP,
):
    rows = goals_repo.list_goals(conn, user_id)
    goals = [
        GoalRecord(
            goal_id=r["goal_id"],
            goal_type=r["goal_type"],
            target_paisa=r["target_amount_paisa"],
            target_display=format_taka(r["target_amount_paisa"], "bn"),
            months=r["months"],
            plan_option_key=r["plan_option_key"],
            monthly_contribution_paisa=r["monthly_contribution_paisa"],
            monthly_contribution_display=format_taka(r["monthly_contribution_paisa"], "bn"),
            created_at=r["created_at"],
            note_bn="লক্ষ্য সংরক্ষিত হয়েছে।",
            note_en="Saved goal plan.",
        )
        for r in rows
    ]
    return GoalsData(goals=goals)


# --- Amount Parser ---
@app.post("/v1/parse-amount", response_model=ParseAmountData)
def parse_user_amount(
    req: ParseAmountRequest,
    _rate_limited: None = Depends(rate_limit("parse_amount")),
):
    """Deterministic amount parser (Bengali/English digits & units)."""
    parsed = parse_amount(req.text)
    display = format_taka(parsed.amount_paisa, "bn") if parsed.amount_paisa is not None else None
    return ParseAmountData(
        raw_text=req.text,
        amount_paisa=parsed.amount_paisa,
        amount_display=display,
        ambiguous=parsed.ambiguous,
        note=parsed.note,
    )


# --- Copilot / Chat ---
@app.post("/v1/chat")
def chat_endpoint(
    req: ChatRequest,
    _rate_limited: None = Depends(rate_limit("chat")),
    user_id: str = Depends(get_current_user_id),
    conn: sqlite3.Connection = DB_DEP,
):
    """Conversational endpoint with strict safety, tool grounding, and fail-closed validation."""
    cfg = _app_state["cfg"]
    forecast_v = _app_state["forecast_version"]

    # Build context from verified tool output
    summary_data, _ = get_summary(conn, cfg, forecast_v, user_id)
    forecast_data, _ = get_forecast(conn, cfg, user_id)
    cashout_data, _ = get_cashout_insights(conn, cfg, user_id)

    context = {
        "balance_paisa": summary_data.balance_paisa,
        "monthly_income_paisa": summary_data.metrics.monthly_income_paisa,
        "monthly_spend_paisa": summary_data.metrics.monthly_spend_paisa,
        "shortfall_prob": forecast_data.shortfall_prob,
        "horizon_days": forecast_data.horizon_days,
        "trough_date": forecast_data.trough_date,
        "min_balance_paisa": forecast_data.days[0].p50_paisa if forecast_data.days else 0,
        "replaceable_fee_saved_paisa": cashout_data.replaceable_fee_saved_paisa,
        "safe_to_spend_paisa": summary_data.safe_to_spend.safe_to_spend_total_paisa,
        "daily_safe_budget_paisa": summary_data.safe_to_spend.daily_safe_budget_paisa,
        "status": summary_data.safe_to_spend.status,
        "upcoming_commitments_paisa": summary_data.safe_to_spend.upcoming_commitments_paisa,
        "estimated_cash_paisa": summary_data.cash_on_hand.estimated_cash_paisa,
    }

    res = handle_message(req.message, context, settings, locale=req.locale, spend_conn=conn)
    evidence = build_evidence(
        cfg,
        n_transactions=tx_repo.count_for_user(conn, user_id),
        labels=res.evidence_labels,
        forecast_version=forecast_v,
        generated_text=res.generated_text,
        validator_passed=res.validator_passed,
        fallback_used=res.fallback_used,
    )

    data = ChatData(
        reply=res.reply,
        intent=res.intent,
        fallback_used=res.fallback_used,
        generated_text=res.generated_text,
        refusal=res.refusal,
    )
    return {"data": data.model_dump(), "evidence": evidence.model_dump()}


# --- Empirical Benchmark (AI vs Rule Baseline) ---
@app.get("/v1/me/benchmark", response_model=BenchmarkComparisonOut)
@app.get("/v1/benchmark", response_model=BenchmarkComparisonOut)
def get_benchmark_comparison(user_id: str = Depends(get_current_user_id)):
    """Empirical proof comparing ML quantile forecaster against rule baselines.
    Scoped to a verified token (global metrics only; no personal data)."""
    return load_benchmark_metrics()


# --- Model Card & Metadata ---
@app.get("/v1/meta/model-card")
def get_model_card():
    """Model card metadata and fairness benchmark evaluation."""
    metrics_file = BASE_DIR / "docs" / "metrics" / "eval.json"
    eval_metrics = {}
    if metrics_file.exists():
        eval_metrics = json.loads(metrics_file.read_text(encoding="utf-8"))

    return {
        "model": "Quantile Gradient Boosted Cash-Flow Forecaster (LightGBM)",
        "version": _app_state.get("forecast_version", "unknown"),
        "task": "Daily net-flow quantile prediction (p10, p50, p90)",
        "intended_use": "Short-term liquidity pressure estimation and savings planning",
        "limitations": [
            "Synthetic transaction training data only; requires governed MFS partner data before production use",
            "Predictions are probability ranges, never single-point guarantees",
            "Does not execute financial transactions or approve lending",
        ],
        "fairness_evaluation": eval_metrics.get("forecast", {}),
    }
