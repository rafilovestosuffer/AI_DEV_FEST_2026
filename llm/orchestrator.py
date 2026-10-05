"""LLM Intent Orchestrator and Fallback Engine (architecture §6 / §12 / invariant 1, 2, 7).

- Routes user messages or starter chips to pure tool outputs.
- Injects `user_id` from verified token — never from client payload.
- Enforces kill switch, daily spend caps, and prompt sanitization.
- Validates all generated numbers against verified tool outputs.
- Fails closed to reviewed Bangla templates when validation fails.
"""
from __future__ import annotations

import datetime as dt
import re
import sqlite3
from dataclasses import dataclass
from typing import Any

from api.config import Settings
from api.repositories import spend
from core.formatting import format_probability, format_taka, to_bangla_digits, to_english_digits
from core.timeutils import DHAKA
from llm.render import render
from llm.sanitizer import sanitize_input
from llm.validator import extract_number_words, validate_numbers


@dataclass(frozen=True)
class OrchestratorResponse:
    reply: str
    intent: str
    evidence_labels: dict[str, str]
    allowed_numbers: list[float]
    generated_text: bool
    validator_passed: bool
    fallback_used: bool
    refusal: bool = False


# ---------------------------------------------------------------------
# Slot-based narration (mission: LLM emits placeholders, app inserts values)
# ---------------------------------------------------------------------
_SLOT_RE = re.compile(r"\{\{\s*f(\d+)\s*\}\}")
_BARE_DIGIT_RE = re.compile(r"\d")


def build_facts(ctx: dict[str, Any], locale: str) -> list[tuple[str, str]]:
    """Flatten the verified context into ordered (key, formatted value) facts.

    The LLM may ONLY reference these values through {{fK}} slot tokens; the
    application substitutes the trusted, pre-formatted string itself.
    """
    facts: list[tuple[str, str]] = []
    for k, v in ctx.items():
        if isinstance(v, bool) or v is None:
            continue
        if isinstance(v, (int, float)):
            if k.endswith("_paisa"):
                facts.append((k, format_taka(int(v), locale)))
            elif "prob" in k:
                facts.append((k, format_probability(float(v), locale)))
            else:
                s = str(int(v))
                facts.append((k, to_bangla_digits(s) if locale == "bn" else s))
        elif isinstance(v, str) and v:
            facts.append((k, v))
    return facts


def render_slots(draft: str, facts: list[tuple[str, str]]) -> str | None:
    """Validate a slot-token draft and substitute trusted values.

    Fails (returns None) when the draft references an unknown slot id, or
    contains any bare digit or number word outside slot tokens. Fail-closed:
    the caller then uses the reviewed deterministic template.
    """
    if not draft:
        return None
    out: list[str] = []
    pos = 0
    for m in _SLOT_RE.finditer(draft):
        idx = int(m.group(1))
        if idx < 1 or idx > len(facts):
            return None
        out.append(draft[pos:m.start()])
        out.append(facts[idx - 1][1])
        pos = m.end()
    out.append(draft[pos:])
    rendered = "".join(out).strip()
    # The residual (non-slot) text must be number-free: no digits at all
    # (Bangla or English — the strict slot protocol) and no number words.
    residual = _SLOT_RE.sub(" ", draft)
    if _BARE_DIGIT_RE.search(to_english_digits(residual)):
        return None
    if extract_number_words(residual):
        return None
    if len(rendered) < 5:
        return None
    return rendered
_INTENT_PATTERNS = [
    ("greeting", re.compile(r"(hello|hi|hey|assalamu|salam|সালাম|হ্যালো|নমস্কার|কেমন|আদাব)", re.IGNORECASE)),
    ("safe_spend", re.compile(r"(নিরাপদ|বাজেট|কত খরচ|safe to spend|can i spend|budget|daily|প্রতিদিন|খরচ করতে পারব)", re.IGNORECASE)),
    ("forecast", re.compile(r"(টানাটানি|ঘাটতি|ভবিষ্যত|সামনে|আগামী|পূর্বাভাস|forecast|shortfall|predict|future|risk|ঝুঁকি)", re.IGNORECASE)),
    ("cashout", re.compile(r"(ক্যাশ-?আউট|এজেন্ট|ফি|cashout|cash-?out|fee|agent)", re.IGNORECASE)),
    ("goal", re.compile(r"(সঞ্চয়|লক্ষ্য|জমাতে|সেভ|goal|save|savings|plan)", re.IGNORECASE)),
    ("summary", re.compile(r"(ব্যালেন্স|হিসাব|লেনদেন|আয়|খরচ|summary|balance|income|spend|transactions)", re.IGNORECASE)),
]


