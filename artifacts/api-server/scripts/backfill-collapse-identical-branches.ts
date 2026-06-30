/**
 * Backfill: collapse identical conjugation branches in stored fact templates
 * ("{NAME} {can|can} fly" → "{NAME} can fly"). Non-conjugating verbs (modals like
 * can/will/should) have the same he/she and they form, so the LLM tokenizer
 * sometimes wrapped them into a useless duplicate pair. Both branches render
 * identically, so this is an output-preserving cleanup.
 *
 * Runs ONLY the deterministic `collapseIdenticalConjugationBranches` pass — no LLM
 * call, no cost — so it's safe and idempotent. It does NOT re-tokenize.
 *
 * Scans BOTH durable surfaces:
 *   - facts.text — ALL facts, including INACTIVE staging facts (do NOT filter to
 *     isActive=true; moderation staging facts need the cleanup before approval).
 *     For each changed fact it recomputes the text-derived set the fact-creation
 *     path keeps in sync (canonicalText, splitTokenIndex, hasPronouns) — collapsing
 *     the only conjugation token can correctly flip hasPronouns to false.
 *   - pending_reviews.submittedText — the moderation review template (no derived
 *     columns; canonical/split are computed later at staging-fact creation).
 *
 * No re-embed: canonicalText only loses redundant verb-agreement noise, negligible
 * for duplicate search (same rationale as backfill-conjugate-verbs.ts).
 *
 * Usage (from repo root):
 *   pnpm --filter @workspace/api-server exec tsx scripts/backfill-collapse-identical-branches.ts --dry-run
 *   pnpm --filter @workspace/api-server exec tsx scripts/backfill-collapse-identical-branches.ts --apply
 *   pnpm --filter @workspace/api-server exec tsx scripts/backfill-collapse-identical-branches.ts --fact-id 123 --dry-run
 *
 * Defaults to --dry-run (reports, writes nothing). --apply is required to mutate.
 */

import { installStdioGuard } from "../src/lib/stdioGuard";
installStdioGuard();

import { db } from "@workspace/db";
import { factsTable, pendingReviewsTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { collapseIdenticalConjugationBranches } from "../src/lib/templateGrammar";
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
    const next = collapseIdenticalConjugationBranches(fact.text);
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
      const next = collapseIdenticalConjugationBranches(review.submittedText);
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
