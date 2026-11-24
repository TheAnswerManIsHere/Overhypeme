/**
 * Read-only: how many facts and pending submissions do not satisfy the fact
 * wording house style (plan docs/plans/PLAN_FACT_HOUSE_STYLE.md, the one-time
 * pass's post-release check). After migration 0165 both counts should be 0;
 * a fact counted here is one the pass's SQL twin and `applyHouseStyle`
 * disagree on (houseStyleParity.test.ts names where they can). It also counts
 * facts whose plain-name version is not renderCanonical of their wording
 * (M3). Prints counts and up to ten ids, never wording.
 *
 * Run: pnpm --filter @workspace/api-server exec tsx scripts/check-house-style.ts
 */

import { eq } from "drizzle-orm";
import { db, factsTable, pendingReviewsTable } from "@workspace/db";
import { applyHouseStyle } from "../src/lib/templateGrammar";
import { renderCanonical } from "../src/lib/renderCanonical";

const facts = await db.select({ id: factsTable.id, text: factsTable.text, canonicalText: factsTable.canonicalText }).from(factsTable);
const pending = await db
  .select({ id: pendingReviewsTable.id, text: pendingReviewsTable.submittedText })
  .from(pendingReviewsTable)
  .where(eq(pendingReviewsTable.status, "pending"));

const untidy = (rows: Array<{ id: number; text: string }>) => rows.filter((r) => applyHouseStyle(r.text) !== r.text).map((r) => r.id);
const untidyFacts = untidy(facts);
const untidyPending = untidy(pending);

console.log(`[house-style] facts: ${facts.length}, not in the house style: ${untidyFacts.length}${untidyFacts.length ? ` (ids ${untidyFacts.slice(0, 10).join(", ")})` : ""}`);
console.log(`[house-style] pending submissions: ${pending.length}, not in the house style: ${untidyPending.length}${untidyPending.length ? ` (ids ${untidyPending.slice(0, 10).join(", ")})` : ""}`);
const driftedCanonical = facts.filter((f) => f.canonicalText !== null && f.canonicalText !== renderCanonical(f.text)).map((f) => f.id);
console.log(`[house-style] plain-name versions out of step with their wording: ${driftedCanonical.length}${driftedCanonical.length ? ` (ids ${driftedCanonical.slice(0, 10).join(", ")})` : ""}`);
process.exit(0);
