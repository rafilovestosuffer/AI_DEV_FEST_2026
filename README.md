# Sathi (সাথী)

> **A Bangla-First AI Financial Copilot for Mobile-Wallet Users**  
> Built for **AI Hackathon 2026**, Track 03: *Customer Innovation & Financial Independence*  
> Organized by **DIU Computer and Programming Club (DIU-CPC)** × **উপায় (upay)**, Daffodil International University.

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/Platform-Android%20%7C%20Web-brightgreen.svg)]()
[![Python](https://img.shields.io/badge/Python-3.11+-blue.svg)]()
[![Frontend](https://img.shields.io/badge/Frontend-Next.js%2016%20%2B%20TypeScript-black.svg)]()
[![Shell](https://img.shields.io/badge/Mobile-Capacitor%20Android-blueviolet.svg)]()

> 🌐 **Live web app:** <https://sathi-pied.vercel.app> &nbsp;·&nbsp; 📱 **Android APK:** [Download from Releases](https://github.com/AdilShamim8/Sathi/releases/latest) &nbsp;·&nbsp; 🧪 Try it instantly with **“Explore with demo data”** on first launch

---

## 📸 App Screenshots

**Dashboard — Safe-to-Spend, shortfall risk & financial health** (live deployment, demo data):

<p align="center">
  <img src="docs/screenshots/dashboard.png" alt="Sathi dashboard — Safe-to-Spend, shortfall risk, financial health, goal progress" width="880">
</p>

**The five core views** — the Android APK and the website run the exact same code and show the exact same numbers:

| | | |
|:---:|:---:|:---:|
| **Home**<br>Safe-to-Spend & risk | **Spending**<br>Category intelligence | **Copilot**<br>Grounded Bangla chat |
| <img src="docs/screenshots/mobile-home.png" width="230"> | <img src="docs/screenshots/mobile-spending.png" width="230"> | <img src="docs/screenshots/mobile-copilot.png" width="230"> |
| **Cash Flow**<br>Forecast & pressure | **Goals**<br>Monte Carlo plans | **Insights**<br>Evidence-backed advice |
| <img src="docs/screenshots/mobile-cash-flow.png" width="230"> | <img src="docs/screenshots/mobile-goals.png" width="230"> | <img src="docs/screenshots/ui-06-insights.png" width="230"> |

<details>
<summary><b>📂 Full UI gallery</b> — onboarding, transactions, Bangla mode, salary & settings</summary>

| | | |
|:---:|:---:|:---:|
| <img src="docs/screenshots/ui-09-onboarding.png" width="210"> | <img src="docs/screenshots/ui-07-transactions.png" width="210"> | <img src="docs/screenshots/ui-08-bangla.png" width="210"> |
| <img src="docs/screenshots/ui-02-cashflow.png" width="210"> | <img src="docs/screenshots/ui-03-spending.png" width="210"> | <img src="docs/screenshots/ui-04-copilot.png" width="210"> |
| <img src="docs/screenshots/ui-10-settings.png" width="210"> | <img src="docs/screenshots/ui-11-txn-edit.png" width="210"> | <img src="docs/screenshots/ui-01-home.png" width="210"> |

</details>

---

## 1. Project Overview

Many low- and irregular-income mobile financial service (MFS) users have access to digital payments but lack financial control. Income arrives at one time while household obligations arrive at another; users discover shortfalls only in the last week of the month, forcing them into informal borrowing or skipping essentials. In addition, habitual small cash-outs lead to significant fee leakage while taking money off the digital trail.

**Sathi (সাথী)** turns transaction history into actionable tools that keep every financial decision strictly in human hands:

1. **Safe-to-Spend Today:** A single defensible number — wallet total minus commitments, essentials buffer and prorated savings — now computed **by the ML model** (rule baseline always kept beside it).
2. **Shortfall Forecasting:** LightGBM quantile forecasts ($p_{10}, p_{50}, p_{90}$) + calibrated balance-path simulation give a **calibrated probability** of running short before the next income arrives — never a misleading point estimate.
3. **Plain Bangla Copilot:** Ask in Bangla, Banglish or English; an LLM narrates deterministic engine results under a strict numeric validator that **fails closed** to templates.
4. **Natural-Language Capture:** `আজকে রিকশা ভাড়া ৮০ টাকা` becomes a parsed transaction with a preview before saving (100% amount + category accuracy on the labelled holdout).
5. **Feasible Goal Planning:** Monte Carlo savings paths with Wilson 95% intervals and three honest option types (goal date / monthly amount / probability).
6. **Cash-Out Conversion Audit:** Repeat-agent cash-outs mapped to digital-capable merchants with avoidable fees at the labelled rate.
7. **Salary-Aware Forecasting:** Optional salary amount + pay-day refines every projection.

### The Track 03 Big Question
> *"How might an MFS platform help customers become more financially confident and independent, not merely more active users?"*

Sathi's answer: **Empower the customer with foresight, clear trade-offs, and honest options, keeping all financial decisions strictly in human hands.** Sathi never moves money, never determines credit underwriting, and never nudges spending.

---

## 2. Key Features & AI Advantage

| Capability | How AI & Engineering Are Applied | Why a Simple Rule Is Insufficient |
| :--- | :--- | :--- |
| **Shortfall Forecasting** | LightGBM quantile regression (9 quantiles) on leakage-safe features + recurring-stream detection + calibrated path sampling | Fixed rules fail under lumpy income dates and volatile expenses. Honest benchmark position (frozen test, docs/eval_report.md T2): the model clearly beats the rule (Brier 0.024 vs 0.053, BSS +0.546) and the forecast band it needs, but only **ties the previous block-bootstrap** on the main test set (Brier 0.0240 vs 0.0236; bootstrap leads PR-AUC 0.410 vs 0.387 and recall at 60% precision). The model's edge is robustness: on the drifted cohort it wins (Brier 0.038 vs 0.041, PR-AUC 0.532 vs 0.476) and it degrades more slowly under feature noise. |
| **Safe-to-Spend** | Model-based daily budget from forecast paths (P(shortfall) = α by construction); rule formula kept as baseline | Static buffers ignore the user's actual income timing and upcoming obligations. |
| **Goal Feasibility** | Monte Carlo simulation over historical inflow/outflow distributions with Wilson 95% CI, **empirically recalibrated** (Platt, fitted on the frozen T6 back-test) | Simple "save 20%" rules ignore irregular timing and overestimate feasibility, leading to abandoned goals. Our own raw simulation was ~3–5× optimistic (stated 10.5% → realised 2.8%); every P(goal met) now ships through the recalibration (ECE 0.099 → 0.020) and never claims certainty. |
| **Bangla Copilot** | LLM orchestrator for intent routing and natural narration with a strict numeric validator | Translates complex figures into culturally native Bangla while strictly enforcing deterministic math. |
| **NL Transaction Capture** | Deterministic Bangla/Banglish/English parser (amount + category + merchant) with confirmation step | Typing forms is high-friction on low-end phones; free text is natural but must never guess wrong silently. |
| **Cash-Out Insights** | Deterministic transaction cluster analysis mapping recurring cash withdrawals to digital merchant rails | Accurately calculates true fee savings and digital retention potential. |

---

## 3. System Architecture & Tech Stack

```
          OFFLINE (Developers / CI — repo root, the "ML factory")
 data_gen/ ─► Seeded Dataset ─► ml/ (Features → Train → Calibrate → Evaluate T1–T7)
     │                              │
     └─► Demo Bundler ─► web/public/demo/*.json          promote (copy)
                                                           │
          ONLINE (Request Flow — web/, the deployable app) ▼
 Android APK (Capacitor) ──┐                       web/ml-artifacts/forecast/
 Web App (Next.js 16) ─────┼──► web/src/app/api — 35 routes · 45 handlers
        │                  │         │
        │  /api/v1/* — the reference Sathi contract (15 routes: personas,
        │             demo JWT, evidence blocks, fail-closed chat, user
        │             liquidity inputs, counterfactual actions)
        └──► web/src/lib/engine — pure deterministic TypeScript engines
                 │   (money, categorizer, simulation, planner, cashout,
                 │    safe-to-spend, LightGBM predictor, forecaster…)
                 └──► llm chain: sanitize → intent → context → LLM draft
                        → numeric validation → template fallback (fail-closed)

  Reference twin: `make run` serves the same v1 contract from the Python
  backend (api/ FastAPI) on :8000 — the app reproduces it bit-compatibly.
```

### Technology Stack
- **Web app (`web/`) — what the live deployment runs:** Next.js 16 App Router, React 19, TypeScript (strict), Tailwind CSS 4, Prisma (SQLite; optional libSQL/Turso adapter for durable serverless storage), and the **z-ai LLM SDK (`z-ai-web-dev-sdk`) for the deployed chat** (server-side only, wrapped in the fail-closed validator chain). The chat uses **slot-based narration**: the LLM may only reference numbers through `{{fK}}` tokens that the app replaces with trusted, pre-formatted values; any bare digit or number word (Bangla or English) in the draft fails closed to a reviewed template. **Optional OpenRouter** is available in-app for users who bring their own key (Settings → Online AI chat): the key stays on the device, calls go directly to openrouter.ai, and any failure falls back to the deterministic copilot. OpenRouter is not required for anything and is not part of the Vercel deployment.
- **Backend factory (repo root):** Python 3.11+, FastAPI, Pydantic v2 — the reference service and the training pipeline. Its LLM layer (`llm/orchestrator.py`, measured by `llm/pick_model.py`) supports OpenRouter-compatible providers via `LLM_*` env vars for self-hosted runs; it is offline-only and never served by Vercel.
- **Data & ML:** pandas, NumPy, LightGBM 4.6.0 (quantile loss, 9 quantiles), scikit-learn, SHAP
- **Storage:** SQLite (WAL mode) — `web/db` for the app, `data/` for the pipeline; hosted libSQL (Turso) supported for the app on serverless
- **Native Android Shell:** Capacitor (`web/android`, `com.upay.sathi`) loading the deployed app
- **CI/CD:** GitHub Actions — `backend-ci.yml` (pytest + data verification), `app-ci.yml` (TS tests, lint, type-check, build), `android-apk.yml` (release-signed APK + GitHub Release)

### Deploying (Vercel / self-hosted)

The app is serverless-ready: on a fresh or empty database it creates its own schema and seeds on first request (no `db push` needed).

1. Import this GitHub repo into Vercel with **Root Directory: `web`**.
2. Deploy — no environment variables required. Install (bun), build command and framework (Next.js) are auto-detected; `ml-artifacts/` is traced into the functions so model forecasts work.
3. **Keep every API route in one function group.** Vercel groups routes by their config — a route that alone sets `export const maxDuration` deploys as a *separate* serverless function with its *own* `/tmp`. That once broke the deployed Copilot: every other screen saw the user's data while `/api/copilot` queried an empty database ("copilot temporarily unavailable"). The route configs are now uniform by design (see invariant 10).
4. **How the database works on serverless:** `web/src/lib/db.ts` detects the Vercel environment and redirects the SQLite file to an auto-created writable copy under `/tmp` (the rest of the filesystem is read-only). `ensureSchema()` builds the tables on first request — zero-config cold start. Setting a `file:` `DATABASE_URL` on Vercel is redirected to `/tmp` automatically.
5. **Know the trade-off:** `/tmp` is per-instance and resets on cold starts — fine for a demo (one tap re-onboards with demo data), not for real users. **For durable hosted data, use Turso (free tier, SQLite dialect, no schema change):**
   1. Create a database at [turso.tech](https://turso.tech) → copy its `libsql://…` URL and a database token.
   2. In Vercel → Settings → Environment Variables, set `DATABASE_URL = libsql://…` and `DATABASE_AUTH_TOKEN = <token>`.
   3. Redeploy. `db.ts` detects the `libsql://` URL and switches Prisma onto the libSQL driver adapter (`@prisma/adapter-libsql`) — every instance now shares one durable database.
   Local development is unaffected (`file:` URLs keep using plain SQLite), and the adapter path is verified by `web/scripts/test-libsql-adapter.ts`.

Self-hosting stays as before:
```bash
cd web && bun install && bun run db:push && bun run build
DATABASE_URL=file:./db/custom.db PORT=3000 bun run start   # standalone server
```

The Android shell loads whichever deployment URL you set in `web/capacitor.config.json`.

---

## 4. Architectural Invariants (Non-Negotiables)

1. **LLM Never Computes Money:** The LLM only routes user intent and narrates engine results through slot tokens (`{{fK}}`) that the app fills with trusted values. All math is deterministic.
2. **Numeric Validator Fails Closed:** Every number emitted by the LLM is validated against engine outputs — digits (Bangla ০–৯ and English 0–9) *and* number words ("five thousand", "পাঁচ হাজার"); unverified figures fail closed to a deterministic Bangla template.
3. **Pure Core:** `core/` (Python) and `web/src/lib/engine/` (TypeScript) contain pure business logic with zero I/O, no database access, no network calls, and no clock reads.
4. **Integer Paisa:** Money is strictly integer paisa (`paisa`) throughout the backend, database, and client types.
5. **Display Strings Only:** The frontend renders read-only `display` strings generated by the server and never performs money arithmetic.
6. **Evidence Blocks:** All user insights include an `evidence` block with labelled figures (`Data`, `Prediction`, `Assumption`, `Generated`).
7. **Offline Core + Demo Resilience:** The mobile APK loads the live site by design; when the network is unreachable it retries with backoff, then opens the **offline core** — a self-contained page that carries each persona's bundled transaction history and runs the deterministic engines **on the device**: recurring-stream detection, a seeded block-bootstrap path simulation (200 paths, 5-day blocks), safe-to-spend (Q10 of the minimum balance minus the personal floor), a shortfall explanation built only from computed facts, and a goal Monte Carlo. No backend, no LLM, no internet is needed for that core experience; the page silently reconnects to the live app the moment `/api/v1/healthz` answers. (The LightGBM quantile forecaster runs online; offline, the bootstrap — the online fallback too — stands in, and the page says so.)
8. **No Hand-Typed Metrics:** every published number is generated by `ml/evaluate.py` and served verbatim from the artifacts.
9. **Leakage-Safe Features:** every model feature is computed strictly before the forecast origin — enforced by tests on both the Python and TypeScript sides.
10. **One Function Group on Serverless:** all API routes share identical route-level config (no per-route `maxDuration`/`memory`) so Vercel deploys them into a single function with a single `/tmp` database. A lone per-route override splits it into a separate instance with its own empty database — the exact failure that once made the deployed Copilot unavailable while every other screen worked.

---

## 5. Personas

Sathi is validated across 5 synthetic personas (see `config/personas.yaml`, ported to `web/src/lib/engine/sathiPersonas.ts`):
1. **Rina (Hero Persona):** Salaried garment worker with fixed monthly salary on the 7th, front-loaded obligations, and month-end liquidity squeeze.
2. **Remittance Household:** Irregular, lumpy inflows from overseas family members.
3. **Gig / Ride-Share Driver:** Daily volatile income with high-frequency fuel and maintenance outlays.
4. **Student:** Sporadic small family allowances with limited transaction history.
5. **Small Merchant / Shopkeeper:** Mixed personal and micro-business transactions with heavy cash dependency.

---

## 6. Repository Layout & Documentation Map

```
├── README.md                    # Project overview & quickstart (this file)
├── LICENSE                      # Apache 2.0 Open Source License
├── Makefile                     # Backend + web commands (verified)
├── requirements.txt             # Python dependencies (pinned)
├── sathi_config.py              # YAML config loader (fees, personas, risk…)
├── api/                         # Reference FastAPI service (v1 contract twin)
├── core/                        # Pure deterministic engines (money, planner,
│                                #   simulation, categorizer, cashout, metrics…)
├── llm/                         # Sanitizer → validator → orchestrator → templates
├── ml/                          # Training & evaluation: train, calibrate,
│                                #   evaluate (T1–T7), features, inference
├── config/                      # 8 YAML assumption files
├── data_gen/                    # Seeded synthetic generator + demo bundler
├── data/                        # Generated parquet panel + ground truth
├── tests/                       # 98 pytest tests (engines, API, data, forecast)
├── context/                     # Architectural specs & working guides
│   ├── Hackathon Rule Context/  #   Official DIU-CPC × upay hackathon documents
│   └── context/                 #   architecture, code-standards, ui-context…
├── docs/                        # eval_report.md (T1–T7), model-card.md,
│                                #   metrics/, diagrams/, screenshots,
│                                #   HACKATHON_COMPLIANCE.md (§13/§14/§15 matrix)
├── scripts/                     # Repo utilities (fixture gen, diagrams, smoke)
└── web/                         # ★ The deployable Next.js app
    ├── src/                     #   App Router UI (7 views, EN/বাংলা) + 35 API
    │                            #     routes incl. /api/v1/* (15 reference routes)
    ├── prisma/                  #   Schema (User, Transaction, Goal, Insight,
    │                            #     KnowledgeDoc, AuditEvent, ForecastRecord)
    ├── ml-artifacts/            #   Promoted model (9 boosters + calibration)
    ├── tests/                   #   102 TypeScript tests (parity, leakage, CRUD,
    │                            #     counterfactual actions)
    ├── scripts/                 #   App-side dev utilities
    ├── public/demo/             #   Offline persona bundles (5 personas)
    ├── android/                 #   Capacitor shell (com.upay.sathi)
    └── capacitor.config.json    #   APK points at the deployed URL
```

---

## 7. Requirements & Prerequisites

- **Python:** 3.11 or higher
- **Bun:** v1.1+ (or Node.js 20 with npm — commands below use bun)
- **Android SDK:** (Optional, for local APK builds; GitHub Actions handles CI builds)
- **Operating System:** Windows, macOS, or Linux

---

## 8. Installation & Setup

### 1. Clone the Repository
```bash
git clone https://github.com/AdilShamim8/Sathi.git
cd Sathi
```

### 2. Backend Setup (the ML factory — optional for running the web app)
```bash
python -m venv .venv
# On Windows:
.venv\Scripts\activate
# On Linux/macOS:
source .venv/bin/activate

pip install -r requirements.txt
```

### 3. Web App Setup (the deployable product)
```bash
cd web
bun install          # also runs `prisma generate`
cp .env.example .env # DATABASE_URL preconfigured (file:../db/custom.db)
bun run db:push      # create the SQLite schema (fresh DB auto-seeds on first load)
```

---

## 9. Environment Variables

**`web/.env`** (the Next.js app — copy from `web/.env.example`):

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | SQLite connection string (preconfigured to `file:../db/custom.db`, relative to `web/prisma/`) |
| `SATHI_ML_ARTIFACTS` | (optional) override the model artifacts directory; defaults to `./ml-artifacts/forecast` |
| `SATHI_OPENROUTER_API_KEY` | (optional) deployer's OpenRouter key — server-side fallback so chat replies get AI phrasing on deployments where the primary gateway has no credentials. Never exposed to the client; every draft still passes the fail-closed slot/grounding validators |
| `SATHI_OPENROUTER_MODEL` | (optional) model for the fallback above; defaults to `openrouter/auto` |
| (optional) AI gateway credentials | If absent, the copilot runs in deterministic mode — all features still work |

**`.env`** (repo root — the Python backend; copy from `.env.example`): `APP_ENV`, `DATABASE_URL` (python format `sqlite:///./data/sathi.db`), `AUTH_SECRET`, `ALLOWED_ORIGINS`, `LLM_*` (the backend works end to end with `LLM_ENABLED=false`).

> **Security Note:** Secrets and server keys are never committed to git or exposed to the client bundle.

---

## 10. Run and Build Commands

| Target | Command | Purpose |
| :--- | :--- | :--- |
| **Web Dev Server** | `make web-dev` (or `cd web && bun run dev`) | Start the Next.js app on :3000 |
| **Web Production Build** | `make web-build` | Standalone build in `web/.next/standalone` (ships `ml-artifacts/`) |
| **Web Tests / Lint** | `make web-test` / `make web-lint` | 102 TS tests / ESLint + type-check |
| **Backend Dev Server** | `make run` | Reference FastAPI v1 service on :8000 |
| **Dataset Generation** | `make data` | Seeded synthetic panel (2,000 users + 500 drifted) |
| **Train / Evaluate** | `make train` / `make eval` | 9-quantile boosters / T1–T7 metrics (offline only) |
| **Demo Bundles** | `make demo-bundle` | Regenerate `web/public/demo/*.json` |
| **Capacitor Android Sync** | `cd web && npx cap sync android` | Sync app assets into `web/android` |
| **Offline Page Regeneration** | `python3 scripts/gen_offline_page.py` | Rebuild `res/raw/offline.html` from `web/public/demo/*.json` |
| **Android APK Build** | GitHub Actions (`.github/workflows/android-apk.yml`) | Release-signed APK + GitHub Release |

---

## 11. Testing & Code Quality

```bash
# Backend test suite (root)
pytest                        # → 98 passed

# Backend lint & static analysis
ruff check . && mypy core api llm

# Web app tests, lint, type-check, build (web/)
cd web
bun test                      # → 102 passed (engines, ML parity, CRUD, slot protocol, number words, OpenRouter fallback, counterfactual actions)
bun run lint
bunx tsc --noEmit
```

**API smoke tests** (dev server running — all return 200):
```bash
curl localhost:3000/api/boot          # owner status (needsOnboarding + mode)
curl localhost:3000/api/summary       # snapshot + safe-to-spend + shortfall risk
curl localhost:3000/api/forecast      # forecast + ML risk + evidence + action cards
curl localhost:3000/api/metrics       # ML validation vs rule baseline + parser accuracy

# Sathi v1 API (reference contract, model-driven):
TOKEN=$(curl -s -X POST localhost:3000/api/v1/auth/demo-login \
  -H 'Content-Type: application/json' \
  -d '{"user_id":"garment_worker"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')
curl -H "Authorization: Bearer $TOKEN" localhost:3000/api/v1/me/forecast   # shortfall prob + safe_to_spend + daily_allowance + liquidity_basis + top_action
curl -H "Authorization: Bearer $TOKEN" localhost:3000/api/v1/me/summary    # safe_to_spend.method: "model" + liquidity_basis
curl -H "Authorization: Bearer $TOKEN" localhost:3000/api/v1/me/actions   # counterfactual actions ranked by delta P(shortfall)
curl -H "Authorization: Bearer $TOKEN" localhost:3000/api/v1/me/inputs    # current liquidity corrections
curl -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"cash_on_hand_taka": 2500, "income_day": 7, "other_liquid_taka": 1000}' \
  localhost:3000/api/v1/me/inputs                                        # correct the liquidity estimate (decays at observed burn)
curl -H "Authorization: Bearer $TOKEN" localhost:3000/api/v1/me/benchmark  # T1–T7 from the generated eval artifacts
```

**Liquidity model (P0):** total liquidity = **wallet balance + effective cash-on-hand + other user-declared liquid funds**. Cash-on-hand is estimated behaviorally from the cash-out rhythm and can be corrected by the user (`POST /v1/me/inputs`); a declaration holds for 14 days and then decays at the user's observed daily cash burn, so a stale entry never overstates liquidity. A cash-out is never treated as money vanishing — it leaves the wallet and re-enters the pocket estimate subject to burn. Every response carries a `liquidity_basis` block showing exactly which components were used and the cash provenance (`user-declared, decayed Nd` vs `estimated (cash-out rhythm)`).

**Counterfactual actions (P1):** `GET /v1/me/actions` ranks 2–3 candidate actions (trim the top trimmable category 20%, batch cash-outs — fee savings computed from the actual tariff, hold a one-week payday buffer) by rerunning the SAME simulated liquidity paths with each action's deterministic cash-flow delta and reporting the new P(shortfall). Suggestions only — the system never moves money. The forecast's `top_action` field carries the winner.

**Validation highlights** (generated, never hand-typed — `docs/eval_report.md`): forecaster Brier **0.024** vs rule **0.053** (BSS vs rule **+0.546**) — and, stated plainly: on the main frozen test the model **ties the previous block-bootstrap** (Brier 0.0240 vs 0.0236; bootstrap leads PR-AUC 0.410 vs 0.387 and recall at 60% precision 0.375 vs 0.236), while winning on the drifted cohort (Brier 0.038 vs 0.041, PR-AUC 0.532) and degrading more slowly under ±10–30% feature noise. Pinball improvement **+4.9%** over the best baseline, daily p10–p90 coverage **84.7%** (nominal 80%). **Rare-class caveat:** shortfall events occur in only **3.1%** of test user-weeks — Brier/PR-AUC values are small by construction, per-persona positives are sparse (shopkeeper 0.0%), and alert cutoffs are chosen on validation user-weeks; alert-level recall/precision carry wide error bars at this base rate. **Operating point (validation-chosen, applied untouched to the frozen test):** maximizing recall subject to precision ≥ 0.60 on validation gives model recall **0.236** @ precision 0.57 and bootstrap recall **0.278** @ precision 0.67 — the aspirational recall ≥ 0.80 @ precision ≥ 0.60 bar is **not attainable for any method at this class balance**, which is reported as-is rather than tuned away. Reliability: **ECE 0.012** (model) / 0.014 (bootstrap). On the **drifted cohort** the model leads everything: Brier **0.038** vs bootstrap 0.041 vs rule 0.066 (BSS vs rule **+0.415**), PR-AUC 0.532, and recall at 60% precision **0.460 vs 0.335** (bootstrap). Goal planner: raw simulation was **3–5× optimistic** (stated 10.5% → realised 2.8%; 27.6% → 5.1%); the shipped **Platt recalibration** brings ECE from **0.099 → 0.020** (T6). In-product classifier (frozen test users): ML Brier **0.056** vs simple-rule **0.066** (BSS **+15%**), PR-AUC **0.978** vs **0.879**. NL parser: **100%** amount / **100%** category on the labelled holdout. The TypeScript LightGBM predictor matches the Python booster **exactly** (9 models × 24 fixture rows, diff 0 — `web/tests/fixtures/lgb-predictions.json`).

---

## 12. Deliverables & Hackathon Roadmap

- **Live Web URL:** <https://sathi-pied.vercel.app> — deployed on Vercel (Root Directory `web`), zero-config serverless SQLite
- **Android APK:** [Download from Releases](https://github.com/AdilShamim8/Sathi/releases/latest) — `sathi-<version>.apk`, release-signed by CI on every `v*` tag. The shell loads the live deployment; if the network is blocked it retries with backoff, then falls back to the **offline core** — 5 sample personas with their bundled transaction histories and the deterministic engines running on-device (see invariant 7) — and reconnects automatically.
  - **Updating:** since v6.2.0 the APK is signed with a stable release key, so future versions install directly over the old one — no uninstall, no data loss. (Moving from a pre-v6.2.0 debug build to the release key requires **one final uninstall**.)
  - **Note for Bangladeshi networks:** some providers intermittently block `*.vercel.app`. The app is immune in demo mode and auto-reconnects; for a fully unblocked experience, map a custom domain to the Vercel project (Settings → Domains).
- **Compliance matrix:** [`docs/HACKATHON_COMPLIANCE.md`](docs/HACKATHON_COMPLIANCE.md) — §13 Product Readiness, §14 Responsible AI & Safety, §15 Evaluation, with an evidence pointer for every line
- **Build window (T+0 disclosure):** all product code in this repository was authored **2026-10-02 → 2026-10-04**, inside the hackathon's initial development window (T+0 → T+72h per the official guideline; the final hours were a requirements-audit fix pass: user liquidity inputs, counterfactual actions, slot-based LLM narration, and the on-device offline core). The pushed history contains 74 commits in total — 50 of them the granular product-development sequence from the initial working-product upload `66f0be4` onward — all dated 2–4 Oct 2026; earlier local iteration was consolidated into `4ae2dde` ("feat(v6.0): refactor monorepo…") during a repository restructure — the consolidated tree is the same work, and no substantially completed solution prepared before T+0 was reused (rule 4.3). Only general-purpose open-source libraries and the documented third-party services in [`docs/third_party.md`](docs/third_party.md) are pre-existing components (rule 4.3 permits these).
- **Responsible AI:** synthetic data only (no real PII; every ML number labelled SIMULATED); LLM guardrails (numeric grounding, deterministic fallback, no autonomous decisions); model guardrails (leakage-safe features enforced by test, held-out calibration, fail-closed serving); `audit_events` records every capture, forecast and query
- **Submission Milestone:** demo video + technical report at T+66h

---

## 13. License & Attribution

- **License:** Apache License 2.0 — see [LICENSE](LICENSE) for details.
- **Academic & Competition Context:** Developed for AI DEV FEST 2026 AI Hackathon by DIU-CPC and upay.
- **Third-Party Libraries & AI Disclosures:** Documented in [`docs/third_party.md`](docs/third_party.md) per Hackathon Rulebook §4.4.
- **Design & Code Lineage:** UI/UX inspired by Origin (useorigin.com) design language. All engines (Python reference `core/`+`ml/`+`llm/` and the TypeScript port in `web/src/lib/engine/`) were written for this submission inside the hackathon window (see the T+0 disclosure in §12); the TypeScript side is a faithful port of the Python reference developed alongside it in this repository. All data is synthetic.
