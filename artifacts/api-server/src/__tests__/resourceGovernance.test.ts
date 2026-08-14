import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Request, Response } from "express";
import { enforceGovernance, completeGovernance } from "../lib/resourceGovernance";

function makeReq(userId = "u1", tier: "registered" | "legendary" = "registered") {
  return {
    user: { id: userId, membershipTier: tier, realUserRole: "user" },
    path: "/videos/generate",
    header: (_: string) => null,
  } as unknown as Request;
}

function makeRes() {
  const res = {
    code: 200,
    body: null as unknown,
    status(c: number) { this.code = c; return this; },
    json(b: unknown) { this.body = b; return this; },
  };
  return res as unknown as Response & { code: number; body: unknown };
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

  // #409 round 4: a pre-provider refusal (budget gate) doesn't fail open into
  // fal's health tracking either — skipProviderHealth must keep it from
  // resetting a real fail streak or diluting the latency average, not just
  // from incrementing the fail count.
  it("skipProviderHealth does not reset an in-progress fail streak", () => {
    const req = makeReq("u3", "legendary");
    const provider = "fal-skip";

    for (let i = 0; i < 2; i++) {
      const res = makeRes();
      const g = enforceGovernance(req, res, { path: "video", provider, model: "m", estimatedCostUsd: 0.01 });
      assert.equal(g.ok, true);
      completeGovernance(req, { provider, latencyMs: 50, failed: true, actualCostUsd: 0 });
    }

    // A budget-gate refusal lands between the real failures — reported as
    // `failed: false` (per round 3) but with skipProviderHealth (round 4).
    const midRes = makeRes();
    const midGate = enforceGovernance(req, midRes, { path: "video", provider, model: "m", estimatedCostUsd: 0.01 });
    assert.equal(midGate.ok, true);
    completeGovernance(req, { provider, latencyMs: 5, failed: false, actualCostUsd: 0, skipProviderHealth: true });

    // The third REAL failure should still be the one that opens the circuit —
    // if the skip call had reset the streak (the round-3-only shape), this
    // would be the first failure again and the circuit would stay closed.
    const thirdRes = makeRes();
    const g3 = enforceGovernance(req, thirdRes, { path: "video", provider, model: "m", estimatedCostUsd: 0.01 });
    assert.equal(g3.ok, true);
    completeGovernance(req, { provider, latencyMs: 50, failed: true, actualCostUsd: 0 });

    const resBlock = makeRes();
    const blocked = enforceGovernance(req, resBlock, { path: "video", provider, model: "m", estimatedCostUsd: 0.01 });
    assert.equal(blocked.ok, false, "circuit should be open after 3 real failures, undiluted by the skipped call");
    assert.equal(resBlock.code, 503);
  });
});
