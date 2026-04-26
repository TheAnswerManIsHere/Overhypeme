import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  resolveImageSizePx,
  resolveVideoDimensions,
  computeVideoCost,
  computeImageCost,
} from "../lib/costComputation.js";
import type { CachedPrice } from "../lib/falPricing.js";

const FETCHED_AT = new Date("2026-01-01T00:00:00Z");

function assertClose(actual: number, expected: number, epsilon = 1e-9): void {
  assert.ok(
    Math.abs(actual - expected) < epsilon,
    `expected ${actual} ≈ ${expected} (within ${epsilon})`,
  );
}

describe("resolveImageSizePx", () => {
  it("returns 1024×1024 for square_hd", () => {
    assert.deepEqual(resolveImageSizePx("square_hd"), { width: 1024, height: 1024 });
  });

  it("returns 512×512 for square", () => {
    assert.deepEqual(resolveImageSizePx("square"), { width: 512, height: 512 });
  });

  it("returns 768×1024 for portrait_4_3", () => {
    assert.deepEqual(resolveImageSizePx("portrait_4_3"), { width: 768, height: 1024 });
  });

  it("returns 576×1024 for portrait_16_9", () => {
    assert.deepEqual(resolveImageSizePx("portrait_16_9"), { width: 576, height: 1024 });
  });

  it("returns 1024×768 for landscape_4_3", () => {
    assert.deepEqual(resolveImageSizePx("landscape_4_3"), { width: 1024, height: 768 });
  });

  it("returns 1024×576 for landscape_16_9", () => {
    assert.deepEqual(resolveImageSizePx("landscape_16_9"), { width: 1024, height: 576 });
  });

  it("falls back to 1024×1024 for an unknown image_size name", () => {
    assert.deepEqual(resolveImageSizePx("totally-bogus"), { width: 1024, height: 1024 });
  });

  it("falls back to 1024×1024 for an empty string", () => {
    assert.deepEqual(resolveImageSizePx(""), { width: 1024, height: 1024 });
  });
});

describe("resolveVideoDimensions at 720p", () => {
  const cases: Array<[string, { width: number; height: number }]> = [
    ["16:9", { width: 1280, height: 720 }],
    ["9:16", { width: 720, height: 1280 }],
    ["1:1", { width: 720, height: 720 }],
    ["4:3", { width: 960, height: 720 }],
    ["3:4", { width: 720, height: 960 }],
    ["3:2", { width: 1080, height: 720 }],
    ["2:3", { width: 720, height: 1080 }],
    ["21:9", { width: 1680, height: 720 }],
  ];

  for (const [aspect, expected] of cases) {
    it(`returns ${expected.width}×${expected.height} for ${aspect}`, () => {
      assert.deepEqual(resolveVideoDimensions(aspect, "720p"), expected);
    });
  }

  it("falls back to 1280×720 for an unknown aspect ratio", () => {
    assert.deepEqual(resolveVideoDimensions("99:1", "720p"), { width: 1280, height: 720 });
  });

  it("treats an unknown resolution as 720p (no scaling applied)", () => {
    assert.deepEqual(resolveVideoDimensions("16:9", "1080p"), { width: 1280, height: 720 });
  });
});

describe("resolveVideoDimensions at 480p", () => {
  it("scales 16:9 720p proportionally to 480p (853×480)", () => {
    // 1280 * (480/720) = 853.33 → round to 853
    // 720  * (480/720) = 480
    assert.deepEqual(resolveVideoDimensions("16:9", "480p"), { width: 853, height: 480 });
  });

  it("scales 1:1 720p to 480×480", () => {
    assert.deepEqual(resolveVideoDimensions("1:1", "480p"), { width: 480, height: 480 });
  });

  it("scales 9:16 720p to 480×853", () => {
    assert.deepEqual(resolveVideoDimensions("9:16", "480p"), { width: 480, height: 853 });
  });

  it("scales 4:3 720p to 640×480", () => {
    assert.deepEqual(resolveVideoDimensions("4:3", "480p"), { width: 640, height: 480 });
  });

  it("scales 21:9 720p to 1120×480", () => {
    assert.deepEqual(resolveVideoDimensions("21:9", "480p"), { width: 1120, height: 480 });
  });

  it("scales the fallback 1280×720 to 853×480 when aspect ratio is unknown", () => {
    assert.deepEqual(resolveVideoDimensions("bogus", "480p"), { width: 853, height: 480 });
  });
});

