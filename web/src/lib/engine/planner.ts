/**
 * Goal planner — ported from Sathi core/planner.py.
 *
 * Three honest option types (reference architecture §6.2):
 *   A: extend the timeline at a feasible contribution
 *   B: trim a named leakage (fees + avoidable spend) and redirect it
 *   C: save a percentage of each inflow (suits irregular earners)
 *
 * Common random numbers (one pre-sampled surplus matrix) make P(goal met)
 * monotonic in contribution and in time by construction. The essentials
 * safety buffer caps every contribution. No option is pre-selected or
 * promoted.
 *
 * Empirical calibration: the raw i.i.d. simulation over trailing history
 * is systematically optimistic (held-out back-test T6: goals stated at
 * 10.5% were met 2.8% of the time; at 27.6%, 5.1% — surplus mean-reverts).
 * Every probability is therefore passed through the same Platt (logistic)
 * recalibration fitted on the frozen test users as the Python twin:
 *     p_cal = sigmoid(A + B * logit(p_raw))
 * The shipped constants live in config/app.yaml under `planner:`
 * (calibration_a / calibration_b — mirrored in sathiConfig.ts
 * PLANNER_CONFIG; there is no config/planner.yaml).
 * An all-paths success is capped at 1 - 1/(2n) first — the planner must
 * never emit certainty the back-test does not support.
 *
 * Amounts are whole taka in this port (the app's internal unit).
 */

import { mulberry32 } from "./rng";
import { addMonths } from "./timeutils";

export interface PlannerConfig {
  nSimulations: number;
  horizonCapMonths: number;
  minMonthlyContribution: number;
  likelyCutoff: number;
  uncertainCutoff: number;
  /** Platt recalibration (log-odds). Optional — defaults mirror the Python
   *  config (config/app.yaml, `planner:` block) so existing constructors
   *  keep working. Derived on the frozen T6 back-test; see docs/eval_report.md. */
  calibrationA?: number;
  calibrationB?: number;
}

export interface PlanOption {
  key: "extend_timeline" | "trim_leakage" | "percent_of_inflow";
  monthlyContribution: number;
  percentOfInflow: number | null;
  months: number;
  pGoalMet: number;
  /** Wilson 95% interval — the honest simulation range. */
  pLow: number;
  pHigh: number;
  tradeoffBn: string;
  tradeoffEn: string;
}

export interface GoalPlan {
  target: number;
  requestedMonths: number;
  monthlyRequired: number;
  pRequested: number;
  verdict: "likely" | "uncertain" | "unlikely";
  options: PlanOption[];
  feasibilityNoteBn: string;
  feasibilityNoteEn: string;
  deadline: string; // ISO date
}

/** 95% Wilson score interval for a binomial proportion. */
export function wilson(p: number, n: number): [number, number] {
  if (n === 0) return [0, 1];
  const z = 1.959963984540054;
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  // Clamp around p: float noise must not push a bound past the estimate.
  const lo = Math.min(Math.max(0, centre - margin), p);
  const hi = Math.max(Math.min(1, centre + margin), p);
  return [lo, hi];
}

/** Platt recalibration of a raw Monte Carlo probability (see header).
 *  Monotone, maps 0 -> 0, and never claims certainty. */
export function calibrate(
  p: number,
  n: number,
  calibrationA: number,
  calibrationB: number,
): number {
  if (p <= 0) return 0;
  if (p >= 1) p = 1 - 0.5 / Math.max(n, 1);
  const z = calibrationA + calibrationB * Math.log(p / (1 - p));
  if (z >= 0) return 1 / (1 + Math.exp(-z));
  const e = Math.exp(z); // numerically stable far-left tail
  return e / (1 + e);
}

/**
 * P(cumulative min(monthly, surplus) reaches target within `months`).
 * S: pre-sampled monthly surpluses (common random numbers). A month's
 * contribution never exceeds that month's surplus.
 */
function simulateFixed(
  S: number[][],
  target: number,
  monthly: number,
  months: number,
): number {
  const horizon = Math.min(months, S[0].length);
  let reached = 0;
  for (const row of S) {
    let cum = 0;
    for (let m = 0; m < horizon; m++) {
      cum += Math.min(monthly, Math.max(row[m], 0));
      if (cum >= target) {
        reached++;
        break;
      }
    }
  }
  return reached / S.length;
}

/** P(rate × each month's inflow accumulates to target within `months`). */
function simulatePercent(
  I: number[][],
  target: number,
  rate: number,
  months: number,
): number {
  const horizon = Math.min(months, I[0].length);
  let reached = 0;
  for (const row of I) {
    let cum = 0;
    for (let m = 0; m < horizon; m++) {
      cum += Math.max(row[m], 0) * rate;
      if (cum >= target) {
        reached++;
        break;
      }
    }
  }
  return reached / I.length;
}

