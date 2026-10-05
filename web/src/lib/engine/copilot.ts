/**
 * Personalized Financial Coach + fail-closed LLM guardrails (P0).
 *
 * Orchestration:
 *   question → intent detection → user context → deterministic engines
 *   → knowledge retrieval → grounded answer (numbers from engines only)
 *   → optional LLM re-write of the summary (server-side z-ai sdk)
 *
 * The LLM never sees freedom to invent numbers: it receives the computed
 * evidence and must select from it. A numeric validator checks every number
 * in the answer — ৳ amounts, percentages and bare counts — against the
 * engine outputs; on ANY failure the deterministic template is shown
 * (fail-closed). If the AI gateway is unavailable, the deterministic answer
 * is returned with llmEnhanced=false — the product still works.
 */
import type {
  CopilotAnswer, EvidenceItem, Goal, Txn, Confidence,
  SafeToSpendResult, ShortfallRiskResult, SpendingIntelligence, CashOnHand,
} from "./domain";
import { categoryLabel, MODEL_VERSION } from "./domain";
import { computeSpendingIntelligence, estimateMonthlyCapacity, estimateCashOnHand } from "./analytics";
import { toEnglishDigits } from "./formatting";
import { forecastCashflow } from "./forecast";
import { analyzeGoal, simulateGoal } from "./goals";
import { retrieveKnowledge, type KnowledgeChunk } from "./knowledge";
import { shortfallRisk } from "./ml";
import { calculateSafeToSpend, upcomingCommitments } from "./safeToSpend";

export type Intent =
  | "where_money_going"
  | "month_end_pressure"
  | "goal_feasibility"
  | "what_changed"
  | "recurring_expenses"
  | "simulate_savings"
  | "explain_spending"
  | "safe_to_spend"
  | "shortfall_risk"
  | "monthly_review"
  | "general";

const INTENT_PATTERNS: [Intent, RegExp][] = [
  ["safe_to_spend", /safe.*(spend|spending)|কত.*খরচ.*পারি|নিরাপদ|how much.*(can|should) i (spend|safely)|daily budget/i],
  ["shortfall_risk", /shortfall|risk|ঝুঁকি|run out|শেষ হয়ে|কম পড়|আগেই শেষ/i],
  ["month_end_pressure", /month.?end|run short|শেষে|শেষ মাস|টাকা থাকে না|shortage|pressure|চাপ/i],
  ["simulate_savings", /what if|save .*more|আরও .*জমা|যদি .*কমাই|reduce|simulate|কাট/i],
  ["goal_feasibility", /goal|save.*\d|সঞ্চয়|লক্ষ্য|reach|target|জমাতে/i],
  ["what_changed", /changed|difference|পার্থক্য|বদলেছে|vs last|compare/i],
  ["recurring_expenses", /recurring|repeat|প্রতি মাসে|নিয়মিত|subscription/i],
  ["explain_spending", /explain|don.?t understand|বুঝি না|ব্যাখ্যা|meaning/i],
  ["where_money_going", /where.*money|কোথায়.*টাকা|টাকা.*যায়|spending|খরচ কোথায়|কোথায় খরচ/i],
  ["monthly_review", /review|কী দেখবো|কি দেখব|what should|পর্যালোচনা/i],
];

export function detectIntent(question: string): Intent {
  for (const [intent, re] of INTENT_PATTERNS) {
    if (re.test(question)) return intent;
  }
  return "general";
}

const DISCLAIMER =
  "Estimates are based on your transaction history and stated assumptions. This is decision support, not financial advice — the final choice is always yours.";

export interface CopilotContext {
  txns: Txn[];
  goals: Goal[];
  knowledge: KnowledgeChunk[];
  anchor: Date;
  openingBalance: number;
  salary: { amount: number | null; payDay: number | null };
  /** Kill switch / daily budget verdict from the route (default: allowed). */
  llmAllowed?: boolean;
  /** Secondary server-side draft generator (e.g. OpenRouter via env key) used
   *  when the primary z-ai sdk is unavailable. Same grounding validator applies. */
  llmFallback?: (system: string, user: string) => Promise<string | null>;
}