describe("computeVideoCost", () => {
  const price: CachedPrice = { unitPrice: 1.0, unit: "video_token", fetchedAt: FETCHED_AT };

  it("returns the formula tokens = w*h*fps*sec/1024 and cost = (tokens/1M)*unitPrice", () => {
    // 1280 * 720 * 24 * 5 / 1024 = 108_000 tokens
    // (108_000 / 1_000_000) * 1.0 = 0.108 USD
    const result = computeVideoCost(
      { width: 1280, height: 720, fps: 24, durationSeconds: 5 },
      price,
    );
    assert.equal(result.billingUnits, 108_000);
    assertClose(result.costUsd, 0.108);
  });

  it("scales linearly with unitPrice", () => {
    const result = computeVideoCost(
      { width: 1280, height: 720, fps: 24, durationSeconds: 5 },
      { ...price, unitPrice: 2.5 },
    );
    assert.equal(result.billingUnits, 108_000);
    assertClose(result.costUsd, 0.27);
  });

  it("returns zero cost when duration is zero", () => {
    const result = computeVideoCost(
      { width: 1280, height: 720, fps: 24, durationSeconds: 0 },
      price,
    );
    assert.equal(result.billingUnits, 0);
    assert.equal(result.costUsd, 0);
  });

  it("returns zero cost when unitPrice is zero", () => {
    const result = computeVideoCost(
      { width: 1280, height: 720, fps: 24, durationSeconds: 5 },
      { ...price, unitPrice: 0 },
    );
    assert.equal(result.billingUnits, 108_000);
    assert.equal(result.costUsd, 0);
  });

  it("doubles cost when duration doubles", () => {
    const a = computeVideoCost(
      { width: 1280, height: 720, fps: 24, durationSeconds: 5 },
      price,
    );
    const b = computeVideoCost(
      { width: 1280, height: 720, fps: 24, durationSeconds: 10 },
      price,
    );
    assertClose(b.costUsd, a.costUsd * 2);
    assert.equal(b.billingUnits, a.billingUnits * 2);
  });
});

describe("computeImageCost", () => {
  const FETCHED = new Date("2026-01-01T00:00:00Z");

  it("uses per-image pricing when unit is 'image'", () => {
    const price: CachedPrice = { unitPrice: 0.05, unit: "image", fetchedAt: FETCHED };
    const result = computeImageCost({ widthPx: 1024, heightPx: 1024, count: 4 }, price);
    assert.equal(result.billingUnits, 4);
    assertClose(result.costUsd, 0.20);
  });

  it("uses per-image pricing as the default for any non-megapixel unit", () => {
    const price: CachedPrice = { unitPrice: 0.05, unit: "weird_unit", fetchedAt: FETCHED };
    const result = computeImageCost({ widthPx: 1024, heightPx: 1024, count: 3 }, price);
    assert.equal(result.billingUnits, 3);
    assertClose(result.costUsd, 0.15);
  });

  it("uses megapixel pricing when unit is 'megapixel'", () => {
    const price: CachedPrice = { unitPrice: 0.10, unit: "megapixel", fetchedAt: FETCHED };
    // 1024 * 1024 * 2 / 1_000_000 = 2.097152 MP
    // cost = 2.097152 * 0.10 = 0.2097152
    const result = computeImageCost({ widthPx: 1024, heightPx: 1024, count: 2 }, price);
    assertClose(result.billingUnits, 2.097152);
    assertClose(result.costUsd, 0.2097152);
  });

  it("returns zero cost when count is zero (per-image)", () => {
    const price: CachedPrice = { unitPrice: 0.05, unit: "image", fetchedAt: FETCHED };
    const result = computeImageCost({ widthPx: 1024, heightPx: 1024, count: 0 }, price);
    assert.equal(result.billingUnits, 0);
    assert.equal(result.costUsd, 0);
  });

  it("returns zero cost when count is zero (megapixel)", () => {
    const price: CachedPrice = { unitPrice: 0.10, unit: "megapixel", fetchedAt: FETCHED };
    const result = computeImageCost({ widthPx: 1024, heightPx: 1024, count: 0 }, price);
    assert.equal(result.billingUnits, 0);
    assert.equal(result.costUsd, 0);
  });

  it("returns zero cost when unitPrice is zero", () => {
    const price: CachedPrice = { unitPrice: 0, unit: "image", fetchedAt: FETCHED };
    const result = computeImageCost({ widthPx: 1024, heightPx: 1024, count: 5 }, price);
    assert.equal(result.billingUnits, 5);
    assert.equal(result.costUsd, 0);
  });

  it("scales megapixel billing with both image dimensions and count", () => {
    const price: CachedPrice = { unitPrice: 1.0, unit: "megapixel", fetchedAt: FETCHED };
    const a = computeImageCost({ widthPx: 1000, heightPx: 1000, count: 1 }, price);
    const b = computeImageCost({ widthPx: 2000, heightPx: 1000, count: 1 }, price);
    const c = computeImageCost({ widthPx: 1000, heightPx: 1000, count: 4 }, price);
    assert.equal(a.billingUnits, 1);
    assert.equal(b.billingUnits, 2);
    assert.equal(c.billingUnits, 4);
  });
});
