/**
 * The engine comparison's dry run (launch Phase 8, increment 2a; plan
 * `docs/plans/PLAN_PHASE8_ENGINE_EVALUATION.md`, *Implementation Steps* 2,
 * post-merge: "33 panels and 198 expected cells"). READ-ONLY: it reads this
 * database's image engines, derives the round 1 and round 2 layouts for three
 * placeholder facts against them and prices every cell at its engine's
 * per-call bound, the worst case for both rounds. No allowance is checked:
 * pricing does not gate a comparison run (David, 2026-11-07, `decisions.md`).
 * It writes nothing and calls no model.
 *
 * Run (on the Repl):
 *   pnpm --filter @workspace/api-server exec tsx scripts/comparison-dry-run.ts
 * Exits non-zero if the counts are not 33 and 198.
 */
import { installStdioGuard } from "../src/lib/stdioGuard.js";
installStdioGuard();

import { db } from "@workspace/db";
import { enginesTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { COMPARISON_DEFAULT_FAMILIES, COMPARISON_ROUND_PRESETS } from "@workspace/api-zod";
import { deriveComparisonLayout } from "../src/lib/comparison/layout.js";
import { cellBoundUsd, panelPreparationBoundUsd, type WorkItem } from "../src/lib/comparison/admission.js";
import { estimateOf, plannerSettings } from "../src/lib/comparison/sets.js";

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

  const report = {
    panels: panels.length,
    cells: cells.length,
    ...estimate,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  const ok = report.panels === 33 && report.cells === 198;
  process.stdout.write(ok ? "DRY RUN OK\n" : "DRY RUN FAILED\n");
  process.exit(ok ? 0 : 1);
}

main().catch((err: unknown) => {
  process.stderr.write(`DRY RUN ERROR: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
