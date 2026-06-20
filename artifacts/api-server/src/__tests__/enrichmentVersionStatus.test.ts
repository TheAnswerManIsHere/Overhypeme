/**
 * Unit tests for the shared enrichment version-staleness helpers
 * (`@workspace/api-zod`). Pure — no DB/IO. These back the per-fact "Visual
 * Taxonomy Enrichment" staleness badge and the Taxonomy Health version diff,
 * so both surfaces agree with the evaluator's stale-or-not decision.
 *
 * Only CLASSIFICATION (taxonomy enrichment) staleness participates — the
 * enrichment-time visual preview subsystem was retired.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  enrichmentVersionStatusFromStored,
  computeEnrichmentVersionStatus,
  currentTaxonomyVersions,
} from "@workspace/api-zod";

const CURRENT = {
  classificationPromptVersion: "v3",
  visualStrategyVersion: "v2",
};

describe("enrichmentVersionStatusFromStored", () => {
  it("flags an older classification version as stale (enrichment)", () => {
    const s = enrichmentVersionStatusFromStored(
      { classificationPromptVersion: "v2" },
      CURRENT,
    );
    assert.equal(s.enrichmentStale, true);
    assert.equal(s.isStale, true);
    const classification = s.fields.find((f) => f.field === "classification")!;
    assert.equal(classification.stored, "v2");
    assert.equal(classification.current, "v3");
    assert.equal(classification.missing, false);
  });

  it("treats a missing (null) classification version as stale + missing", () => {
    const s = enrichmentVersionStatusFromStored(
      { classificationPromptVersion: null },
      CURRENT,
    );
    assert.equal(s.enrichmentStale, true);
    const classification = s.fields.find((f) => f.field === "classification")!;
    assert.equal(classification.missing, true);
    assert.equal(classification.stored, null);
  });

  it("is not stale when the classification version matches current", () => {
    const s = enrichmentVersionStatusFromStored(
      { classificationPromptVersion: "v3" },
      CURRENT,
    );
    assert.equal(s.isStale, false);
    assert.equal(s.enrichmentStale, false);
    // No preview field participates anymore.
    assert.equal(s.fields.length, 1);
    assert.equal(s.fields[0]!.field, "classification");
  });
});

describe("computeEnrichmentVersionStatus", () => {
  it("reads the classification version out of an enrichment blob", () => {
    const s = computeEnrichmentVersionStatus(
      { classificationPromptVersion: "v2" },
      CURRENT,
    );
    assert.equal(s.enrichmentStale, true);
  });

  it("treats an absent enrichment as stale", () => {
    const s = computeEnrichmentVersionStatus(null, CURRENT);
    assert.equal(s.enrichmentStale, true);
    assert.equal(s.isStale, true);
  });

  it("defaults to the live version constants when none are passed", () => {
    const live = currentTaxonomyVersions();
    const s = computeEnrichmentVersionStatus({
      classificationPromptVersion: live.classificationPromptVersion,
    });
    assert.equal(s.isStale, false);
  });
});
