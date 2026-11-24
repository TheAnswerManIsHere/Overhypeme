/**
 * The needs-attention checks (plan docs/plans/PLAN_FACT_LIFECYCLE_REBUILD.md,
 * 2C; Testing Plan: "each needs-attention predicate, with counts equal to
 * filter results"; Phase 2 Definition of Done: "each needs-attention count
 * equals its filter's result"). Over the real database, through
 * `GET /admin/facts`:
 *
 *   - each predicate trips on the states it names and not on the ones beside
 *     them (taxonomy null; engine, fallback and prompt generation, recorded or
 *     read from the planner's plan; a gag without a full set; either
 *     fingerprint column null; 2 versus 3 failures in the last 10 finished
 *     renders, an 11th older one ignored, a fallback success, an eval run,
 *     queued renders);
 *   - each reason's count equals the filtered list's total, in one response;
 *   - an unknown reason is refused;
 *   - the fingerprint fill covers a deactivated fact and stops at its cap;
 *   (that a stored prompt records its generation, through the real compile
 *   and the real fallback redraw, is in imagePromptJobs.test.ts).
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import request from "supertest";
import { db, factsTable, usersTable, factGagsTable, factGagExamplesTable } from "@workspace/db";
import { insertLiveFact } from "@workspace/db/live-fact-fixture";
import { imagePromptAttemptsTable, evalRunsTable } from "@workspace/db/schema";
import { eq, inArray, sql } from "drizzle-orm";
import {
  buildPlaceholderFactEnrichment,
  buildPlaceholderGag,
  GAG_EXAMPLE_KINDS,
  IMAGE_PROMPT_GENERATION_VERSION,
  PROMPT_GENERATION_VERSION_KEY,
} from "@workspace/api-zod";

import adminRouter from "../routes/admin.js";
import { buildTestApp } from "./helpers/buildTestApp.js";
import { ATTENTION_REASONS, ATTENTION_FAIL_MIN, ATTENTION_FAIL_WINDOW, UNRECORDED_PLANLESS_GENERATION, type AttentionReason } from "../lib/factAttention.js";
import { backfillEmbeddings } from "../lib/embeddings.js";
import { IMAGE_ENGINE_IDS, fallbackEngineIdFor } from "../lib/imageEngineRouting.js";

const RUN = randomUUID().slice(0, 8);
const T2I = IMAGE_ENGINE_IDS.photoreal.t2i;
const T2I_FALLBACK = fallbackEngineIdFor(T2I)!;

let adminId = "";
let app: ReturnType<typeof buildTestApp>;
const factIds: number[] = [];

/** A live fact (approved, its one gag carried over before example sets). */
async function liveFact(values: Partial<typeof factsTable.$inferInsert> = {}): Promise<{ factId: number; gagId: number }> {
  const f = await insertLiveFact({
    text: `{NAME} attention ${RUN} ${randomUUID().slice(0, 6)}`,
    enrichment: buildPlaceholderFactEnrichment(),
    canonicalText: `attention ${RUN}`,
    embedding: Array(384).fill(0.01),
    ...values,
  } as never, buildPlaceholderGag());
  factIds.push(f.id);
  return { factId: f.id, gagId: f.gags[0]!.id };
}

interface RenderOpts {
  failed?: boolean;
  refused?: boolean;
  queued?: boolean;
  engine?: string | null;
  fallback?: { routedEngineId: string } | null;
  generation?: string | null;
  plan?: boolean;
  evalRunId?: number;
  at?: Date;
}

