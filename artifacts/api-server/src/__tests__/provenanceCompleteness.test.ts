/**
 * @purpose The completeness audit of image tracing (#912): an AI picture's record holds everything that shaped it, so its watermark id leads to the whole configuration even after every live row it came from is gone — the vendor input exactly as sent, the attempt's whole planning lineage, what the vendor returned (the seed it used), and a content fingerprint of each reference picture the request named; vendorContext fingerprints inline and linked references, says why it could not, and keeps inline pictures out of the record.
 * @subsystem provenance
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import sharp from "sharp";

import { db } from "@workspace/db";
import { factsTable, imageGenerationRequestsTable, imagePromptAttemptsTable, imageProvenanceTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import type { FactEnrichment } from "@workspace/api-zod";

import { imageGenerationHandler } from "../lib/imagePromptJobs.js";
import { resolveImageEngine } from "../lib/imageEngineRouting.js";
import { fal } from "../lib/falClient.js";
import { vendorContext, __setReferenceFetchForTest } from "../lib/provenance/vendorContext.js";
import { photoBackgrounds } from "./helpers/photoBackground.js";

const ENRICHMENT: FactEnrichment = {
  primaryArchetype: "superhuman_physical_feat",
  subtype: "force_scaled_action",
  modifiers: [],
  visualLiteralness: "literal_dramatization",
  visualComplexity: "medium",
  overhypeFit: "strong",
  adultSuitability: "safe",
  adultSuitabilityNotes: "",
  suggestedHashtags: [],
  taxonomyConfidence: 0.9,
  adminReviewNotes: "",
  culturalReferences: [],
  semanticEntities: [],
};
// The worker's credential gate needs a value; fal.subscribe is replaced below, so it is never used.
process.env["FAL_AI_API_KEY"] = process.env["FAL_AI_API_KEY"] ?? "test-fal-key";
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

describe("vendorContext", () => {
  it("fingerprints an inline reference and a linked one, and keeps the inline bytes out of the record", async () => {
    const inline = Buffer.from("inline-reference-bytes");
    const linked = Buffer.from("linked-reference-bytes");
    __setReferenceFetchForTest((async () => new Response(linked, { headers: { "content-type": "image/png" } })) as typeof fetch);
    try {
      const ctx = await vendorContext(
        { prompt: "p", image_urls: [`data:image/jpeg;base64,${inline.toString("base64")}`, "https://fal.test/ref.png"], seed: 7 },
        { seed: 7, images: [{ url: `data:image/png;base64,${"A".repeat(5000)}` }] },
      );
      assert.deepEqual(ctx.referenceImages.map((r) => [r.at, r.sha256, r.byteSize]), [
        ["image_urls[0]", sha(inline), inline.length],
        ["image_urls[1]", sha(linked), linked.length],
      ]);
      assert.equal(ctx.referenceImages[0]!.url, "data:image/jpeg;base64,…", "the inline bytes are already in the request; the record keeps their hash");
      const image = (ctx.vendorResponse as { images: { url: { omitted: string; sha256: string } }[] }).images[0]!;
      assert.match(image.url.omitted, /characters/);
      assert.equal((ctx.vendorResponse as { seed: number }).seed, 7);
    } finally {
      __setReferenceFetchForTest(null);
    }
  });

  it("says why a reference has no fingerprint, and never throws", async () => {
    __setReferenceFetchForTest((async () => new Response("gone", { status: 404 })) as typeof fetch);
    try {
      const ctx = await vendorContext({ image_url: "https://fal.test/expired.png" }, undefined);
      assert.match(ctx.referenceImages[0]!.unhashed!, /answered 404/);
      assert.equal(ctx.vendorResponse, null, "no vendor result (a storage-only retry) is recorded as none");
    } finally {
      __setReferenceFetchForTest(null);
    }
    const unseamed = await vendorContext({ image_url: "https://fal.test/x.png" }, {});
    assert.match(unseamed.referenceImages[0]!.unhashed!, /test run/, "a test run fetches nothing unless it supplies a reader");
  });
});

describe("an AI render's record holds its whole configuration", () => {
  const photos = photoBackgrounds();
  let factId: number;
  before(async () => {
    photos.setUp();
    const [fact] = await db.insert(factsTable).values({ text: "{NAME} lifts a truck.", isActive: false, enrichment: ENRICHMENT }).returning({ id: factsTable.id });
    factId = fact!.id;
  });
  after(async () => {
    await db.delete(imageProvenanceTable).where(eq(imageProvenanceTable.factId, factId));
    await db.delete(imageGenerationRequestsTable).where(eq(imageGenerationRequestsTable.factId, factId));
    await db.delete(factsTable).where(eq(factsTable.id, factId));
    await photos.tearDown();
  });

  it("the vendor input, the attempt's planning lineage and the vendor's reply all survive the attempt and the fact", async () => {
    const visualPlan = { scene: "a truck held overhead", camera: "low angle" };
    const [attempt] = await db.insert(imagePromptAttemptsTable).values({
      factId,
      renderJobId: randomUUID(),
      generationMode: "t2i",
      subjectRenderMode: "t2i_fallback",
      targetEngine: "nano_banana_2",
      actualImageEngineId: (await resolveImageEngine("t2i")).id,
      sourceImageAnalysis: { faces: 0 } as never,
      identityPolicy: { policy: "none" } as never,
      renderControls: { aspectRatio: "landscape", styleId: "comic" } as never,
      factEnrichmentSnapshot: ENRICHMENT as never,
      archetypeStrategyVersion: "v2",
      renderedFactText: "Alex lifts a truck.",
      visualPlan: visualPlan as never,
      compiledPrompt: { imagePrompt: "a truck, lifted, comic style" } as never,
    }).returning({ id: imagePromptAttemptsTable.id });

    const png = await sharp({ create: { width: 32, height: 18, channels: 3, background: "#456" } }).png().toBuffer();
    const original = fal.subscribe;
    let sent: Record<string, unknown> | null = null;
    (fal as { subscribe: unknown }).subscribe = async (_endpoint: string, opts: { input: Record<string, unknown> }) => {
      sent = opts.input;
      return { requestId: "req-complete-1", data: { images: [{ url: `data:image/png;base64,${png.toString("base64")}` }], seed: 424242, has_nsfw_concepts: [false] } };
    };
    // Set here, not only at load: the shard shares one process, and another
    // file's cleanup may have removed the key since this file loaded.
    const priorKey = process.env["FAL_AI_API_KEY"];
    process.env["FAL_AI_API_KEY"] = priorKey ?? "test-fal-key";
    try {
      const out = await imageGenerationHandler.run({ attemptId: attempt!.id }, {} as never);
      assert.equal(out.ok, true, JSON.stringify(out));
    } finally {
      (fal as { subscribe: unknown }).subscribe = original;
      if (priorKey === undefined) delete process.env["FAL_AI_API_KEY"];
      else process.env["FAL_AI_API_KEY"] = priorKey;
    }

    // Every live row it came from goes: the attempt, then the fact.
    await db.delete(imagePromptAttemptsTable).where(eq(imagePromptAttemptsTable.id, attempt!.id));

    const [record] = await db.select().from(imageProvenanceTable).where(eq(imageProvenanceTable.attemptId, attempt!.id));
    assert.ok(record, "the picture was recorded");
    const [request] = await db.select().from(imageGenerationRequestsTable).where(eq(imageGenerationRequestsTable.id, record!.generationRequestId!));
    assert.deepEqual(request!.request, sent, "the vendor input exactly as sent");
    assert.equal(request!.vendorRequestId, "req-complete-1");

    const snap = record!.snapshot as {
      attempt: Record<string, unknown>;
      vendorResponse: { seed: number; has_nsfw_concepts: boolean[] };
      referenceImages: unknown[];
      prompt: string;
    };
    assert.equal(snap.prompt, "a truck, lifted, comic style");
    assert.deepEqual(snap.attempt["visualPlan"], visualPlan, "the planner's output");
    assert.deepEqual(snap.attempt["renderControls"], { aspectRatio: "landscape", styleId: "comic" });
    assert.deepEqual(snap.attempt["sourceImageAnalysis"], { faces: 0 });
    assert.deepEqual(snap.attempt["identityPolicy"], { policy: "none" });
    assert.deepEqual(snap.attempt["factEnrichmentSnapshot"], ENRICHMENT);
    assert.equal(snap.attempt["renderedFactText"], "Alex lifts a truck.");
    assert.equal(snap.attempt["archetypeStrategyVersion"], "v2");
    assert.ok(snap.attempt["requestSettings"], "the size settings computed for this run");
    assert.equal(snap.vendorResponse.seed, 424242, "the seed the vendor actually used");
    assert.deepEqual(snap.vendorResponse.has_nsfw_concepts, [false]);
    assert.deepEqual(snap.referenceImages, [], "a text-to-image render names no reference");
    assert.ok(record!.sourceCommit === null || /^[0-9a-f]{40}$/.test(record!.sourceCommit), "the code version, or unversioned in a test");
  });
});