export function planGoal(params: {
  target: number;
  months: number;
  /** historical monthly surpluses (whole taka) — the user's own history. */
  monthlySurplusSamples: number[];
  /** historical monthly inflows (whole taka). */
  monthlyInflowSamples: number[];
  monthlyFeeLeakage: number;
  monthlyAvoidable: number;
  maxSafeContribution: number;
  config: PlannerConfig;
  seed: number;
  asOfDate: Date;
}): GoalPlan {
  const {
    target, months, monthlySurplusSamples, monthlyInflowSamples,
    monthlyFeeLeakage, monthlyAvoidable, maxSafeContribution, config, seed, asOfDate,
  } = params;
  if (target <= 0 || months <= 0) {
    throw new Error("target and months must be positive");
  }
  // Platt recalibration constants (see module header) — defaults mirror
  // core/planner.py so every constructor stays valid.
  const calA = config.calibrationA ?? -2.4133;
  const calB = config.calibrationB ?? 0.5291;
  const cal = (p: number) => calibrate(p, config.nSimulations, calA, calB);

  const poolS = monthlySurplusSamples.length ? monthlySurplusSamples : [0];
  const poolI = monthlyInflowSamples.length ? monthlyInflowSamples : [0];
  const rand = mulberry32(seed);

  // Common random numbers: one pre-sampled matrix for every option.
  const sample = (pool: number[]): number[][] => {
    const S: number[][] = [];
    for (let i = 0; i < config.nSimulations; i++) {
      const row: number[] = [];
      for (let m = 0; m < config.horizonCapMonths; m++) {
        row.push(pool[Math.floor(rand() * pool.length)]);
      }
      S.push(row);
    }
    return S;
  };
  const S = sample(poolS);
  const I = sample(poolI);

  const monthlyRequired = Math.ceil(target / months);
  const pRequested = cal(simulateFixed(S, target, monthlyRequired, months));
  let verdict: GoalPlan["verdict"];
  if (pRequested >= config.likelyCutoff) verdict = "likely";
  else if (pRequested >= config.uncertainCutoff) verdict = "uncertain";
  else verdict = "unlikely";

  // Feasible base contribution: median positive surplus, floored and capped.
  const positive = poolS.filter((s) => s > 0);
  let base = positive.length ? median(positive) : 0;
  base = Math.max(base, config.minMonthlyContribution);
  base = Math.min(base, maxSafeContribution);

  const options: PlanOption[] = [];

  // --- Option A: extend the timeline at the feasible contribution ---------
  if (base > 0) {
    const monthsA = Math.min(Math.ceil(target / base), config.horizonCapMonths);
    const pA = cal(simulateFixed(S, target, base, monthsA));
    const [lo, hi] = wilson(pA, config.nSimulations);
    options.push({
      key: "extend_timeline",
      monthlyContribution: base,
      percentOfInflow: null,
      months: monthsA,
      pGoalMet: pA, pLow: lo, pHigh: hi,
      tradeoffBn: "বেশি সময় লাগবে, তবে মাসিক অংক ছোট ও টেকসই",
      tradeoffEn: "Takes longer, but the monthly amount stays small and sustainable",
    });
  }

  // --- Option B: trim the named leakage, redirect it to the goal ----------
  const leakage = monthlyFeeLeakage + monthlyAvoidable;
  if (leakage > 0 && base >= 0) {
    const contribB = Math.min(base + leakage, maxSafeContribution);
    if (contribB > 0) {
      const monthsB = Math.min(Math.ceil(target / contribB), config.horizonCapMonths);
      const pB = cal(simulateFixed(S, target, contribB, monthsB));
      const [lo, hi] = wilson(pB, config.nSimulations);
      options.push({
        key: "trim_leakage",
        monthlyContribution: contribB,
        percentOfInflow: null,
        months: monthsB,
        pGoalMet: pB, pLow: lo, pHigh: hi,
        tradeoffBn: "ক্যাশ-আউট ফি ও এড়ানো যায় এমন খরচ কমিয়ে সেই টাকা জমানো হবে",
        tradeoffEn: "Redirects cash-out fees and avoidable spend into the goal",
      });
    }
  }

  // --- Option C: percentage of each inflow (irregular-income friendly) ----
  const medInflow = median(poolI);
  if (medInflow > 0) {
    const rateNeeded = monthlyRequired / medInflow;
    const rate = Math.min(Math.max(rateNeeded, 0.05), 0.5); // 5%–50% sane band
    const expectedMonthly = Math.floor(medInflow * rate);
    if (expectedMonthly <= maxSafeContribution) {
      const pC = cal(simulatePercent(I, target, rate, months));
      const [lo, hi] = wilson(pC, config.nSimulations);
      options.push({
        key: "percent_of_inflow",
        monthlyContribution: expectedMonthly,
        percentOfInflow: rate,
        months,
        pGoalMet: pC, pLow: lo, pHigh: hi,
        tradeoffBn: "আয় আসার সঙ্গে সঙ্গে একটি নির্দিষ্ট অংশ আলাদা রাখা হয়",
        tradeoffEn: "Sets aside a fixed share the moment income arrives",
      });
    }
  }

  // Honest headline (kind, plain, always with a next step).
  let noteBn: string;
  let noteEn: string;
  if (verdict === "unlikely") {
    noteBn = "এই সময়ে এই লক্ষ্য পৌঁছানো কঠিন। নিচের বিকল্পগুলো দেখুন — সিদ্ধান্ত আপনার।";
    noteEn = "This goal is unlikely in the requested time. The options below are more realistic — you decide.";
  } else if (verdict === "uncertain") {
    noteBn = "লক্ষ্যটি সম্ভব, তবে ঝুঁকি আছে। বিকল্প পরিকল্পনাগুলো তুলনা করে দেখুন।";
    noteEn = "Possible, but not certain. Compare the options below.";
  } else {
    noteBn = "আপনার ইতিহাস অনুযায়ী এই লক্ষ্য অর্জনযোগ্য মনে হচ্ছে।";
    noteEn = "Given your history, this goal looks achievable.";
  }

  return {
    target,
    requestedMonths: months,
    monthlyRequired,
    pRequested,
    verdict,
    options,
    feasibilityNoteBn: noteBn,
    feasibilityNoteEn: noteEn,
    deadline: addMonths(asOfDate, months).toISOString().slice(0, 10),
  };
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
