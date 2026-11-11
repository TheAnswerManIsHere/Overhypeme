// Image tracing, increment 1 (plan docs/plans/PLAN_IMAGE_TRACING.md; #907):
// the provenance record, the stamp, the trace, and the properties the plan
// names — the stamp never changes a picture's pixels and carries only the id
// and an engine name; a record holds the hash of exactly the bytes returned;
// it survives deletion of the account; the trace returns every match and
// names what it tried; the workbench hands back our stamped copy, not the
// vendor's URL; the retention purge does nothing at 0; the trace is admin-only.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import sharp from "sharp";
import request from "supertest";
import { db } from "@workspace/db";
import {
  adminConfigTable,
  imageGenerationRequestsTable,
  imageProvenanceTable,
  usersTable,
} from "@workspace/db/schema";
import { eq, inArray, like } from "drizzle-orm";

import { readStampedId, sniffImage, stampImage, xmpPacket } from "../lib/provenance/imageFile.js";
import {
  actorForUser,
  finishImage,
  latestCellGenerationRequest,
  newProvenanceId,
  recordGenerationRequest,
  setVendorRequestId,
} from "../lib/provenance/records.js";
import { parseTraceInput, traceIdOrLink } from "../lib/provenance/trace.js";
import { finishWorkbenchResult } from "../lib/provenance/workbench.js";
import { attemptProvenanceContext } from "../lib/provenance/attemptActor.js";
import { runProvenanceRetentionPurge } from "../jobs/provenanceRetentionPurger.js";
import { codeVersion } from "../lib/codeVersion.js";
import { enqueueForceReviewRenderPrepare } from "../lib/reviewRenderScenarios.js";
import { asyncJobsTable } from "@workspace/db/schema";
import adminProvenanceRouter from "../routes/adminProvenance.js";
import { buildTestApp } from "./helpers/buildTestApp.js";

const P = `t-prov-${randomUUID().slice(0, 6)}`;
const adminId = `${P}-admin`;
const memberId = `${P}-member`;
const createdRecordIds: number[] = [];
const createdRequestIds: number[] = [];

async function picture(format: "png" | "jpeg" | "webp" | "webp-lossless"): Promise<Buffer> {
  const base = sharp({ create: { width: 41, height: 27, channels: 3, background: { r: 180, g: 40, b: 90 } } })
    .composite([{ input: Buffer.from('<svg width="41" height="27"><circle cx="12" cy="12" r="9" fill="#0c0"/></svg>'), left: 0, top: 0 }]);
  if (format === "png") return base.png().toBuffer();
  if (format === "jpeg") return base.jpeg({ quality: 80 }).toBuffer();
  if (format === "webp") return base.webp({ quality: 70 }).toBuffer();
  return base.webp({ lossless: true }).toBuffer();
}

async function finish(args: Parameters<typeof finishImage>[0]) {
  const out = await finishImage(args);
  createdRecordIds.push(out.provenanceId);
  return out;
}

before(async () => {
  await db.insert(usersTable).values([
    { id: adminId, email: `${adminId}@test.local`, membershipTier: "legendary", isAdmin: true },
    { id: memberId, email: `${memberId}@test.local`, membershipTier: "registered", isAdmin: false },
  ]);
});

after(async () => {
  if (createdRecordIds.length) await db.delete(imageProvenanceTable).where(inArray(imageProvenanceTable.id, createdRecordIds));
  if (createdRequestIds.length) await db.delete(imageGenerationRequestsTable).where(inArray(imageGenerationRequestsTable.id, createdRequestIds));
  await db.delete(imageProvenanceTable).where(like(imageProvenanceTable.objectPath, `%${P}%`));
  await db.delete(usersTable).where(inArray(usersTable.id, [adminId, memberId]));
});

