import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { enforceGovernance, completeGovernance } from "../lib/resourceGovernance";

function makeReq(userId = "u1", tier: "registered" | "legendary" = "registered") {
  return {
    user: { id: userId, membershipTier: tier, realUserRole: "user" },
    path: "/videos/generate",
    header: (_: string) => null,
  } as any;
}

function makeRes() {
  return {
    code: 200,
    body: null as any,
    status(c: number) { this.code = c; return this; },
    json(b: any) { this.body = b; return this; },
  } as any;
}

describe("resourceGovernance", () => {
  it("enforces concurrent generation limit", () => {
    const req = makeReq();
    const res1 = makeRes();
    const g1 = enforceGovernance(req, res1, { path: "video", provider: "fal", model: "m", estimatedCostUsd: 0.01 });
    assert.equal(g1.ok, true);

    const res2 = makeRes();
    const g2 = enforceGovernance(req, res2, { path: "video", provider: "fal", model: "m", estimatedCostUsd: 0.01 });
    assert.equal(g2.ok, false);
    assert.equal(res2.code, 429);

    completeGovernance(req, { provider: "fal", latencyMs: 10, failed: false, actualCostUsd: 0.01 });
  });

  it("opens circuit after repeated provider failures", () => {
    const req = makeReq("u2", "legendary");
    for (let i = 0; i < 3; i++) {
      const res = makeRes();
      const g = enforceGovernance(req, res, { path: "video", provider: "fal-cb", model: "m", estimatedCostUsd: 0.01 });
      assert.equal(g.ok, true);
      completeGovernance(req, { provider: "fal-cb", latencyMs: 50, failed: true, actualCostUsd: 0 });
    }
    const resBlock = makeRes();
    const blocked = enforceGovernance(req, resBlock, { path: "video", provider: "fal-cb", model: "m", estimatedCostUsd: 0.01 });
    assert.equal(blocked.ok, false);
    assert.equal(resBlock.code, 503);
  });
});
