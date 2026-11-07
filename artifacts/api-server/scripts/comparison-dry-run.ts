/**
 * The engine comparison's dry run (launch Phase 8, increment 2a; plan
 * `docs/plans/PLAN_PHASE8_ENGINE_EVALUATION.md`, *Implementation Steps* 2,
 * post-merge: "33 panels and 198 expected cells and a refused over-budget
 * estimate"). READ-ONLY: it reads this database's image engines, derives the
 * round 1 and round 2 layouts for three placeholder facts against them, prices
 * every cell at its engine's per-call bound, and plans a render run against a
 * week with $1 left, which must refuse. It writes nothing and calls no model.
 *
 * Run (on the Repl):
 *   pnpm --filter @workspace/api-server exec tsx scripts/comparison-dry-run.ts
 * Exits non-zero if the counts are not 33 and 198 or the refusal does not occur.
 */
import { installStdioGuard } from "../src/lib/stdioGuard.js";
installStdioGuard();

import { db } from "@workspace/db";
import { enginesTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { COMPARISON_DEFAULT_FAMILIES, COMPARISON_ROUND_PRESETS, PAID_RUN_ALLOWANCE_USD, PAID_WEEK_ALLOWANCE_USD } from "@workspace/api-zod";
import { deriveComparisonLayout } from "../src/lib/comparison/layout.js";
import { cellBoundUsd, panelPreparationBoundUsd, planRun, type WorkItem } from "../src/lib/comparison/admission.js";
import { estimateOf, plannerSettings } from "../src/lib/comparison/sets.js";

/** A week with this much left must refuse a render run of rounds 1 and 2. */
const TIGHT_WEEK_USD = 1;

async function main(): Promise<void> {
  const engines = await db.select().from(enginesTable).where(eq(enginesTable.kind, "image"));
  const panels = ([1, 2] as const).flatMap((round) => {
    const preset = COMPARISON_ROUND_PRESETS[round];
    return deriveComparisonLayout({
      factIds: [1, 2, 3],
      scenarioKeys: [...preset.scenarioKeys],
      lookStyleIds: [...preset.lookStyleIds],
      engineFamilies: [...COMPARISON_DEFAULT_FAMILIES],
    }, engines);
  });
  const price = new Map(engines.map((e) => [e.id, e.priceModel]));
  const prepareBound = panelPreparationBoundUsd(await plannerSettings());
  const prepare: WorkItem[] = panels.map((_, i) => ({ ref: `panel:${i}`, label: `preparing panel ${i}`, boundUsd: prepareBound }));
  const cells: WorkItem[] = panels.flatMap((p, i) => p.engineIds.map((engineId) => ({ ref: `cell:${i}:${engineId}`, label: `rendering ${engineId}`, boundUsd: cellBoundUsd(price.get(engineId)), engineId })));
  const estimate = estimateOf(prepare, cells);
  const tight = planRun(cells, { allowanceUsd: PAID_RUN_ALLOWANCE_USD, weekRemainingUsd: TIGHT_WEEK_USD, unresolvedReservedUsd: 0 });
  const full = planRun(cells, { allowanceUsd: PAID_RUN_ALLOWANCE_USD, weekRemainingUsd: PAID_WEEK_ALLOWANCE_USD, unresolvedReservedUsd: 0 });

  const report = {
    panels: panels.length,
    cells: cells.length,
    ...estimate,
    renderRunsAtFiveDollars: full.runsNeeded,
    refusedWithOneDollarLeft: tight.admitted === false,
    refusal: tight.refusal,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  const ok = report.panels === 33 && report.cells === 198 && report.refusedWithOneDollarLeft;
  process.stdout.write(ok ? "DRY RUN OK\n" : "DRY RUN FAILED\n");
  process.exit(ok ? 0 : 1);
}

main().catch((err: unknown) => {
  process.stderr.write(`DRY RUN ERROR: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
