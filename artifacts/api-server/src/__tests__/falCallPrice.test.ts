/**
 * The recorder's per-call fal price (#631 increment 8, D7): a per-megapixel
 * endpoint is bounded from the request rather than refused, and anything the
 * bound cannot read is still refused, never under-reserved.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { db } from "@workspace/db";
import { falPricingCacheTable } from "@workspace/db/schema";
import { like } from "drizzle-orm";

import { falCachedCallPrice, falCallPrice } from "../lib/falClient.js";
import { Allowance, recordingFal } from "../lib/aiDouble/recorder.js";
import { resetRecordingCache } from "../lib/aiDouble/recordings.js";
import { FAL_PRESET_SIZES } from "../lib/aiDouble/falPresetSizes.js";
import { resolveImageSizePx } from "../lib/costComputation.js";

const PULID = "fal-ai/flux-pulid";
// The pricing API's answer for flux-pulid, as recorded 2026-10-13
// (src/lib/aiDouble/recordings/fal.pricing--308484772fa6….json).
const MEGAPIXEL = { prices: [{ endpoint_id: PULID, unit_price: 0.0333, unit: "megapixels", currency: "USD" }] };
const PER_IMAGE = { prices: [{ endpoint_id: "fal-ai/nano-banana-2", unit_price: 0.08, unit: "image", currency: "USD" }] };

const close = (a: number | null, b: number) => assert.ok(a !== null && Math.abs(a - b) < 1e-9, `${a} ≈ ${b}`);

describe("falCallPrice", () => {
  it("keeps a per-image price as it stands", () => {
    close(falCallPrice(PER_IMAGE, "fal-ai/nano-banana-2", { prompt: "x" }), 0.08);
  });

  it("bounds a per-megapixel price from a named preset, rounded up to whole megapixels", () => {
    // portrait_16_9 is 576×1024 = 0.59 MP → 1 MP.
    close(falCallPrice(MEGAPIXEL, PULID, { image_size: "portrait_16_9" }), 0.0333);
    // square_hd is 1024×1024 = 1.05 MP → 2 MP.
    close(falCallPrice(MEGAPIXEL, PULID, { image_size: "square_hd" }), 0.0666);
  });

  it("multiplies by num_images and reads an explicit size", () => {
    close(falCallPrice(MEGAPIXEL, PULID, { image_size: { width: 1600, height: 1200 }, num_images: 3 }), 0.0333 * 2 * 3);
  });

  it("uses fal's landscape_4_3 default when the request names no size", () => {
    close(falCallPrice(MEGAPIXEL, PULID, { prompt: "x" }), 0.0333);
  });

  it("refuses what it cannot bound: an unknown preset, a malformed size or count, an unknown unit, no entry", () => {
    assert.equal(falCallPrice(MEGAPIXEL, PULID, { image_size: "huge" }), null);
    assert.equal(falCallPrice(MEGAPIXEL, PULID, { image_size: { width: "1024" } }), null);
    assert.equal(falCallPrice(MEGAPIXEL, PULID, { num_images: 0 }), null);
    assert.equal(falCallPrice(MEGAPIXEL, PULID, { num_images: 1.5 }), null);
    assert.equal(falCallPrice({ prices: [{ endpoint_id: PULID, unit_price: 0.1, unit: "seconds" }] }, PULID, {}), null);
    assert.equal(falCallPrice(MEGAPIXEL, "fal-ai/other", {}), null);
    assert.equal(falCallPrice(null, PULID, {}), null);
  });
});

describe("the recorder's preset table", () => {
  it("matches the product's own fal preset sizes, entry for entry", () => {
    for (const [name, size] of Object.entries(FAL_PRESET_SIZES)) assert.deepEqual(resolveImageSizePx(name), size, name);
  });
});

describe("recordingFal prices each call from its request", () => {
  // The recorder writes what it records; point it at a scratch directory, never the committed recordings.
  let saved: string | undefined;
  let dir: string;
  before(() => {
    saved = process.env.AI_RECORDINGS_DIR;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fal-call-price-"));
    process.env.AI_RECORDINGS_DIR = dir;
    resetRecordingCache();
  });
  after(() => {
    if (saved === undefined) delete process.env.AI_RECORDINGS_DIR;
    else process.env.AI_RECORDINGS_DIR = saved;
    resetRecordingCache();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("hands the subscribe input to the price lookup", async () => {
    const seen: unknown[] = [];
    const vendor = {
      async subscribe() {
        return { data: { images: [] } };
      },
      storage: { async upload() { return "https://v3.fal.media/files/x.png"; } },
      queue: { submit: async () => ({}), status: async () => ({}), result: async () => ({}) },
      config() {},
    };
    const rec = recordingFal(vendor as never, new Allowance(1), { clients: {} } as never, async (_endpoint, input) => {
      seen.push(input);
      return 0.01;
    });
    await rec.subscribe(PULID, { input: { image_size: "portrait_16_9", prompt: "unpriced-input-probe" } });
    assert.deepEqual(seen, [{ image_size: "portrait_16_9", prompt: "unpriced-input-probe" }]);
  });
});

describe("falCachedCallPrice: the in-server recorder prices from the product's cache", () => {
  const PREFIX = "tfccprice-";
  const KEYS = ["FAL_AI_API_KEY", "FAL_KEY", "AI_BACKEND"] as const;
  let saved: Record<string, string | undefined> = {};
  before(async () => {
    saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
    for (const k of KEYS) delete process.env[k];
    await db.delete(falPricingCacheTable).where(like(falPricingCacheTable.endpointId, `${PREFIX}%`));
    const now = new Date();
    await db.insert(falPricingCacheTable).values({ endpointId: `${PREFIX}pulid`, unitPrice: "0.0333", unit: "megapixels", currency: "USD", fetchedAt: now, createdAt: now, updatedAt: now });
  });
  after(async () => {
    await db.delete(falPricingCacheTable).where(like(falPricingCacheTable.endpointId, `${PREFIX}%`));
    for (const k of KEYS) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  });

  it("bounds a cached per-megapixel price from the request, with no live pricing call", async () => {
    close(await falCachedCallPrice(`${PREFIX}pulid`, { image_size: "square_hd" }), 0.0666);
  });

  it("ignores a stale cached price and refuses when it cannot fetch a live one", async () => {
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await db.insert(falPricingCacheTable).values({ endpointId: `${PREFIX}stale`, unitPrice: "0.0333", unit: "megapixels", currency: "USD", fetchedAt: old, createdAt: old, updatedAt: old });
    assert.equal(await falCachedCallPrice(`${PREFIX}stale`, { image_size: "square_hd" }), null);
  });

  it("refuses an endpoint the cache has no price for and cannot fetch one", async () => {
    assert.equal(await falCachedCallPrice(`${PREFIX}absent`, { image_size: "square_hd" }), null);
  });
});
