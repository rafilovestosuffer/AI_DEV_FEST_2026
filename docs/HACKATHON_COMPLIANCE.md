# Sathi — Hackathon Compliance & Verification Matrix

> **Purpose.** This document maps every line of the hackathon's **§13 Product Readiness**, **§14 Responsible AI & Safety**, and **§15 Evaluation Framework** to concrete, checkable evidence inside this repository — written to be read by a judge or a senior reviewer, and re-verified by the commands in §6.
>
> **Status:** v6.0 (template layout: Python factory at repo root, Next.js app in `web/`) · model `fc-2026-09-30-15d8427d` · 102 TypeScript + 98 Python tests green (both enforced in CI) · all 31 smoke checks passing · owner-scoped product API with full CRUD + reset.

---

## 1. §13 — Product Readiness Checklist

| # | Requirement | Status | Evidence (where to look) |
|---|---|---|---|
| 1 | **User problem is frequent or economically meaningful** | ✅ Covered | Month-end shortfall from income/expense **timing mismatch** is the daily reality of irregular-income MFS users (garment workers, gig riders, remittance households). Habitual agent cash-outs leak 1.5% (min ৳5) per withdrawal. See `README.md` §1, the five personas in `web/src/lib/engine/sathiPersonas.ts` (ported from `config/personas.yaml`), and `docs/diagrams/architecture.png`. |
| 2 | **AI adds value beyond a simple deterministic rule** | ✅ Covered | Model Brier **0.024** vs rule baseline **0.053** (skill +54.6%). Early-warning alerting, stated honestly per method at its validation-chosen cutoff: the model recalls **50%** of shortfall weeks (precision 0.32 at cutoff 0.15); the previous block-bootstrap baseline recalls **29%** (precision 0.64 at cutoff 0.25); the simple rule's recall is actually **66.7%** — but it buys that by over-alerting, at a Brier **2.2× worse** than the model's (0.053 vs 0.024) and PR-AUC 0.228 vs 0.387. Ablation (T5): removing recurring-stream timing degrades Brier 0.024 → 0.0263 — the model weighs timing, obligations and volatility together in a way rules cannot. `docs/metrics/benchmark.json`, `docs/metrics/eval.json` §T2/T5, served live at `/api/v1/me/benchmark`. |
| 3 | **There is a clear action after the prediction or recommendation** | ✅ Covered | Every risk surface ends in decisions: **3 action cards with simulated impact** on `/api/forecast` (POST) and the CashFlow view; **3 honest goal options** (Monte Carlo + Wilson 95% CI) on `/api/v1/me/goal-plan`; **cash-out fee audit** naming repeat agents, replaceable withdrawals and avoidable ৳ at the labelled rate. Actions are options with trade-offs — never auto-executed. |
| 4 | **The business benefit can be measured** | ✅ Covered | (a) Avoidable fees per user — deterministic, auditable (cashout engine); (b) early-warning recall/precision at a fixed cutoff — reported in `eval.json` §T2; (c) plan realism — goal-planner back-test: raw ECE **0.099** → **0.020 after the shipped Platt recalibration** over 175 users × 875 goals (§T6); (d) every served prediction is persisted (`ForecastRecord`) so a pilot can score realized outcomes against predicted probabilities. |
| 5 | **The model can be validated with future real-world data** | ✅ Covered | `ForecastRecord` stores probability, pressure, factors and `model_version` per prediction — the scoring dataset for future outcomes. The full re-training + re-evaluation pipeline is reproducible (`make data && make train && make eval` from the repo root); evaluation splits are **by user**, never by row. Schema: `web/prisma/schema.prisma`; pipeline: root `Makefile`. |
| 6 | **Privacy, fairness, explainability, and security can be addressed** | ✅ Covered | See §2 below — each principle has its own evidence row: synthetic-only data (privacy), T3 persona + income-band audit (fairness), SHAP + reason traces + evidence blocks (explainability), injection sanitizer + numeric validation + rate limits (security). |
| 7 | **The system can integrate into a real digital-service workflow** | ✅ Covered | The `/api/v1/*` surface reproduces the reference backend contract exactly (`{data, evidence}` envelope, paisa ints, bn display strings, HMAC demo tokens, sliding-window rate limits) — the original clients and test-suite run unmodified. Android shell + APK CI at `web/android/`, `.github/workflows/`. |

### Post-Hackathon Pathway — where Sathi stands

