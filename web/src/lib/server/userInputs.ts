/**
 * User-submitted liquidity inputs (mission P0) — server-side persistence +
 * the effective-liquidity blend.
 *
 * Liquidity = wallet + effective cash-on-hand + other user-declared liquid
 * funds. The behavioral estimate guesses pocket cash from the cash-out
 * rhythm; a user declaration overrides it and then DECAYS forward at the
 * observed daily cash burn, so a stale declaration never overstates
 * liquidity. A cash-out is never treated as money vanishing — it leaves the
 * wallet and re-enters the pocket estimate subject to burn.
 *
 * Storage: the UserInput table (ensureSchema DDL; raw SQL here so the
 * Prisma client does not need regeneration in CI).
 */
import { db } from "@/lib/db";
import { ensureSchema } from "@/lib/server/ensureSchema";
import type { Txn } from "@/lib/engine/domain";

export interface UserInputsRow {
  cashOnHandTaka: number | null;
  cashOnHandUpdatedAt: Date | null;
  incomeDay: number | null;
  rentAmountTaka: number | null;
  rentConfirmed: boolean;
  otherLiquidTaka: number | null;
  updatedAt: Date | null;
}

export interface UserInputsPatch {
  cashOnHandTaka?: number | null;
  incomeDay?: number | null;
  rentAmountTaka?: number | null;
  rentConfirmed?: boolean | null;
  otherLiquidTaka?: number | null;
}

const DAY_MS = 24 * 3600 * 1000;
/** How many days a user cash declaration stays authoritative. */
export const DECLARATION_TTL_DAYS = 14;

interface RawRow {
  cashOnHandTaka: number | bigint | null;
  cashOnHandUpdatedAt: Date | string | null;
  incomeDay: number | bigint | null;
  rentAmountTaka: number | bigint | null;
  rentConfirmed: number | bigint | null;
  otherLiquidTaka: number | bigint | null;
  updatedAt: Date | string | null;
}

function normalize(r: RawRow | undefined): UserInputsRow {
  if (!r) {
    return {
      cashOnHandTaka: null, cashOnHandUpdatedAt: null, incomeDay: null,
      rentAmountTaka: null, rentConfirmed: false, otherLiquidTaka: null, updatedAt: null,
    };
  }
  const num = (v: number | bigint | null): number | null =>
    v === null ? null : Number(v);
  const date = (v: Date | string | null): Date | null =>
    v === null ? null : v instanceof Date ? v : new Date(String(v));
  return {
    cashOnHandTaka: num(r.cashOnHandTaka),
    cashOnHandUpdatedAt: date(r.cashOnHandUpdatedAt),
    incomeDay: num(r.incomeDay),
    rentAmountTaka: num(r.rentAmountTaka),
    rentConfirmed: Number(r.rentConfirmed ?? 0) === 1,
    otherLiquidTaka: num(r.otherLiquidTaka),
    updatedAt: date(r.updatedAt),
  };
}

export async function getUserInputs(userId: number): Promise<UserInputsRow> {
  await ensureSchema();
  const rows = await db.$queryRawUnsafe(
    `SELECT "cashOnHandTaka", "cashOnHandUpdatedAt", "incomeDay", "rentAmountTaka",
            "rentConfirmed", "otherLiquidTaka", "updatedAt"
     FROM "UserInput" WHERE "userId" = ? LIMIT 1`,
    userId,
  ) as RawRow[];
  return normalize(rows[0]);
}

export async function upsertUserInputs(userId: number, patch: UserInputsPatch): Promise<UserInputsRow> {
  await ensureSchema();
  const current = await getUserInputs(userId);
  const now = new Date();

  const cash = patch.cashOnHandTaka !== undefined ? patch.cashOnHandTaka : current.cashOnHandTaka;
  const cashAt = patch.cashOnHandTaka !== undefined ? now : current.cashOnHandUpdatedAt;
  const incomeDay = patch.incomeDay !== undefined ? patch.incomeDay : current.incomeDay;
  const rent = patch.rentAmountTaka !== undefined ? patch.rentAmountTaka : current.rentAmountTaka;
  const rentConfirmed = patch.rentConfirmed !== undefined ? patch.rentConfirmed : current.rentConfirmed;
  const other = patch.otherLiquidTaka !== undefined ? patch.otherLiquidTaka : current.otherLiquidTaka;

  await db.$executeRawUnsafe(
    `INSERT INTO "UserInput" ("userId", "cashOnHandTaka", "cashOnHandUpdatedAt", "incomeDay",
                             "rentAmountTaka", "rentConfirmed", "otherLiquidTaka", "updatedAt")
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT("userId") DO UPDATE SET
       "cashOnHandTaka" = excluded."cashOnHandTaka",
       "cashOnHandUpdatedAt" = excluded."cashOnHandUpdatedAt",
       "incomeDay" = excluded."incomeDay",
       "rentAmountTaka" = excluded."rentAmountTaka",
       "rentConfirmed" = excluded."rentConfirmed",
       "otherLiquidTaka" = excluded."otherLiquidTaka",
       "updatedAt" = excluded."updatedAt"`,
    userId, cash, cashAt, incomeDay, rent, rentConfirmed ? 1 : 0, other, now,
  );
  return getUserInputs(userId);
}

/**
 * Behavioral pocket-cash estimate (same formula the v1 summary used:
 * ~30% of the trailing 21-day cash-out total is assumed still unspent),
 * plus the observed trailing total and daily burn.
 */
export function behavioralCash(txns: Txn[], anchor: Date): { estimateTaka: number; burnTakaPerDay: number; trailingTotalTaka: number } {
  const recent = txns.filter(
    (t) => t.direction === "out" && t.category === "cash_out" &&
      new Date(t.timestamp).getTime() > anchor.getTime() - 21 * DAY_MS,
  );
  const total = recent.reduce((s, t) => s + t.amount, 0);
  return { estimateTaka: Math.round(total * 0.3), burnTakaPerDay: total / 21, trailingTotalTaka: total };
}

/**
 * Blend a user declaration with the behavioral estimate. A fresh declaration
 * wins and decays at the observed burn; past the TTL the behavioral estimate
 * takes over again. Returns the taka value actually used + a provenance string.
 */
export function effectiveCashOnHand(
  txns: Txn[],
  anchor: Date,
  declaredTaka: number | null,
  declaredAt: Date | null,
): { cashTaka: number; source: string } {
  const behavioral = behavioralCash(txns, anchor);
  if (declaredTaka === null || !declaredAt) {
    return { cashTaka: behavioral.estimateTaka, source: "estimated (cash-out rhythm)" };
  }
  const ageDays = Math.max(0, Math.floor((anchor.getTime() - declaredAt.getTime()) / DAY_MS));
  if (ageDays > DECLARATION_TTL_DAYS) {
    return { cashTaka: behavioral.estimateTaka, source: "estimated (declaration expired)" };
  }
  const decayed = Math.max(0, Math.round(declaredTaka - behavioral.burnTakaPerDay * ageDays));
  return { cashTaka: decayed, source: `user-declared, decayed ${ageDays}d at observed burn` };
}
