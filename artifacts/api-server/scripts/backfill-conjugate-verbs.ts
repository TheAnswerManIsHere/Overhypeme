/**
 * Backfill: repair missed person-subject verb conjugations in stored fact
 * templates ("{Subj} keeps" → "{Subj} {keeps|keep}", which fixes "They keeps").
 *
 * This runs ONLY the deterministic `autoConjugatePersonSubjectVerbs` pass — no
 * LLM call, no cost — so it's safe, idempotent, and targets exactly the reported
 * bug without re-tokenizing (and possibly regressing) already-correct templates.
 *
 * For every changed fact it recomputes the full text-derived set the
 * fact-creation path keeps in sync (text, canonicalText, splitTokenIndex,
 * hasPronouns); `updatedAt` is bumped automatically by the schema's $onUpdate.
 * It does NOT re-embed — the embedding source (canonicalText) only shifts verb
 * agreement, which is negligible for duplicate search; run an embedding repair
 * separately if perfect alignment is ever wanted.
 *
 * Usage (from repo root):
 *   pnpm --filter @workspace/api-server exec tsx scripts/backfill-conjugate-verbs.ts --dry-run
 *   pnpm --filter @workspace/api-server exec tsx scripts/backfill-conjugate-verbs.ts --apply
 *   pnpm --filter @workspace/api-server exec tsx scripts/backfill-conjugate-verbs.ts --fact-id 123 --dry-run
 *   pnpm --filter @workspace/api-server exec tsx scripts/backfill-conjugate-verbs.ts --fact-id 123 --apply
 *
 * Defaults to --dry-run (reports, writes nothing). --apply is required to mutate.
 */

import { installStdioGuard } from "../src/lib/stdioGuard";
installStdioGuard();

import { db } from "@workspace/db";
import { factsTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { autoConjugatePersonSubjectVerbs } from "../src/lib/templateGrammar";
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
  const { apply, dryRun, factId } = parseArgs(process.argv.slice(2));
  console.log(
    `[backfill] mode=${apply ? "APPLY (writes)" : "DRY-RUN (no writes)"}` +
      (factId !== undefined ? ` fact-id=${factId}` : " (all facts)"),
  );

  const rows = factId !== undefined
    ? await db.select({ id: factsTable.id, text: factsTable.text }).from(factsTable).where(eq(factsTable.id, factId))
    : await db.select({ id: factsTable.id, text: factsTable.text }).from(factsTable);

  console.log(`[backfill] scanning ${rows.length} fact(s)...\n`);

  let changed = 0;
  for (const fact of rows) {
    const next = autoConjugatePersonSubjectVerbs(fact.text);
    if (next === fact.text) continue;

    changed++;
    console.log(`  #${fact.id}`);
    console.log(`    was: ${fact.text}`);
    console.log(`    now: ${next}`);

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

  console.log(
    `\n[backfill] done. scanned=${rows.length} changed=${changed}` +
      (apply ? " (written)" : " (dry-run — re-run with --apply to write)"),
  );
  process.exit(0);
}

void main();