/** One render of a fact: finished (picture or error) or queued, with its recorded provenance. */
async function render(factId: number, gagId: number | null, o: RenderOpts = {}): Promise<number> {
  const finishedOk = !o.failed && !o.refused && !o.queued;
  const [row] = await db.insert(imagePromptAttemptsTable).values({
    factId,
    gagId,
    renderJobId: randomUUID(),
    generationMode: "t2i",
    subjectRenderMode: "human_identity_i2i",
    targetEngine: "nano_banana_2",
    actualImageEngineId: o.engine === undefined ? T2I : o.engine,
    engineFallback: o.fallback
      ? { state: "switched", routedEngineId: o.fallback.routedEngineId, routedRecipeVersionId: null, refusedGenerationRequestId: null, refusedVendorRequestId: null, reason: "refused", fallbackEngineId: T2I_FALLBACK, fallbackRecipeVersionId: null, resolvedAtHandover: false, at: new Date().toISOString() } as never
      : null,
    sourceImageAnalysis: {} as never,
    identityPolicy: {} as never,
    renderControls: {} as never,
    factEnrichmentSnapshot: buildPlaceholderFactEnrichment() as never,
    archetypeStrategyVersion: "v2",
    visualPlan: o.plan ? ({ legacy: true } as never) : null,
    compiledPrompt: o.queued ? null : (o.generation === null
      ? { prompt: "p" }
      : { prompt: "p", [PROMPT_GENERATION_VERSION_KEY]: o.generation ?? IMAGE_PROMPT_GENERATION_VERSION }) as never,
    generatedImageObjectPath: finishedOk ? `/objects/ai-bg-v2/${factId}/${randomUUID()}.png` : null,
    error: o.failed || o.refused ? "vendor failed" : null,
    errorCode: o.refused ? "vendor_content_refused" : null,
    evalRunId: o.evalRunId ?? null,
    ...(o.at ? { createdAt: o.at } : {}),
  }).returning({ id: imagePromptAttemptsTable.id });
  return row!.id;
}

/** Publish a full example set for a gag (all three kinds), its marker cleared, in one transaction. */
async function publishSet(factId: number, gagId: number, opts: RenderOpts[] = []): Promise<void> {
  const ids: number[] = [];
  for (let i = 0; i < GAG_EXAMPLE_KINDS.length; i++) ids.push(await render(factId, gagId, opts[i] ?? {}));
  await db.transaction(async (tx) => {
    await tx.insert(factGagExamplesTable).values(GAG_EXAMPLE_KINDS.map((k, i) => ({ gagId, subjectKind: k, stage: "approved" as const, attemptId: ids[i]!, approvedBy: adminId })));
    await tx.update(factGagsTable).set({ approvedCarriedOver: false, approvedBeforeExampleSets: false }).where(eq(factGagsTable.id, gagId));
  });
}

/** A live fact with a complete, current published set: needs nothing. */
async function healthyFact(values: Partial<typeof factsTable.$inferInsert> = {}): Promise<{ factId: number; gagId: number }> {
  const f = await liveFact(values);
  await publishSet(f.factId, f.gagId);
  return f;
}

