/**
 * Test helpers for a gag's example renders and sets (migration 0143, 0157;
 * plan docs/plans/PLAN_FACT_LIFECYCLE_REBUILD.md, item 12): a finished render
 * of given content for one subject kind, and a complete male, female and pet
 * set recorded at either stage, so a test can meet the go-live rule.
 */
import { randomUUID } from "node:crypto";
import { db, factGagExamplesTable } from "@workspace/db";
import { imagePromptAttemptsTable } from "@workspace/db/schema";
import { GAG_EXAMPLE_KINDS, SCENARIO_FOR_KIND, buildPlaceholderFactEnrichment, type GagExampleKind } from "@workspace/api-zod";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Executor = typeof db | Tx;

/** A finished (or failed) unstyled render of `content` for one kind. */
export async function insertExampleRender(
  factId: number,
  gagId: number,
  content: unknown,
  kind: GagExampleKind,
  opts: { failed?: boolean; executor?: Executor } = {},
): Promise<number> {
  const [row] = await (opts.executor ?? db).insert(imagePromptAttemptsTable).values({
    factId,
    gagId,
    reviewRenderScenarioKey: SCENARIO_FOR_KIND[kind],
    renderJobId: randomUUID(),
    generationMode: "t2i",
    subjectRenderMode: "t2i_fallback",
    targetEngine: "nano_banana_2",
    sourceImageAnalysis: {} as never,
    identityPolicy: {} as never,
    renderControls: {} as never,
    factEnrichmentSnapshot: { ...buildPlaceholderFactEnrichment(), visualPromptStrategyOverride: content } as never,
    archetypeStrategyVersion: "v2",
    generatedImageObjectPath: opts.failed ? null : `/objects/ai-bg-v2/${factId}/${randomUUID()}.png`,
    error: opts.failed ? "vendor failed" : null,
  }).returning({ id: imagePromptAttemptsTable.id });
  return row!.id;
}

/** Record a complete set of renders of `content` as the gag's examples at `stage`. Returns the attempt ids per kind. */
export async function giveExampleSet(
  factId: number,
  gagId: number,
  content: unknown,
  stage: "approved" | "pending",
  executor: Executor = db,
): Promise<Record<GagExampleKind, number>> {
  const out = {} as Record<GagExampleKind, number>;
  for (const kind of GAG_EXAMPLE_KINDS) {
    out[kind] = await insertExampleRender(factId, gagId, content, kind, { executor });
    await executor.insert(factGagExamplesTable).values({ gagId, subjectKind: kind, stage, attemptId: out[kind] });
  }
  return out;
}
