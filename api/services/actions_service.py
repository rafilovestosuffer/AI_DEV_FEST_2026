"""Counterfactual action engine (mission P1).

Ranks 2-3 candidate actions by their estimated reduction in shortfall
probability. Each action is a deterministic cash-flow delta applied to the
SAME simulated liquidity paths the forecaster produced (the forecast's own
quantile + stream + path simulation), so the counterfactual is comparable
to the baseline by construction:

    path'(day d) = path(day d) + freed_daily * d + one_time

p_after = P(min path' < floor) over the same shortfall window.
Deterministic code owns every number; the LLM never sees this computation.
"""
from __future__ import annotations

import datetime as dt
import sqlite3
from collections import defaultdict

import numpy as np

from api.schemas.extended import ActionOut, ActionsData
from api.services.convert import row_to_txn
from core.categorizer import categorize
from core.formatting import format_taka
from core.money import apply_rate
from core.schemas import TxnType
from core.timeutils import dhaka_date

# Categories where a spending trim is a realistic user choice (never rent,
# bills, mobile or family support — those are obligations).
_TRIMMABLE = ("food", "transport", "other")
_TRIM_FRACTION = 0.20

_CAT_LABELS = {"food": "খাবার ও বাজার", "transport": "যাতায়াত", "other": "অন্যান্য খরচ"}
_CAT_LABELS_EN = {"food": "food & groceries", "transport": "transport", "other": "other spending"}


def _quantile10_min(paths: np.ndarray, window: int, floor: int) -> tuple[float, int]:
    mins = paths[:, 1:window + 1].min(axis=1)
    p = float(np.mean(mins < floor))
    safe = max(int(np.quantile(mins, 0.10)) - floor, 0)
    return p, safe