export async function answerQuestion(question: string, ctx: CopilotContext): Promise<CopilotAnswer> {
  const intent = detectIntent(question);
  const intel = computeSpendingIntelligence(ctx.txns, ctx.anchor);
  const cash = estimateCashOnHand(ctx.txns, ctx.anchor, ctx.openingBalance, ctx.salary);
  const fc = forecastCashflow(ctx.txns, ctx.anchor, 7, cash.walletBalance);
  const { capacity } = estimateMonthlyCapacity(ctx.txns, ctx.anchor);
  const risk = shortfallRisk(ctx.txns, ctx.anchor, ctx.openingBalance, cash.walletBalance, 7, ctx.salary);
  const commitments = upcomingCommitments(intel.recurring, ctx.anchor, 7);
  const activeGoal = ctx.goals.find((g) => g.status === "active") ?? null;
  const goalAnalysis = activeGoal ? analyzeGoal(activeGoal, ctx.txns, ctx.anchor) : null;
  const sts = calculateSafeToSpend({
    walletBalance: cash.walletBalance,
    upcomingCommitments: commitments,
    dailyEssentials: cash.dailyEssentials,
    horizonDays: 7,
    monthlySavingsTarget: capacity > 0 ? Math.round(capacity * 0.3) : 0,
  });

  const knowledgeHits = retrieveKnowledge(question, ctx.knowledge, 3);
  // dedupe by sourceId — retrieval can surface sibling chunks of one doc
  const knowledgeRefs = [...new Set(knowledgeHits.map((h) => `${h.chunk.sourceId}: ${h.chunk.title}`))];

  const base = buildDeterministicAnswer(intent, question, {
    intel, fc, capacity, goalAnalysis, activeGoal, ctx, cash, risk, sts,
  });
  base.knowledgeRefs = knowledgeRefs;

  // Guardrail check: never invent numbers — verify every ৳ figure in the
  // LLM summary appears in the evidence; otherwise keep deterministic text.
  let llmSummary = ctx.llmAllowed === false
    ? null
    : await tryLlmSummary(question, intent, base, knowledgeHits.map((h) => h.chunk.chunkText));

  // Secondary path (deployer's OpenRouter key, server-side): only when the
  // primary z-ai sdk produced nothing, and still behind the same validator.
  if (llmSummary === null && ctx.llmAllowed !== false && ctx.llmFallback) {
    try {
      const evidenceText = [...base.numbers, ...base.evidence]
        .map((e) => `- ${e.label}: ${e.value}`)
        .join("\n");
      llmSummary = await ctx.llmFallback(
        [
          "You are the explanation voice of a financial decision-support copilot inside a mobile wallet (Sathi, Bangladesh).",
          "Rewrite the draft answer so it is warm, clear and non-judgmental (2-3 sentences). You may answer in the user's language (Bangla, Banglish or English).",
          "STRICT RULES: never invent or estimate numbers; you may only repeat ৳ amounts that appear verbatim in the evidence list. Never present forecasts as certainty. Never pressure the user to spend. Do not give regulated financial advice. Output only the rewritten summary text.",
        ].join("\n"),
        `User question: "${question}"\n\nComputed evidence (the ONLY numbers you may cite):\n${evidenceText || "(no numeric evidence)"}\n\nDraft answer to rewrite: "${base.summary}"`,
      );
    } catch {
      llmSummary = null; // fail-closed — deterministic answer already built
    }
  }
  if (llmSummary && numbersAreGrounded(llmSummary, base)) {
    base.summary = llmSummary;
    base.llmEnhanced = true;
  }
  return base;
}

