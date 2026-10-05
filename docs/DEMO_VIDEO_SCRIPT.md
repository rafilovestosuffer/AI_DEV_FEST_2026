# Sathi (সাথী) — Demo Video Script (3 min 45 s)

**Rulebook §7.2 checklist:** demonstrate how the implemented idea works ✓ · explain the features and AI components implemented ✓ · describe real-life impact / practical value ✓.

| | |
|---|---|
| **Runtime target** | 3:30–3:50 (hard cap 4:00) |
| **Primary capture** | Live web app — <https://sathi-pied.vercel.app> — screen-recorded in a mobile viewport (430×932, Chrome device mode) or on a real Android phone |
| **Secondary capture (B-roll)** | Android APK (`sathi-v6.3.0.apk` from GitHub Releases) on a physical device: launch → offline core with airplane-mode on → auto-reconnect |
| **Persona used throughout** | Garment worker "Rina Begum" (demo persona) — example on-screen values below are from this persona; **always read the live numbers from the screen**, never voice a number you cannot see |
| **Language** | Voiceover in English; on-screen product text switches to বাংলা where quoted — the app is fully bilingual |
| **Lower-third captions** | Keep every metric caption identical to what is on screen; add "SIMULATED — synthetic demo data" whenever a model number is shown |

---

## Shot list

### Shot 1 — The hook: Rina's month-end problem (0:00 – 0:22)

- **Visual:** Slow B-roll or stills: a garment factory gate, a hand counting cash, an MFS agent shop, a phone showing a long raw transaction list. End on the empty wallet balance screen.
- **Voiceover (EN):** "This is Rina. Her salary lands on the 7th of every month. Her rent, her bills, her family's needs stretch across the whole month. Around the 28th, the wallet runs dry — and she only finds out when it's already too late. Her wallet app can show her a list of transactions. It cannot answer the only question she has: *will I run short before my next salary?*"
- **On-screen text (bn):** "মাসের শেষ সপ্তাহে টাকা শেষ — কিন্তু কেন?" ("Money runs out in the last week — but why?")

### Shot 2 — Onboarding (0:22 – 0:42)

- **Screen:** Open <https://sathi-pied.vercel.app> fresh (or use Reset in Settings). Onboarding asks the owner's name, then offers two explicit choices: a personal ledger, or demo data.
- **Action:** Tap the demo card **"ডেমো ডেটা দিয়ে ঘুরে দেখুন"** ("Explore with demo data") and pick the **garment worker** persona. Toast: "Welcome!"
- **Voiceover:** "Sathi — সাথী means *companion*. It runs instantly in the browser or as an Android app, in Bangla and English. One tap loads a demo persona — a synthetic garment worker whose wallet history looks like Rina's. No sign-up, no bank connection, and all demo data is clearly synthetic."

### Shot 3 — Home: one defensible number (0:42 – 1:10)

- **Screen:** Home view. Point at the hero: **Safe-to-Spend · next 7 days**, the daily budget line, the shortfall-risk badge, and cash-on-hand.
- **Voiceover:** "The home screen answers today's question first: *how much can I safely spend today?* This number is not a static buffer — it is computed from simulated liquidity paths of the next three weeks: wallet plus estimated cash-on-hand, minus upcoming commitments learned from her recurring streams, minus a safety buffer and prorated savings. Under the hood it's a quantile of the simulated minimum balance — and the plain rule-based formula is always kept beside it, so you can compare."
- **On-screen (read aloud):** the safe-to-spend amount and the daily allowance (example from this persona: safe-to-spend ≈ ৳318, daily ≈ ৳45 — read what is on screen).

### Shot 4 — Cash-flow forecast with p10/p50/p90 bands (1:10 – 1:45)

- **Screen:** Tap **Cash Flow**. Show the dark hero — **"Shortfall risk · next 7 days"** with the probability and gauge — then the expected inflow/outflow, the **likely range (80%)**, the day-by-day bars, and the line *"এটি অনুমান, নিশ্চয়তা নয়।" / "This is an estimate, not a certainty."*
- **Voiceover:** "This is the AI core. A LightGBM quantile forecaster — nine models, one for each decile — predicts Rina's irregular daily flow for the coming weeks, on top of her detected salary, rent and bill streams. Recurring money is scheduled; only the genuinely uncertain part is learned. The bands you see are p10 to p90: eighty percent of simulated futures stay inside them. The API behind this screen serves twenty-one days of p10/p50/p90 balance bands, and the headline number is a *calibrated probability* of running short — with the projected lowest-balance day named."
- **Optional cut (0:04):** DevTools or `curl /api/v1/me/forecast` showing the `days[]` array with `p10/p50/p90` fields and `method: "lightgbm-quantile + recurring streams + calibrated paths"`.

### Shot 5 — Why this risk? Evidence + counterfactual actions (1:45 – 2:20)

- **Screen:** Scroll to **"কেন এই ঝুঁকি? — প্রমাণসহ"** ("Why this risk level? — the evidence") and expand it; then scroll to the action cards.
- **Voiceover:** "Every prediction shows its evidence: which factors moved the risk, which assumptions were used, which model version produced it. Nothing is a black box. And every risk comes with options — not commands."
- **Action:** Tap an action card ("trim top trimmable category 20%", "batch cash-outs", "hold a payday buffer"). Point at the simulated impact line as it renders: **risk goes down** (e.g., "31% → 24%" — read the two numbers on screen) with freed monthly ৳.
- **Voiceover:** "Each card re-runs the *same* simulated paths with that one change applied, and shows the new probability — a counterfactual with a negative delta. Sathi never executes anything. As the app says: **'বিকল্প উপস্থাপিত হয়, নির্দেশ নয় — সিদ্ধান্ত আপনার।'** — *options are presented, never commanded — you decide.*"

