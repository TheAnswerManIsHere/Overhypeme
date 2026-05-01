import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveCheckoutRequestKey } from "../lib/checkoutIdempotency.js";

describe("resolveCheckoutRequestKey", () => {
  it("reuses client request ID when provided", () => {
    const key = resolveCheckoutRequestKey({
      userId: "u_1",
      priceId: "price_1",
      clientRequestId: "req-123",
    });
    assert.equal(key, "checkout:client:req-123");
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
