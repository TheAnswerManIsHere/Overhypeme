/**
 * Shared helpers for versioned enrichment (stale-fact refresh).
 *
 * The versioning model: `facts.*` is the SOLE active enrichment truth;
 * `fact_enrichment_versions` is an append-only archive + in-flight candidate
 * store (statuses candidate | promoted | superseded | rejected). A send-back
 * creates a candidate, the candidate enrichment job fills it, moderation
 * previews it, approve promotes it into `facts.*`, reject retains it.
 */

import crypto from "node:crypto";

/**
 * Hash of the RAW fact text a candidate was classified against. Stored on the
 * candidate at send-back and re-checked at promote so a candidate built for an
 * older fact text is never silently promoted after the text was edited.
 * Single source of truth — both the send-back primitive and the promote drift
 * guard must hash via THIS function so the comparison is apples-to-apples.
 */
export function hashFactText(text: string): string {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}