function buildDeterministicAnswer(
  intent: Intent,
  question: string,
  d: {
    intel: SpendingIntelligence;
    fc: ReturnType<typeof forecastCashflow>;
    capacity: number;
    goalAnalysis: ReturnType<typeof analyzeGoal> | null;
    activeGoal: Goal | null;
    ctx: CopilotContext;
    cash: CashOnHand;
    risk: ShortfallRiskResult;
    sts: SafeToSpendResult;
  },
): CopilotAnswer {
  const { intel, fc, capacity, goalAnalysis, activeGoal, ctx, cash, risk, sts } = d;
  const money = (n: number) => `৳${Math.round(n).toLocaleString()}`;
  const evidence: EvidenceItem[] = [];
  const numbers: EvidenceItem[] = [];
  const options: { title: string; description: string; impact: string }[] = [];
  const assumptions: string[] = [];
  let summary = "";
  let confidence: Confidence = "medium";

  switch (intent) {
    case "safe_to_spend": {
      summary = `Your estimated safe-to-spend is ${money(sts.safeToSpendTotal)} over the next ${sts.horizonDays} days — about ${money(sts.dailySafeBudget)} per day after reserving upcoming commitments (${money(sts.upcomingCommitments)}), a safety buffer and prorated savings. Status: ${sts.statusLabelEn}.`;
      numbers.push(
        { label: "Safe to spend (7d)", value: money(sts.safeToSpendTotal) },
        { label: "Daily safe budget", value: money(sts.dailySafeBudget) },
        { label: "Cash on hand", value: money(cash.walletBalance) },
        { label: "Upcoming commitments", value: money(sts.upcomingCommitments) },
        { label: "Safety buffer", value: money(sts.safetyBuffer) },
      );
      evidence.push(...sts.breakdown.map((b) => ({ label: b.label, value: money(Math.abs(b.amount)) })));
      options.push(
        { title: "Keep discretionary under the daily budget", description: `Spending up to ${money(sts.dailySafeBudget)}/day keeps every commitment covered.`, impact: "No shortfall risk" },
        { title: "Defer one discretionary purchase", description: "Moving it past the next salary date frees the whole amount.", impact: "Protects the buffer" },
      );
      assumptions.push("Safe-to-spend = cash on hand − commitments − buffer − prorated savings", "Commitments learned from recurring patterns in your history");
      break;
    }
    case "shortfall_risk": {
      const pct = Math.round(risk.probability * 100);
      summary = `The model estimates a ${pct}% probability that your balance dips below your essential-spend safety line within the next 7 days${risk.troughDay ? `, most likely around ${new Date(risk.troughDay).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}` : ""}. Main drivers: ${risk.topFactors.slice(0, 2).map((f) => f.label.toLowerCase()).join(" and ")}.`;
      numbers.push(
        { label: "Shortfall probability", value: `${pct}%` },
        { label: "Risk level", value: risk.riskLevel.toUpperCase() },
        { label: "Projected lowest balance", value: money(risk.projectedTrough) },
        { label: "Simple rule would say", value: risk.baselineRuleProbability === 1 ? "risk" : "no risk" },
      );
      evidence.push(...risk.topFactors.map((f) => ({ label: f.label, value: f.value })));
      options.push(
        { title: "Defer discretionary spending this week", description: "Each day under the daily safe budget lowers the chance of dipping.", impact: "Risk falls quickly" },
        { title: "Check commitments before they hit", description: `${money(sts.upcomingCommitments)} of recurring obligations are due within 7 days.`, impact: "Avoid surprises" },
      );
      assumptions.push("Probability from a logistic model trained on synthetic personas, validated vs a rule baseline", "A probability, not a certainty");
      confidence = "medium";
      break;
    }
    case "where_money_going": {
      summary = `In the last ${intel.periodDays} days you spent ${money(intel.totalOut)} across ${intel.categories.length} categories. Your largest is ${categoryLabel(intel.concentration.topCategory)} at ${Math.round(intel.concentration.topShare)}% of outflow.`;
      for (const c of intel.categories.slice(0, 5)) {
        numbers.push({ label: c.labelEn, value: `${money(c.thisMonth)} (${Math.round(c.share)}%)` });
      }
      for (const r of intel.recurring.slice(0, 3)) {
        evidence.push({ label: `Recurring: ${r.label}`, value: `${r.occurrences}× / ~${money(r.monthlyEstimate)} per month` });
      }
      options.push(
        { title: "See full category breakdown", description: "Spending Intelligence screen shows every category, trend and recurring pattern.", impact: "Finds where the money actually goes" },
        { title: "Review recurring expenses", description: `${intel.recurring.length} recurring patterns detected, ~${money(intel.recurring.reduce((s, r) => s + r.monthlyEstimate, 0))}/month combined.`, impact: "Recurring spend is the easiest to plan around" },
      );
      assumptions.push("Category totals computed from the trailing 30 days of your transactions");
      break;
    }
    case "month_end_pressure": {
      const monthlyLate = Math.round(intel.monthEndPattern.lateOutflow / 3);
      summary = `Your month-end pressure appears to be a timing pattern: about ${money(monthlyLate)} leaves your wallet during days 21–31 each month while no income arrives, cash-outs are frequent, and the next ${fc.horizonDays} days look ${fc.pressure}.`;
      evidence.push(
        { label: "Outflow on days 21–31 (per month)", value: `~${money(monthlyLate)}` },
        { label: "Inflow on days 21–31", value: `~${money(Math.round(intel.monthEndPattern.lateInflow / 3))}` },
        { label: "Cash-outs (30d)", value: `${intel.cashOut.count}× / ${money(intel.cashOut.total)}` },
        { label: `Next ${fc.horizonDays}d outflow (est.)`, value: money(fc.expectedOutflow) },
        { label: `Next ${fc.horizonDays}d inflow (est.)`, value: money(fc.expectedInflow) },
      );
      numbers.push(...fc.factors.slice(0, 3).map((f) => ({ label: "Factor", value: f })));
      options.push(
        { title: "Shift one discretionary expense earlier in the cycle", description: "Spreading spend reduces the month-end squeeze without changing totals.", impact: "Smoother cash flow" },
        { title: "Hold a small buffer from salary day", description: "Setting aside a fixed amount on payday protects the last week.", impact: "Buffer for the final 10 days" },
        { title: "Reduce cash-out frequency", description: "Paying digitally where possible avoids repeated cash-out fees.", impact: "Lower fees, clearer records" },
      );
      assumptions.push(...fc.assumptions);
      confidence = fc.confidence;
      break;
    }
    case "goal_feasibility": {
      if (!goalAnalysis || !activeGoal) {
        summary = "You don't have an active savings goal yet. Tell me a target — for example “I want to save ৳30,000 in 6 months” — and I'll check feasibility.";
        options.push({ title: "Create a goal", description: "Set target amount and timeline on the Goals screen.", impact: "Get a concrete plan with scenarios" });
        confidence = "high";
        break;
      }
      summary = `Your goal “${activeGoal.name}” needs ${money(goalAnalysis.requiredMonthly)}/month for ${goalAnalysis.monthsRemaining} months. Your estimated capacity is ${money(goalAnalysis.currentCapacity)}/month, leaving a projected gap of ${money(goalAnalysis.projectedGap)}. Status: ${goalAnalysis.feasibility.replace("_", " ")}.`;
      numbers.push(
        { label: "Target", value: money(goalAnalysis.targetAmount) },
        { label: "Required monthly", value: money(goalAnalysis.requiredMonthly) },
        { label: "Estimated capacity", value: money(goalAnalysis.currentCapacity) },
        { label: "Projected gap", value: money(goalAnalysis.projectedGap) },
      );
      for (const s of goalAnalysis.scenarios) {
        options.push({
          title: `Option: ${s.title}`,
          description: s.description,
          impact: s.reachesGoal ? "Reaches the goal" : `Gap of ${money(s.gap)} remains`,
        });
      }
      assumptions.push(...goalAnalysis.assumptions);
      break;
    }
    case "what_changed": {
      const changed = intel.categories.filter((c) => c.changePct !== null && Math.abs(c.changePct) >= 10).slice(0, 4);
      summary = changed.length
        ? `Compared with the previous 30 days, the biggest change is ${changed[0].labelEn}: ${changed[0].changePct! > 0 ? "+" : ""}${Math.round(changed[0].changePct!)}%.`
        : "Your category spending looks broadly stable compared with the previous 30 days.";
      for (const c of changed) {
        numbers.push({
          label: c.labelEn,
          value: `${money(c.lastMonth)} → ${money(c.thisMonth)} (${c.changePct! > 0 ? "+" : ""}${Math.round(c.changePct!)}%)`,
        });
      }
      options.push({ title: "Open Spending Intelligence", description: "See per-category trends, recurring patterns and unusual transactions.", impact: "Full evidence trail" });
      assumptions.push("Comparison window: trailing 30 days vs the 30 days before");
      break;
    }
    case "recurring_expenses": {
      const recIn = intel.recurringIncome;
      summary = `I found ${intel.recurring.length} recurring expense patterns worth about ${money(intel.recurring.reduce((s, r) => s + r.monthlyEstimate, 0))} per month in total${recIn.length ? `, and recurring income of ~${money(recIn.reduce((s, r) => s + r.monthlyEstimate, 0))}/month` : ""}.`;
      for (const r of intel.recurring.slice(0, 6)) {
        numbers.push({ label: `${r.label}${r.merchant ? ` · ${r.merchant}` : ""}`, value: `${r.occurrences}× · avg ${money(r.avgAmount)} · ~${money(r.monthlyEstimate)}/mo (${r.cadence})` });
      }
      for (const r of recIn.slice(0, 2)) {
        evidence.push({ label: `Recurring income: ${r.label}`, value: `${money(r.avgAmount)} around day ${r.typicalDayOfMonth ?? "?"} of the month (learned from history)` });
      }
      options.push({ title: "Trim one recurring pattern", description: "Small recurring amounts add up — simulate the effect toward your goal.", impact: "Converts habit into planned savings" });
      assumptions.push("A pattern counts as recurring when it appears in 3+ distinct weeks over 90 days");
      break;
    }
    case "simulate_savings": {
      const m = question.replace(/[০-৯]/g, (dd) => "০১২৩৪৫৬৭৮৯".indexOf(dd).toString()).match(/(\d[\d,]*)/);
      const extra = m ? parseInt(m[1].replace(/,/g, ""), 10) : 1500;
      if (activeGoal) {
        const sim = simulateGoal({ goal: activeGoal, txns: ctx.txns, anchor: ctx.anchor, extraMonthlySavings: extra });
        summary = `If you set aside ${money(extra)} more each month, your monthly capacity becomes ${money(sim.newCapacity)} and you would reach “${activeGoal.name}” ${sim.monthsSaved && sim.monthsSaved > 0 ? `about ${sim.monthsSaved} month(s) sooner` : "within the timeline"}.`;
        numbers.push(
          { label: "Extra per month", value: money(extra) },
          { label: "New capacity", value: money(sim.newCapacity) },
          { label: "Projected total by target date", value: money(sim.projectedTotal) },
          { label: "Remaining gap", value: money(sim.projectedGap) },
          { label: "Months to goal", value: sim.monthsToGoal !== null ? `${sim.monthsToGoal}` : "—" },
        );
        options.push(...sim.tradeoffs.map((t) => ({ title: "Trade-off", description: t, impact: "Weigh before deciding" })));
        assumptions.push(...sim.assumptions);
      } else {
        summary = `Saving ${money(extra)} more per month would add ${money(extra * 6)} over 6 months. Create a goal and I can tie the simulation to a target.`;
        numbers.push({ label: "6-month effect", value: money(extra * 6) });
      }
      break;
    }
    case "explain_spending": {
      const top = intel.categories[0];
      summary = `Your transactions group into ${intel.categories.length} categories. The largest is ${top ? `${top.labelEn} (${money(top.thisMonth)}, ${Math.round(top.share)}%)` : "—"}. Anything unusual is flagged with evidence, not judgement.`;
      for (const a of intel.anomalies.slice(0, 2)) {
        evidence.push({ label: `Unusual: ${categoryLabel(a.category)}`, value: a.reason });
      }
      for (const c of intel.categories.slice(0, 4)) {
        numbers.push({ label: c.labelEn, value: money(c.thisMonth) });
      }
      options.push({ title: "Open Transactions", description: "Every transaction with category and confidence score.", impact: "Full transparency" });
      assumptions.push("Categories are assigned by a deterministic keyword classifier with confidence scores");
      break;
    }
    case "monthly_review":
    default: {
      summary = `This month: ${money(intel.totalIn)} in, ${money(intel.totalOut)} out, estimated savings ${money(intel.net)}. Cash-flow outlook for the next ${fc.horizonDays} days is ${fc.pressure}, with a ${Math.round(risk.probability * 100)}% shortfall risk and safe-to-spend of ${money(sts.safeToSpendTotal)}. Estimated monthly savings capacity: ${money(capacity)}.`;
      numbers.push(
        { label: "Money in (30d)", value: money(intel.totalIn) },
        { label: "Money out (30d)", value: money(intel.totalOut) },
        { label: "Estimated savings", value: money(intel.net) },
        { label: "7-day outlook", value: fc.pressure.toUpperCase() },
        { label: "Safe to spend (7d)", value: money(sts.safeToSpendTotal) },
        { label: "Shortfall risk", value: `${Math.round(risk.probability * 100)}%` },
      );
      if (intel.anomalies[0]) evidence.push({ label: "Worth a look", value: intel.anomalies[0].reason });
      options.push(
        { title: "Check the forecast", description: "Day-by-day expected inflow/outflow with uncertainty bounds.", impact: "See pressure windows early" },
        { title: "Review goal progress", description: activeGoal ? `“${activeGoal.name}” is ${goalAnalysis?.progressPct ?? 0}% funded.` : "No active goal yet.", impact: "Keep the plan on track" },
      );
      assumptions.push(...fc.assumptions.slice(0, 2));
    }
  }

  return {
    intent,
    summary,
    evidence,
    numbers,
    options,
    assumptions,
    confidence,
    disclaimer: DISCLAIMER,
    knowledgeRefs: [],
    llmEnhanced: false,
  };
}

