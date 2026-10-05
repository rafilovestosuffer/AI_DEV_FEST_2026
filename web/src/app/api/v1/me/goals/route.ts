import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import {
  userIdFromRequest, ensurePersonaUser, buildEvidence, ok, unauthorized, notFound, badRequest,
} from "@/lib/server/sathiApi";
import { formatTaka } from "@/lib/engine/formatting";
import { GOAL_TYPES } from "@/lib/engine/sathiConfig";

export const dynamic = "force-dynamic";

/** List saved goals (reference: GET /v1/me/goals). */
export async function GET(req: NextRequest) {
  try {
    const personaId = userIdFromRequest(req);
    if (!personaId) return unauthorized();
    const user = await ensurePersonaUser(personaId).catch(() => null);
    if (!user) return notFound();
    const goals = await db.goal.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
    });

    const data = {
      goals: goals.map((g) => ({
        id: g.id,
        name: g.name,
        goal_type: g.name.toLowerCase().includes("emergency") ? "emergency_fund" : "other",
        target_paisa: g.targetAmount * 100,
        target_display: formatTaka(g.targetAmount, "bn"),
        target_date: g.targetDate.toISOString().slice(0, 10),
        saved_so_far_paisa: g.savedSoFar * 100,
        saved_so_far_display: formatTaka(g.savedSoFar, "bn"),
        monthly_commitment_paisa: g.monthlyCommitment * 100,
        status: g.status,
      })),
      goal_types: GOAL_TYPES,
    };
    const evidence = buildEvidence({
      nTransactions: 0,
      windowStart: new Date().toISOString().slice(0, 10),
      asOfDate: new Date().toISOString().slice(0, 10),
      labels: { goals: "Data" },
    });
    return ok(data, evidence);
  } catch (e) {
    console.error("[v1 goals GET]", e);
    return notFound("Goals failed");
  }
}

/** Save a chosen plan as a goal (reference: POST /v1/me/goals). */
export async function POST(req: NextRequest) {
  try {
    const personaId = userIdFromRequest(req);
    if (!personaId) return unauthorized();
    const user = await ensurePersonaUser(personaId).catch(() => null);
    if (!user) return notFound();

    const body = (await req.json().catch(() => null)) as
      | { name?: string; goal_type?: string; target_paisa?: number; months?: number; monthly_contribution_paisa?: number }
      | null;
    const targetPaisa = body?.target_paisa;
    // Same upper bound as the legacy twin POST /api/goals (targetAmount ≤
    // ৳100,000,000, expressed here in paisa) — an unbounded target would let
    // a hostile client fabricate absurd monthly commitments.
    if (!targetPaisa || !Number.isFinite(targetPaisa) || targetPaisa <= 0 || targetPaisa > 10_000_000_000) {
      return badRequest("target_paisa must be a positive amount up to 10,000,000,000 (৳100,000,000)");
    }

    const months = Math.max(1, Math.min(36, body?.months ?? 6));
    const monthly = body?.monthly_contribution_paisa
      ? Math.round(body.monthly_contribution_paisa / 100)
      : Math.ceil(targetPaisa / 100 / months);

    const goal = await db.goal.create({
      data: {
        userId: user.id,
        name: body?.name ?? (body?.goal_type ?? "goal").replace(/_/g, " "),
        targetAmount: Math.round(targetPaisa / 100),
        targetDate: new Date(Date.now() + months * 30.44 * 24 * 3600 * 1000),
        savedSoFar: 0,
        monthlyCommitment: monthly,
        status: "active",
      },
    });

    const data = {
      id: goal.id,
      name: goal.name,
      target_paisa: goal.targetAmount * 100,
      target_display: formatTaka(goal.targetAmount, "bn"),
      months,
      monthly_contribution_paisa: goal.monthlyCommitment * 100,
      monthly_contribution_display: formatTaka(goal.monthlyCommitment, "bn"),
      status: goal.status,
      note: "No money moves — this records the plan only.",
    };
    const evidence = buildEvidence({
      nTransactions: 0,
      windowStart: new Date().toISOString().slice(0, 10),
      asOfDate: new Date().toISOString().slice(0, 10),
      labels: { goal_saved: "Data" },
    });
    return ok(data, evidence);
  } catch (e) {
    console.error("[v1 goals POST]", e);
    return notFound("Goal save failed");
  }
}
