/**
 * Backfill: collapse {NAME}-subject conjugation pairs in stored fact templates
 * ("{NAME} {gives|give} you the finger" → "{NAME} gives you the finger").
 *
 * A {NAME} token renders as a literal singular name for EVERY pronoun set, so a
 * conjugation pair whose subject is {NAME} is wrong by construction — it renders
 * the plural branch ("David give…") for they/them (and plural custom) viewers.
 * The old tokenizer prompt and the old {NAME}-inclusive conjugation net actively
 * CREATED such pairs, so the stored corpus systematically contains them; the
 * grammar contract now keeps pairs only after {SUBJ}/{Subj} and this backfill
 * repairs the existing rows.
 *
 * Runs ONLY the deterministic `collapseNameSubjectConjugationPairs` pass — no
 * LLM call, no cost — so it's safe and idempotent (pure text transform; running
 * it twice equals running it once). It does NOT re-tokenize.
 *
 * Row states:
 *   - rows with a {NAME}-subject pair → collapsed to the singular branch (changed)
 *   - rows without one → no-op (left untouched, counted as scanned)
 *   - INACTIVE staging facts → included (do NOT filter to isActive=true;
 *     moderation staging facts need the repair before approval)
 *   - pending_reviews.submittedText → included (no derived columns there;
 *     canonical/split are computed later at staging-fact creation)
 *
 * For each changed fact it recomputes the text-derived set the fact-creation
 * path keeps in sync (canonicalText, splitTokenIndex, hasPronouns) — collapsing
 * the only conjugation token can correctly flip hasPronouns to false.
 *
 * No re-embed: canonicalText only loses redundant verb-agreement noise,
 * negligible for duplicate search (same rationale as backfill-conjugate-verbs.ts).
 *
 * Recovery: not automatically reversible, but every change is printed as a
 * was/now pair — run --dry-run first and keep the apply log.
 *
 * Usage (from repo root):
 *   pnpm --filter @workspace/api-server exec tsx scripts/backfill-collapse-name-subject-pairs.ts --dry-run
 *   pnpm --filter @workspace/api-server exec tsx scripts/backfill-collapse-name-subject-pairs.ts --apply
 *   pnpm --filter @workspace/api-server exec tsx scripts/backfill-collapse-name-subject-pairs.ts --fact-id 123 --dry-run
 *
 * Defaults to --dry-run (reports, writes nothing). --apply is required to mutate.
 */

import { installStdioGuard } from "../src/lib/stdioGuard";
installStdioGuard();

import { db } from "@workspace/db";
import { factsTable, pendingReviewsTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { collapseNameSubjectConjugationPairs } from "../src/lib/templateGrammar";
import { renderCanonical } from "../src/lib/renderCanonical";
import { computeSplitTokenIndex } from "../src/lib/splitTokenIndex";

// Same detector the fact-creation path uses (facts.ts) — kept identical so the
// backfilled `hasPronouns` flag matches what a fresh insert would compute.
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

  // ── facts.text (ALL facts, incl. inactive staging facts) ──────────────────
  const facts = factId !== undefined
    ? await db.select({ id: factsTable.id, text: factsTable.text }).from(factsTable).where(eq(factsTable.id, factId))
    : await db.select({ id: factsTable.id, text: factsTable.text }).from(factsTable);
  console.log(`[backfill] scanning ${facts.length} fact(s)...`);
  for (const fact of facts) {
    const next = collapseNameSubjectConjugationPairs(fact.text);
    if (next === fact.text) continue;
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
    }
  }

  // ── pending_reviews.submittedText (skipped when --fact-id targets one fact) ─
  if (factId === undefined) {
    const reviews = await db
      .select({ id: pendingReviewsTable.id, submittedText: pendingReviewsTable.submittedText })
      .from(pendingReviewsTable);
    console.log(`[backfill] scanning ${reviews.length} pending review(s)...`);
    for (const review of reviews) {
      const next = collapseNameSubjectConjugationPairs(review.submittedText);
      if (next === review.submittedText) continue;
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
    `\n[backfill] done. changed=${changed}` +
      (apply ? " (written)" : " (dry-run — re-run with --apply to write)"),
  );
  process.exit(0);
}

void main();
