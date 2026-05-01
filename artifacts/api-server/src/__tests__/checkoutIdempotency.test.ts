import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveCheckoutRequestKey } from "../lib/checkoutIdempotency.js";

describe("resolveCheckoutRequestKey", () => {
  it("reuses client request ID when provided (deterministic for same user+price)", () => {
    const key1 = resolveCheckoutRequestKey({
      userId: "u_1",
      priceId: "price_1",
      clientRequestId: "req-123",
    });
    const key2 = resolveCheckoutRequestKey({
      userId: "u_1",
      priceId: "price_1",
      clientRequestId: "req-123",
    });
    assert.equal(key1, key2, "same user+price+clientRequestId must produce the same key");
    assert.match(key1, /^checkout:client:[a-f0-9]{32}$/);
  });

  it("scopes clientRequestId by user — different users get different keys", () => {
    const keyU1 = resolveCheckoutRequestKey({
      userId: "u_1",
      priceId: "price_1",
      clientRequestId: "req-123",
    });
    const keyU2 = resolveCheckoutRequestKey({
      userId: "u_2",
      priceId: "price_1",
      clientRequestId: "req-123",
    });
    assert.notEqual(keyU1, keyU2, "different users must not share a checkout key even with same clientRequestId");
  });

  it("scopes clientRequestId by price — different prices get different keys", () => {
    const keyP1 = resolveCheckoutRequestKey({
      userId: "u_1",
      priceId: "price_1",
      clientRequestId: "req-123",
    });
    const keyP2 = resolveCheckoutRequestKey({
      userId: "u_1",
      priceId: "price_2",
      clientRequestId: "req-123",
    });
    assert.notEqual(keyP1, keyP2, "different prices must produce different keys for the same clientRequestId");
  });

  it("is deterministic for the same user+price+time bucket", () => {
    const now = new Date("2026-04-30T12:00:00.000Z");
    const a = resolveCheckoutRequestKey({ userId: "u_1", priceId: "price_1", now });
    const b = resolveCheckoutRequestKey({ userId: "u_1", priceId: "price_1", now: new Date("2026-04-30T12:05:00.000Z") });
    assert.equal(a, b);
  });

  it("changes across buckets", () => {
    const a = resolveCheckoutRequestKey({ userId: "u_1", priceId: "price_1", now: new Date("2026-04-30T12:00:00.000Z") });
    const b = resolveCheckoutRequestKey({ userId: "u_1", priceId: "price_1", now: new Date("2026-04-30T12:11:00.000Z") });
    assert.notEqual(a, b);
  });
});
