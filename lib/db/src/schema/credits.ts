import { sql } from "drizzle-orm";
import { bigint, foreignKey, index, integer, pgTable, text, timestamp, uniqueIndex, varchar } from "drizzle-orm/pg-core";
import { usersTable } from "./auth";

/**
 * An account's credits (launch Phase 7, plan PLAN_PHASE7_IMAGE_OFFERING.md §1;
 * migration 0171). One row per change; the balance is the sum of an account's
 * rows, derived by `artifacts/api-server/src/lib/credits/ledger.ts`, the only
 * writer in application code (`scripts/check-credit-ledger-writer.mjs`).
 *
 * A grant row is a LOT (`lotId` null, positive credits). A row that draws on a
 * lot or restores it names the lot, so a lot's unspent count is its credits
 * plus the rows that name it. `(kind, ref, lot)` is unique, so a retried write
 * is a no-op. Append-only by trigger: no UPDATE, and no DELETE except the
 * cascade from the account's own deletion. The free credit is written by a
 * trigger on `users` the first time an account is verified. The kinds and
 * their shape are the migration's `credit_ledger_lot_shape_check`.
 */
export const CREDIT_LEDGER_KINDS = ["free_grant", "admin_grant", "admin_debit"] as const;
export type CreditLedgerKind = (typeof CREDIT_LEDGER_KINDS)[number];

export const creditLedgerTable = pgTable("credit_ledger", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  userId: varchar("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  kind: varchar("kind", { length: 32 }).$type<CreditLedgerKind>().notNull(),
  credits: integer("credits").notNull(),
  ref: varchar("ref", { length: 128 }).notNull(),
  lotId: bigint("lot_id", { mode: "number" }),
  note: text("note"),
  /** Who it was, with no foreign key: an admin's own deletion changes no ledger row; `actorLabel` is what is shown. */
  actorId: varchar("actor_id"),
  actorLabel: text("actor_label"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  foreignKey({ columns: [t.lotId], foreignColumns: [t.id], name: "credit_ledger_lot_id_credit_ledger_id_fk" }),
  uniqueIndex("UQ_credit_ledger_kind_ref_lot").on(t.kind, t.ref, sql`(COALESCE(${t.lotId}, 0))`),
  index("IDX_credit_ledger_user").on(t.userId, t.id),
  index("IDX_credit_ledger_lot").on(t.lotId).where(sql`${t.lotId} IS NOT NULL`),
]);
