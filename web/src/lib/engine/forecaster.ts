/**
 * Inference for the irregular-flow quantile forecaster — port of the
 * reference ml/inference.py (ML handoff, commit 7e4f6a0).
 *
 * One call turns a user's transaction history into simulated wallet paths:
 *
 *   1. panel.ts builds the leakage-safe origin features (history <= origin),
 *   2. the 9 LightGBM quantile boosters predict the daily irregular net flow,
 *      sorted (no crossing) and widened by the split-conformal correction,
 *   3. recurringStreams.detectStreams finds salary/rent/bill streams,
 *   4. liquidity.ts draws block-correlated paths (rho from calibration).
 *
 * Everything user-facing is a functional of those paths: P(shortfall), trough
 * day, daily balance bands and the model-based safe-to-spend. The same code
 * path serves the API and the tests, so train/serve skew cannot appear.
 * The boosters are the exact artifacts the Python pipeline trained
 * (bit-identical predictions, see tests/fixtures/lgb-predictions.json).
 *
 * Fail-closed: when the artifacts are unavailable the loader returns null and
 * callers fall back to the deterministic rule / bootstrap baselines.
 */

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import type { Txn } from "./domain";
import { mulberry32 } from "./rng";
import { parseLgbModel, predictLgb, type LgbModel } from "./lightgbm";
import {
  buildPanel, panelIndexOf, panelStreamsAt, OriginFeatures, TAUS, FEATURES,
  type PanelTxn, type UserPanel,
} from "./panel";
import { sampleStreamFlows, simulateLiquidityPaths } from "./liquidity";
import { safeToSpendFromPaths } from "./safeToSpend";
import type { Day } from "./timeutils";

/* ---------------- artifacts loading ---------------- */

export interface Calibration {
  taus: number[];
  conformal_widen_scaled: number;
  rho: number;
  block_days: number;
  shortfall_platt?: { a: number; b: number };
  [k: string]: unknown;
}

export interface Forecaster {
  version: string;
  metadata: Record<string, unknown>;
  calibration: Calibration;
  boosters: Map<number, LgbModel>;
}

let cachedForecaster: Forecaster | null | undefined;

function artifactsDir(): string {
  const custom = process.env.SATHI_ML_ARTIFACTS;
  if (custom) return custom;
  const candidates = [
    path.join(process.cwd(), "ml-artifacts", "forecast"),
    path.join(process.cwd(), "..", "ml-artifacts", "forecast"),
  ];
  for (const c of candidates) {
    if (existsSync(path.join(c, "latest.json"))) return c;
  }
  return candidates[0]!;
}

/**
 * Load the latest model version once per process (null when the artifacts
 * are missing — callers must treat that as "model unavailable", never crash).
 */
export function getForecaster(): Forecaster | null {
  if (cachedForecaster !== undefined) return cachedForecaster;
  try {
    const dir = artifactsDir();
    const version = (
      JSON.parse(readFileSync(path.join(dir, "latest.json"), "utf8")) as { version: string }
    ).version;
    const folder = path.join(dir, version);
    const metadata = JSON.parse(readFileSync(path.join(folder, "metadata.json"), "utf8"));
    const calibration = JSON.parse(
      readFileSync(path.join(folder, "calibration.json"), "utf8"),
    ) as Calibration;
    const boosters = new Map<number, LgbModel>();
    for (const t of TAUS) {
      const file = path.join(folder, `model_q${String(Math.round(t * 100)).padStart(2, "0")}.txt`);
      boosters.set(t, parseLgbModel(readFileSync(file, "utf8")));
    }
    cachedForecaster = { version, metadata, calibration, boosters };
  } catch (e) {
    console.warn("[forecaster] artifacts unavailable, falling back:", (e as Error).message);
    cachedForecaster = null;
  }
  return cachedForecaster;
}

/** Test hook: drop the cached forecaster (next call reloads). */
export function resetForecasterCache(): void {
  cachedForecaster = undefined;
}