describe("the stamp", () => {
  for (const format of ["png", "jpeg", "webp", "webp-lossless"] as const) {
    it(`keeps a ${format} picture's pixels exactly and carries the id`, async () => {
      const raw = await picture(format);
      const stamped = stampImage(raw, { id: 4503599627370001, engine: "Nano Banana 2" })!;
      assert.ok(stamped, "the format is stampable");
      const a = await sharp(raw).raw().toBuffer({ resolveWithObject: true });
      const b = await sharp(stamped).raw().toBuffer({ resolveWithObject: true });
      assert.equal(b.info.channels, a.info.channels);
      assert.ok(a.data.equals(b.data), "decoded pixels are byte-identical");
      assert.equal(readStampedId(stamped), 4503599627370001);
      assert.equal(sniffImage(stamped).format, sniffImage(raw).format);
      assert.ok((await sharp(stamped).metadata()).xmp, "standard readers see the XMP");
    });
  }

  it("carries only the id and the engine name — never settings or a prompt", () => {
    const xmp = xmpPacket({ id: 7, engine: "Seedream" });
    const attrs = [...xmp.matchAll(/ovh:(\w+)=/g)].map((m) => m[1]);
    assert.deepEqual(attrs.sort(), ["Engine", "ProvenanceId"]);
    assert.ok(!xmpPacket({ id: 7 }).includes("ovh:Engine"), "no engine name when none is given");
  });

  it("reads the true format from the bytes, whatever the name says", async () => {
    assert.equal(sniffImage(await picture("jpeg")).mime, "image/jpeg");
    assert.equal(sniffImage(await picture("webp")).ext, "webp");
    assert.equal(sniffImage(Buffer.from("not an image")).format, "unknown");
  });
});

describe("the record", () => {
  it("ids are random, positive and exact in JavaScript", () => {
    const ids = new Set(Array.from({ length: 2000 }, () => newProvenanceId()));
    assert.equal(ids.size, 2000);
    for (const id of ids) assert.ok(Number.isSafeInteger(id) && id > 0 && id < 2 ** 52);
  });

  it("holds the hash of exactly the bytes returned, stamped, with its code version", async () => {
    const raw = await picture("png");
    const out = await finish({
      bytes: raw, kind: "ai_render", actor: await actorForUser(memberId, "member"), stamp: true, stampEngine: "Test Engine",
      objectPath: ("/objects/" + `ai-bg-v2/${P}/a.png`), snapshot: { prompt: "a test prompt" },
    });
    const [row] = await db.select().from(imageProvenanceTable).where(eq(imageProvenanceTable.id, out.provenanceId));
    assert.equal(row!.sha256, createHash("sha256").update(out.bytes).digest("hex"));
    assert.equal(row!.byteSize, out.bytes.length);
    assert.equal(readStampedId(out.bytes), out.provenanceId);
    assert.equal(row!.mime, "image/png");
    assert.equal(row!.width, 41);
    assert.equal(row!.actorEmail, `${memberId}@test.local`);
    assert.equal(row!.sourceCommit, codeVersion().commit, "the record names the code version, or null for an unversioned run");
  });

  it("an upload is recorded unstamped: the member's bytes are not changed", async () => {
    const raw = await picture("jpeg");
    const out = await finish({ bytes: raw, kind: "upload", actor: await actorForUser(memberId, "member"), stamp: false, objectPath: ("/objects/" + `uploads/${P}/u.jpg`) });
    assert.ok(out.bytes.equals(raw));
    assert.equal(readStampedId(out.bytes), null);
  });

  it("survives deletion of the account that made it, keeping its contact address at the time", async () => {
    const goneId = `${P}-gone`;
    await db.insert(usersTable).values({ id: goneId, email: `${goneId}@test.local`, membershipTier: "registered", isAdmin: false });
    const out = await finish({ bytes: await picture("png"), kind: "upload", actor: await actorForUser(goneId, "member"), stamp: false, objectPath: ("/objects/" + `uploads/${P}/gone.png`) });
    await db.delete(usersTable).where(eq(usersTable.id, goneId));
    const trace = await traceIdOrLink(String(out.provenanceId));
    assert.equal(trace.matches.length, 1);
    assert.equal(trace.matches[0]!.record.actorEmail, `${goneId}@test.local`);
    assert.equal(trace.matches[0]!.stillExists.account, false);
  });

  it("the generation request is captured before submission, and a recovery reads the frozen one", async () => {
    const cellId = 900_000_000 + Math.floor(Math.random() * 1000);
    const id = await recordGenerationRequest({
      producer: "comparison_cell", engineId: "e1", endpointId: "fal-ai/test", request: { prompt: "first", quality: "high" },
      actor: await actorForUser(adminId, "admin"), comparisonCellId: cellId,
    });
    createdRequestIds.push(id);
    await setVendorRequestId(id, `${P}-vendor`);
    const frozen = await latestCellGenerationRequest(cellId);
    assert.equal(frozen!.id, id);
    assert.deepEqual(frozen!.request, { prompt: "first", quality: "high" });
    assert.equal(frozen!.vendorRequestId, `${P}-vendor`);
    assert.equal(frozen!.actorKind, "admin");
  });
});

