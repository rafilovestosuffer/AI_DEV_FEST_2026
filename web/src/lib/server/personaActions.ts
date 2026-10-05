/**
 * Counterfactual action engine (mission P1) — server-side.
 *
 * Ranks 2-3 candidate actions by the estimated reduction in shortfall
 * probability. Each action is a deterministic cash-flow delta applied to the
 * SAME simulated liquidity paths the forecaster produced:
 *
 *   path'(day d) = path(day d) + freed_daily * d + one_time
 *
 *   p_raw_after = P(min path' < floor) over the same shortfall window
 *   p_after     = recalibrate(p_raw_after, shortfall_platt)
 *
 * The counterfactual probability is passed through the SAME Platt
 * recalibration the baseline forecast used (forecaster.ts recalibrate() with
 * calibration.shortfall_platt from the shipped artifacts). Both scales must
 * match: the baseline pShortfall is recalibrated, so a raw simulation
 * probability for the counterfactual would mix scales and can even flip the
 * sign of the risk delta. In the bootstrap fallback (model unavailable) the
 * baseline is raw, so the counterfactual stays raw too — scales always agree.
 *
 * Deterministic code owns every number; the LLM never touches this.
 */
import type { User } from "@prisma/client";
import type { Txn } from "@/lib/engine/domain";
import { personaUserForecast } from "@/lib/server/userForecast";
import { recalibrate } from "@/lib/engine/forecaster";
import { simulateBalancePaths } from "@/lib/engine/simulation";
import { categorize } from "@/lib/engine/categorizer";
import { cashoutFee } from "@/lib/engine/cashout";
import { formatTaka } from "@/lib/engine/formatting";
import { ESSENTIALS_PER_DAY_TAKA, SIMULATION_CONFIG, THRESHOLDS } from "@/lib/engine/sathiConfig";
import { estimateCashOnHand } from "@/lib/engine/analytics";

export interface PersonaAction {
  action_id: string;
  title_bn: string;
  title_en: string;
  detail_bn: string;
  detail_en: string;
  category: string;
  shortfall_prob_before: number;
  shortfall_prob_after: number;
  delta_shortfall_prob: number;
  freed_monthly_taka: number | null;
  safe_to_spend_after_taka: number;
}

interface PersonaRisk {
  pathsPaisa: number[][];
  floorPaisa: number;
  windowDays: number;
  pShortfall: number;
  /** Platt coefficients the baseline pShortfall was calibrated with
   * (null on the raw bootstrap fallback) — the counterfactual MUST reuse
   * exactly these so before/after live on the same probability scale. */
  platt: { a: number; b: number } | null;
  safeToSpendPaisa: number;
  daysToIncome: number | null;
  method: string;
}

const TRIMMABLE = new Set(["food", "transport", "other", "shopping", "entertainment"]);
const TRIM_FRACTION = 0.2;

/** Baseline risk for a persona user: model forecaster, fail-closed to the
 * seeded block bootstrap (the forecast route's fallback). */