/* ---------------- CRC32 stable seed (ml/inference.py stable_seed) ---------------- */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? (0xedb88320 ^ (c >>> 1)) >>> 0 : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** zlib.crc32-compatible unsigned 32-bit checksum of a string. */
export function crc32(s: string): number {
  let c = 0xffffffff;
  for (let i = 0; i < s.length; i++) {
    c = CRC_TABLE[(c ^ s.charCodeAt(i)) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** Process-independent seed (Python's hash() is salted per process). */
export function stableSeed(...parts: (string | number)[]): number {
  return crc32(parts.map(String).join("|"));
}

/* ---------------- forecast ---------------- */

export interface UserForecast {
  modelVersion: string;
  origin: Day;
  horizonDays: number;
  /** (P, H+1) wallet balance paths, paisa; column 0 = today. */
  paths: number[][];
  floorPaisa: number;
  /** Shortfall window used for pShortfall. */
  windowDays: number;
  /** P(balance < floor within windowDays), Platt-recalibrated. */
  pShortfall: number;
  /** Platt coefficients recalibrate() applied to pShortfall (null when the
   *  artifacts ship none) — counterfactuals over these paths MUST reuse them
   *  so before/after probabilities share one scale. */
  shortfallPlatt: { a: number; b: number } | null;
  /** Median argmin day (1 = tomorrow); null when the window is empty. */
  troughDay: number | null;
  /** Q_0.10(min balance over window) - floor. */
  safeToSpendPaisa: number;
  daysToIncome: number;
  cashOnHandPaisa: number;
  /** (H, T) predicted irregular-flow quantiles, paisa. */
  irregularQuantiles: number[][];
  confidence: "normal" | "low";
}

export interface ForecastOptions {
  festivalDays: Set<string>;
  floorDays: number;
  nPaths: number;
  seed: number;
  windowDays?: number;
  alpha?: number;
  conformal?: boolean;
  minHistoryDays?: number;
}

/** Platt map fitted on held-out users (ml/calibrate.py); identity if absent. */
export function recalibrate(p: number, coef?: { a: number; b: number }): number {
  if (!coef) return p;
  const q = Math.min(Math.max(p, 1e-3), 1 - 1e-3);
  const z = coef.a * Math.log(q / (1 - q)) + coef.b;
  return 1 / (1 + Math.exp(-z));
}

function medianInt(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

/**
 * (H, T) scale-free quantiles for the given feature rows: one booster per
 * tau, sorted per row (quantiles never cross), then conformally widened.
 */
export function quantiles(fc: Forecaster, X: number[][], conformal = true): number[][] {
  const raw: number[][] = X.map(() => new Array<number>(TAUS.length));
  for (let ti = 0; ti < TAUS.length; ti++) {
    const tau = TAUS[ti]!;
    const booster = fc.boosters.get(tau)!;
    for (let r = 0; r < X.length; r++) {
      raw[r]![ti] = predictLgb(booster, X[r]!);
    }
  }
  const widen = conformal ? Number(fc.calibration.conformal_widen_scaled) : 0;
  return raw.map((row) => {
    const sorted = [...row].sort((a, b) => a - b);
    return sorted.map((v, ti) => v + (widen * (TAUS[ti]! - 0.5)) / 0.4);
  });
}

/** Forecast from the end of `origin` (all data <= origin is known). */
export function forecastPanel(
  fc: Forecaster,
  panel: UserPanel,
  origin: Day,
  horizon: number,
  opts: ForecastOptions,
): UserForecast {
  const i = panelIndexOf(panel, origin);
  const fb = new OriginFeatures(panel, opts.festivalDays);
  const streams = panelStreamsAt(panel, origin);
  const state = fb.originState(i, streams);
  const ks = Array.from({ length: horizon }, (_, h) => h + 1);
  const X = fb.targetRows(state, origin, ks);
  const scale = fb.scale(i);
  const conformal = opts.conformal ?? true;
  const qScaled = quantiles(fc, X, conformal).map((row) => row.map((v) => v * scale)); // (H, T) paisa

  const rand = mulberry32(opts.seed);
  const sched = sampleStreamFlows(streams, origin, horizon, opts.nPaths, rand);
  const startBal = panel.eodBalance[i]!;
  const start = Number.isNaN(startBal) ? 0 : Math.trunc(startBal);
  const paths = simulateLiquidityPaths(
    start,
    qScaled,
    TAUS,
    sched,
    Number(fc.calibration.rho),
    Math.trunc(Number(fc.calibration.block_days)),
    rand,
  );

  const floor = Math.trunc(fb.floor(i, opts.floorDays));
  const toIncome = state._timing.daysToNextIncome + 1; // days from origin
  const window =
    opts.windowDays !== undefined ? opts.windowDays : Math.min(Math.max(toIncome, 7), horizon);
  const mins: number[] = [];
  const argmins: number[] = [];
  for (const p of paths) {
    let min = Infinity;
    let argmin = 1;
    for (let d = 1; d <= window; d++) {
      if (p[d]! < min) {
        min = p[d]!;
        argmin = d;
      }
    }
    mins.push(min);
    argmins.push(argmin);
  }
  const rawP = mins.length ? mins.filter((m) => m < floor).length / mins.length : 0;
  const p = recalibrate(rawP, fc.calibration.shortfall_platt);
  const trough = argmins.length ? medianInt(argmins) : null;
  const [cash] = fb.cashEstimate(i, streams);
  return {
    modelVersion: fc.version,
    origin,
    horizonDays: horizon,
    paths,
    floorPaisa: floor,
    windowDays: window,
    pShortfall: p,
    shortfallPlatt: fc.calibration.shortfall_platt ?? null,
    troughDay: window >= 1 ? trough : null,
    safeToSpendPaisa: safeToSpendFromPaths(
      paths.map((p) => p.slice(0, window + 1)),
      floor,
      opts.alpha ?? 0.1,
    ),
    daysToIncome: toIncome,
    cashOnHandPaisa: Math.trunc(cash),
    irregularQuantiles: qScaled,
    confidence: i + 1 < (opts.minHistoryDays ?? 30) ? "low" : "normal",
  };
}

/** Forecast from the app's transaction shape (taka → paisa, ledger replay). */
export function forecastTransactions(
  fc: Forecaster,
  userId: string,
  txns: Txn[],
  openingBalanceTaka: number,
  origin: Day,
  horizon: number,
  opts: ForecastOptions,
): UserForecast {
  const panelTxns = toPanelTxns(txns, openingBalanceTaka).filter((t) => t.day <= origin);
  const panel = buildPanel(userId, panelTxns, origin);
  return forecastPanel(fc, panel, origin, horizon, opts);
}

/* ---------------- app-txn → reference-shape adapter ---------------- */

/**
 * Map this app's transactions (whole taka, category/merchant) onto the
 * reference wallet shape (type + counterparty + paisa + balance_after).
 *
 * Types keep the reference vocabulary so stream keys group the way the
 * models expect: salary_in / remittance_in / cash_in / cash_out / p2m_out /
 * p2p_out / topup / bill_pay. Fees are 0 in the persona ledger (the
 * cash-out fee audit is a separate analytical view).
 *
 * Days are the UTC calendar days of the stored wall-clock timestamps — the
 * same convention the persona generator and the v1 API use (the generator
 * writes Dhaka wall clocks as UTC instants of the same date). balance_after
 * is reconstructed with the documented insufficient-balance rule: inflows
 * land first each day; an outflow larger than the balance is skipped. Only
 * the day's final ledger event carries a balance, so the panel's
 * end-of-day value is exact regardless of within-day ordering.
 */
export function toPanelTxns(txns: Txn[], openingBalanceTaka: number): PanelTxn[] {
  const sorted = [...txns].sort(
    (a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp),
  );
  let balance = Math.max(0, Math.round(openingBalanceTaka)) * 100;

  const byDay = new Map<Day, number[]>();
  sorted.forEach((t, idx) => {
    const day = Math.floor(Date.parse(t.timestamp) / 86400000);
    const arr = byDay.get(day) ?? [];
    arr.push(idx);
    byDay.set(day, arr);
  });

  const balanceAfter = new Map<number, number>();
  for (const day of [...byDay.keys()].sort((a, b) => a - b)) {
    const idxs = byDay.get(day)!;
    const inflows = idxs.filter((ix) => sorted[ix]!.direction === "in");
    const outflows = idxs.filter((ix) => sorted[ix]!.direction === "out");
    let lastKept: number | null = null;
    for (const ix of inflows) {
      balance += Math.round(sorted[ix]!.amount) * 100;
      balanceAfter.set(ix, balance);
      lastKept = ix;
    }
    for (const ix of outflows) {
      const amt = Math.round(sorted[ix]!.amount) * 100;
      if (amt > balance) continue; // paid late or in cash — skipped
      balance -= amt;
      balanceAfter.set(ix, balance);
      lastKept = ix;
    }
    if (lastKept !== null) {
      // only the day's final event keeps a value; the panel forward-fills
      for (const ix of idxs) if (ix !== lastKept) balanceAfter.delete(ix);
    }
  }

  return sorted.map((t, ix) => {
    const day = Math.floor(Date.parse(t.timestamp) / 86400000);
    const sub = t.subcategory ?? "";
    const cat = t.category ?? "";
    let type: string;
    if (t.direction === "in") {
      if (sub === "salary") type = "salary_in";
      else if (sub === "remittance") type = "remittance_in";
      else type = "cash_in";
    } else if (cat === "cash_out") type = "cash_out";
    else if (sub === "rent" || sub === "family") type = "p2p_out";
    else if (sub === "supplier") type = "p2m_out";
    else if (cat === "mobile_topup") type = "topup";
    else if (cat === "utilities") type = "bill_pay";
    else type = "p2m_out";
    const counterparty = t.merchant ?? sub ?? cat ?? "wallet";
    return {
      day,
      type,
      amountPaisa: Math.round(t.amount) * 100,
      feePaisa: 0,
      counterpartyId: counterparty,
      balanceAfterPaisa: balanceAfter.has(ix) ? balanceAfter.get(ix)! : null,
    };
  });
}

