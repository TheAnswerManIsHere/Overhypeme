/**
 * @purpose A member's AI picture and its one credit (launch Phase 7, increment 2; plan PLAN_PHASE7_IMAGE_OFFERING.md §2): the spend drawn when the picture is requested, from the oldest lot with credits left, and its return to that same lot when the picture fails or is refused. Both are written only inside the caller's transaction, under a lock the caller holds.
 * @subsystem membership
 *
 * The ref of both rows is `picture:<attempt id>`, so `(kind, ref, lot)` makes a
 * retried spend or return a no-op (migration 0172's unique key). Migration
 * 0173's triggers refuse a return for a delivered picture and a delivery for a
 * returned one; the caller serialises the two on a lock of the attempt row.
 */
import { and, eq, inArray, sql, type SQL, type AnyColumn } from "drizzle-orm";
import { creditLedgerTable, usersTable } from "@workspace/db";
import type { Executor } from "../visualConceptOwner";
import { creditBalance, openLots } from "./ledger";

const pictureRef = (attemptId: number): string => `picture:${attemptId}`;

/**
 * SQL over a query's attempt-id column: this picture's credit has a spend, or
 * a return, on the ledger. The one statement of both, for the readers that
 * filter attempts in SQL (the in-progress cap and list, and settlement).
 */
export const pictureHasLedgerRow = (kind: "picture_spend" | "picture_return", attemptId: AnyColumn): SQL =>
  sql`EXISTS (SELECT 1 FROM credit_ledger c WHERE c.kind = ${kind} AND c.ref = 'picture:' || ${attemptId}::text)`;

/** The account cannot pay for a picture: no credit, or a balance at or below zero after a reversal. */
export class NoCreditError extends Error {
  readonly code = "no_credit";
  constructor(readonly balance: number) {
    super(balance < 0
      ? "Your balance is below zero after a refund, so a new picture has to wait until more credits arrive."
      : "You have no credits left for a picture.");
    this.name = "NoCreditError";
  }
}

/**
 * Lock the account row for the rest of the caller's transaction, so two
 * requests with one credit cannot both spend it (plan §1: "two simultaneous
 * requests with one credit yield one picture"). Call before reading the balance.
 */
export async function lockAccountForSpend(userId: string, tx: Executor): Promise<void> {
  await tx.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.id, userId)).for("update").limit(1);
}

/**
 * Refuse unless the account can pay: a balance of at least one and a lot with
 * a credit left. The caller holds the account lock (`lockAccountForSpend`).
 */
export async function assertCanSpendPicture(userId: string, tx: Executor): Promise<number> {
  const balance = await creditBalance(userId, tx);
  if (balance < 1) throw new NoCreditError(balance);
  const lots = await openLots(userId, tx);
  if (lots.length === 0) throw new NoCreditError(0);
  return lots[0]!.lotId;
}

/**
 * Draw one credit for this picture from the oldest lot with credits left.
 * Inside the transaction that creates the picture's attempt, under the account
 * lock. Returns the lot it drew on. A second call for the same picture draws
 * nothing more.
 */
export async function spendPictureCredit(userId: string, attemptId: number, tx: Executor): Promise<number> {
  const [already] = await tx.select({ lotId: creditLedgerTable.lotId }).from(creditLedgerTable)
    .where(and(eq(creditLedgerTable.kind, "picture_spend"), eq(creditLedgerTable.ref, pictureRef(attemptId)))).limit(1);
  if (already?.lotId != null) return already.lotId;
  const lotId = await assertCanSpendPicture(userId, tx);
  await tx.insert(creditLedgerTable).values({ userId, kind: "picture_spend", credits: -1, ref: pictureRef(attemptId), lotId });
  return lotId;
}

/**
 * Return this picture's credit to the lot it came from. Inside the caller's
 * transaction, which holds the lock on the attempt row. True when a return was
 * written now; false when there was nothing to return or it was already
 * returned. Refused by the database if the picture was delivered.
 */
export async function returnPictureCredit(attemptId: number, tx: Executor): Promise<boolean> {
  const spent = await tx.select({ userId: creditLedgerTable.userId, credits: creditLedgerTable.credits, lotId: creditLedgerTable.lotId })
    .from(creditLedgerTable)
    .where(and(eq(creditLedgerTable.kind, "picture_spend"), eq(creditLedgerTable.ref, pictureRef(attemptId))));
  if (spent.length === 0) return false;
  const rows = spent.map((s) => ({ userId: s.userId, kind: "picture_return" as const, credits: -s.credits, ref: pictureRef(attemptId), lotId: s.lotId! }));
  const written = await tx.insert(creditLedgerTable).values(rows).onConflictDoNothing().returning({ id: creditLedgerTable.id });
  return written.length > 0;
}

/** Whether this picture's credit was spent and whether it was returned. */
export async function pictureCreditState(attemptId: number, tx: Executor): Promise<{ spent: boolean; returned: boolean }> {
  const returned = await returnedPictures([attemptId], tx);
  const rows = await tx.select({ id: creditLedgerTable.id }).from(creditLedgerTable)
    .where(and(eq(creditLedgerTable.kind, "picture_spend"), eq(creditLedgerTable.ref, pictureRef(attemptId)))).limit(1);
  return { spent: rows.length > 0, returned: returned.has(attemptId) };
}

/** Which of these pictures had their credit returned: one query, on the (kind, ref) index. */
export async function returnedPictures(attemptIds: number[], tx: Executor): Promise<Set<number>> {
  if (attemptIds.length === 0) return new Set();
  const rows = await tx.select({ ref: creditLedgerTable.ref }).from(creditLedgerTable)
    .where(and(eq(creditLedgerTable.kind, "picture_return"), inArray(creditLedgerTable.ref, attemptIds.map(pictureRef))));
  return new Set(rows.map((r) => Number(r.ref.slice("picture:".length))));
}