export function personaRisk(user: User, txns: Txn[]): PersonaRisk | null {
  if (txns.length === 0) return null;
  const fc = personaUserForecast(user, txns);
  if (fc) {
    return {
      pathsPaisa: fc.paths,
      floorPaisa: fc.floorPaisa,
      windowDays: fc.windowDays,
      pShortfall: fc.pShortfall,
      platt: fc.shortfallPlatt,
      safeToSpendPaisa: fc.safeToSpendPaisa,
      daysToIncome: fc.daysToIncome,
      method: "lightgbm-quantile + recurring streams + calibrated paths",
    };
  }
  // Bootstrap fallback (same as GET /api/v1/me/forecast).
  const anchor = new Date();
  const cash = estimateCashOnHand(txns, anchor, user.openingBalance, {
    amount: user.salaryAmount, payDay: user.salaryPayDay,
  });
  const dailyNets = new Map<string, number>();
  for (const t of txns) {
    const key = t.timestamp.slice(0, 10);
    dailyNets.set(key, (dailyNets.get(key) ?? 0) + (t.direction === "in" ? t.amount : -t.amount));
  }
  const sorted = [...dailyNets.keys()].sort();
  if (!sorted.length) return null;
  const horizon = THRESHOLDS.shortfall_horizon_days;
  const paths = simulateBalancePaths({
    residuals: sorted.map((k) => dailyNets.get(k)!),
    startBalance: cash.walletBalance,
    horizonDays: horizon,
    blockLengthDays: SIMULATION_CONFIG.block_length_days,
    nPaths: SIMULATION_CONFIG.n_paths,
    seed: parseInt(anchor.toISOString().slice(0, 10).replace(/-/g, ""), 10),
  });
  const floorTaka = ESSENTIALS_PER_DAY_TAKA;
  const window = Math.min(cash.daysToNextIncome ?? horizon, horizon);
  const mins = paths.map((p) => Math.min(...p.slice(1, window + 1)));
  const q = (arr: number[], p: number): number => {
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
  };
  return {
    pathsPaisa: paths.map((p) => p.map((v) => v * 100)),
    floorPaisa: floorTaka * 100,
    windowDays: window,
    pShortfall: mins.filter((m) => m < floorTaka).length / Math.max(mins.length, 1),
    // raw bootstrap baseline — no Platt map applied, so none for the
    // counterfactual either (see module header: scales must always agree)
    platt: null,
    safeToSpendPaisa: Math.max(q(mins, 10) - floorTaka, 0) * 100,
    daysToIncome: cash.daysToNextIncome ?? null,
    method: `seeded stationary block bootstrap (${SIMULATION_CONFIG.block_length_days}-day blocks)`,
  };
}

function pShortfallOfAdjusted(paths: number[][], windowDays: number, floorPaisa: number, freedDailyPaisa: number, oneTimePaisa: number): { p: number; safe: number } {
  let hits = 0;
  const mins: number[] = [];
  for (const path of paths) {
    let min = Infinity;
    for (let d = 1; d <= windowDays && d < path.length; d++) {
      const v = path[d]! + freedDailyPaisa * d + oneTimePaisa;
      if (v < min) min = v;
    }
    mins.push(min);
    if (min < floorPaisa) hits++;
  }
  const s = [...mins].sort((a, b) => a - b);
  const q10 = s[Math.min(s.length - 1, Math.floor(0.1 * s.length))]!;
  return { p: paths.length ? hits / paths.length : 0, safe: Math.max(Math.trunc(q10) - Math.trunc(floorPaisa), 0) };
}

