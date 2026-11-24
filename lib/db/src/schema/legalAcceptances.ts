/**
 * @purpose The record of which version of the Terms and the Privacy page each account agreed to, and when (launch Phase 14, increment 4; plan S-b): one row per acceptance, never overwritten, so a re-acceptance after a version change keeps the earlier one as evidence. The verified-actor gate reads only "has a row at the current version".
 * @subsystem accounts-auth
 */
import { pgTable, serial, timestamp, uniqueIndex, varchar } from "drizzle-orm/pg-core";
import { usersTable } from "./auth";

/**
 * Append-only by convention: the code has no update or delete path for it
 * (only the account's own deletion, by cascade). Nothing in the database
 * refuses an UPDATE; that is said here rather than implied (plan, *Data
 * Model*).
 */
export const legalAcceptancesTable = pgTable("legal_acceptances", {
  id: serial("id").primaryKey(),
  userId: varchar("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  /** One of LEGAL_ACCEPTANCE_DOCUMENTS; a CHECK in migration 0162 keeps it so (declared there only, as support_requests' are). */
  document: varchar("document", { length: 20 }).notNull(),
  /** The document's `version` from `docs/legal/<document>.md`, which names exactly one text. */
  version: varchar("version", { length: 40 }).notNull(),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  // One row per (account, document, version): accepting a version twice adds
  // nothing, and a new version is a new row beside the old.
  uniqueIndex("idx_legal_acceptances_user_document").on(t.userId, t.document, t.version),
]);

/** The documents an account accepts: it agrees to the Terms and acknowledges the Privacy page. Kept in sync with the CHECK in 0162. */
export const LEGAL_ACCEPTANCE_DOCUMENTS = ["terms", "privacy"] as const;
export type LegalAcceptanceDocument = (typeof LEGAL_ACCEPTANCE_DOCUMENTS)[number];

export type LegalAcceptance = typeof legalAcceptancesTable.$inferSelect;