def detect_intent(text: str) -> str:
    """Classify user intent into one of the core journeys or general."""
    for intent, pattern in _INTENT_PATTERNS:
        if pattern.search(text):
            return intent
    return "general"


def _today_dhaka() -> dt.date:
    """Server "today" in Asia/Dhaka — the llm_spend day boundary (ADR-10:
    calendar logic runs in Dhaka local time)."""
    return dt.datetime.now(DHAKA).date()


def handle_message(
    user_message: str,
    context_data: dict[str, Any],
    settings: Settings,
    locale: str = "bn",
    spend_conn: sqlite3.Connection | None = None,
) -> OrchestratorResponse:
    """Process a user message safely with sanitization, routing, validation, and fail-closed templates.

    `spend_conn` wires the llm_spend daily cap (architecture §4.2): when
    today's provider calls (Asia/Dhaka date) already reached
    settings.llm_daily_cap, the provider is never called and the reviewed
    deterministic template is the answer (fail closed). Every real provider
    attempt is counted, so subsequent requests see the updated total.
    """
    cleaned_text, is_safe = sanitize_input(user_message)
    if not is_safe:
        reply = render("general_refusal", locale=locale)
        return OrchestratorResponse(
            reply=reply,
            intent="refusal",
            evidence_labels={"refusal": "Data"},
            allowed_numbers=[],
            generated_text=False,
            validator_passed=True,
            fallback_used=True,
            refusal=True,
        )

    intent = detect_intent(cleaned_text)

    # Compile ground truth allowed numbers from context
    allowed_numbers: set[float | int] = {0, 1, 2, 3, 4, 5, 6, 7, 14, 21, 30}
    for k, v in context_data.items():
        if isinstance(v, (int, float)):
            allowed_numbers.add(v)
            if isinstance(v, int):
                # Include Taka amount equivalent if paisa
                if k.endswith("_paisa"):
                    allowed_numbers.add(v // 100)
                    allowed_numbers.add(round(v / 100, 2))

    # Facts for slot-based narration: the LLM writes {{fK}} tokens only.
    facts = build_facts(context_data, locale)

    # 1. If LLM is disabled or kill switch active, render template directly
    if not settings.llm_enabled or settings.llm_provider == "none":
        template_name, template_vars = _resolve_template_vars(intent, context_data, locale)
        reply = render(template_name, locale=locale, **template_vars)
        return OrchestratorResponse(
            reply=reply,
            intent=intent,
            evidence_labels={"narrative": "Data"},
            allowed_numbers=sorted(list(allowed_numbers)),
            generated_text=False,
            validator_passed=True,
            fallback_used=True,
        )

    # 2. Daily spend cap — FAIL CLOSED (architecture §4.2): count today's
    #    provider calls (Asia/Dhaka date) and, at the cap, never call the
    #    provider; the reviewed deterministic template is the answer.
    if spend_conn is not None:
        spend_day = _today_dhaka().isoformat()
        if spend.get_calls(spend_conn, spend_day) >= max(settings.llm_daily_cap, 0):
            template_name, template_vars = _resolve_template_vars(intent, context_data, locale)
            reply = render(template_name, locale=locale, **template_vars)
            return OrchestratorResponse(
                reply=reply,
                intent=intent,
                evidence_labels={"narrative": "Data"},
                allowed_numbers=sorted(list(allowed_numbers)),
                generated_text=False,
                validator_passed=True,
                fallback_used=True,
            )
    else:
        spend_day = None

    # 3. OpenRouter LLM generation via the SLOT PROTOCOL: the model writes
    #    {{fK}} placeholders; the app substitutes trusted values. Any free
    #    digit or number word in the draft fails closed to the template.
    draft_reply, draft_is_generated = _generate_draft(
        cleaned_text, intent, context_data, locale, settings, facts,
        spend_conn=spend_conn, spend_day=spend_day,
    )

    if draft_is_generated and draft_reply:
        rendered = render_slots(draft_reply, facts)
        if rendered is not None:
            # Defense in depth: the substituted text must still be numerically
            # grounded in the verified context.
            val_res = validate_numbers(rendered, allowed_numbers)
            if val_res.passed:
                return OrchestratorResponse(
                    reply=rendered,
                    intent=intent,
                    evidence_labels={"narrative": "Generated text"},
                    allowed_numbers=sorted(list(allowed_numbers)),
                    generated_text=True,
                    validator_passed=True,
                    fallback_used=False,
                )
        # Fail closed! Use reviewed template instead
        template_name, template_vars = _resolve_template_vars(intent, context_data, locale)
        reply = render(template_name, locale=locale, **template_vars)
        return OrchestratorResponse(
            reply=reply,
            intent=intent,
            evidence_labels={"narrative": "Data"},
            allowed_numbers=sorted(list(allowed_numbers)),
            generated_text=False,
            validator_passed=False,
            fallback_used=True,
        )

    # 4. Template path (LLM unavailable / disabled / at the daily cap)
    template_name, template_vars = _resolve_template_vars(intent, context_data, locale)
    reply = render(template_name, locale=locale, **template_vars)
    return OrchestratorResponse(
        reply=reply,
        intent=intent,
        evidence_labels={"narrative": "Data"},
        allowed_numbers=sorted(list(allowed_numbers)),
        generated_text=False,
        validator_passed=True,
        fallback_used=True,
    )


def _resolve_template_vars(intent: str, ctx: dict[str, Any], locale: str) -> tuple[str, dict[str, str]]:
    """Map intent to pre-reviewed templates and formatted variables."""
    if intent == "greeting":
        return "greeting", {}

    if intent == "safe_spend":
        bal = format_taka(ctx.get("balance_paisa", 0), locale)
        safe = format_taka(ctx.get("safe_to_spend_paisa", ctx.get("balance_paisa", 0)), locale)
        daily = format_taka(ctx.get("daily_safe_budget_paisa", 0), locale)
        return "safe_spend", {
            "balance": bal,
            "safe_spend": safe,
            "daily_budget": daily,
        }

    if intent == "forecast":
        prob = ctx.get("shortfall_prob", 0.0)
        horizon = str(ctx.get("horizon_days", 14))
        if locale == "bn":
            horizon = to_bangla_digits(horizon)
        if prob > 0.3:
            return "forecast_risk", {
                "horizon": horizon,
                "shortfall_prob": format_probability(prob, locale),
                "trough_date": str(ctx.get("trough_date", "পরের সপ্তাহ" if locale == "bn" else "next week")),
            }
        else:
            return "forecast_safe", {
                "horizon": horizon,
                "min_balance": format_taka(ctx.get("min_balance_paisa", 0), locale),
                "trough_date": str(ctx.get("trough_date", "পরের সপ্তাহ" if locale == "bn" else "next week")),
            }

    if intent == "cashout":
        savings = ctx.get("replaceable_fee_saved_paisa", 0)
        return "cashout_audit", {
            "savings": format_taka(savings, locale),
        }

    if intent == "goal":
        target = ctx.get("target_paisa", 1000000)
        months = str(ctx.get("months", 6))
        if locale == "bn":
            months = to_bangla_digits(months)
        return "goal_plan", {
            "target_amount": format_taka(target, locale),
            "months": months,
        }

    if intent == "summary":
        inc = format_taka(ctx.get("monthly_income_paisa", 0), locale)
        spd = format_taka(ctx.get("monthly_spend_paisa", 0), locale)
        return "summary_income_spend", {
            "income": inc,
            "spend": spd,
        }

    return "general_help", {}


def _call_openrouter(
    user_message: str,
    intent: str,
    ctx: dict[str, Any],
    locale: str,
    settings: Settings,
    facts: list[tuple[str, str]] | None = None,
) -> str | None:
    if not settings.llm_api_key or not settings.llm_enabled:
        return None

    try:
        import httpx

        lang_name = "Bangla (বাংলা)" if locale == "bn" else "English"

        if facts:
            # SLOT PROTOCOL — the only permitted way for the model to use a
            # number. App code substitutes the trusted value afterwards.
            slot_lines = "\n".join(f"{{{{f{i + 1}}}}} = {k} = {v}" for i, (k, v) in enumerate(facts))
            system_prompt = (
                f"You are Sathi (সাথী), an empathetic AI financial copilot for mobile wallet users in Bangladesh. "
                f"Respond warmly and conversationally in {lang_name}, 2-3 sentences.\n"
                f"NUMBER SAFETY — SLOT PROTOCOL (mandatory):\n"
                f"- Refer to EVERY number ONLY through its slot token, exactly as written: {{{{f1}}}}, {{{{f2}}}}, ...\n"
                f"- NEVER write digits yourself (0-9 or ০-৯) and NEVER write number words (e.g. five thousand, পাঁচ হাজার).\n"
                f"- Do not mention field names like safe_to_spend_paisa. Use the slot token where the value belongs.\n"
                f"- If no slot fits, speak qualitatively (e.g. 'a few days').\n"
                f"SLOTS (verified values, inserted by the app):\n{slot_lines}"
            )
        else:
            context_lines = []
            for k, v in ctx.items():
                if not str(k).endswith("_raw"):
                    context_lines.append(f"- {k}: {v}")
            context_str = "\n".join(context_lines)
            system_prompt = (
                f"You are Sathi (সাথী), an empathetic and certified AI financial copilot for mobile wallet users in Bangladesh. "
                f"Respond politely and conversationally in {lang_name}. "
                f"Keep your response concise (2-3 sentences max). "
                f"CRITICAL SAFETY RULE: You must ONLY reference the exact numerical figures provided in the verified context below. "
                f"Never invent ungrounded numbers or make unauthorized investment guarantees.\n\n"
                f"VERIFIED CONTEXT:\n{context_str}"
            )

        headers = {
            "Authorization": f"Bearer {settings.llm_api_key}",
            "HTTP-Referer": "https://sathi.app",
            "X-Title": "Sathi Copilot",
            "Content-Type": "application/json",
        }

        payload = {
            "model": settings.llm_model or "openrouter/auto",
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_message},
            ],
            "temperature": 0.2,
            "max_tokens": 250,
        }

        base_url = getattr(settings, "llm_base_url", "https://openrouter.ai/api/v1").rstrip("/")
        endpoint = f"{base_url}/chat/completions"
        with httpx.Client(timeout=12.0) as client:
            resp = client.post(endpoint, headers=headers, json=payload)
            if resp.status_code == 200:
                data = resp.json()
                content = data.get("choices", [{}])[0].get("message", {}).get("content", "").strip()
                if content:
                    return content
    except Exception:
        pass
    return None


def _generate_draft(
    user_text: str,
    intent: str,
    ctx: dict[str, Any],
    locale: str,
    settings: Settings,
    facts: list[tuple[str, str]] | None = None,
    spend_conn: sqlite3.Connection | None = None,
    spend_day: str | None = None,
) -> tuple[str, bool]:
    """Generate draft via OpenRouter if active, otherwise fall back to template.

    Every real provider attempt (key present, provider configured) is counted
    in llm_spend for the given day; the cap itself is enforced by
    handle_message BEFORE any provider call. An attempt that returns None is
    still an attempt — it may have reached the provider.
    """
    if (settings.llm_enabled
            and settings.llm_provider in ("openai-compatible", "openrouter")
            and settings.llm_api_key):
        llm_reply = _call_openrouter(user_text, intent, ctx, locale, settings, facts)
        if spend_conn is not None and spend_day is not None:
            spend.increment(spend_conn, spend_day)
        if llm_reply:
            return llm_reply, True

    name, vars = _resolve_template_vars(intent, ctx, locale)
    return render(name, locale=locale, **vars), False