describe("who made it", () => {
  it("a moderation render names its admin; an unattended batch is system; a product render its member", async () => {
    const asAdmin = await attemptProvenanceContext({ userId: null, evalRunId: null, renderControls: { reviewAudit: { reviewId: 1, adminUserId: adminId } } });
    assert.equal(asAdmin.producer, "review_render");
    assert.equal(asAdmin.actor.kind, "admin");
    assert.equal(asAdmin.actor.userId, adminId);
    const unattended = await attemptProvenanceContext({ userId: null, evalRunId: null, renderControls: { reviewAudit: { reviewId: 1, adminUserId: "system" } } });
    assert.equal(unattended.actor.kind, "system");
    const product = await attemptProvenanceContext({ userId: memberId, evalRunId: null, renderControls: {} });
    assert.equal(product.producer, "product_render");
    assert.equal(product.actor.kind, "member");
  });
});

describe("the moderation hand-off", () => {
  it("a visual-concept approval's render batch carries the approving admin, not \"system\"", async () => {
    const enq = await enqueueForceReviewRenderPrepare(987_654_321, adminId);
    const jobId = enq.jobId;
    const rows = await db.select().from(asyncJobsTable).where(eq(asyncJobsTable.id, jobId));
    try {
      assert.equal((rows[0]!.payload as { adminUserId?: string }).adminUserId, adminId);
    } finally {
      await db.delete(asyncJobsTable).where(eq(asyncJobsTable.id, jobId));
    }
  });
});

