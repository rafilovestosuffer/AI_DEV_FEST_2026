/**
 * Counterfactual action engine regression tests (mission P1).
 *
 * Locks in the audit fixes around /api/v1/me/actions:
 *  - H1: the counterfactual shortfall probability MUST pass through the SAME
 *    Platt recalibration as the baseline forecast (forecaster.ts
 *    recalibrate() with the shipped calibration.shortfall_platt, a≈0.778).
 *    Mixing a raw simulation p with a recalibrated baseline previously made
 *    some actions show POSITIVE risk deltas (risk-increasing suggestions).
 *  - Scale-free invariants that must hold on every date: delta ≤ 0, ranking
 *    by delta ascending, 4-decimal rounding never contradicts itself, and an
 *    empty ledger degrades gracefully instead of crashing.
 *
 * Run: bun test tests/sathi-actions.test.ts
 */
import { describe, expect, test } from "bun:test";
import type { User } from "@prisma/client";
import { personaActions, personaRisk } from "../src/lib/server/personaActions";
import { recalibrate, getForecaster } from "../src/lib/engine/forecaster";
import { generateSathiPersonaHistory, SATHI_PERSONAS } from "../src/lib/engine/sathiPersonas";
import { ESSENTIALS_PER_DAY_TAKA } from "../src/lib/engine/sathiConfig";
import type { Txn } from "../src/lib/engine/domain";

/** The five demo personas the v1 surface ships. */
const PERSONA_IDS = ["garment_worker", "gig_driver", "remittance_household", "shopkeeper", "student"] as const;