| Stage | Outcome | Sathi's position |
|---|---|---|
| 1. Competition | Prototype + pitch + evidence | **This repository** — working app, generated metrics, model card, compliance matrix. |
| 2. Technical review | Model quality, architecture, security, feasibility | **Ready** — model card (`docs/model-card.md`), T1–T7 eval (`docs/eval_report.md`), 102 + 98 tests, bit-identical serving proof (`web/tests/fixtures/lgb-predictions.json`), layered architecture diagrams (`docs/diagrams/`). |
| 3. Business review | Customer value, strategic relevance, economics | **Ready** — Track 03 framing (customer innovation & financial independence); measurable levers: fee leakage, shortfall avoidance, savings follow-through. |
| 4. Controlled validation | Access to suitable governed data | **Designed for it** — synthetic-only now; retraining/evaluation is one command on governed data; predictions already persisted for outcome scoring. |
| 5. POC | Test with real operational context | **Deployable** — fail-closed serving (rule/bootstrap fallback), reference-compatible API, container/CI assets. |
| 6. Pilot assessment | Measure impact, risk, scalability, adoption | **Instrumented** — Brier/coverage monitoring per cohort (T3/T4 patterns), drift checks (drifted-cohort row in `eval.json`), audit trail. |
| 7. Next decision | Integrate, incubate, partner, or close | Decision point — evidence base is in place. |

---

## 2. §14 — Responsible AI & Safety Requirements

| Principle | Minimum expectation | How Sathi implements it | Verification |
|---|---|---|---|
| **Privacy** | Use only synthetic/public/self-generated data during the hackathon | Seeded mulberry32 PRNG generators for all personas; documented injected patterns (`web/src/lib/engine/synthetic.ts`, `data_gen/`); no real PII anywhere; every ML number labelled **"SIMULATED — synthetic data only"**. **v4:** onboarding asks the owner's name and demo data is an explicit opt-in choice; a double-confirmed **Reset / delete all data** wipes the owner account completely. **Data location, stated precisely:** in the deployed Vercel configuration the database is a per-instance server-side SQLite under `/tmp` (README §3 documents this trade-off and the Turso/libSQL option for durable hosted data); in the APK the chat history and the optional OpenRouter key stay in device-local storage. What leaves the device is bounded either way: only the copilot question plus already-computed aggregates reach the server-side LLM (fail-closed, 20 s timeout), and the optional OpenRouter path sends the user's own key plus computed aggregates directly to openrouter.ai only when the user explicitly enables it | `eval.json` `label` field; README §5b + §Responsible AI; `/api/v1/me/benchmark` serves the label verbatim; Settings → Data & privacy in the shipped UI |
| **Explainability** | Show the main reasons behind important predictions | (a) SHAP global + per-example attributions (T7) — top drivers: user scale 30.7%, income-gap share 22.4%, day-of-month 10.5%; (b) per-transaction **categorizer reason traces** (rule id + bn/en text); (c) **evidence block on every response** — factors, assumptions, model version, config hash; (d) "Why this risk level?" in the CashFlow view | `eval.json` §shap; `/api/v1/me/transactions` reason traces; any `/api/v1/me/*` response's `evidence` block |
| **Fairness** | Check whether the model behaves differently across relevant groups | T3 fairness audit: Brier / PR-AUC / coverage / reliability **per persona** (garment, gig, remittance, shopkeeper, student) and **per income band** (under-15k, 15k–25k, 25k–40k). Differences are reported, not hidden (e.g. garment worker Brier 0.0296, PR-AUC 0.690 vs overall 0.024 / 0.387 — rare-event base rate differs by cohort) | `eval.json` §shortfall.per_persona / per_income_band; `docs/eval_report.md` §T3 |
| **Security** | Consider adversarial manipulation, prompt injection, data leakage, access control | 14 prompt-injection patterns (EN + বাংলা) + NFC normalization at the chat boundary; **numeric parity validation** on every LLM draft (Bangla digits + comma normalization); HMAC-signed demo tokens (24 h); per-token sliding-window rate limits; **leakage-safe features enforced by test** (no persona/id/ground-truth/future data — `web/tests/sathi-ml.test.ts`); no secrets committed | `web/src/lib/engine/llmSafety.ts`; `web/src/lib/server/sathiApi.ts`; test suite |
| **Human oversight** | High-impact actions allow appropriate human review | No money ever moves — actions are **options with quantified trade-offs** the user chooses; low-confidence NL parses require confirmation before saving; every LLM interaction and significant engine decision is appended to `AuditEvent` | `web/src/app/api/transactions` (confirmation flow); `web/prisma/schema.prisma` AuditEvent |
| **Transparency** | Clearly separate predictions, assumptions, and generated explanations | Every number carries: `method` (model / rule / bootstrap), `model_version`, labelled assumptions, and an `llmEnhanced` flag separating engine output from LLM phrasing; baselines are served **beside** the model, never hidden | `/api/v1/me/summary` (`method`, `rule_safe_to_spend_*`), `/api/v1/me/forecast` (`method`, `model_version`) |
| **No harmful automation** | Do not autonomously approve/deny consequential financial decisions | The product informs only: it never approves, denies, blocks, or moves money; the LLM cannot alter numbers (validator discards mismatches); goal plans present honest options including "not feasible" | `web/src/lib/engine/orchestrator.ts` fail-closed path; planner's 3 option types |