describe("the trace", () => {
  it("reads ids and the links an admin would paste", () => {
    assert.deepEqual(parseTraceInput(" 123456 "), { kind: "id", id: 123456 });
    assert.deepEqual(parseTraceInput("https://overhype.me/m/abc123"), { kind: "meme", slug: "abc123" });
    assert.deepEqual(parseTraceInput("https://overhype.me/api/memes/abc123/image"), { kind: "meme", slug: "abc123" });
    assert.deepEqual(parseTraceInput("https://overhype.me/api/storage/objects/ai-bg-v2/5/9-1.png?x=1"), { kind: "object", objectPath: "/objects/ai-bg-v2/5/9-1.png" });
    assert.deepEqual(parseTraceInput("/api/admin/provenance/images/77"), { kind: "provenanceImage", id: 77 });
    assert.equal(parseTraceInput("hello there").kind, "unrecognised");
    // The links the admin screens show for a recorded picture (Codex, PR #911).
    assert.deepEqual(parseTraceInput("https://overhype.me/api/admin/reviews/12/renders/abc-123/image"), { kind: "moderationRender", renderJobId: "abc-123" });
    assert.deepEqual(parseTraceInput("/api/admin/comparison/panels/7/images/0123456789abcdef"), { kind: "comparisonImage", panelId: 7, token: "0123456789abcdef" });
    assert.deepEqual(parseTraceInput("/api/admin/eval/attempts/44/image"), { kind: "attempt", attemptId: 44 });
    assert.deepEqual(parseTraceInput("/api/memes/ai-user/image?storagePath=%2Fobjects%2Fai-bg-v2%2F5%2F9-1.png"), { kind: "object", objectPath: "/objects/ai-bg-v2/5/9-1.png" });
  });

  it("returns every record a link matches, never picking one", async () => {
    const path = ("/objects/" + `uploads/${P}/same.jpg`);
    const bytes = await picture("jpeg");
    await finish({ bytes, kind: "upload", actor: await actorForUser(memberId, "member"), stamp: false, objectPath: path });
    await finish({ bytes, kind: "upload", actor: await actorForUser(adminId, "member"), stamp: false, objectPath: path });
    const trace = await traceIdOrLink(`https://overhype.me/api/storage${path}`);
    assert.equal(trace.method, "link");
    assert.equal(trace.matches.length, 2);
    assert.deepEqual(new Set(trace.matches.map((m) => m.record.actorUserId)), new Set([memberId, adminId]));
  });

  it("traces a moderation render's and an eval render's link after the attempt is gone", async () => {
    const attemptId = 800_000_000 + Math.floor(Math.random() * 1000);
    const renderJobId = `${P}-job`;
    await finish({
      bytes: await picture("png"), kind: "ai_render", actor: await actorForUser(adminId, "admin"), stamp: true, stampEngine: "E",
      attemptId, objectPath: `/objects/ai-bg-v2/${P}/r.png`, snapshot: { renderJobId },
    });
    const byRender = await traceIdOrLink(`/api/admin/reviews/1/renders/${renderJobId}/image`);
    assert.equal(byRender.matches.length, 1);
    assert.equal(byRender.matches[0]!.record.attemptId, attemptId);
    const byEval = await traceIdOrLink(`/api/admin/eval/attempts/${attemptId}/image`);
    assert.equal(byEval.matches.length, 1);
  });

  it("traces a blind-judging link through the token the record holds, with no panel row", async () => {
    const panelId = 700_000_000 + Math.floor(Math.random() * 1000);
    const token = "0123456789abcdef";
    await finish({
      bytes: await picture("png"), kind: "comparison_cell", actor: await actorForUser(adminId, "admin"), stamp: true,
      comparisonCellId: 1, objectPath: `/objects/comparison/${P}/c.png`, snapshot: { panelId, blindToken: token },
    });
    const t = await traceIdOrLink(`https://overhype.me/api/admin/comparison/panels/${panelId}/images/${token}`);
    assert.equal(t.method, "link");
    assert.equal(t.matches.length, 1);
  });

  it("reads a broken link as unrecognised rather than failing", async () => {
    assert.equal(parseTraceInput("https://overhype.me/m/%E0%A4%A").kind, "unrecognised");
    const t = await traceIdOrLink("/api/storage/objects/%zz");
    assert.equal(t.matches.length, 0);
  });

  it("labels a legacy FLUX picture and says what it tried", async () => {
    const trace = await traceIdOrLink("https://overhype.me/api/storage/objects/ai-backgrounds/ab/12-male-x.png");
    assert.equal(trace.matches.length, 0);
    assert.match(trace.note ?? "", /Legacy path, settings not recorded/);
    assert.equal(trace.tried.length, 1);
  });

  it("is admin-only", async () => {
    const anon = buildTestApp({ kind: "unauthenticated" }, adminProvenanceRouter);
    const member = buildTestApp({ kind: "authenticated", userId: memberId }, adminProvenanceRouter);
    const admin = buildTestApp({ kind: "authenticated", userId: adminId }, adminProvenanceRouter);
    assert.notEqual((await request(anon).get("/api/admin/provenance/trace?q=1")).status, 200);
    assert.equal((await request(member).get("/api/admin/provenance/trace?q=1")).status, 403);
    assert.notEqual((await request(member).get("/api/admin/provenance/images/1")).status, 200);
    const ok = await request(admin).get("/api/admin/provenance/trace?q=1");
    assert.equal(ok.status, 200);
    assert.ok(Array.isArray(ok.body.tried));
  });
});

