/**
 * The AI baseline driver's render coverage (#654 round 3; plan
 * PLAN_GAG_EXAMPLES.md): a gag's male, female and pet renders must each be
 * present and terminal before the journey accepts their outcome. The kinds are
 * named in the driver, independent of the product's own list.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { BASELINE_RENDER_KINDS, renderCoverageProblems, settledBaselineRenders } from "../testing/aiBaselineCoverage.js";

const tile = (status = "done") => ({ status, latestAttemptId: 1 });
const all = () => ({ male: tile(), female: tile(), pet: tile() });

describe("the AI baseline driver's render coverage", () => {
  it("accepts the three kinds once each is present and terminal", () => {
    assert.deepEqual(renderCoverageProblems(all()), []);
    assert.deepEqual(settledBaselineRenders(all())?.map((c) => c.kind), [...BASELINE_RENDER_KINDS]);
  });

  it("refuses a gag with no renders", () => {
    assert.equal(renderCoverageProblems({ male: null, female: null, pet: null }).length, 3);
    assert.equal(settledBaselineRenders({ male: null, female: null, pet: null }), null);
  });

  it("refuses a kind that was never drawn", () => {
    const renders = { ...all(), pet: tile("missing") };
    assert.deepEqual(renderCoverageProblems(renders), ["pet is missing"]);
    assert.equal(settledBaselineRenders(renders), null);
  });

  it("waits while a kind is still rendering", () => {
    const renders = { ...all(), male: tile("rendering") };
    assert.deepEqual(renderCoverageProblems(renders), []);
    assert.equal(settledBaselineRenders(renders), null);
  });

  it("can settle one kind alone (the iteration render)", () => {
    assert.deepEqual(settledBaselineRenders({ male: tile("failed") }, ["male"])?.map((c) => c.status), ["failed"]);
  });
});
