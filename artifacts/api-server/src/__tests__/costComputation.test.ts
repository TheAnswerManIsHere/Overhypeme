import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  resolveImageSizePx,
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
