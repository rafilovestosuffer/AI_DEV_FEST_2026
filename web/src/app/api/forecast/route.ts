import { NextRequest, NextResponse } from "next/server";
import { requireOwner, onboardingRequiredResponse, isOnboardingRequiredError } from "@/lib/server/guard";
import { getUserTransactions, getActiveGoals, recordForecast } from "@/lib/server/data";
import { computeAll } from "@/lib/server/compute";
import { buildActionCards } from "@/lib/engine/actions";
import { shortfallRisk } from "@/lib/engine/ml";
import { calculateSafeToSpend } from "@/lib/engine/safeToSpend";

export const dynamic = "force-dynamic";

/**
 * Full cash-flow forecast: baseline expected flows + ML shortfall risk +
 * safe-to-spend + P1 action cards. Everything carries evidence.
 */
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const horizonDays = Math.min(30, Math.max(3, parseInt(searchParams.get("horizon") ?? "7", 10) || 7));

    const user = await requireOwner();
    const anchor = new Date();
    const txns = await getUserTransactions(user.id);
    const goals = await getActiveGoals(user.id);
    const salary = { amount: user.salaryAmount, payDay: user.salaryPayDay };

    const { intel, cash, fc, risk, sts } = computeAll(txns, anchor, user.openingBalance, salary, horizonDays);
    const activeGoal = goals.find((g) => g.status === "active") ?? null;
    const actions = buildActionCards({ txns, anchor, intel, risk, sts, activeGoal });

    await recordForecast(user.id, {
      horizonDays,
      predictedInflow: fc.expectedInflow,
      predictedOutflow: fc.expectedOutflow,
      shortfallProb: risk.probability,
      pressure: fc.pressure,
      factors: fc.factors,
      modelVersion: `${fc.modelVersion}+${risk.modelVersion}`,
    });

    return NextResponse.json({
      cashOnHand: cash,
      forecast: fc,
      risk,
      safeToSpend: sts,
      actions,
      goal: activeGoal,
    });
  } catch (e) {
    if (isOnboardingRequiredError(e)) return onboardingRequiredResponse();
    console.error("[forecast]", e);
    return NextResponse.json({ error: "Failed to compute forecast" }, { status: 500 });
  }
}

/**
 * P1: simulate an action's impact on risk + safe-to-spend + goal.
 * The simulation is deterministic: it re-runs the engines with adjusted
 * inputs derived from the chosen action.
 */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      actionId?: string;
      extraMonthlySavings?: number;
      cutCategory?: string;
      cutPct?: number;
    };
    const user = await requireOwner();
    const anchor = new Date();
    const txns = await getUserTransactions(user.id);
    const goals = await getActiveGoals(user.id);
    const salary = { amount: user.salaryAmount, payDay: user.salaryPayDay };
    const { intel, cash, risk, sts, capacity } = computeAll(txns, anchor, user.openingBalance, salary);
    const activeGoal = goals.find((g) => g.status === "active") ?? null;

    // Clamp the cut percentage to 0-100 (same bound as /api/goals/simulate,
    // the legacy twin of this simulation endpoint) so a hostile or buggy
    // client cannot inflate freedMonthly without bound.
    const cutPct = typeof body.cutPct === "number" && Number.isFinite(body.cutPct)
      ? Math.max(0, Math.min(100, body.cutPct))
      : undefined;

    // determine freed monthly amount for the action
    let freedMonthly = 0;
    if (body.actionId === "buffer_payday") {
      freedMonthly = Math.max(500, Math.round(capacity * 0.2));
    } else if (body.actionId === "batch_cashouts") {
      freedMonthly = Math.round(intel.cashOut.total * 0.04);
    } else if (body.cutCategory && cutPct) {
      const from90 = anchor.getTime() - 90 * 24 * 3600 * 1000;
      const catSpend = txns
        .filter((t) => new Date(t.timestamp).getTime() >= from90 && t.direction === "out" && t.category === body.cutCategory)
        .reduce((s, t) => s + t.amount, 0) / 3;
      freedMonthly = Math.round(catSpend * (cutPct / 100));
    } else if (body.extraMonthlySavings) {
      freedMonthly = body.extraMonthlySavings;
    }

    // recompute safe-to-spend with the added 7/30 liquidity
    const addedLiquidity = (freedMonthly * 7) / 30;
    const stsAfter = calculateSafeToSpend({
      walletBalance: cash.walletBalance + addedLiquidity,
      upcomingCommitments: sts.upcomingCommitments,
      dailyEssentials: cash.dailyEssentials,
      horizonDays: 7,
      monthlySavingsTarget: Math.round(capacity * 0.3),
    });

    // recompute shortfall risk with the adjusted balance (same model)
    const riskAfter = shortfallRisk(
      txns, anchor, user.openingBalance, cash.walletBalance + addedLiquidity, 7, salary,
    );

    // goal impact
    let goalImpact: { monthsSaved: number | null; gapAfter: number | null } = {
      monthsSaved: null, gapAfter: null,
    };
    if (activeGoal && freedMonthly > 0) {
      const remaining = Math.max(0, activeGoal.targetAmount - activeGoal.savedSoFar);
      const baseMonths = capacity > 0 ? Math.ceil(remaining / capacity) : null;
      const newMonths = capacity + freedMonthly > 0 ? Math.ceil(remaining / (capacity + freedMonthly)) : null;
      const monthsRemaining = Math.max(0.5, Math.round(((new Date(activeGoal.targetDate).getTime() - anchor.getTime()) / (30.44 * 24 * 3600 * 1000)) * 10) / 10);
      const projected = activeGoal.savedSoFar + (capacity + freedMonthly) * monthsRemaining;
      goalImpact = {
        monthsSaved: baseMonths !== null && newMonths !== null ? Math.max(0, baseMonths - newMonths) : null,
        gapAfter: Math.max(0, activeGoal.targetAmount - projected),
      };
    }

    return NextResponse.json({
      actionId: body.actionId ?? "custom",
      freedMonthly,
      before: {
        shortfallProb: risk.probability,
        safeToSpend: sts.safeToSpendTotal,
        dailyBudget: sts.dailySafeBudget,
      },
      after: {
        shortfallProb: riskAfter.probability,
        safeToSpend: stsAfter.safeToSpendTotal,
        dailyBudget: stsAfter.dailySafeBudget,
      },
      goalImpact,
    });
  } catch (e) {
    if (isOnboardingRequiredError(e)) return onboardingRequiredResponse();
    console.error("[forecast POST]", e);
    return NextResponse.json({ error: "Failed to simulate action" }, { status: 500 });
  }
}

