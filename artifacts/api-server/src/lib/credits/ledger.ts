/**
 * @purpose An account's credits (launch Phase 7, plan PLAN_PHASE7_IMAGE_OFFERING.md §1): the balance derived from the append-only ledger, its entries, and an admin's adjustment, which draws a debit from the oldest lots first. The one writer of `credit_ledger` in application code (scripts/check-credit-ledger-writer.mjs); the free credit is granted by a database trigger when an account is first verified (migration 0171).
 * @subsystem membership
 */
import { db, creditLedgerTable, usersTable, type CreditLedgerKind } from "@workspace/db";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Executor } from "../visualConceptOwner";

/** The most one admin adjustment may move, either way: a typo guard, not a policy. */
export const ADMIN_ADJUSTMENT_MAX = 1000;
export const ADMIN_ADJUSTMENT_NOTE_MAX = 1000;
const CREDIT_LEDGER_PAGE = 100;

export interface CreditEntry {
  id: number;
  kind: CreditLedgerKind;
  credits: number;
  lotId: number | null;
  note: string | null;
  actorLabel: string | null;
  createdAt: Date;
}

/** An account's balance: the sum of its ledger rows (0 when it has none). */
export async function creditBalance(userId: string, executor: Executor = db): Promise<number> {
  const [row] = await executor
    .select({ balance: sql<number>`COALESCE(SUM(${creditLedgerTable.credits}), 0)::int` })
    .from(creditLedgerTable)
    .where(eq(creditLedgerTable.userId, userId));
  return row?.balance ?? 0;
}

/** An account's most recent ledger entries, newest first. */
export async function creditEntries(userId: string, limit = CREDIT_LEDGER_PAGE, executor: Executor = db): Promise<CreditEntry[]> {
  return executor
    .select({
      id: creditLedgerTable.id,
      kind: creditLedgerTable.kind,
      credits: creditLedgerTable.credits,
      lotId: creditLedgerTable.lotId,
      note: creditLedgerTable.note,
      actorLabel: creditLedgerTable.actorLabel,
      createdAt: creditLedgerTable.createdAt,
    })
    .from(creditLedgerTable)
    .where(eq(creditLedgerTable.userId, userId))
    .orderBy(desc(creditLedgerTable.id))
    .limit(limit);
}

/** Each lot of an account with credits left, oldest first: its credits plus every row that names it. */
async function openLots(userId: string, executor: Executor): Promise<Array<{ lotId: number; remaining: number }>> {
  const drawn = sql<number>`COALESCE((SELECT SUM(d.credits) FROM credit_ledger d WHERE d.lot_id = ${creditLedgerTable.id}), 0)::int`;
  const rows = await executor
    .select({ lotId: creditLedgerTable.id, remaining: sql<number>`(${creditLedgerTable.credits} + ${drawn})::int` })
    .from(creditLedgerTable)
    .where(and(eq(creditLedgerTable.userId, userId), isNull(creditLedgerTable.lotId)))
    .orderBy(asc(creditLedgerTable.id));
  return rows.filter((r) => r.remaining > 0);
}

export class CreditAdjustmentError extends Error {
  constructor(public readonly code: "user_not_found" | "insufficient_balance" | "request_reused", message: string) {
    super(message);
    this.name = "CreditAdjustmentError";
  }
}

export interface AdminAdjustment {
  userId: string;
  /** Non-zero; positive adds a lot, negative draws from the oldest lots. */
  credits: number;
  note: string;
  /** The admin's own id for this adjustment, so a retry is the same adjustment (a no-op). */
  requestId: string;
  admin: { id: string; label: string };
}

/**
 * Apply an admin's adjustment under a lock on the account, so it cannot race a
 * spend or another adjustment. A request id already used for this account and
 * this amount returns `applied: false` and changes nothing; reused for anything
 * else, it is refused. A debit never takes the balance below zero (plan §1: a
 * balance goes negative only by a refund or dispute).
 */
export async function applyAdminAdjustment(input: AdminAdjustment): Promise<{ applied: boolean; balance: number }> {
  return db.transaction(async (tx) => {
    const [account] = await tx.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.id, input.userId)).for("update").limit(1);
    if (!account) throw new CreditAdjustmentError("user_not_found", "User not found");

    const kind: CreditLedgerKind = input.credits > 0 ? "admin_grant" : "admin_debit";
    const earlier = await tx
      .select({ userId: creditLedgerTable.userId, credits: creditLedgerTable.credits })
      .from(creditLedgerTable)
      .where(and(inArray(creditLedgerTable.kind, ["admin_grant", "admin_debit"]), eq(creditLedgerTable.ref, input.requestId)));
    if (earlier.length > 0) {
      const same = earlier.every((r) => r.userId === input.userId) && earlier.reduce((s, r) => s + r.credits, 0) === input.credits;
      if (!same) throw new CreditAdjustmentError("request_reused", "This adjustment id was already used for a different adjustment.");
      return { applied: false, balance: await creditBalance(input.userId, tx) };
    }

    const row = { userId: input.userId, kind, ref: input.requestId, note: input.note, actorId: input.admin.id, actorLabel: input.admin.label };
    const rows: Array<typeof row & { credits: number; lotId?: number }> = [];
    if (kind === "admin_grant") {
      rows.push({ ...row, credits: input.credits });
    } else {
      let owed = -input.credits;
      const lots = await openLots(input.userId, tx);
      if (lots.reduce((s, l) => s + l.remaining, 0) < owed) {
        throw new CreditAdjustmentError("insufficient_balance", "The account does not hold that many credits.");
      }
      for (const lot of lots) {
        if (owed === 0) break;
        const take = Math.min(lot.remaining, owed);
        rows.push({ ...row, credits: -take, lotId: lot.lotId });
        owed -= take;
      }
    }
    await tx.insert(creditLedgerTable).values(rows);
    return { applied: true, balance: await creditBalance(input.userId, tx) };
  });
}
