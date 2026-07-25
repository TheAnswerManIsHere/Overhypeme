/**
 * Fact-enrichment repair + prompt-provenance regression suite.
 *
 * Covers the deterministic redundant-mechanism repair guard (the grenade
 * still-misclassified-as-temporal bug) and the prompt-provenance stamping that
 * makes a stale/overridden enrichment prompt impossible to hide behind a
 * "version is current" badge. Pure — no live LLM, no DB writes (the model is
 * injected; the schema/repair functions are pure).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  validateEnrichment,
  classificationPromptDiagnosticsSchema,
  CLASSIFICATION_PROMPT_VERSION,
  type FactEnrichment,
} from "@workspace/api-zod";
import {
  enrichFactWithModel,
  repairRedundantMechanismMisclassification,
} from "../lib/factEnrichment.js";
import { hashPromptText } from "../lib/factEnrichmentConfig.js";

const GRENADE_TEXT = "David once threw a grenade and killed 50 people - then it exploded.";

/** A valid temporal-causality enrichment (what the model wrongly emits). */
function buildTemporal(overrides: Partial<Record<string, unknown>> = {}): FactEnrichment {
  const raw = {
    primaryArchetype: "temporal_causality_inversion",
    subtype: "pre_cause_consequence",
    modifiers: [],
    visualLiteralness: "literal_dramatization",
    visualComplexity: "medium",
    overhypeFit: "reject",
    adultSuitability: "incompatible",
    adultSuitabilityNotes: "fact involves violence and death",
    suggestedHashtags: ["legendary", "impossible", "absurd"],
    taxonomyConfidence: 0.2,
    adminReviewNotes: "Low confidence",
    culturalReferences: [],
    semanticEntities: [],
    ...overrides,
  };
  const result = validateEnrichment(raw);
  if (!result.ok) throw new Error(`buildTemporal produced invalid enrichment: ${result.error}`);
  return result.data;
}

// ─── Repair guard (pure function) ──────────────────────────────────────────

describe("repairRedundantMechanismMisclassification", () => {
  it("repairs the exact low-confidence grenade misclassification, preserving fit/adult", () => {
    const repaired = repairRedundantMechanismMisclassification(GRENADE_TEXT, buildTemporal());

    assert.equal(repaired.primaryArchetype, "superhuman_physical_feat");
    assert.equal(repaired.subtype, "force_scaled_action");
    assert.ok(repaired.modifiers.includes("normal_function_rendered_unnecessary"));
    assert.ok(repaired.modifiers.includes("projectile_impact_power"));
    assert.match(repaired.adminReviewNotes, /Auto-repaired/);
    // joke-mechanism only: fit/adult left exactly as the model decided.
    assert.equal(repaired.overhypeFit, "reject");
    assert.equal(repaired.adultSuitability, "incompatible");
    // the repaired blob is itself valid.
    assert.equal(validateEnrichment(repaired).ok, true);
  });

  it("does NOT repair a high-confidence temporal classification, but notes it", () => {
    const repaired = repairRedundantMechanismMisclassification(
      GRENADE_TEXT,
      buildTemporal({ taxonomyConfidence: 0.9 }),
    );
    assert.equal(repaired.primaryArchetype, "temporal_causality_inversion");
    assert.match(repaired.adminReviewNotes, /not auto-repaired because the temporal classification was high-confidence/i);
  });

  it("does NOT repair the explicit reverse-order case (genuinely temporal)", () => {
    const repaired = repairRedundantMechanismMisclassification(
      "The grenade exploded, then David threw it.",
      buildTemporal(),
    );
    assert.equal(repaired.primaryArchetype, "temporal_causality_inversion");
    assert.doesNotMatch(repaired.adminReviewNotes, /Auto-repaired/);
  });

  it("does NOT repair a low-confidence temporal fact with no thrown weapon", () => {
    const repaired = repairRedundantMechanismMisclassification(
      "David finished tomorrow's workout yesterday.",
      buildTemporal(),
    );
    assert.equal(repaired.primaryArchetype, "temporal_causality_inversion");
    assert.doesNotMatch(repaired.adminReviewNotes, /Auto-repaired/);
  });

  it("repairs the bullet/gun redundant-mechanism variant", () => {
    const repaired = repairRedundantMechanismMisclassification(
      "David threw a bullet through the target, then fired the gun.",
      buildTemporal(),
    );
    assert.equal(repaired.primaryArchetype, "superhuman_physical_feat");
    assert.ok(repaired.modifiers.includes("normal_function_rendered_unnecessary"));
  });
});

