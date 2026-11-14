/**
 * One-off probe (PR #936 post-merge step 3): draft gags for up to five facts at
 * Visual Concept review through the real job, as Regenerate does, and report
 * per generation: time, tokens, cost, unusable gags, and any bubble speaker
 * that reads "Alex". Stops before a call that would take the run past $3.
 * Ephemeral: run on dev, then delete.
 */
import { db, pool } from "@workspace/db";
import { pendingReviewsTable, factsTable } from "@workspace/db/schema";
import { and, eq, isNotNull } from "drizzle-orm";
import { zodResponseFormat } from "openai/helpers/zod";
import { candidateConceptsWireSchema, isCandidateConceptPickable } from "@workspace/api-zod";
import { runVisualConceptsJob } from "../src/lib/visualConceptJobs";
import { resolveVisualConceptsLLMSettings, generateVisualConceptsWithModel, type GenerateVisualConceptsInput } from "../src/lib/visualConcepts/generator";
import { getVisualConceptsSystem } from "../src/lib/visualConceptsConfig";
import { callUtilityLLM } from "../src/lib/utilityLLM";

const PRICE_IN = 10 / 1e6, PRICE_OUT = 50 / 1e6, CAP_USD = 3, WORST_PER_GEN = 0.6;
let spent = 0;

const rows = await db
  .select({ reviewId: pendingReviewsTable.id, factId: pendingReviewsTable.stagingFactId })
  .from(pendingReviewsTable)
  .where(and(eq(pendingReviewsTable.workflowStage, "concept_review"), isNotNull(pendingReviewsTable.stagingFactId)))
  .limit(5);
console.log(`facts at concept_review: ${rows.length}`);

for (const r of rows) {
  if (spent + WORST_PER_GEN > CAP_USD) { console.log("stopping: the next generation could pass $3"); break; }
  const calls: Array<{ ms: number; inTok: number; outTok: number; reasoningTok: number }> = [];
  const generate = async (input: GenerateVisualConceptsInput) => {
    const settings = await resolveVisualConceptsLLMSettings();
    if (settings.unusableReason) throw new Error(settings.unusableReason);
    const out = await generateVisualConceptsWithModel(input, async (msgs) => {
      const t = Date.now();
      const res = await callUtilityLLM({
        model: settings.model ?? undefined, temperature: 0.8, maxTokens: settings.maxTokens,
        reasoningEffort: settings.reasoningEffort, timeoutMs: settings.timeoutMs,
        responseFormat: zodResponseFormat(candidateConceptsWireSchema, "visual_concepts"),
        messages: [{ role: "system", content: await getVisualConceptsSystem() }, ...msgs],
      });
      const u = res.usage;
      calls.push({ ms: Date.now() - t, inTok: u?.prompt_tokens ?? 0, outTok: u?.completion_tokens ?? 0, reasoningTok: u?.completion_tokens_details?.reasoning_tokens ?? 0 });
      return res.choices[0]?.message?.content ?? "{}";
    });
    return { ...out, provenance: settings.provenance };
  };
  const t0 = Date.now();
  const result = await runVisualConceptsJob({ reviewId: r.reviewId, factId: r.factId! }, { generate });
  const cost = calls.reduce((s, c) => s + c.inTok * PRICE_IN + c.outTok * PRICE_OUT, 0);
  spent += cost;
  const [fact] = await db.select({ blob: factsTable.visualConceptCandidates }).from(factsTable).where(eq(factsTable.id, r.factId!));
  const blob = fact?.blob as { candidates?: any[]; provenance?: { engineId: string; model: string }; jokeRead?: string } | null;
  const cands = blob?.candidates ?? [];
  console.log(JSON.stringify({
    reviewId: r.reviewId, ok: result.ok, error: result.ok ? undefined : (result as { error?: string }).error,
    totalMs: Date.now() - t0, calls, costUsd: Number(cost.toFixed(4)),
    engine: blob?.provenance?.engineId, model: blob?.provenance?.model,
    gags: cands.length, unusable: cands.filter((c) => !isCandidateConceptPickable(c)).length,
    conversionFailed: cands.filter((c) => JSON.stringify(c).includes("CONVERSION_FAILED")).length,
    bubbles: cands.reduce((s, c) => s + (c.bubbles?.length ?? 0), 0),
    speakers: [...new Set(cands.flatMap((c) => (c.bubbles ?? []).map((b: any) => b.entity)))],
    alexSpeaker: cands.some((c) => (c.bubbles ?? []).some((b: any) => /\balex\b/i.test(b.entity))),
    jokeReadChars: blob?.jokeRead?.length ?? 0,
  }));
}
console.log(`TOTAL_USD ${spent.toFixed(4)}`);
await pool.end();
