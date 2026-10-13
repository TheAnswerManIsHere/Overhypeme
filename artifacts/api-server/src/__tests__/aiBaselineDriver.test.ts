/**
 * The AI baseline driver's render coverage (#654 round 3): the three review
 * renders the baseline exists to cover must each be present, required and
 * terminal before the journey accepts their outcome. The check is named in
 * the driver, independent of the cards' own `required` flags.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { BASELINE_RENDER_SCENARIOS, renderCoverageProblems, settledBaselineRenders } from "../testing/aiBaselineCoverage.js";

const card = (key: string, status = "done", required = true) => ({ key, status, required });
const all = () => BASELINE_RENDER_SCENARIOS.map((k) => card(k));

describe("the AI baseline driver's render coverage", () => {
  it("accepts the three expected scenarios once each is required and terminal", () => {
    const cards = [...all(), card("non_human_animal", "done", false)];
    assert.deepEqual(renderCoverageProblems(cards), []);
    assert.deepEqual(settledBaselineRenders(cards)?.map((c) => c.key), [...BASELINE_RENDER_SCENARIOS]);
  });

  it("refuses an empty grid", () => {
    assert.equal(renderCoverageProblems([]).length, 3);
    assert.equal(settledBaselineRenders([]), null);
  });

  it("refuses a grid that omits an expected scenario", () => {
    const cards = all().filter((c) => c.key !== "i2i_female_default");
    assert.deepEqual(renderCoverageProblems(cards), ["i2i_female_default is missing"]);
    assert.equal(settledBaselineRenders(cards), null);
  });

  it("refuses an expected scenario marked optional", () => {
    const cards = all().map((c) => (c.key === "generic_t2i" ? { ...c, required: false } : c));
    assert.deepEqual(renderCoverageProblems(cards), ["generic_t2i is not required"]);
    assert.equal(settledBaselineRenders(cards), null);
  });

  it("waits while an expected scenario is still rendering", () => {
    const cards = all().map((c) => (c.key === "i2i_male_default" ? { ...c, status: "running" } : c));
    assert.deepEqual(renderCoverageProblems(cards), []);
    assert.equal(settledBaselineRenders(cards), null);
  });
});