// ─── Provenance stamping (model injected) ──────────────────────────────────

describe("enrichFactWithModel — repair + provenance integration", () => {
  it("repairs the injected bad grenade output and stamps prompt diagnostics", async () => {
    const bad = buildTemporal();
    const result = await enrichFactWithModel(
      { factText: GRENADE_TEXT },
      async () => JSON.stringify(bad),
      {
        promptDiagnostics: {
          source: "code_default",
          hash: "abc123",
          length: 100,
          codeDefaultHash: "abc123",
          matchesCodeDefault: true,
        },
      },
    );

    assert.equal(result.primaryArchetype, "superhuman_physical_feat");
    assert.ok(result.modifiers.includes("normal_function_rendered_unnecessary"));
    assert.equal(result.classificationPromptVersion, CLASSIFICATION_PROMPT_VERSION);
    assert.equal(result.classificationPromptDiagnostics?.source, "code_default");
    assert.equal(result.classificationPromptDiagnostics?.matchesCodeDefault, true);
  });

  it("works without promptDiagnostics (back-compat 2-arg call)", async () => {
    const result = await enrichFactWithModel(
      { factText: "David counted to infinity twice." },
      async () =>
        JSON.stringify(
          buildTemporal({
            primaryArchetype: "logic_formal_impossibility",
            subtype: "infinity_impossibility",
            overhypeFit: "strong",
            adultSuitability: "safe",
            taxonomyConfidence: 0.95,
          }),
        ),
    );
    assert.equal(result.primaryArchetype, "logic_formal_impossibility");
    assert.equal(result.classificationPromptDiagnostics, undefined);
  });
});

// ─── Diagnostics schema ────────────────────────────────────────────────────

describe("classificationPromptDiagnostics schema", () => {
  it("represents and validates a prompt MISMATCH on a stored enrichment", () => {
    const raw = {
      ...buildTemporal({ overhypeFit: "strong", adultSuitability: "safe", taxonomyConfidence: 0.9 }),
      classificationPromptDiagnostics: {
        source: "admin_config_value",
        hash: "oldhash",
        codeDefaultHash: "newhash",
        length: 123,
        matchesCodeDefault: false,
      },
    };
    const result = validateEnrichment(raw);
    assert.equal(result.ok, true, result.ok ? "" : result.error);
    assert.equal(
      result.ok && result.data.classificationPromptDiagnostics?.matchesCodeDefault,
      false,
    );
    assert.equal(
      result.ok && result.data.classificationPromptDiagnostics?.source,
      "admin_config_value",
    );
  });

  it("accepts the admin_config_debug_value source", () => {
    const parsed = classificationPromptDiagnosticsSchema.safeParse({
      source: "admin_config_debug_value",
      hash: "h",
      codeDefaultHash: "c",
      length: 0,
      matchesCodeDefault: false,
    });
    assert.equal(parsed.success, true);
  });

  it("rejects an unknown source", () => {
    const parsed = classificationPromptDiagnosticsSchema.safeParse({
      source: "somewhere_else",
      hash: "h",
      codeDefaultHash: "c",
      length: 0,
      matchesCodeDefault: false,
    });
    assert.equal(parsed.success, false);
  });
});

// ─── Hash helper ───────────────────────────────────────────────────────────

describe("hashPromptText", () => {
  it("is stable for the same input and differs for different input", () => {
    assert.equal(hashPromptText("abc"), hashPromptText("abc"));
    assert.notEqual(hashPromptText("abc"), hashPromptText("abcd"));
    assert.equal(hashPromptText("abc").length, 16);
  });
});
