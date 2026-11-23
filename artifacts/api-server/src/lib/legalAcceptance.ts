/**
 * @purpose Which legal documents an account must accept and at which versions (the Terms, agreed to, and the Privacy page, acknowledged; launch Phase 14, increment 4), the SQL the session loader uses to read "has a row at the current version of each", and the one write path, which checks the versions a client names against the current ones server-side so an old or invented version is never recorded.
 * @subsystem accounts-auth
 */
import { db } from "@workspace/db";
import { legalAcceptancesTable, LEGAL_ACCEPTANCE_DOCUMENTS, usersTable, type LegalAcceptanceDocument } from "@workspace/db/schema";
import { CURRENT_LEGAL_VERSIONS } from "@workspace/db/legal-versions";
import { sql, type SQL } from "drizzle-orm";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** The version of each document an account must hold an acceptance at now. Read from the generated module, so it is the version the page shows. */
export function requiredLegalVersions(): Readonly<Record<LegalAcceptanceDocument, string>> {
  return { terms: CURRENT_LEGAL_VERSIONS.terms, privacy: CURRENT_LEGAL_VERSIONS.privacy };
}

/**
 * True for a `usersTable` row that holds an acceptance of every required
 * document at its current version. One EXISTS per document, each on the
 * (user, document, version) index.
 */
export function legalAcceptedExpr(): SQL<boolean> {
  const required = requiredLegalVersions();
  const clauses = LEGAL_ACCEPTANCE_DOCUMENTS.map(
    (doc) => sql`EXISTS (SELECT 1 FROM ${legalAcceptancesTable} la
      WHERE la.user_id = ${usersTable.id} AND la.document = ${doc} AND la.version = ${required[doc]})`,
  );
  return sql<boolean>`(${sql.join(clauses, sql` AND `)})`;
}

export type AcceptanceCheck = { ok: true } | { ok: false; error: string; code: "LEGAL_VERSION_OUTDATED" | "LEGAL_ACCEPTANCE_MISSING" };

/**
 * Checks a client's `{ terms, privacy }` against the current versions. A
 * missing one means the box was not ticked; a different one means the page
 * the person read is no longer current, and they are asked to read it again.
 */
export function checkAcceptance(body: unknown): AcceptanceCheck {
  const given = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const required = requiredLegalVersions();
  for (const doc of LEGAL_ACCEPTANCE_DOCUMENTS) {
    const v = given[doc];
    if (typeof v !== "string" || v.length === 0) {
      return { ok: false, error: "Agree to the Terms and acknowledge the Privacy Policy to continue.", code: "LEGAL_ACCEPTANCE_MISSING" };
    }
    if (v !== required[doc]) {
      return { ok: false, error: "The Terms or the Privacy Policy changed since this page loaded. Reload to read the current version.", code: "LEGAL_VERSION_OUTDATED" };
    }
  }
  return { ok: true };
}

/**
 * Records an acceptance of every required document at its current version in
 * one insert; a document the account already holds at that version is skipped
 * by the unique index, so a repeated click or a race adds nothing. Insert-only:
 * nothing updates or deletes a row.
 */
export async function recordLegalAcceptance(tx: Tx | typeof db, userId: string, now: Date = new Date()): Promise<void> {
  const required = requiredLegalVersions();
  await tx
    .insert(legalAcceptancesTable)
    .values(LEGAL_ACCEPTANCE_DOCUMENTS.map((document) => ({ userId, document, version: required[document], acceptedAt: now })))
    .onConflictDoNothing();
}