describe("the engine workbench", () => {
  it("hands back our stamped, recorded copy in place of the vendor URL, once", async () => {
    const vendorId = `${P}-wb`;
    const reqId = await recordGenerationRequest({
      producer: "engine_workbench", engineId: "wb-engine", endpointId: "fal-ai/wb", request: { prompt: "workbench" },
      actor: await actorForUser(adminId, "admin"),
    });
    createdRequestIds.push(reqId);
    await setVendorRequestId(reqId, vendorId);
    const png = await picture("png");
    const stored: Array<{ subPath: string; buffer: Buffer }> = [];
    const deps = {
      storage: { uploadObjectBuffer: async (a: { subPath: string; buffer: Buffer }) => { stored.push(a); return `/objects/${a.subPath}`; } },
      download: async () => png,
      exists: async (path: string) => stored.some((x) => `/objects/${x.subPath}` === path),
    };
    const vendorResult = { images: [{ url: "https://v3.fal.media/files/x.png", width: 41 }], seed: 3 };
    const first = await finishWorkbenchResult({ id: "wb-engine", label: "WB Engine" }, vendorId, vendorResult, deps) as typeof vendorResult & { images: Array<{ url: string; provenance_id: string }> };
    assert.match(first.images[0]!.url, /^\/api\/admin\/provenance\/images\/\d+$/);
    assert.ok(!JSON.stringify(first).includes("fal.media"), "the vendor URL is gone");
    const id = Number(first.images[0]!.provenance_id);
    createdRecordIds.push(id);
    assert.equal(readStampedId(stored[0]!.buffer), id);
    const [row] = await db.select().from(imageProvenanceTable).where(eq(imageProvenanceTable.id, id));
    assert.equal(row!.generationRequestId, reqId);
    assert.equal(row!.actorUserId, adminId);

    const again = await finishWorkbenchResult({ id: "wb-engine", label: "WB Engine" }, vendorId, vendorResult, deps) as typeof first;
    assert.equal(again.images[0]!.url, first.images[0]!.url, "a repeated poll reuses the record");
    assert.equal(stored.length, 1);
  });

  it("stores again when an earlier poll's store failed after its record was written (Codex, PR #911)", async () => {
    const vendorId = `${P}-wb-fail`;
    const reqId = await recordGenerationRequest({
      producer: "engine_workbench", engineId: "wb-engine", endpointId: "fal-ai/wb", request: { prompt: "x" },
      actor: await actorForUser(adminId, "admin"),
    });
    createdRequestIds.push(reqId);
    await setVendorRequestId(reqId, vendorId);
    const png = await picture("png");
    const stored: string[] = [];
    let failNext = true;
    const deps = {
      storage: { uploadObjectBuffer: async (a: { subPath: string }) => {
        if (failNext) { failNext = false; throw new Error("storage down"); }
        stored.push(`/objects/${a.subPath}`); return `/objects/${a.subPath}`;
      } },
      download: async () => png,
      exists: async (path: string) => stored.includes(path),
    };
    const vendorResult = { images: [{ url: "https://v3.fal.media/files/y.png" }] };
    await assert.rejects(finishWorkbenchResult({ id: "wb-engine", label: "WB" }, vendorId, vendorResult, deps));
    const retried = await finishWorkbenchResult({ id: "wb-engine", label: "WB" }, vendorId, vendorResult, deps) as { images: Array<{ url: string; provenance_id: string }> };
    assert.equal(stored.length, 1, "the second poll stored the picture");
    const records = await db.select().from(imageProvenanceTable).where(eq(imageProvenanceTable.generationRequestId, reqId));
    records.forEach((r) => createdRecordIds.push(r.id));
    assert.equal(records.length, 2, "the failed store's record stays; the stored picture has its own");
    assert.equal(retried.images[0]!.url, `/api/admin/provenance/images/${retried.images[0]!.provenance_id}`);
    assert.equal(stored[0], records.find((r) => String(r.id) === retried.images[0]!.provenance_id)!.objectPath);
  });

  it("leaves a result with no image unchanged", async () => {
    const r = { label: "safe", score: 0.1 };
    assert.deepEqual(await finishWorkbenchResult({ id: "x", label: "x" }, `${P}-none`, r), r);
  });
});