/** Same synthetic history the server seeds for a persona (production seed). */
function personaSeed(personaId: string): number {
  let h = 2166136261;
  for (let i = 0; i < personaId.length; i++) {
    h ^= personaId.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % 100000;
}

function mkUser(personaId: string, openingBalance: number): User {
  return {
    id: 1,
    name: SATHI_PERSONAS[personaId]!.name,
    role: "persona",
    preferredLanguage: "bn",
    mode: "demo",
    salaryAmount: personaId === "garment_worker" ? 18000 : null,
    salaryPayDay: personaId === "garment_worker" ? 7 : null,
    salaryMerchant: null,
    openingBalance,
    createdAt: new Date(),
  } as unknown as User;
}

/** Persona ledger in the app's Txn shape, anchored at today (as the server does). */
function personaLedger(personaId: string): { user: User; txns: Txn[] } {
  const { txns, openingBalance } = generateSathiPersonaHistory(
    personaId, new Date(), personaSeed(personaId),
  );
  return {
    user: mkUser(personaId, openingBalance),
    txns: txns.map((t, i) => ({
      id: i,
      timestamp: t.timestamp.toISOString(),
      amount: t.amount,
      currency: t.currency,
      direction: t.direction,
      category: t.category,
      subcategory: t.subcategory,
      merchant: t.merchant,
      channel: t.channel,
      source: t.source,
      classificationConfidence: t.classificationConfidence,
    })),
  };
}

/** Raw (uncalibrated) counterfactual P(shortfall) for a one-time cash buffer —
 * mirrors pShortfallOfAdjusted() with freedDaily = 0. */
function rawBufferShortfallP(
  base: NonNullable<ReturnType<typeof personaRisk>>,
  oneTimePaisa: number,
): number {
  let hits = 0;
  for (const path of base.pathsPaisa) {
    let min = Infinity;
    for (let d = 1; d <= base.windowDays && d < path.length; d++) {
      const v = path[d]! + oneTimePaisa;
      if (v < min) min = v;
    }
    if (min < base.floorPaisa) hits++;
  }
  return base.pathsPaisa.length ? hits / base.pathsPaisa.length : 0;
}

const round4 = (x: number) => Math.round(x * 10000) / 10000;
/** buffer_payday's fixed counterfactual: one week of essentials, one-time. */
const BUFFER_PAISA = ESSENTIALS_PER_DAY_TAKA * 7 * 100;

describe("counterfactual action engine (Platt scale fix + invariants)", () => {
  test("every persona: all action deltas are ≤ 0 — suggestions never increase risk", () => {
    expect(Object.keys(SATHI_PERSONAS).sort()).toEqual([...PERSONA_IDS].sort());
    let sawNegativeDelta = false;
    for (const personaId of PERSONA_IDS) {
      const { user, txns } = personaLedger(personaId);
      const { actions, base } = personaActions(user, txns);
      expect(base).not.toBeNull();
      // buffer_payday is always offered, so a persona with history always
      // gets at least one actionable suggestion.
      expect(actions.length).toBeGreaterThanOrEqual(1);
      for (const a of actions) {
        expect(Number.isFinite(a.delta_shortfall_prob)).toBe(true);
        expect(a.delta_shortfall_prob).toBeLessThanOrEqual(0);
        expect(a.shortfall_prob_after).toBeLessThanOrEqual(a.shortfall_prob_before);
        if (a.delta_shortfall_prob < 0) sawNegativeDelta = true;
      }
    }
    // Liveness: the counterfactual engine genuinely reduces risk somewhere.
    expect(sawNegativeDelta).toBe(true);
  });

  test("Platt recalibration is monotone — ordering of probabilities is preserved", () => {
    const fc = getForecaster();
    const shipped = fc?.calibration.shortfall_platt;
    // The artifacts ship the Platt map fitted on held-out users (a≈0.778>0).
    expect(shipped).toBeTruthy();
    expect(shipped!.a).toBeGreaterThan(0);

    const grid = [0.001, 0.01, 0.05, 0.125, 0.25, 0.5, 0.75, 0.9, 0.999];
    for (const coef of [shipped!, { a: 2.5, b: 1.0 }, { a: 0.1, b: -3 }] as const) {
      const calibrated = grid.map((p) => recalibrate(p, coef));
      for (let i = 1; i < calibrated.length; i++) {
        expect(calibrated[i]!).toBeGreaterThanOrEqual(calibrated[i - 1]!);
      }
      // strictly increasing on the interior for a > 0
      expect(recalibrate(0.25, coef)).toBeLessThan(recalibrate(0.75, coef));
      for (const c of calibrated) {
        expect(c).toBeGreaterThan(0);
        expect(c).toBeLessThan(1);
      }
    }
    // Identity when no coefficients are shipped (bootstrap fallback scale).
    for (const p of grid) {
      expect(recalibrate(p, undefined)).toBe(p);
    }
  });

  test("actions are ranked by delta_shortfall_prob ascending (best first)", () => {
    for (const personaId of PERSONA_IDS) {
      const { user, txns } = personaLedger(personaId);
      const { actions } = personaActions(user, txns);
      expect(actions.length).toBeGreaterThanOrEqual(1);
      for (let i = 1; i < actions.length; i++) {
        expect(actions[i - 1]!.delta_shortfall_prob).toBeLessThanOrEqual(actions[i]!.delta_shortfall_prob);
      }
      // re-sorting by delta reproduces the shipped order (stable sort)
      const resorted = [...actions].sort((a, b) => a.delta_shortfall_prob - b.delta_shortfall_prob);
      expect(resorted.map((a) => a.action_id)).toEqual(actions.map((a) => a.action_id));
    }
  });

  test("empty ledger fails safe: no crash, no fabricated actions, buffer still offered when a baseline exists", () => {
    const { user } = personaLedger("garment_worker");
    // 1. No history at all → null base, empty action list, never a throw.
    expect(personaRisk(user, [])).toBeNull();
    expect(personaActions(user, [])).toEqual({ actions: [], base: null });

    // 2. History with nothing trimmable and fewer than 3 cash-outs → the
    //    unconditional payday-buffer suggestion is still produced.
    const { txns } = personaLedger("garment_worker");
    const sparse = txns.filter(
      (t) => t.direction === "in" || t.category === "housing" || t.category === "utilities",
    );
    const { actions, base } = personaActions(user, sparse);
    if (base) {
      expect(actions.length).toBe(1);
      expect(actions[0]!.action_id).toBe("buffer_payday");
      expect(actions[0]!.delta_shortfall_prob).toBeLessThanOrEqual(0);
    } else {
      expect(actions).toEqual([]);
    }
  });

  test("rounding-invariant: delta never contradicts after − before at the 4-decimal rounding tolerance", () => {
    for (const personaId of PERSONA_IDS) {
      const { user, txns } = personaLedger(personaId);
      const { actions } = personaActions(user, txns);
      for (const a of actions) {
        const implied = a.shortfall_prob_after - a.shortfall_prob_before;
        // each of the three fields rounds independently to 4 decimals
        expect(Math.abs(a.delta_shortfall_prob - implied)).toBeLessThanOrEqual(1.5e-4 + 1e-9);
      }
    }
  });

  test("rounding-invariant: probabilities stay in [0,1] and rounding never flips the direction", () => {
    for (const personaId of PERSONA_IDS) {
      const { user, txns } = personaLedger(personaId);
      const { actions, base } = personaActions(user, txns);
      expect(base).not.toBeNull();
      expect(base!.pShortfall).toBeGreaterThanOrEqual(0);
      expect(base!.pShortfall).toBeLessThanOrEqual(1);
      for (const a of actions) {
        expect(a.shortfall_prob_before).toBeGreaterThanOrEqual(0);
        expect(a.shortfall_prob_before).toBeLessThanOrEqual(1);
        expect(a.shortfall_prob_after).toBeGreaterThanOrEqual(0);
        expect(a.shortfall_prob_after).toBeLessThanOrEqual(1);
        // delta ≤ 0 must imply after ≤ before on the displayed (rounded) values
        if (a.delta_shortfall_prob <= 0) {
          expect(a.shortfall_prob_after).toBeLessThanOrEqual(a.shortfall_prob_before);
        }
      }
    }
  });

  test("counterfactual probabilities use the SAME Platt recalibration as the baseline (H1 scale fix)", () => {
    for (const personaId of PERSONA_IDS) {
      const { user, txns } = personaLedger(personaId);
      const { actions } = personaActions(user, txns);
      const base = personaRisk(user, txns);
      expect(base).not.toBeNull();
      const buffer = actions.find((a) => a.action_id === "buffer_payday");
      expect(buffer).toBeTruthy();

      const rawP = rawBufferShortfallP(base!, BUFFER_PAISA);
      // The engine must publish the RECALIBRATED counterfactual — publishing
      // the raw simulation probability here is the exact H1 regression
      // (mixed scales produced positive deltas before the fix).
      const expected = round4(recalibrate(rawP, base!.platt ?? undefined));
      expect(buffer!.shortfall_prob_after).toBe(expected);
      expect(buffer!.delta_shortfall_prob).toBe(round4(recalibrate(rawP, base!.platt ?? undefined) - base!.pShortfall));
    }
  });
});