export function personaActions(user: User, txns: Txn[]): {
  actions: PersonaAction[];
  base: PersonaRisk | null;
} {
  const base = personaRisk(user, txns);
  if (!base) return { actions: [], base: null };

  const anchor = new Date();
  const cutoffMs = anchor.getTime() - 30 * 24 * 3600 * 1000;

  // Signals from the last 30 days.
  const catMonth = new Map<string, number>();
  const cashouts: number[] = [];
  for (const t of txns) {
    const ts = new Date(t.timestamp).getTime();
    if (ts < cutoffMs) continue;
    if (t.direction === "out" && t.category === "cash_out") {
      cashouts.push(t.amount);
      continue;
    }
    if (t.direction === "out") {
      const cat = categorize(t).category;
      if (TRIMMABLE.has(cat)) catMonth.set(cat, (catMonth.get(cat) ?? 0) + t.amount);
    }
  }

  const CAT_BN: Record<string, string> = { food: "খাবার ও বাজার", transport: "যাতায়াত", other: "অন্যান্য খরচ", shopping: "কেনাকাটা", entertainment: "বিনোদন" };
  const CAT_EN: Record<string, string> = { food: "food & groceries", transport: "transport", other: "other spending", shopping: "shopping", entertainment: "entertainment" };

  const candidates: {
    id: string; titleBn: string; titleEn: string; detailBn: string; detailEn: string;
    category: string; freedMonthly: number | null; freedDaily: number; oneTime: number;
  }[] = [];

  // 1 — trim the top trimmable category by 20%.
  let topCat: string | null = null;
  let topTotal = 0;
  for (const [c, v] of catMonth) if (v > topTotal) { topCat = c; topTotal = v; }
  if (topCat && topTotal > 0) {
    const freed = Math.round(topTotal * TRIM_FRACTION);
    if (freed >= 50) {
      candidates.push({
        id: "trim_discretionary",
        titleBn: `${CAT_BN[topCat] ?? topCat} ২০% কমান`,
        titleEn: `Trim ${CAT_EN[topCat] ?? topCat} by 20%`,
        detailBn: `গত ৩০ দিনে ${formatTaka(topTotal, "bn")} খরচ হয়েছে; ২০% কমালে মাসে প্রায় ${formatTaka(freed, "bn")} সাশ্রয় হবে।`,
        detailEn: `You spent ${formatTaka(topTotal, "en")} here in the last 30 days; a 20% trim frees about ${formatTaka(freed, "en")} a month.`,
        category: "habits",
        freedMonthly: freed,
        freedDaily: freed / 30,
        oneTime: 0,
      });
    }
  }

  // 2 — batch cash-outs (tariff-grounded: 1.5% with ৳5 minimum).
  if (cashouts.length >= 3) {
    const total = cashouts.reduce((s, a) => s + a, 0);
    const feeNow = cashouts.reduce((s, a) => s + cashoutFee(a), 0);
    const feeBatched = 2 * cashoutFee(Math.round(total / 2));
    const saved = Math.max(0, feeNow - feeBatched);
    if (saved >= 5) {
      candidates.push({
        id: "batch_cashouts",
        titleBn: "ক্যাশ-আউট একত্র করুন",
        titleEn: "Batch your cash-outs",
        detailBn: `৩০ দিনে ${cashouts.length}টি ক্যাশ-আউটের ফি প্রায় ${formatTaka(feeNow, "bn")}; দুটি বড় উত্তোলনে নামলে প্রায় ${formatTaka(saved, "bn")} সাশ্রয়।`,
        detailEn: `${cashouts.length} cash-outs in 30 days cost about ${formatTaka(feeNow, "en")} in fees; batching into 2 larger withdrawals saves about ${formatTaka(saved, "en")}.`,
        category: "cashflow",
        freedMonthly: saved,
        freedDaily: saved / 30,
        oneTime: 0,
      });
    }
  }

  // 3 — hold a payday buffer (one week of essentials).
  const bufferTaka = ESSENTIALS_PER_DAY_TAKA * 7;
  candidates.push({
    id: "buffer_payday",
    titleBn: "বেতনের দিন এক সপ্তাহের বাফার রাখুন",
    titleEn: "Hold a one-week buffer on salary day",
    detailBn: `বেতন আসামাত্র খরচ শুরুর আগে প্রায় ${formatTaka(bufferTaka, "bn")} (এক সপ্তাহের আবশ্যক খরচ) আলাদা রাখলে মাসের শেষের টানাপোড়েন কমে।`,
    detailEn: `Setting aside about ${formatTaka(bufferTaka, "en")} (one week of essentials) right when income arrives softens the end-of-month trough.`,
    category: "cashflow",
    freedMonthly: null,
    freedDaily: 0,
    oneTime: bufferTaka,
  });

  // Counterfactual over the same paths — recalibrated with the SAME Platt
  // coefficients as the baseline so the two probabilities share one scale.
  const actions: PersonaAction[] = candidates.map((c) => {
    const freedDailyPaisa = (c.freedDaily * 100);
    const oneTimePaisa = c.oneTime * 100;
    const { p: rawP, safe } = pShortfallOfAdjusted(base.pathsPaisa, base.windowDays, base.floorPaisa, freedDailyPaisa, oneTimePaisa);
    const p = recalibrate(rawP, base.platt ?? undefined);
    return {
      action_id: c.id,
      title_bn: c.titleBn,
      title_en: c.titleEn,
      detail_bn: c.detailBn,
      detail_en: c.detailEn,
      category: c.category,
      shortfall_prob_before: Math.round(base.pShortfall * 10000) / 10000,
      shortfall_prob_after: Math.round(p * 10000) / 10000,
      delta_shortfall_prob: Math.round((p - base.pShortfall) * 10000) / 10000,
      freed_monthly_taka: c.freedMonthly,
      safe_to_spend_after_taka: Math.round(safe / 100),
    };
  });
  actions.sort((a, b) => a.delta_shortfall_prob - b.delta_shortfall_prob);
  return { actions, base };
}