/** Every reason the list gives a fact (searched by id through the whole list). */
async function reasonsOf(factId: number): Promise<AttentionReason[]> {
  const res = await request(app).get(`/api/admin/facts?visibility=both&limit=100&search=${encodeURIComponent(RUN)}`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const row = (res.body.facts as Array<{ id: number; attention: AttentionReason[] }>).find((f) => f.id === factId);
  assert.ok(row, `fact ${factId} is in the list`);
  return row.attention;
}

async function inFilter(reason: AttentionReason, factId: number): Promise<boolean> {
  const res = await request(app).get(`/api/admin/facts?attention=${reason}&limit=100&search=${encodeURIComponent(RUN)}`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return (res.body.facts as Array<{ id: number }>).some((f) => f.id === factId);
}

/** The fact trips exactly `reasons`, by its row and by each filter. */
async function expectReasons(factId: number, reasons: AttentionReason[]): Promise<void> {
  assert.deepEqual([...(await reasonsOf(factId))].sort(), [...reasons].sort());
  for (const r of ATTENTION_REASONS) assert.equal(await inFilter(r, factId), reasons.includes(r), `filter ${r} for fact ${factId}`);
}

describe("the needs-attention checks (2C)", () => {
  before(async () => {
    adminId = `t-attn-${RUN}`;
    await db.insert(usersTable).values({ id: adminId, email: `${adminId}@test.local`, isAdmin: true, membershipTier: "legendary" });
    app = buildTestApp({ kind: "authenticated", userId: adminId }, adminRouter);
  });

  after(async () => {
    if (factIds.length) {
      // As gagExampleSets.test.ts does: deleting the gags takes their examples (a set may not be emptied while its gag stands).
      await db.update(factsTable).set({ isActive: false }).where(inArray(factsTable.id, factIds));
      await db.delete(factGagsTable).where(inArray(factGagsTable.factId, factIds));
      await db.delete(imagePromptAttemptsTable).where(inArray(imagePromptAttemptsTable.factId, factIds));
      await db.delete(factsTable).where(inArray(factsTable.id, factIds));
    }
    await db.delete(usersTable).where(eq(usersTable.id, adminId));
  });

  it("a live fact with a complete, current set and both fingerprints needs nothing", async () => {
    const { factId } = await healthyFact();
    await expectReasons(factId, []);
  });

  describe("taxonomy missing", () => {
    it("trips on an approved fact with no stored taxonomy, live or deactivated", async () => {
      const live = await healthyFact({ enrichment: null });
      await expectReasons(live.factId, ["taxonomy_missing"]);
      const off = await healthyFact({ enrichment: null });
      await db.update(factsTable).set({ isActive: false }).where(eq(factsTable.id, off.factId));
      await expectReasons(off.factId, ["taxonomy_missing"]);
    });

    it("does not trip on a fact never approved", async () => {
      const [f] = await db.insert(factsTable).values({ text: `{NAME} unapproved ${RUN}`, isActive: false }).returning({ id: factsTable.id });
      factIds.push(f!.id);
      await expectReasons(f!.id, []);
    });
  });

  describe("duplicate fingerprint missing", () => {
    it("trips when either the embedding or the canonical text is missing", async () => {
      const noEmbedding = await healthyFact({ embedding: null });
      await expectReasons(noEmbedding.factId, ["fingerprint_missing"]);
      const noCanonical = await healthyFact({ canonicalText: null });
      await expectReasons(noCanonical.factId, ["fingerprint_missing"]);
    });
  });

  describe("example missing", () => {
    it("trips on a live fact's carried-over gag without a full set", async () => {
      const { factId } = await liveFact();
      await expectReasons(factId, ["example_missing"]);
    });

    it("does not trip on a deactivated fact (a live fact's check, as the plan words it)", async () => {
      const { factId } = await liveFact();
      await db.update(factsTable).set({ isActive: false }).where(eq(factsTable.id, factId));
      await expectReasons(factId, []);
    });
  });

  describe("example stale", () => {
    it("trips on an example drawn by an engine not routed today", async () => {
      const { factId, gagId } = await liveFact();
      await publishSet(factId, gagId, [{ engine: "nano-banana-2" }]);
      await expectReasons(factId, ["example_stale"]);
    });

    it("a pre-0123 render (no engine recorded) reads as the old by-mode engine: stale", async () => {
      const { factId, gagId } = await liveFact();
      await publishSet(factId, gagId, [{}, { engine: null }]);
      await expectReasons(factId, ["example_stale"]);
    });

    it("an example today's engine refused and its recorded fallback drew is current", async () => {
      const { factId, gagId } = await liveFact();
      await publishSet(factId, gagId, [{ engine: T2I_FALLBACK, fallback: { routedEngineId: T2I } }]);
      await expectReasons(factId, []);
    });

    it("the fallback engine without a recorded switch from today's engine is stale", async () => {
      const bare = await liveFact();
      await publishSet(bare.factId, bare.gagId, [{ engine: T2I_FALLBACK }]);
      await expectReasons(bare.factId, ["example_stale"]);
      const oldRouted = await liveFact();
      await publishSet(oldRouted.factId, oldRouted.gagId, [{ engine: T2I_FALLBACK, fallback: { routedEngineId: "gpt-image-1" } }]);
      await expectReasons(oldRouted.factId, ["example_stale"]);
    });

    it("an example recording an older prompt generation is stale", async () => {
      const { factId, gagId } = await liveFact();
      await publishSet(factId, gagId, [{}, {}, { generation: "v10" }]);
      await expectReasons(factId, ["example_stale"]);
    });

    it("an unrecorded example is v11 without a planner plan and older with one", async () => {
      const planless = await liveFact();
      await publishSet(planless.factId, planless.gagId, [{ generation: null }, { generation: null }, { generation: null }]);
      await expectReasons(planless.factId, UNRECORDED_PLANLESS_GENERATION === IMAGE_PROMPT_GENERATION_VERSION ? [] : ["example_stale"]);
      const planned = await liveFact();
      await publishSet(planned.factId, planned.gagId, [{ generation: null, plan: true }]);
      await expectReasons(planned.factId, ["example_stale"]);
    });

    it("covers a deactivated fact, and ignores a removed gag's examples", async () => {
      const off = await liveFact();
      await publishSet(off.factId, off.gagId, [{ engine: "nano-banana-2" }]);
      await db.update(factsTable).set({ isActive: false }).where(eq(factsTable.id, off.factId));
      await expectReasons(off.factId, ["example_stale"]);
      await db.update(factGagsTable).set({ removedAt: new Date() }).where(eq(factGagsTable.id, off.gagId));
      await expectReasons(off.factId, []);
    });
  });

  describe("pictures often failing", () => {
    const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);

    it(`trips at ${ATTENTION_FAIL_MIN} failures or refusals in the last ${ATTENTION_FAIL_WINDOW} finished renders, not one fewer`, async () => {
      const two = await healthyFact();
      await render(two.factId, null, { failed: true, at: minutesAgo(3) });
      await render(two.factId, null, { refused: true, at: minutesAgo(2) });
      await expectReasons(two.factId, []);
      await render(two.factId, null, { refused: true, at: minutesAgo(1) });
      await expectReasons(two.factId, ["pictures_failing"]);
    });

    it(`ignores a failure older than the last ${ATTENTION_FAIL_WINDOW} finished renders`, async () => {
      const f = await healthyFact();
      // The healthy set is 3 successes; add old failures, then enough newer
      // successes that only two failures stay inside the window.
      for (let i = 0; i < 3; i++) await render(f.factId, null, { failed: true, at: minutesAgo(100 - i) });
      for (let i = 0; i < ATTENTION_FAIL_WINDOW - 2; i++) await render(f.factId, null, { at: minutesAgo(50 - i) });
      await render(f.factId, null, { failed: true, at: minutesAgo(10) });
      await render(f.factId, null, { failed: true, at: minutesAgo(9) });
      await expectReasons(f.factId, []);
    });

    it("counts a picture the fallback drew as a success, and leaves out queued renders and eval runs", async () => {
      const f = await healthyFact();
      const [evalRun] = await db.insert(evalRunsTable).values({} as never).returning({ id: evalRunsTable.id });
      for (let i = 0; i < 3; i++) await render(f.factId, null, { failed: true, evalRunId: evalRun!.id, at: minutesAgo(5 - i) });
      for (let i = 0; i < 3; i++) await render(f.factId, null, { queued: true, at: minutesAgo(4 - i) });
      await render(f.factId, null, { failed: true, at: minutesAgo(1) });
      await render(f.factId, null, { failed: true, at: minutesAgo(1) });
      await render(f.factId, null, { engine: T2I_FALLBACK, fallback: { routedEngineId: T2I }, at: minutesAgo(0) });
      try {
        await expectReasons(f.factId, []);
      } finally {
        await db.delete(imagePromptAttemptsTable).where(eq(imagePromptAttemptsTable.evalRunId, evalRun!.id));
        await db.delete(evalRunsTable).where(eq(evalRunsTable.id, evalRun!.id));
      }
    });

    it("does not trip on a deactivated fact", async () => {
      const f = await healthyFact();
      for (let i = 0; i < 4; i++) await render(f.factId, null, { failed: true });
      await db.update(factsTable).set({ isActive: false }).where(eq(factsTable.id, f.factId));
      await expectReasons(f.factId, []);
    });
  });

  it("each reason's count equals its filter's total, in one response", async () => {
    // At least one fact per reason exists by now.
    for (const reason of ATTENTION_REASONS) {
      const res = await request(app).get(`/api/admin/facts?attention=${reason}&limit=1`);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.ok(res.body.attentionCounts[reason] > 0, `${reason} has a fact`);
      assert.equal(res.body.total, res.body.attentionCounts[reason], reason);
    }
  });

  it("refuses an unknown reason", async () => {
    const res = await request(app).get("/api/admin/facts?attention=bogus");
    assert.equal(res.status, 400);
  });

  describe("the fingerprint fill", () => {
    it("fills a deactivated approved fact, and stops at its cap", async () => {
      const a = await healthyFact({ embedding: null, canonicalText: null });
      const b = await healthyFact({ embedding: null, canonicalText: null });
      await db.update(factsTable).set({ isActive: false }).where(eq(factsTable.id, b.factId));
      const missing = async () => (await db.select({ id: factsTable.id }).from(factsTable)
        .where(sql`${factsTable.id} IN ${[a.factId, b.factId]} AND (${factsTable.embedding} IS NULL OR ${factsTable.canonicalText} IS NULL)`)).map((r) => r.id);

      const stubEmbed = async () => Array(384).fill(0.02);
      const one = await backfillEmbeddings({ limit: 1, embed: stubEmbed });
      assert.equal(one.processed + one.failed, 1, "a capped run handles one fact");
      await backfillEmbeddings({ limit: 1000, embed: stubEmbed });
      assert.deepEqual(await missing(), [], "both facts, live and deactivated, are filled");
      await expectReasons(b.factId, []);
    });
  });

});
