/**
 * Backfill: retire the never-valid "They's" render from stored fact templates
 * by expanding subject-pronoun 's contractions into an explicit {is|are} pair
 * ("{Subj}'s unstoppable" → "{Subj} {is|are} unstoppable"; legacy "{He's}
 * unstoppable" → "{Subj} {is|are} unstoppable").
 *
 * "'s" after a subject-pronoun token is ambiguous ("is" vs "has") and, for
 * they/them, renders the never-valid "They's". Every template-writing route
 * now expands this deterministically at ingress
 * (`expandSubjectContractions` inside `applyDeterministicGrammar`), and the
 * renderer has a defense-in-depth fallback for old text — but rows written
 * BEFORE this PR may still store the raw contraction or the legacy `{He's}`/
 * `{he's}` token. This backfill repairs those existing rows.
 *
 * Runs ONLY the deterministic `expandSubjectContractionsForBackfill` pure
 * transform (see `../src/lib/expandSubjectContractionBackfill.ts`) — no LLM
 * call, no cost — so it's safe and idempotent (running it twice equals
 * running it once). It does NOT re-tokenize.
 *
 * Row states:
 *   - rows with a subject-pronoun contraction → expanded to {is|are} (changed)
 *   - rows without one → no-op (left untouched, counted as scanned)
 *   - INACTIVE staging facts → included (do NOT filter to isActive=true;
 *     moderation staging facts need the repair before approval)
 *   - pending_reviews.submittedText → included (no derived columns there;
 *     canonical/split are computed later at staging-fact creation)
 *   - facts with an in-flight refresh candidate → the candidate's
 *     fact_text_hash is re-stamped to hash the new text, so the promote drift
 *     guard (REFRESH_STALE_TEXT) doesn't strand a mid-review refresh over this
 *     meaning-preserving grammar repair
 *
 * For each changed fact it recomputes the text-derived set the fact-creation
 * path keeps in sync (canonicalText, splitTokenIndex, hasPronouns) —
 * expanding the contraction adds a conjugation-pair token, which can flip
 * hasPronouns to true.
 *
 * Every transformed row is asserted to pass `validateTemplate()` before being
 * written — the legacy `{He's}`/`{he's}` token is NOT in the closed grammar
 * set, so this backfill is also what makes those rows newly valid.
 *
 * No re-embed: canonicalText only gains an explicit auxiliary a viewer would
 * already infer from "'s", negligible for duplicate search (same rationale as
 * backfill-conjugate-verbs.ts).
 *
 * Recovery: not automatically reversible, but every change is printed as a
 * was/now pair — run --dry-run first and keep the apply log.
 *
 * Usage (from repo root):
 *   pnpm --filter @workspace/api-server exec tsx scripts/backfill-expand-subject-contractions.ts --dry-run
 *   pnpm --filter @workspace/api-server exec tsx scripts/backfill-expand-subject-contractions.ts --apply
 *   pnpm --filter @workspace/api-server exec tsx scripts/backfill-expand-subject-contractions.ts --fact-id 123 --dry-run
 *
 * Defaults to --dry-run (reports, writes nothing). --apply is required to mutate.
 */

import { installStdioGuard } from "../src/lib/stdioGuard";
installStdioGuard();

import { db } from "@workspace/db";
import { factsTable, pendingReviewsTable, factEnrichmentVersionsTable } from "@workspace/db/schema";
import { and, eq } from "drizzle-orm";
import { expandSubjectContractionsForBackfill } from "../src/lib/expandSubjectContractionBackfill";
import { validateTemplate } from "../src/lib/templateGrammar";
import { hashFactText } from "../src/lib/enrichmentVersioning";
import { renderCanonical } from "../src/lib/renderCanonical";
import { computeSplitTokenIndex } from "../src/lib/splitTokenIndex";

// Same detector the fact-creation path uses (facts.ts / normalizeFactTemplateForStorage.ts)
// — kept identical so the backfilled `hasPronouns` flag matches what a fresh insert would compute.
const HAS_PRONOUN_RE =
  /\{(SUBJ|OBJ|POSS|POSS_PRO|REFL|Subj|Obj|Poss|Poss_Pro|Refl|he|him|his|himself|He|Him|His|Himself|he's|He's|[^|{}]+\|[^|{}]+)\}/;

