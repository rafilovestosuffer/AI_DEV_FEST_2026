/**
 * Sathi v1 API server layer — ported concepts from the reference repo's
 * api/ package: auth (demo-login tokens), in-memory sliding-window rate
 * limits, the evidence block attached to every insight-bearing response,
 * and persona user resolution on top of this app's Prisma store.
 *
 * The reference FastAPI service is faithfully reproduced as Next.js route
 * handlers under /api/v1/*, envelope-shaped: { data, evidence }.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { User } from "@prisma/client";
import { ensureSchema } from "@/lib/server/ensureSchema";
import { SATHI_PERSONAS, generateSathiPersonaHistory } from "@/lib/engine/sathiPersonas";
import {
  FEES, THRESHOLDS, configHash,
} from "@/lib/engine/sathiConfig";
import { formatTaka } from "@/lib/engine/formatting";
import { MODEL_VERSION } from "@/lib/engine/domain";
import { KNOWLEDGE_CORPUS } from "@/lib/engine/knowledge";
import type { Txn } from "@/lib/engine/domain";

/* ---------------- auth: demo-login tokens ---------------- */

const TOKEN_TTL_MS = 24 * 3600 * 1000;
// When the env secret is unset, derive a random per-instance secret instead
// of shipping a shared constant (tokens then simply re-issue after a cold
// start — the demo login flow handles that).
const DEMO_SECRET = process.env.SATHI_JWT_SECRET || randomBytes(32).toString("hex");

/** Mint a signed demo token: base64(payload).signature. */
export function mintDemoToken(userId: string): string {
  const payload = Buffer.from(JSON.stringify({ sub: userId, exp: Date.now() + TOKEN_TTL_MS })).toString("base64url");
  const sig = createHmac("sha256", DEMO_SECRET).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

/** Verify a demo token; returns the persona user id or null. */
export function verifyDemoToken(token: string): string | null {
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  const expected = createHmac("sha256", DEMO_SECRET).update(payload).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { sub: string; exp: number };
    if (Date.now() > parsed.exp) return null;
    return parsed.sub;
  } catch {
    return null;
  }
}

/** Extract + verify the Bearer token from a request. */
export function userIdFromRequest(req: NextRequest): string | null {
  const auth = req.headers.get("authorization") ?? "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return m ? verifyDemoToken(m[1]) : null;
}

/* ---------------- rate limiting (in-memory sliding window) ---------------- */

const buckets = new Map<string, number[]>();

export function rateLimit(key: string, limitPerWindow: number, windowMs = 60_000): boolean {
  const now = Date.now();
  const arr = (buckets.get(key) ?? []).filter((t) => now - t < windowMs);
  if (arr.length >= limitPerWindow) {
    buckets.set(key, arr);
    return false;
  }
  arr.push(now);
  buckets.set(key, arr);
  return true;
}

export function clientKey(req: NextRequest, route: string): string {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  return `${route}:${ip}`;
}

/* ---------------- LLM kill switch + daily budget ---------------- */

/** Env-driven kill switch: set SATHI_LLM_ENABLED=false to disable every LLM
 * call (both chat surfaces fall back to deterministic templates). */
export const LLM_ENABLED = process.env.SATHI_LLM_ENABLED !== "false";

/** Per-instance daily LLM call budget (SATHI_LLM_DAILY_CAP, default 1000).
 * Serverless instances are ephemeral; the provider dashboard limit remains
 * the real cap — this is defense in depth. */
export function llmBudgetAllowed(cap = Number(process.env.SATHI_LLM_DAILY_CAP ?? 1000)): boolean {
  const day = new Date().toISOString().slice(0, 10);
  const used = llmSpend.get(day) ?? 0;
  if (used >= cap) return false;
  llmSpend.set(day, used + 1);
  return true;
}
const llmSpend = new Map<string, number>();

/* ---------------- persona user resolution ---------------- */

/**
 * Ensure a Sathi persona user exists with seeded synthetic history
 * (idempotent, deterministic per persona). The main UI's demo user is
 * untouched; persona users power the /api/v1 surface.
 *
 * Resolution is role-scoped: a user row only counts as the persona when its
 * role is "persona". If the device OWNER happens to be named "Rina Begum"
 * (the garment_worker persona's name), that owner row must NEVER be
 * returned here — the owner's personal ledger stays out of the demo-persona
 * API and a fresh persona user is seeded instead.
 */