describe("retention", () => {
  it("deletes nothing while the setting is 0 (kept indefinitely)", async () => {
    // Migration 0129 seeds the setting at 0; a database without the row reads the same default.
    const [cfg] = await db.select().from(adminConfigTable).where(eq(adminConfigTable.key, "image_provenance.retention_days"));
    assert.ok(cfg === undefined || cfg.value === "0");
    const result = await runProvenanceRetentionPurge();
    assert.deepEqual(result, { retentionDays: 0, deletedRecords: 0, deletedRequests: 0 });
  });
});

describe("the producer inventory", () => {
  // Plan, Settled Decision 10 and Testing Plan: a producer that skips the
  // finishing step is caught here. Every source file that stores bytes or
  // calls the image vendor must also record provenance, or be named below
  // with the reason it does not (yet).
  const SRC = new URL("../", import.meta.url).pathname;
  const EXEMPT: Record<string, string> = {
    "lib/objectStorage.ts": "the store itself, and the restricted (quarantine) wrapper, which moves existing bytes",
    "lib/aiMemePipeline.ts": "the legacy FLUX path, labelled not instrumented; retired by #887 increment 4",
    "lib/sourceImageAnalysis/tier1FalDetector.ts": "a classifier: returns no image",
    "lib/comparison/transport.ts": "the comparison's fal transport, behind comparison/runs.ts, which records",
    "testing/legacyFixture/load.ts": "test fixture data",
  };
  const PRODUCES = /uploadObjectBuffer\(|fal\.subscribe\(|fal\.queue\.submit|fal\.queue\.result/;
  const RECORDS = /finishAndStore\(|finishImage\(|recordGenerationRequest\(|finishWorkbenchResult\(|finishMeme\(/;

  it("every file that stores a picture or calls the image vendor records provenance, or is named as exempt", async () => {
    const { readdir, readFile } = await import("node:fs/promises");
    const files = (await readdir(SRC, { recursive: true }))
      .filter((f) => f.endsWith(".ts") && !f.includes("__tests__") && !f.endsWith(".test.ts"));
    const unrecorded: string[] = [];
    for (const f of files) {
      const text = await readFile(SRC + f, "utf8");
      if (PRODUCES.test(text) && !RECORDS.test(text) && !(f in EXEMPT) && f !== "lib/provenance/records.ts") unrecorded.push(f);
    }
    assert.deepEqual(unrecorded, [], "a new producer must call the finishing step (lib/provenance/records.ts) or be exempted here with a reason");
  });

  // Increment 2: a meme is drawn by three functions that return an unmarked,
  // unrecorded picture. Each may be called only by the traced wrapper beside
  // it (composeTracedMeme, renderTracedMeme, which go through finishMeme), so
  // a new route that draws a meme cannot send one without its record. Unlike
  // the file-level check above, this one is per function: a file that already
  // records cannot quietly gain an untraced call.
  it("the untraced meme-drawing functions are called only by the traced wrappers", async () => {
    const { readdir, readFile } = await import("node:fs/promises");
    const ALLOWED: Record<string, string[]> = {
      generateMemeBuffer: ["lib/memeGenerator.ts", "lib/memeComposite.ts", "lib/memeBake.ts"],
      composeMeme: ["lib/memeComposite.ts"],
      renderMemeRecipe: ["lib/memeBake.ts"],
    };
    const files = (await readdir(SRC, { recursive: true }))
      .filter((f) => f.endsWith(".ts") && !f.includes("__tests__") && !f.endsWith(".test.ts"));
    const strays: string[] = [];
    for (const f of files) {
      const text = await readFile(SRC + f, "utf8");
      for (const [fn, allowed] of Object.entries(ALLOWED)) {
        if (new RegExp(`\\b${fn}\\(`).test(text) && !allowed.includes(f)) strays.push(`${f} calls ${fn}`);
      }
    }
    assert.deepEqual(strays, [], "draw a meme through composeTracedMeme or renderTracedMeme, which record and watermark it");
  });
});
