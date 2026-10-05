"""Schemas for /v1/me/summary, /v1/me/transactions, /v1/me/goals and /v1/me/benchmark."""
from __future__ import annotations

from typing import Any, Literal, Optional

from pydantic import BaseModel, Field

from api.schemas.common import InsightLabel


class UserRef(BaseModel):
    persona: str
    persona_label_bn: str
    persona_label_en: str


class SafeToSpendOut(BaseModel):
    safe_to_spend_total_paisa: int
    safe_to_spend_total_display: str
    safe_to_spend_wallet_paisa: int
    safe_to_spend_wallet_display: str
    daily_safe_budget_paisa: int
    daily_safe_budget_display: str
    upcoming_commitments_paisa: int
    upcoming_commitments_display: str
    safety_buffer_paisa: int
    safety_buffer_display: str
    estimated_cash_paisa: int
    estimated_cash_display: str
    wallet_balance_paisa: int
    wallet_balance_display: str
    status: Literal["comfortable", "cautious", "tight", "deficit"]
    status_label_bn: str
    status_label_en: str
    horizon_days: int
    advice_bn: str
    advice_en: str
    # "model": Q_0.10(simulated min balance) - floor; "rule": deterministic formula.
    method: Literal["model", "rule"] = "rule"
    rule_safe_to_spend_paisa: Optional[int] = None
    rule_safe_to_spend_display: Optional[str] = None
    shortfall_prob: Optional[float] = None


class CashOnHandOut(BaseModel):
    estimated_cash_paisa: int
    estimated_cash_display: str
    trailing_cashout_total_paisa: int
    trailing_cashout_total_display: str
    daily_cash_burn_paisa: int
    daily_cash_burn_display: str
    days_of_cash_remaining: float
    confidence: Literal["normal", "low"]
    last_cashout_date: Optional[str] = None
    # User-corrected liquidity (POST /v1/me/inputs): the value actually used.
    effective_cash_paisa: Optional[int] = None
    effective_cash_display: Optional[str] = None
    other_liquid_paisa: Optional[int] = None
    source: Optional[str] = None


class RecurringItemOut(BaseModel):
    item_id: str
    title_bn: str
    title_en: str
    category: str
    direction: Literal["inflow", "outflow"]
    amount_paisa: int
    amount_display: str
    interval_days: int
    periodicity: Literal["monthly", "fortnightly", "weekly"]
    expected_day_of_month: Optional[int] = None
    confidence: float
    next_expected_date: str
    occurrence_count: int


class RecurringSummaryOut(BaseModel):
    inflows: list[RecurringItemOut]
    outflows: list[RecurringItemOut]
    total_monthly_inflow_paisa: int
    total_monthly_outflow_paisa: int
    total_monthly_inflow_display: str
    total_monthly_outflow_display: str
    detected_salary_dom: Optional[int] = None
    upcoming_commitments_14d_paisa: int
    upcoming_commitments_14d_display: str


class MetricsOut(BaseModel):
    monthly_income_paisa: int
    monthly_income_display: str
    monthly_spend_paisa: int
    monthly_spend_display: str
    savings_rate: float | None
    savings_rate_display: str | None
    income_volatility: float | None
    income_volatility_display: str | None
    buffer_days: float | None
    buffer_days_display: str | None
    cash_dependency_ratio: float | None
    cash_dependency_ratio_display: str | None
    fee_leakage_paisa: int
    fee_leakage_display: str
    fixed_commitment_ratio: float | None
    fixed_commitment_ratio_display: str | None


class CategoryRow(BaseModel):
    category: str
    label_bn: str
    label_en: str
    total_paisa: int
    total_display: str
    share: float
    share_display: str


class Insight(BaseModel):
    id: str
    label: InsightLabel
    text_bn: str
    text_en: str


class SummaryData(BaseModel):
    user: UserRef
    as_of_date: str
    balance_paisa: int
    balance_display: str
    confidence: Literal["normal", "low"]
    safe_to_spend: SafeToSpendOut
    cash_on_hand: CashOnHandOut
    recurring: RecurringSummaryOut
    metrics: MetricsOut
    categories: list[CategoryRow]
    insights: list[Insight]
    # Liquidity provenance: wallet + effective cash-on-hand + other liquid.
    liquidity_basis: Optional[dict] = None


class CounterpartyOut(BaseModel):
    id: str
    type: str
    category: str
    accepts_digital: bool


class CategoryTrace(BaseModel):
    category: str
    label_bn: str
    label_en: str
    rule_id: str
    reason_bn: str
    reason_en: str


class TransactionItem(BaseModel):
    txn_id: str
    ts: str
    type: str
    direction: Literal["in", "out"]
    amount_paisa: int
    amount_display: str
    fee_paisa: int
    fee_display: str
    counterparty: CounterpartyOut
    category: CategoryTrace
    balance_after_paisa: int
    balance_after_display: str


class TransactionsData(BaseModel):
    items: list[TransactionItem]
    page: int
    page_size: int
    total: int
    as_of_date: str


class GoalCreateRequest(BaseModel):
    goal_type: str
    # Sane bounds, mirroring GoalPlanRequest: positive target with a ceiling
    # (~10^13 paisa = ৳100bn — far beyond any MFS wallet) so a garbled client
    # cannot persist absurd money. The web twin route enforces the same
    # positive-target check.
    target_paisa: int = Field(gt=0, le=10_000_000_000_000)
    months: int = Field(gt=0, le=60)
    plan_option_key: str
    monthly_contribution_paisa: int = Field(ge=0, le=10_000_000_000_000)


class GoalRecord(BaseModel):
    goal_id: int
    goal_type: str
    target_paisa: int
    target_display: str
    months: int
    plan_option_key: str
    monthly_contribution_paisa: int
    monthly_contribution_display: str
    created_at: str
    note_bn: str
    note_en: str


class GoalsData(BaseModel):
    goals: list[GoalRecord]


class BenchmarkComparisonOut(BaseModel):
    title: str
    description: str
    brier_score: dict[str, Any]
    quantile_loss: dict[str, Any]
    wape_accuracy: dict[str, Any]
    early_warning_7d: dict[str, Any]
    interpretability: dict[str, Any]
    governance_note: str