export async function ensurePersonaUser(personaId: string): Promise<User> {
  await ensureSchema(); // cold-start safe: creates tables on a fresh database
  const spec = SATHI_PERSONAS[personaId];
  if (!spec) throw new NotFoundError(`Unknown persona: ${personaId}`);
  const existing = await db.user.findFirst({ where: { name: spec.name, role: "persona" } });
  if (existing) {
    const kbCount = await db.knowledgeDoc.count();
    if (kbCount === 0) await seedKnowledgeDocs();
    return existing;
  }

  const anchor = new Date();
  const { txns, openingBalance } = generateSathiPersonaHistory(personaId, anchor, hashSeed(personaId));
  const user = await db.user.create({
    data: {
      name: spec.name,
      role: "persona", // never mixed into the owner's data
      preferredLanguage: "bn",
      salaryAmount: personaId === "garment_worker" ? 18000 : null,
      salaryPayDay: personaId === "garment_worker" ? 7 : null,
      openingBalance,
    },
  });
  await db.transaction.createMany({
    data: txns.map((t) => ({
      userId: user.id,
      timestamp: t.timestamp,
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
  });
  const kbCount = await db.knowledgeDoc.count();
  if (kbCount === 0) await seedKnowledgeDocs();
  return user;
}

function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % 100000;
}

async function seedKnowledgeDocs(): Promise<void> {
  await db.knowledgeDoc.createMany({
    data: KNOWLEDGE_CORPUS.map((c) => ({
      sourceId: c.sourceId,
      title: c.title,
      topic: c.topic,
      chunkText: c.chunkText,
    })),
  });
}

/* ---------------- evidence block (api/services/evidence.py) ---------------- */

export interface AssumptionNote {
  id: string;
  value: string;
  label: string;
}

export interface Evidence {
  data_used: { window: string; as_of_date: string; n_transactions: number; source: string };
  model_version: { forecast: string; categorizer: string };
  config_hash: string;
  assumptions: AssumptionNote[];
  labels: Record<string, string>;
  generated_text: boolean;
  prompt_version: string | null;
  validator: { passed: boolean; fallback_used: boolean };
}

export function buildEvidence(params: {
  nTransactions: number;
  windowStart: string;
  asOfDate: string;
  labels: Record<string, string>;
  forecastVersion?: string;
  generatedText?: boolean;
  promptVersion?: string | null;
  validatorPassed?: boolean;
  fallbackUsed?: boolean;
  extraAssumptions?: AssumptionNote[];
}): Evidence {
  const a: AssumptionNote[] = [
    {
      id: "FEE_CASHOUT_RATE",
      value: `${FEES.cash_out_bps} bps, min ${formatTaka(FEES.cash_out_min_paisa, "en")}`,
      label: "Illustrative cash-out fee to an agent",
    },
    { id: "FEE_DIGITAL_PAYMENT_RATE", value: `${FEES.digital_payment_bps} bps`, label: "Merchant payments assumed free" },
    { id: "ESSENTIALS_PER_DAY", value: formatTaka(THRESHOLDS.essentials_per_day_paisa / 100, "en"), label: "Minimum daily essential spend" },
    { id: "SHORTFALL_HORIZON_DAYS", value: String(THRESHOLDS.shortfall_horizon_days), label: "Shortfall alert lookahead" },
    ...(params.extraAssumptions ?? []),
  ];
  return {
    data_used: {
      window: `${params.windowStart}…${params.asOfDate}`,
      as_of_date: params.asOfDate,
      n_transactions: params.nTransactions,
      source: "synthetic wallet history (seeded, no PII)",
    },
    model_version: {
      forecast: params.forecastVersion ?? MODEL_VERSION,
      categorizer: "rules-v1 (reason trace per transaction)",
    },
    config_hash: configHash(),
    assumptions: a,
    labels: params.labels,
    generated_text: params.generatedText ?? false,
    prompt_version: params.promptVersion ?? null,
    validator: {
      passed: params.validatorPassed ?? true,
      fallback_used: params.fallbackUsed ?? false,
    },
  };
}

/* ---------------- responses ---------------- */

export class NotFoundError extends Error {}

export function ok(data: unknown, evidence: Evidence): NextResponse {
  return NextResponse.json({ data, evidence });
}

export function notFound(message = "User not found"): NextResponse {
  return NextResponse.json({ error: { code: "not_found", message } }, { status: 404 });
}

export function unauthorized(): NextResponse {
  return NextResponse.json(
    { error: { code: "unauthorized", message: "Missing or invalid Bearer token. POST /api/v1/auth/demo-login first." } },
    { status: 401 },
  );
}

export function tooMany(): NextResponse {
  return NextResponse.json(
    { error: { code: "rate_limited", message: "Too many requests — try again in a minute." } },
    { status: 429 },
  );
}

export function badRequest(message: string): NextResponse {
  return NextResponse.json({ error: { code: "bad_request", message } }, { status: 400 });
}

/* ---------------- persona transaction loading ---------------- */

export async function personaTxns(userId: number): Promise<{ txns: Txn[]; user: User }> {
  const user = await db.user.findUnique({ where: { id: userId } });
  if (!user) throw new NotFoundError("User not found");
  const rows = await db.transaction.findMany({
    where: { userId },
    orderBy: { timestamp: "asc" },
  });
  return {
    user,
    txns: rows.map((t) => ({
      id: t.id,
      timestamp: t.timestamp.toISOString(),
      amount: t.amount,
      currency: t.currency,
      direction: t.direction as "in" | "out",
      category: t.category,
      subcategory: t.subcategory,
      merchant: t.merchant,
      channel: t.channel,
      source: t.source,
      classificationConfidence: t.classificationConfidence,
    })),
  };
}

/** Resolve the persona for a persona-seeded user by name — role-scoped:
 * only demo-persona sessions resolve; an owner named like a persona (e.g.
 * "Rina Begum") reports "custom", never the persona. */
export function personaOfUser(user: User): { id: string; labelBn: string; labelEn: string } {
  if (user.role !== "persona") {
    return { id: "custom", labelBn: "কাস্টম", labelEn: "Custom" };
  }
  for (const p of Object.values(SATHI_PERSONAS)) {
    if (p.name === user.name) return { id: p.id, labelBn: p.labelBn, labelEn: p.labelEn };
  }
  return { id: "custom", labelBn: "কাস্টম", labelEn: "Custom" };
}
