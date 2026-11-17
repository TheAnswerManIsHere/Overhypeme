/**
 * @purpose Image tracing, increment 2 (plan docs/plans/PLAN_IMAGE_TRACING.md; #912), end to end through the real producers: a member uploads a photo through the real upload route and saves a meme from it through the real save; the meme is then traced by its link, by its own file, and — after the copy has lost its metadata, been recompressed and resized as a social feed would, and been screenshotted with bars round it — by its invisible watermark alone; every route finds the one meme record, chained to the upload's record. A photo that never passed through Overhype.me finds nothing.
 * @subsystem provenance
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import request from "supertest";
import express from "express";

import { db } from "@workspace/db";
import { factsTable, imageProvenanceTable, memesTable, usersTable } from "@workspace/db/schema";
import { eq, inArray, like, or } from "drizzle-orm";
import { insertLiveFact } from "@workspace/db/live-fact-fixture";
import { buildPlaceholderFactEnrichment, buildPlaceholderGag } from "@workspace/api-zod";

import storageRouter from "../routes/storage.js";
import adminProvenanceRouter from "../routes/adminProvenance.js";
import { createMemeRecord, type MemeAuthorizationDecisions } from "../lib/createMemeRecord.js";
import { ObjectStorageService } from "../lib/objectStorage.js";
import { memeKey } from "../lib/storageKeys.js";
import { logger } from "../lib/logger.js";
import { buildTestApp } from "./helpers/buildTestApp.js";
import { photoBackgrounds } from "./helpers/photoBackground.js";

const P = `t-trm-${randomUUID().slice(0, 6)}`;
const memberId = `${P}-member`;
const adminId = `${P}-admin`;
const ALLOW_ALL: MemeAuthorizationDecisions = { meme_private_visibility: true, meme_rate_limit_high: true };
const PHOTO = fs.readFileSync(new URL("../assets/test-face.jpg", import.meta.url));

interface TraceBody {
  method: string | null;
  matches: { record: { id: number; kind: string; sourceProvenanceId: number | null; memeSlug: string | null }; source: { id: number; kind: string } | null }[];
  tried: string[];
}

describe("a meme traces back to how it was made, from its link or from the picture alone", () => {
  const photos = photoBackgrounds();
  let factId: number;
  let uploadKey: string;
  let uploadRecord: number;
  let slug: string;
  let memeRecord: number;
  let memeFile: Buffer;
  const admin = () => buildTestApp({ kind: "authenticated", userId: adminId }, adminProvenanceRouter);
  const traceFile = async (file: Buffer): Promise<TraceBody> =>
    (await request(admin()).post("/api/admin/provenance/trace-image").set("Content-Type", "image/jpeg").send(file).expect(200)).body as TraceBody;

  // The upload route skips the fal NSFW classifier when no fal key is set,
  // which is what this test relies on. With test isolation off, another file's
  // dummy key (another test file may set one at import) can still be set here,
  // and the route then calls the real classifier and fails closed with a 503
  // (PR #936: a new test file moved this one into that file's shard).
  const falKey = process.env["FAL_AI_API_KEY"];
  const falKeyAlt = process.env["FAL_KEY"];

  before(async () => {
    delete process.env["FAL_AI_API_KEY"];
    delete process.env["FAL_KEY"];
    photos.setUp();
    await db.insert(usersTable).values([
      { id: memberId, email: `${memberId}@test.local`, displayName: "Alex", pronouns: "they/them", membershipTier: "legendary" },
      { id: adminId, email: `${adminId}@test.local`, membershipTier: "legendary", isAdmin: true },
    ]);
    const fact = await insertLiveFact({ text: `${P} {NAME} {outruns|outrun} the sunrise.`, enrichment: buildPlaceholderFactEnrichment(), canonicalText: `${P} They outrun the sunrise.` }, buildPlaceholderGag());
    factId = fact!.id;
  });

  after(async () => {
    await db.delete(memesTable).where(eq(memesTable.createdById, memberId));
    await db.delete(imageProvenanceTable).where(or(eq(imageProvenanceTable.actorUserId, memberId), eq(imageProvenanceTable.factId, factId)));
    await db.delete(factsTable).where(eq(factsTable.id, factId));
    await db.delete(usersTable).where(inArray(usersTable.id, [memberId, adminId]));
    await photos.tearDown();
    if (falKey === undefined) delete process.env["FAL_AI_API_KEY"]; else process.env["FAL_AI_API_KEY"] = falKey;
    if (falKeyAlt === undefined) delete process.env["FAL_KEY"]; else process.env["FAL_KEY"] = falKeyAlt;
  });

  it("the member's upload, through the real route, is recorded", async () => {
    // The upload route logs through req.log, which the production app's request logger provides.
    const app = express();
    app.use((req, _res, next) => { (req as unknown as { log: typeof logger }).log = logger; next(); });
    app.use(buildTestApp({ kind: "authenticated", userId: memberId }, storageRouter));
    const res = await request(app)
      .post("/api/storage/upload-meme").set("Content-Type", "image/jpeg").send(PHOTO);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    uploadKey = res.body.objectPath;
    const [rec] = await db.select().from(imageProvenanceTable).where(eq(imageProvenanceTable.objectPath, uploadKey));
    assert.ok(rec, "the upload has a record");
    assert.equal(rec!.kind, "upload");
    uploadRecord = rec!.id;
  });

  it("saving a meme from it stores a watermarked, stamped file whose record is chained to the upload", async () => {
    const saved = await createMemeRecord({
      userId: memberId, factId, imageSource: { type: "upload", uploadKey }, aspectRatio: "landscape", decisions: ALLOW_ALL,
    });
    slug = saved.permalinkSlug;
    const [rec] = await db.select().from(imageProvenanceTable).where(eq(imageProvenanceTable.memeSlug, slug));
    assert.ok(rec);
    assert.equal(rec!.kind, "meme_bake");
    assert.equal(rec!.sourceProvenanceId, uploadRecord, "chained to the photo it was drawn on");
    assert.equal(rec!.watermarkScheme, "trustmark-q/bch5/v1");
    assert.equal(rec!.actorEmail, `${memberId}@test.local`);
    // Everything the drawing came from (the completeness audit): the words, which of them were drawn in the
    // name's colour, the template they came from, the identity, the layout; the photo is the source record.
    const snap = rec!.snapshot as Record<string, unknown>;
    assert.match(String(snap["caption"]), /Alex outrun the sunrise\./);
    assert.equal(snap["factTemplate"], `${P} {NAME} {outruns|outrun} the sunrise.`);
    assert.ok(JSON.stringify(snap["captionRuns"]).includes('"isName":true'), "the runs drawn in the name's colour");
    assert.deepEqual(snap["identity"], { name: "Alex", pronouns: "they/them" });
    assert.equal(snap["aspectRatio"], "landscape");
    assert.deepEqual(snap["imageSource"], { type: "upload", uploadKey });
    memeRecord = rec!.id;
    const storage = new ObjectStorageService();
    memeFile = Buffer.from(await (await storage.downloadObject(await storage.getObjectEntityFile(`/objects/${memeKey(slug, "jpg")}`))).arrayBuffer());
  });

  it("the meme's link finds its record and the upload behind it", async () => {
    const res = await request(admin()).get("/api/admin/provenance/trace").query({ q: `https://overhype.me/m/${slug}` }).expect(200);
    const body = res.body as TraceBody;
    assert.equal(body.method, "link");
    assert.deepEqual(body.matches.map((m) => m.record.id), [memeRecord]);
    assert.equal(body.matches[0]!.source?.id, uploadRecord);
  });

  it("the meme's own file is found by its stamp, its exact bytes and its watermark, all naming one record", async () => {
    const body = await traceFile(memeFile);
    assert.equal(body.method, "metadata");
    assert.deepEqual(body.matches.map((m) => m.record.id), [memeRecord]);
    assert.match(body.tried.join("\n"), new RegExp(`metadata: id ${memeRecord}, found`));
    assert.match(body.tried.join("\n"), /exact bytes: 1 record/);
    assert.match(body.tried.join("\n"), new RegExp(`watermark: id ${memeRecord}`));
  });

  it("a copy stripped of metadata, recompressed and resized as a social feed would is found by its watermark alone", async () => {
    const shared = await sharp(memeFile).resize({ width: 1080 }).jpeg({ quality: 75 }).toBuffer();
    const body = await traceFile(shared);
    assert.equal(body.method, "watermark");
    assert.deepEqual(body.matches.map((m) => m.record.id), [memeRecord]);
    assert.equal(body.matches[0]!.source?.id, uploadRecord, "and still reaches the upload");
  });

  it("a screenshot with bars round the picture is found once the bars are cut away", async () => {
    const small = await sharp(memeFile).resize({ width: 1200 }).toBuffer();
    const shot = await sharp(small).extend({ top: 180, bottom: 240, left: 0, right: 0, background: "#ffffff" }).png().toBuffer();
    const body = await traceFile(shot);
    assert.equal(body.method, "watermark");
    assert.deepEqual(body.matches.map((m) => m.record.id), [memeRecord]);
    assert.match(body.tried.join("\n"), /after cutting away bars/);
  });

  // #981: a Safari screenshot of the saved-meme page on an iPad — the meme scaled down inside the page, its
  // corners rounded off, a badge and size text above it, an info bar and a heart counter below, a footer — did
  // not trace: the page's text and bars are not plain, so cutting away plain bars stopped short of the picture.
  // Then David's real iPad screenshot still did not trace: its meme was a night scene on a dark page, and the
  // meme's border differed from the page by under 16 levels — no edge a single-pixel step could see. `blend`
  // paints the page in the meme's own border colour, the same property.
  const pageScreenshot = async (picture: Buffer, opts: { blend?: boolean } = {}): Promise<Buffer> => {
    const SW = 1930;
    const meta = await sharp(picture).metadata();
    const SH = Math.round((meta.height! * SW) / meta.width!);
    const scaled = await sharp(picture).resize(SW, SH).png().toBuffer();
    let background = "#0d0d10";
    if (opts.blend) {
      // the mean colour of the meme's outer frame, eight pixels deep
      const { data } = await sharp(scaled).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      const sum = [0, 0, 0];
      let n = 0;
      for (let y = 0; y < SH; y++) for (let x = 0; x < SW; x++) {
        if (x >= 8 && x < SW - 8 && y >= 8 && y < SH - 8) continue;
        for (let c = 0; c < 3; c++) sum[c] += data[(y * SW + x) * 3 + c];
        n++;
      }
      background = `#${sum.map((v) => Math.round(v / n).toString(16).padStart(2, "0")).join("")}`;
    }
    const corners = Buffer.from(`<svg width="${SW}" height="${SH}"><rect width="${SW}" height="${SH}" rx="28" ry="28" fill="#fff"/></svg>`);
    const rounded = await sharp(scaled).ensureAlpha().composite([{ input: corners, blend: "dest-in" }]).png().toBuffer();
    const left = 35, top = 170;
    const chrome = Buffer.from(`<svg width="2000" height="1500">
      <rect x="40" y="60" width="160" height="60" rx="8" fill="#f5c400"/><text x="60" y="102" font-size="34" font-family="sans-serif">SAVED</text>
      <text x="1500" y="102" font-size="30" font-family="monospace" fill="#aaa">4032x2268</text>
      <rect x="${left}" y="${top + SH + 10}" width="${SW}" height="70" fill="#1c1c1c"/>
      <text x="60" y="${top + SH + 55}" font-size="30" font-family="monospace" fill="#ccc">file: image · size: 1.73 MB · res: 4032x2268</text>
      <text x="1800" y="${top + SH + 55}" font-size="36" fill="#e33">♥ 12</text>
      <rect x="0" y="1400" width="2000" height="100" fill="#222"/></svg>`);
    return sharp({ create: { width: 2000, height: 1500, channels: 3, background } })
      .composite([{ input: rounded, left, top }, { input: chrome, left: 0, top: 0 }]).png().toBuffer();
  };

  it("a screenshot of the saved-meme page, the meme scaled down with rounded corners amid the page's text and bars, is found", async () => {
    const big = await sharp(memeFile).resize(4032, 2268, { fit: "fill" }).jpeg({ quality: 92 }).toBuffer();
    const body = await traceFile(await pageScreenshot(big));
    assert.equal(body.method, "watermark");
    assert.deepEqual(body.matches.map((m) => m.record.id), [memeRecord]);
  });

  it("the same page screenshot is found when the page is the meme's own border colour, so its border barely shows", async () => {
    const big = await sharp(memeFile).resize(4032, 2268, { fit: "fill" }).jpeg({ quality: 92 }).toBuffer();
    const body = await traceFile(await pageScreenshot(big, { blend: true }));
    assert.equal(body.method, "watermark");
    assert.deepEqual(body.matches.map((m) => m.record.id), [memeRecord]);
  });

  it("the same page screenshot of a picture that never passed through Overhype.me finds nothing", async () => {
    const foreign = await sharp(fs.readFileSync(new URL("../assets/render-references/female.jpg", import.meta.url)))
      .resize(4032, 2268, { fit: "cover" }).jpeg().toBuffer();
    for (const blend of [false, true]) {
      const body = await traceFile(await pageScreenshot(foreign, { blend }));
      assert.equal(body.method, null);
      assert.deepEqual(body.matches, []);
    }
  });

  it("the member's original photo is found by its exact bytes, as their upload", async () => {
    const body = await traceFile(PHOTO);
    assert.equal(body.method, "hash");
    assert.deepEqual(body.matches.map((m) => m.record.id), [uploadRecord]);
  });

  it("a photo that never passed through Overhype.me finds nothing, and says what was tried", async () => {
    const body = await traceFile(fs.readFileSync(new URL("../assets/render-references/male.jpg", import.meta.url)));
    assert.equal(body.method, null);
    assert.deepEqual(body.matches, []);
    assert.equal(body.tried.length, 3);
  });

  it("a member cannot trace a picture", async () => {
    await request(buildTestApp({ kind: "authenticated", userId: memberId }, adminProvenanceRouter))
      .post("/api/admin/provenance/trace-image").set("Content-Type", "image/jpeg").send(memeFile).expect(403);
  });
});