### Shot 6 — Goals with Wilson intervals (2:20 – 2:45)

- **Screen:** Tap **Goals**, open a goal (e.g., a ৳30,000 emergency fund) → the plan with three option cards under **"আপনার বিকল্প"** ("Your options").
- **Voiceover:** "Goal plans are Monte Carlo simulations over her own surplus history — two thousand paths — and each option ships with a Wilson 95% interval instead of a false promise. We have been honest even with ourselves here: our raw simulation was three-to-five times optimistic in back-tests, so every probability of success now passes through a Platt recalibration fitted on held-out users, cutting calibration error from 0.099 to 0.020. If a goal is not feasible at a contribution, the app says so."

### Shot 7 — Bangla copilot, evidence-grounded (2:45 – 3:15)

- **Screen:** Tap **Copilot**. Tap the suggested chip **"আগামী সাত দিনে ঘাটতির ঝুঁকি কত?"** ("What's my shortfall risk over the next seven days?"). The answer card arrives with a badge — "AI-grounded answer (validated)" or "Deterministic answer (AI not used)" — a numbers grid, and **"কেন? প্রমাণ দেখুন ▾"** ("Why? Show evidence").
- **Second beat:** Type a natural-language capture in the Transactions box: **"আজকে রিকশা ভাড়া ৮০ টাকা"** — the parse preview appears (amount, category) before anything is saved. Tap save → "সংরক্ষিত ✓".
- **Voiceover:** "Ask in Bangla, Banglish or English. A language model narrates the answer — but it is **never allowed to compute money**. It can only reference figures through slots the app fills with pre-formatted engine values; any bare number in Bangla or English digits fails closed to a reviewed template. That's why every answer can show its evidence, and why the parser asks for confirmation before saving anything."

### Shot 8 — The Android app + offline core (B-roll) (3:15 – 3:30)

- **Visual:** Physical Android phone: open the Sathi APK → enable airplane mode → the app retries, then offers **"Continue offline with sample data · অফলাইনে নমুনা ডেটা দেখুন →"** → the offline demo mode renders safe-to-spend, shortfall risk and a goal plan on-device → disable airplane mode → it silently reconnects.
- **Voiceover:** "The Android app is the same product in a native shell — and when the network fails, as it often does, a fully on-device core keeps working: recurring detection, a seeded path simulation, safe-to-spend, goals. No backend, no internet."

### Shot 9 — Real-life impact (3:30 – 3:45)

- **Visual:** Return to the Home screen; slow pan across safe-to-spend, risk, goal progress.
- **Voiceover:** "For a user like Rina, this is foresight she has never had: a number for today, a probability for the week, named avoidable cash-out fees, and savings plans she can actually believe. For an MFS platform, it is Track 03 in product form — customers who become more confident and more independent, not just more active. That's financial companionship: সাথী."

### Shot 10 — Honest guardrails + close (3:45 – 3:55)

- **Visual:** Split screen: the Insights → Model-health reliability chart on one side; the repo's evaluation tables on the other.
- **Voiceover (deliberately plain):** "Three things we want you to know. One — every number you saw is **simulated**, from synthetic personas; real validation needs governed data. Two — on the frozen test set our model clearly beats the simple rule, and it **ties** our previous bootstrap baseline; its real edge shows under drift, and we report the tie as-is. Three — the language model never computes money; deterministic engines do, and they fail closed. Try it now at sathi-pied.vercel.app, or install the APK from GitHub Releases."
- **End card:** logo + `https://sathi-pied.vercel.app` + `github.com/AdilShamim8/Sathi` + "AI DEV FEST 2026 · Track 03".

---

## Production notes

- **Mobile framing throughout** — the product is mobile-first (max-width 430 px); record portrait or a centered mobile viewport on desktop. Capture at ≥1080p; keep cursor/taps visible.
- **Read live numbers, never pre-record them.** The forecast, safe-to-spend and action deltas depend on the persona and day; the script's figures are examples. If a delta is not negative, re-shoot with the garment-worker persona (all shipped action cards reduce risk by construction).
- **The Bangla beats are mandatory** (onboarding demo card, copilot chip, NL capture, "সিদ্ধান্ত আপনার") — they demonstrate the bilingual promise, not decoration. Keep the EN⇄বাংলা toggle visible in the header in at least one shot.
- **APK B-roll:** build or download `sathi-v6.3.0.apk` from GitHub Releases (release-signed; installs over v6.2+). Airplane-mode shot must show the retry-then-offline-core flow and the automatic reconnect — it is invariant 7 of the architecture.
- **Timing discipline:** Shots 4, 5 and 7 carry the AI story (forecaster, calibration, fail-closed LLM) — protect them if cuts are needed; Shots 1 and 9 carry the human story. If over 4:00, trim Shot 8 to 10 s and tighten Shot 3.
- **Captions/subtitles:** burn in EN subtitles; keep every metric caption character-for-character identical to the screen (the repo's rule: no hand-typed metrics).