function parseArgs(argv: string[]) {
  const apply = argv.includes("--apply");
  const dryRun = argv.includes("--dry-run") || !apply; // default: dry-run
  let factId: number | undefined;
  const idIdx = argv.indexOf("--fact-id");
  if (idIdx !== -1) {
    const raw = argv[idIdx + 1];
    const parsed = Number(raw);
    if (!raw || !Number.isInteger(parsed)) {
      console.error(`[backfill] --fact-id requires an integer id (got: ${raw ?? "nothing"})`);
      process.exit(1);
    }
    factId = parsed;
  }
  return { apply, dryRun, factId };
}

async function main() {
  const { apply, factId } = parseArgs(process.argv.slice(2));
  console.log(
    `[backfill] mode=${apply ? "APPLY (writes)" : "DRY-RUN (no writes)"}` +
      (factId !== undefined ? ` fact-id=${factId}` : " (all facts + all pending reviews)"),
  );

  let changed = 0;
  let invalidSkipped = 0;

  // ── facts.text (ALL facts, incl. inactive staging facts) ──────────────────
  const facts = factId !== undefined
    ? await db.select({ id: factsTable.id, text: factsTable.text }).from(factsTable).where(eq(factsTable.id, factId))
    : await db.select({ id: factsTable.id, text: factsTable.text }).from(factsTable);
  console.log(`[backfill] scanning ${facts.length} fact(s)...`);
  for (const fact of facts) {
    const next = expandSubjectContractionsForBackfill(fact.text);
    if (next === fact.text) continue;

    const grammarResult = validateTemplate(next);
    if (!grammarResult.valid) {
      invalidSkipped++;
      console.warn(
        `[facts #${fact.id}] SKIPPED — transformed text fails validateTemplate: ${grammarResult.error}\n  was: ${fact.text}\n  now: ${next}`,
      );
      continue;
    }

    changed++;
    console.log(`[facts #${fact.id}]\n  was: ${fact.text}\n  now: ${next}`);
    if (apply) {
      await db
        .update(factsTable)
        .set({
          text: next,
          canonicalText: renderCanonical(next),
          splitTokenIndex: computeSplitTokenIndex(next),
          hasPronouns: HAS_PRONOUN_RE.test(next),
        })
        .where(eq(factsTable.id, fact.id));
      // An in-flight refresh candidate stores hashFactText(facts.text) and the
      // promote path 409s (REFRESH_STALE_TEXT) on mismatch. This expansion is a
      // deterministic, meaning-preserving grammar repair — the candidate's
      // classification is still valid — so re-stamp its hash instead of
      // stranding the refresh mid-review.
      const restamped = await db
        .update(factEnrichmentVersionsTable)
        .set({ factTextHash: hashFactText(next) })
        .where(
          and(
            eq(factEnrichmentVersionsTable.factId, fact.id),
            eq(factEnrichmentVersionsTable.status, "candidate"),
          ),
        )
        .returning({ id: factEnrichmentVersionsTable.id });
      if (restamped.length > 0) {
        console.log(`  (re-stamped fact_text_hash on in-flight candidate #${restamped[0].id})`);
      }
    }
  }

  // ── pending_reviews.submittedText (skipped when --fact-id targets one fact) ─
  if (factId === undefined) {
    const reviews = await db
      .select({ id: pendingReviewsTable.id, submittedText: pendingReviewsTable.submittedText })
      .from(pendingReviewsTable);
    console.log(`[backfill] scanning ${reviews.length} pending review(s)...`);
    for (const review of reviews) {
      const next = expandSubjectContractionsForBackfill(review.submittedText);
      if (next === review.submittedText) continue;

      const grammarResult = validateTemplate(next);
      if (!grammarResult.valid) {
        invalidSkipped++;
        console.warn(
          `[pending_reviews #${review.id}] SKIPPED — transformed text fails validateTemplate: ${grammarResult.error}\n  was: ${review.submittedText}\n  now: ${next}`,
        );
        continue;
      }

      changed++;
      console.log(`[pending_reviews #${review.id}]\n  was: ${review.submittedText}\n  now: ${next}`);
      if (apply) {
        await db
          .update(pendingReviewsTable)
          .set({ submittedText: next })
          .where(eq(pendingReviewsTable.id, review.id));
      }
    }
  }

  console.log(
    `\n[backfill] done. changed=${changed} invalid_skipped=${invalidSkipped}` +
      (apply ? " (written)" : " (dry-run — re-run with --apply to write)"),
  );
  process.exit(0);
}

void main();