def get_actions(conn: sqlite3.Connection, cfg, user_id: str) -> ActionsData:
    from api.services.forecast_service import user_forecast  # local import: avoid import cycle
    from api.services.inputs_service import get_inputs  # liquidity basis in the response note

    f = user_forecast(conn, cfg, user_id)
    if f is None:
        return ActionsData(
            actions=[], base_shortfall_prob=0.0, base_safe_to_spend_paisa=None,
            method="none — no transaction history",
            note_bn="পর্যাপ্ত লেনদেনের ইতিহাস নেই, তাই কোনো কর্ম-পরিকল্পনা দেখানো হয়নি।",
            note_en="Not enough transaction history to simulate actions yet.",
        )

    origin = as_of(cfg)
    rows = conn.execute(
        "SELECT * FROM transactions WHERE user_id = ? ORDER BY ts", (user_id,),
    ).fetchall()
    txns = [row_to_txn(r) for r in rows]

    paths = np.asarray(f.paths, dtype=np.int64)
    window = int(f.window_days)
    floor = int(f.floor_paisa)
    base_p = float(f.p_shortfall)
    base_safe = int(f.safe_to_spend_paisa)

    cutoff = origin - dt.timedelta(days=30)
    cat_month: dict[str, int] = defaultdict(int)
    cashout_amts: list[int] = []
    for t in txns:
        # ADR-10: calendar logic runs in Asia/Dhaka. The stored timestamps are
        # UTC; their Dhaka-local dates decide window membership (a 21:00Z
        # spend is already the next Dhaka day), matching every other window
        # in the codebase (core/metrics, core/cashout, core/recurring).
        if dhaka_date(t.ts) < cutoff:
            continue
        if t.type == TxnType.CASH_OUT:
            cashout_amts.append(int(t.amount_paisa))
            continue
        if not t.is_inflow:
            cat = categorize(t).category.value
            if cat in _TRIMMABLE:
                cat_month[cat] += int(t.amount_paisa)

    fees = cfg.section("fees")
    bps = int(fees["cash_out_bps"])
    min_fee = int(fees["cash_out_min_paisa"])

    candidates: list[dict] = []

    # Candidate 1 — trim the top trimmable category by 20%.
    if cat_month:
        cat, total = max(cat_month.items(), key=lambda kv: kv[1])
        freed_monthly = int(total * _TRIM_FRACTION)
        if freed_monthly >= 5000:  # ignore trivial trims (< ৳50)
            candidates.append({
                "action_id": "trim_discretionary",
                "title_bn": f"{_CAT_LABELS.get(cat, cat)} ২০% কমান",
                "title_en": f"Trim {_CAT_LABELS_EN.get(cat, cat)} by 20%",
                "detail_bn": (f"গত ৩০ দিনে {format_taka(total, 'bn')} খরচ হয়েছে; ২০% কমালে "
                              f"মাসে প্রায় {format_taka(freed_monthly, 'bn')} সাশ্রয় হবে।"),
                "detail_en": (f"You spent {format_taka(total, 'en')} here in the last 30 days; a "
                              f"20% trim frees about {format_taka(freed_monthly, 'en')} a month."),
                "category": "habits",
                "freed_monthly": freed_monthly,
                "freed_daily": freed_monthly / 30.0,
                "one_time": 0,
            })

    # Candidate 2 — batch cash-outs (tariff-grounded fee saving).
    if len(cashout_amts) >= 3:
        total_amt = sum(cashout_amts)
        fee_now = sum(apply_rate(a, bps, min_fee) for a in cashout_amts)
        fee_batched = 2 * apply_rate(total_amt // 2, bps, min_fee)
        saved = max(0, fee_now - fee_batched)
        if saved >= 500:
            candidates.append({
                "action_id": "batch_cashouts",
                "title_bn": "ক্যাশ-আউট একত্র করুন",
                "title_en": "Batch your cash-outs",
                "detail_bn": (f"৩০ দিনে {len(cashout_amts)}টি ক্যাশ-আউটের ফি প্রায় "
                              f"{format_taka(fee_now, 'bn')}; দুটি বড় উত্তোলনে নামলে প্রায় "
                              f"{format_taka(saved, 'bn')} সাশ্রয়।"),
                "detail_en": (f"{len(cashout_amts)} cash-outs in 30 days cost about "
                              f"{format_taka(fee_now, 'en')} in fees at the {bps // 100}% tariff; "
                              f"batching into 2 larger withdrawals saves about {format_taka(saved, 'en')}."),
                "category": "cashflow",
                "freed_monthly": saved,
                "freed_daily": saved / 30.0,
                "one_time": 0,
            })

    # Candidate 3 — hold a payday buffer (one-time liquidity boost).
    essentials = int(cfg.section("thresholds")["essentials_per_day_paisa"])
    buffer_amt = essentials * 7  # one week of essentials
    candidates.append({
        "action_id": "buffer_payday",
        "title_bn": "বেতনের দিন এক সপ্তাহের বাফার রাখুন",
        "title_en": "Hold a one-week buffer on salary day",
        "detail_bn": (f"বেতন আসামাত্র খরচ শুরুর আগে প্রায় {format_taka(buffer_amt, 'bn')} "
                      f"(এক সপ্তাহের আবশ্যক খরচ) আলাদা রাখলে মাসের শেষের টানাপোড়েন কমে।"),
        "detail_en": (f"Setting aside about {format_taka(buffer_amt, 'en')} (one week of essentials) "
                      f"right when income arrives softens the end-of-month trough."),
        "category": "cashflow",
        "freed_monthly": None,
        "freed_daily": 0.0,
        "one_time": buffer_amt,
    })

    # --- counterfactual: the SAME simulated paths, deterministic deltas ---
    actions: list[ActionOut] = []
    for c in candidates:
        adj = paths.astype(np.float64).copy()
        for d in range(1, adj.shape[1]):
            adj[:, d] += c["freed_daily"] * d + c["one_time"]
        mins = adj[:, 1:window + 1].min(axis=1)
        p_after = float(np.mean(mins < floor))
        safe_after = max(int(np.quantile(mins, 0.10)) - floor, 0)
        actions.append(ActionOut(
            action_id=c["action_id"],
            title_bn=c["title_bn"],
            title_en=c["title_en"],
            detail_bn=c["detail_bn"],
            detail_en=c["detail_en"],
            category=c["category"],
            shortfall_prob_before=round(base_p, 4),
            shortfall_prob_after=round(p_after, 4),
            delta_shortfall_prob=round(p_after - base_p, 4),
            freed_monthly_paisa=c["freed_monthly"],
            safe_to_spend_after_paisa=safe_after,
            safe_to_spend_after_display=format_taka(safe_after, "bn"),
        ))

    actions.sort(key=lambda a: a.delta_shortfall_prob)
    get_inputs(conn, user_id)  # ensure the inputs table exists for this user's next correction
    return ActionsData(
        actions=actions,
        base_shortfall_prob=round(base_p, 4),
        base_safe_to_spend_paisa=base_safe,
        method="counterfactual over the same simulated liquidity paths",
        note_bn="প্রতিটি বিকল্প একই সিমুলেশন পথে পুনঃগণনা করা — সুপারিশ, নির্দেশ নয়।",
        note_en="Each option re-runs the same simulated paths — a suggestion, never an instruction.",
    )


def as_of(cfg) -> dt.date:
    from api.services.evidence import as_of_date
    return as_of_date(cfg)