/** Every number in the LLM text — ৳ amounts, percentages ("12.5%",
 * "শতকরা") and bare counts — must already exist in the computed evidence.
 * Comparisons are decimal-aware: a percentage matches the evidence percent,
 * its raw-fraction form and whole-percent roundings (12.5% ↔ 0.125 ↔ 13%),
 * while ৳ amounts must match to the paisa. One ungrounded number rejects
 * the whole draft (fail-closed to the deterministic template). */
export function numbersAreGrounded(llmText: string, base: CopilotAnswer): boolean {
  // Ground truth: every numeric token in the computed evidence, kept as a
  // number (commas stripped) plus whether it was percentage-formatted.
  const truth: { n: number; pct: boolean }[] = [];
  const collect = (items: EvidenceItem[]) => {
    for (const it of items) {
      for (const m of toEnglishDigits(it.value).matchAll(/([\d,]+(?:\.\d+)?)\s*(%|শতকরা)?/g)) {
        const n = Number(m[1]!.replace(/,/g, ""));
        if (Number.isFinite(n)) truth.push({ n, pct: m[2] !== undefined });
      }
    }
  };
  collect(base.numbers);
  collect(base.evidence);

  // Draft tokens, most specific first: ৳ amounts, then %- / শতকরা- /
  // percent-formatted numbers (suffixed or prefixed), then every remaining
  // bare count. Bangla digits are normalized before matching.
  const num = "([\\d,]+(?:\\.\\d+)?)";
  const TOKEN_RE = new RegExp(
    [
      `৳\\s*${num}`,                                   // ৳1,250.50
      `${num}\\s*(?:%|শতকরা|percent(?:age)?\\b)`,     // 12.5% / 35 শতকরা
      `(?:শতকরা|percent(?:age)?)\\s*${num}`,           // শতকরা ৩৫
      num,                                             // bare count
    ].join("|"),
    "g",
  );
  const AMOUNT_TOL = 0.005; // ৳ figures must match the evidence to the paisa
  const PERCENT_TOL = 0.505; // whole-percent rounding: 12.5% ↔ 13%
  const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol + 1e-9;
  const amountGrounded = (n: number) => truth.some((g) => near(n, g.n, AMOUNT_TOL));
  const percentGrounded = (n: number) => truth.some((g) =>
    near(n, g.n, PERCENT_TOL) || // same percent, rounded
    near(n, g.n * 100, PERCENT_TOL)); // evidence stored the raw fraction (0.125)
  const countGrounded = (n: number) => truth.some((g) =>
    near(n, g.n, AMOUNT_TOL) ||
    (g.pct && near(n, g.n / 100, AMOUNT_TOL))); // draft cites the fraction (0.42 ↔ 42%)

  for (const m of toEnglishDigits(llmText).matchAll(TOKEN_RE)) {
    const n = Number((m[1] ?? m[2] ?? m[3] ?? m[4])!.replace(/,/g, ""));
    if (!Number.isFinite(n)) continue;
    if (m[1] !== undefined) {
      if (!amountGrounded(n)) return false;
    } else if (m[2] !== undefined || m[3] !== undefined) {
      if (!percentGrounded(n)) return false;
    } else if (!countGrounded(n)) {
      return false;
    }
  }
  return true;
}

