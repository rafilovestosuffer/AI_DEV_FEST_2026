"""SQLite storage (WAL mode). The seeded dataset is loaded from the parquet
files produced by `make data` when the database is empty, so a fresh clone
can rebuild everything from the recorded seed.

Timestamps are stored as ISO-8601 UTC strings. Money columns are integer
paisa. All access goes through api/repositories/ — no SQL elsewhere.

Connections are per request: `get_db` hands every request a FRESH connection
(a shared connection across handler threads is a race) with a 30s busy
timeout, closed in a finally block. Startup (init_db / self-check) uses
short-lived connections of its own.
"""
from __future__ import annotations

import json
import sqlite3
from collections.abc import Iterator
from pathlib import Path

import pandas as pd

from api.config import get_settings

SCHEMA = """
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS users (
    user_id      TEXT PRIMARY KEY,
    persona      TEXT NOT NULL,
    age_band     TEXT NOT NULL,
    region       TEXT NOT NULL,
    income_band  TEXT NOT NULL,
    created_at   TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS transactions (
    txn_id                       TEXT PRIMARY KEY,
    user_id                      TEXT NOT NULL REFERENCES users(user_id),
    ts                           TEXT NOT NULL,               -- ISO-8601 UTC
    type                         TEXT NOT NULL,
    amount_paisa                 INTEGER NOT NULL,
    fee_paisa                    INTEGER NOT NULL,
    counterparty_id              TEXT NOT NULL,
    counterparty_type            TEXT NOT NULL,
    counterparty_category        TEXT NOT NULL,
    counterparty_accepts_digital INTEGER NOT NULL,
    channel                      TEXT NOT NULL,
    balance_after_paisa          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_txn_user_ts ON transactions(user_id, ts);
CREATE TABLE IF NOT EXISTS user_goals (
    goal_id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id                      TEXT NOT NULL REFERENCES users(user_id),
    goal_type                    TEXT NOT NULL,
    target_amount_paisa          INTEGER NOT NULL,
    months                       INTEGER NOT NULL,
    plan_option_key              TEXT NOT NULL,
    monthly_contribution_paisa   INTEGER NOT NULL,
    created_at                   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_goals_user ON user_goals(user_id);
-- User-submitted liquidity inputs (mission P0: POST /v1/me/inputs). A user
-- declaration (cash on hand, income day, rent) corrects the behavioral
-- estimates; the estimator decays the declared cash with observed burn.
CREATE TABLE IF NOT EXISTS user_inputs (
    user_id            TEXT PRIMARY KEY REFERENCES users(user_id),
    cash_on_hand_paisa INTEGER,
    cash_on_hand_as_of TEXT,
    income_day         INTEGER,
    rent_amount_paisa  INTEGER,
    rent_confirmed     INTEGER NOT NULL DEFAULT 0,
    other_liquid_paisa INTEGER,
    updated_at         TEXT NOT NULL
);
-- LLM spend counter (architecture §4.2). Resets on redeploy; the provider
-- dashboard hard limit is the real cap.
CREATE TABLE IF NOT EXISTS llm_spend (
    day    TEXT PRIMARY KEY,     -- YYYY-MM-DD (server date)
    calls  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""


def path_from_url(database_url: str) -> Path:
    """sqlite:///relative/or/absolute path -> Path (only sqlite is supported)."""
    prefix = "sqlite:///"
    if not database_url.startswith(prefix):
        raise ValueError(f"unsupported DATABASE_URL: {database_url!r}")
    return Path(database_url[len(prefix):]).expanduser().resolve()


def connect(db_path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(str(db_path), check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    # Wait up to 30s for a writer instead of failing instantly with SQLITE_BUSY
    # (WAL allows one writer; per-request connections contend only on writes).
    conn.execute("PRAGMA busy_timeout = 30000")
    return conn


def get_db() -> Iterator[sqlite3.Connection]:
    """FastAPI dependency: one FRESH connection per request, closed in finally.

    The connection is created and torn down inside the request scope, so no
    sqlite3 object is ever shared between handler threads.
    """
    db_path = path_from_url(get_settings().database_url)
    conn = connect(db_path)
    try:
        yield conn
    finally:
        conn.close()


def init_db(db_path: Path, data_dir: Path) -> dict[str, str]:
    """Create the schema and load the dataset if the DB is empty.

    Returns the meta values used by the startup self-check.
    """
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = connect(db_path)
    try:
        conn.executescript(SCHEMA)
        dataset_meta = json.loads((data_dir / "dataset_meta.json").read_text(encoding="utf-8"))
        n_users = conn.execute("SELECT COUNT(*) AS c FROM users").fetchone()["c"]
        if n_users == 0:
            users = pd.read_parquet(data_dir / "users.parquet")
            txns = pd.read_parquet(data_dir / "transactions.parquet")
            users = users.assign(created_at=users["created_at"].dt.strftime("%Y-%m-%dT%H:%M:%SZ"))
            txns = txns.assign(
                ts=txns["ts"].dt.strftime("%Y-%m-%dT%H:%M:%SZ"),
                counterparty_accepts_digital=txns["counterparty_accepts_digital"].astype(int),
            )
            users.to_sql("users", conn, if_exists="append", index=False)
            txns.to_sql("transactions", conn, if_exists="append", index=False)
        conn.execute(
            "INSERT INTO meta(key, value) VALUES('dataset_hash', ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (dataset_meta["transactions_hash"],),
        )
        conn.commit()
        return {"dataset_hash": dataset_meta["transactions_hash"]}
    finally:
        conn.close()