---

## 3. §15 — Evaluation Framework (judge's rubric)

| Criterion | Weight | What good looks like | Sathi's answer |
|---|---|---|---|
| **Problem relevance** | 20% | Solves a real and meaningful customer/business problem | Month-end shortfall + fee leakage for irregular-income MFS users — frequent (monthly cycle), economically meaningful (fees + forced borrowing), and underserved (raw transaction lists). Track 03: customer innovation & financial independence. |
| **AI/ML depth** | 20% | AI is material to the solution and technically credible | LightGBM 9-quantile direct multi-horizon forecaster; split-conformal widening + within-week correlation ρ=0.4 + Platt recalibration fitted on held-out users only; 30 leakage-safe scale-free features (one global model, all income levels); **bit-identical TypeScript serving** verified against the pinned Python lightgbm (4.6.0) on a 24-row × 9-model fixture; full T1–T7 suite. |
| **Business/customer impact** | 20% | Clear, measurable value and plausible economics | A daily safe-to-spend number; 7-day early warning (model recall 50% at precision 0.32; the bootstrap baseline trades to 29% recall at 0.64 precision, and the rule's 66.7% recall comes from over-alerting at 2.2× worse Brier); named avoidable fees per user; goal plans with empirically recalibrated confidence (back-test ECE 0.099 → 0.020 after Platt calibration). All four are measurable in a pilot via `ForecastRecord` + audit trail. |
| **Prototype quality** | 15% | Working end-to-end experience, not only slides | Production Next.js 16 build; 45 method handlers across 35 routes; 102 TS + 98 Python tests (both run in GitHub Actions CI); bilingual UI (7 views) with evidence everywhere; Android APK CI; demo personas login. Verify: §6 commands below. |
| **Innovation** | 10% | Distinctive insight or differentiated product idea | Focus on **cash-flow timing**, not budgeting; "who computes what" AI split with a numeric-parity fail-closed LLM; model-based safe-to-spend from simulated liquidity paths (Q₀.₁₀ − personal floor) with the rule baseline always visible. |
| **Scalability & integration** | 10% | Believable path toward real systems and future data | Reference-compatible v1 API; Prisma (SQLite → Postgres swap is a config change); artifacts pinned by config hash and traced into standalone builds; retraining pipeline reproducible on governed data; drift + noise robustness rows already measured. |
| **Responsible AI & security** | 5% | Privacy, explainability, fairness, safety considered | The entire §2 table above — implemented and testable, not just stated. |

---

## 4. Effort Split — where the 50 / 20 / 15 / 10 / 5 lives

| Area | Share | Concrete deliverables (files you can open) |
|---|---|---|
| **Cash-flow + Forecast + Safe-to-spend** | **50%** | `web/src/lib/engine/`: `safeToSpend.ts` (model-based Q₀.₁₀ − floor, + rule), `forecaster.ts` + `lightgbm.ts` + `liquidity.ts` + `panel.ts` (model serving), `recurringStreams.ts` + `cashOnHand.ts` (v2), `simulation.ts` (block bootstrap), `forecast.ts` (baseline + backtest), `ml.ts` (risk classifier + validation). Views: Home hero, CashFlow (day-by-day + WHY + actions). APIs: `/api/summary`, `/api/forecast`, `/api/v1/me/{summary,forecast,benchmark}`. Training/eval: `ml/` (offline Python pipeline) + `web/ml-artifacts/` (served model). Tests: the majority of `web/tests/sathi-ml.test.ts` (LightGBM parity, path invariants, leakage, safe-to-spend α-property). |
| **Explainability + Evidence** | **20%** | Evidence blocks on **every** v1 response (`web/src/lib/server/sathiApi.ts` evidence builder); categorizer reason traces; SHAP T7 in `eval.json` + `docs/model-card.md`; `/api/v1/me/benchmark` serving **generated artifacts only** (no hand-typed metrics — a merge-commit guarantee); "Why this risk level?" factor list + Model-health panel with reliability chart in the Insights view; `docs/diagrams/ai-layers.png`. |
| **Goal planning + Scenario simulation** | **15%** | `web/src/lib/engine/planner.ts` (Monte Carlo, 2,000 paths, common random numbers, Wilson 95% CI, 3 honest option types, Platt recalibration of P(goal met) fitted on the frozen T6 back-test); `goals.ts` + `simulation.ts` what-if engine; `/api/goals/{analyze,simulate}`, `/api/v1/me/goal-plan`; T6 back-test (175 users, 875 goals, ECE 0.099); Goals view with scenario cards; action simulation on `/api/forecast` POST. |
| **Bangla AI / RAG / conversational UX** | **10%** | `nlp.ts` (Bangla/Banglish/EN parser, Bangla digits, word-boundary matching — 100%/100% holdout accuracy); `copilot.ts` (10 intents) + `orchestrator.ts` + `templates.ts` (13 × bn/en); `knowledge.ts` (BM25-lite RAG over 10 cited docs); `/api/v1/chat` + `/api/copilot` with sanitizer → numeric validator → fail-closed fallback; bilingual UI with Bangla digit formatting. |
| **UI polish / extra features** | **5%** | Origin-inspired design system (cream/ink/leaf, iOS-style shadows, press feedback, Framer Motion), salary bottom-sheet (explicit user ask), EN⇄বাংলা toggle, Capacitor Android shell + APK workflow, persona picker. |

---

## 5. Honest limitations (read before judging the numbers)

1. **All metrics are SIMULATED** — computed on the seeded synthetic panel (2,000 users + 500 drifted). The label is carried in every artifact and API response; real validation requires governed data (pathway stage 4).
2. **Overall PR-AUC is 0.387** because shortfall events are rare (base rate 3.1%) — per-persona PR-AUC is the fairer read (garment worker 0.690). We report both.
3. **Brier vs the previous bootstrap is a wash overall** (0.0240 vs 0.0236, −1.95% skill) — the model's edge over bootstrap appears under drift (0.0384 vs 0.0413, +7.1%) and over the rule everywhere (+54.6%). Both comparators are always served.
4. **Precision at the 0.15 cutoff trades down** (0.32) for recall (0.50) — a deliberate early-warning posture; the cutoff is derived from validation data, not tuned on test.
5. **SQLite single-writer** is a demo-scale choice; Prisma makes the Postgres swap a connection-string change.

---

## 6. Verification log — re-run everything

> Both suites are enforced on every push / PR by GitHub Actions:
> `backend-ci.yml` runs the 98 pytest tests plus seeded-data determinism + demo-bundle
> verification from the repo root; `app-ci.yml` runs the web job (102 TS tests → lint →
> type-check → build) inside `web/`. Green CI on the repo is the standing proof of the claims below.

```bash
# 1. Install & run the product (web/)
cd web
bun install && bun run db:push && bun run dev      # → http://localhost:3000

# 2. TypeScript quality gates (web/)
bun run lint          # ESLint — clean
bun run test          # 102 tests pass (engines, LightGBM parity, leakage, personas, CRUD, counterfactual actions)
bun run build         # production build, 35 API routes

# 3. Python backend factory (repo root)
cd ..
pip install -r requirements.txt -r requirements-dev.txt
export DATABASE_URL=sqlite:///./data/sathi.db
rm -f data/sathi.db          # force fresh dataset load
pytest -q                    # → 98 passed

# 4. Endpoint smoke (server running)
curl -s localhost:3000/api/boot | head -c 200
curl -s localhost:3000/api/summary | head -c 200
TOKEN=$(curl -s -X POST localhost:3000/api/v1/auth/demo-login \
  -H 'Content-Type: application/json' -d '{"user_id":"garment_worker"}' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')
curl -s -H "Authorization: Bearer $TOKEN" localhost:3000/api/v1/me/forecast | head -c 300
curl -s -H "Authorization: Bearer $TOKEN" localhost:3000/api/v1/me/benchmark | head -c 300

# 5. Regenerate every figure in this document
python scripts/diagrams/render_diagrams.py    # → docs/diagrams/*.png
```

**Latest run (v6.0, template-layout release):** tsc clean · ESLint clean · 102/102 TS tests (from `web/`) · 98/98 Python tests (from repo root) · production build compiled (35 routes) · cold-start E2E on a fresh SQLite (schema self-created, persona seeded, forecast served with `method = lightgbm-quantile + recurring streams + calibrated paths` from `web/ml-artifacts/`) · all 4 architecture diagrams regenerated deterministically.