/* ---------------- LLM enhancement (server-side, fail-closed) ---------------- */

/** Hard ceiling for the LLM rewrite — the user must never wait on a hung gateway. */
const LLM_TIMEOUT_MS = 20_000;

async function tryLlmSummary(
  question: string,
  intent: Intent,
  base: CopilotAnswer,
  knowledgeChunks: string[],
): Promise<string | null> {
  try {
    const { default: ZAI } = await import("z-ai-web-dev-sdk");
    const zai = await ZAI.create();
    const evidenceText = [...base.numbers, ...base.evidence]
      .map((e) => `- ${e.label}: ${e.value}`)
      .join("\n");
    const completion = await Promise.race([
      zai.chat.completions.create({
        messages: [
          {
            role: "system",
            content: [
              "You are the explanation voice of a financial decision-support copilot inside a mobile wallet (Sathi, Bangladesh).",
              "Rewrite the draft answer so it is warm, clear and non-judgmental (2-3 sentences). You may answer in the user's language (Bangla, Banglish or English).",
              "STRICT RULES: never invent or estimate numbers; you may only repeat ৳ amounts that appear verbatim in the evidence list. Never present forecasts as certainty. Never pressure the user to spend. Do not give regulated financial advice. Output only the rewritten summary text.",
              `Intent: ${intent}. Draft answer: "${base.summary}"`,
              knowledgeChunks.length ? `Background educational context (concepts only, no personal numbers):\n${knowledgeChunks.join("\n---\n")}` : "",
            ].join("\n"),
          },
          {
            role: "user",
            content: `User question: "${question}"\n\nComputed evidence (the ONLY numbers you may cite):\n${evidenceText || "(no numeric evidence)"}\n\nAssumptions:\n${base.assumptions.map((a) => `- ${a}`).join("\n")}`,
          },
        ],
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("LLM timeout")), LLM_TIMEOUT_MS),
      ),
    ]);
    const text = completion?.choices?.[0]?.message?.content;
    if (typeof text !== "string" || text.trim().length < 10 || text.trim().length > 1200) return null;
    return text.trim();
  } catch (err) {
    // Degrade gracefully — deterministic answer already built (fail-closed).
    console.warn("[copilot] LLM enhancement skipped:", err instanceof Error ? err.message : err);
    return null;
  }
}

export { MODEL_VERSION };
