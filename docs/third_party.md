# Third-Party Components & AI Tool Disclosure

*Mandatory disclosure in compliance with AI DEV FEST 2026 Rulebook §4.4 and §9.2.*

*Versions below are read directly from the manifests — `requirements.txt` / `requirements-dev.txt` (Python backend factory at the repo root) and `web/package.json` (the deployed app) — not from memory. `^` ranges resolve at install time; the resolved versions used during development were Next.js 16.1.x, React 19.x, z-ai-web-dev-sdk 0.0.18.*

---

## 1. Open-Source Libraries & Frameworks

### 1a. Python — the offline ML factory & reference backend (repo root)

| Dependency | Version / License | Purpose |
| :--- | :--- | :--- |
| **FastAPI** | `0.116.1` (MIT) | Reference backend API framework (offline factory; never served by the deployment) |
| **Uvicorn** | `0.34.2` (BSD-3-Clause) | ASGI server for local/CI runs of the reference service |
| **Pydantic** / pydantic-settings | `2.11.4` / `2.10.1` (MIT) | Runtime data validation and OpenAPI schemas |
| **PyYAML** | `6.0.2` (MIT) | Loads the 8 YAML assumption/config files |
| **NumPy / pandas / PyArrow** | `2.2.5` / `2.3.2` / latest (BSD-3 / BSD-3 / Apache-2.0) | Synthetic panel generation, features, evaluation |
| **LightGBM** | `4.6.0` (MIT) | Quantile gradient-boosted tree training (9 quantiles); the pinned version the TypeScript predictor is verified against |
| **scikit-learn** | `1.7.2` (BSD-3-Clause) | Calibration / evaluation utilities |
| **SHAP** | `0.51.0` (MIT) | Global + per-example feature attributions (T7) |
| **matplotlib** | `3.11.2` (BSD-style "Matplotlib" license) | Reliability diagram (`docs/metrics/reliability.png`) |
| **httpx** | `0.28.1` (BSD-3-Clause) | API test client |
| **PyJWT** | unpinned 2.x (MIT) | HMAC-SHA256 demo authentication tokens |
| Dev tooling | `pytest`, `hypothesis`, `ruff`, `mypy` (MIT / Apache-2.0) | 98-test backend suite, lint, static types |

### 1b. Web app — what the live deployment runs (`web/`)

| Dependency | Version / License | Purpose |
| :--- | :--- | :--- |
| **Next.js** | `^16.1.1` (MIT) | App Router UI + API routes (35 routes / 45 handlers) |
| **React / React DOM** | `^19.0.0` (MIT) | UI component runtime |
| **TypeScript** | `^5` (Apache-2.0) | Strict-mode source language (`tsc --noEmit` in CI) |
| **Tailwind CSS** (+ `@tailwindcss/postcss`, `tw-animate-css`) | `^4` (MIT) | Styling system |
| **Prisma / @prisma/client** | `^6.11.1` (Apache-2.0) | SQLite schema + data access (`web/prisma/schema.prisma`) |
| **@libsql/client** + **@prisma/adapter-libsql** | `^0.18.0` (MIT) + `6.16.2` (Apache-2.0) | Optional Turso/libSQL driver adapter for durable serverless storage (`web/scripts/test-libsql-adapter.ts`) |
| **@tanstack/react-query** | `^5.82.0` (MIT) | Client data fetching/caching |
| **framer-motion** | `^12.23.2` (MIT) | UI motion |
| **lucide-react** | `^0.525.0` (ISC) | Icon library |
| **Radix UI** (`@radix-ui/react-toast`) | `^1.2.14` (MIT) | Accessible toast primitives |
| **clsx / class-variance-authority / tailwind-merge** | `^2.1.1` / `^0.7.1` / `^3.3.1` (MIT / Apache-2.0 / MIT) | Class-name utilities |
| **Capacitor** (`core` / `cli` / `android`) | `^6.2.0` (MIT) | Native Android WebView shell (`com.upay.sathi`) |
| **z-ai-web-dev-sdk** | `^0.0.18` (ISC) | LLM gateway SDK for the deployed chat — imported server-side only (`/api/v1/chat`, copilot narration), always wrapped in the fail-closed slot/numeric validator chain |
| Dev tooling | Bun (test runner), `eslint ^9` + `eslint-config-next`, `@types/react ^19`, `bun-types` | 102-test TS suite, lint, type-check in CI |

---

## 2. Bundled Fonts & Visual Assets
| Asset | Source / License | Notes |
| :--- | :--- | :--- |
| **Hind Siliguri** | Google Fonts (OFL) | Primary Bangla typography bundled locally |
| **Inter** | Google Fonts (OFL) | Primary Latin numbers and UI typography |
| UI design language | inspired by Origin (useorigin.com) | Re-implemented; no Origin code or assets are bundled |

---

## 3. External Services & APIs

| Service | Cost / plan | Role in Sathi |
| :--- | :--- | :--- |
| **Vercel** | Free (Hobby) tier | Hosts the live deployment: **https://sathi-pied.vercel.app** (Root Directory `web`, zero-config serverless SQLite; `ml-artifacts/` traced into the functions) |
| **z-ai LLM gateway** (via `z-ai-web-dev-sdk`) | Included platform gateway | Server-side chat narration for the deployed Copilot. Optional by design: without gateway credentials the copilot answers deterministically from templates — every feature still works |
| **OpenRouter API** | Pay-per-use — **the user's own key** | Optional in-app "Online AI chat" (Settings): the key stays in device-local storage, calls go directly from the device to `openrouter.ai/api/v1/chat/completions` (default model `openrouter/auto`), and any failure falls back to the deterministic copilot. Not required for anything and not part of the Vercel deployment. The Python factory's LLM layer (`llm/orchestrator.py`) can also target OpenRouter-compatible providers via `LLM_*` env vars for self-hosted runs |
| **Turso (libSQL)** | Free tier available | Optional durable hosted SQLite for serverless: set `DATABASE_URL=libsql://…` + `DATABASE_AUTH_TOKEN` and `db.ts` swaps Prisma onto the libSQL adapter. The public demo runs on per-instance `/tmp` SQLite (documented trade-off in README §3) |

---

## 4. AI Coding Assistants & Models
In compliance with Rulebook Section 4.2 and Section 9.2:
- **AI Coding Assistant:** Google DeepMind Antigravity AI Agent (Powered by Gemini) was utilized during pair programming for scaffolding, code generation, and test creation.
- **ML work (forecaster, evaluation, generator realism):** Anthropic Claude Code (Claude Opus) assisted the ML owner with code changes under `ml/`, `core/`, `data_gen/`. Every metric is produced by `python -m ml.evaluate`; none were written by the assistant.
- **In-App LLM Runtime** — three layers, in fail-closed order:
  1. **Deterministic template engine** (zero external cost, zero key dependency) — the fallback that always answers; every number comes from the pure engines.
  2. **z-ai gateway (deployed chat)** — server-side narration through `z-ai-web-dev-sdk` under the slot protocol: the model may only reference figures through `{{fK}}` tokens that the app fills with pre-formatted engine values; any bare digit or number word (Bangla ০–৯ or English) fails closed to a reviewed template.
  3. **Optional OpenRouter (BYO key)** — user-enabled, device-held key, direct calls; never required, never server-side in the deployment.
