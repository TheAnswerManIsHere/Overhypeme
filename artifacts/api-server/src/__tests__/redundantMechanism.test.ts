/**
 * Redundant-mechanism taxonomy regression suite.
 *
 * Locks in the fix for "then"/result-before-mechanism jokes (the grenade bug):
 * facts where the subject's impossible power makes a tool's/weapon's normal
 * mechanism unnecessary must classify as a SUPERHUMAN PHYSICAL FEAT carrying the
 * `normal_function_rendered_unnecessary` modifier — NOT temporal causality
 * inversion. Legitimate temporal jokes must still classify as temporal.
 *
 * No live LLM. Like `taxonomyRegressionFixtures.test.ts`, these tests lock the
 * shape we want enrichment to produce plus the deterministic strategy/directive
 * text that steers the render-time prompt, so regressions in the schema,
 * classifier prompt, strategy map, or modifier directives surface here.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  validateEnrichment,
  isKnownModifier,
  KNOWN_FACT_MODIFIERS,
  CLASSIFICATION_PROMPT_VERSION,
  SUBTYPES_BY_ARCHETYPE,
  VISUAL_PROMPT_STRATEGIES,
  getVisualPromptStrategy,
  type PrimaryArchetype,
} from "@workspace/api-zod";
import { evaluateFactTaxonomyHealth } from "../lib/taxonomyHealth";
import { modifierDirectives } from "../lib/imagePrompt/modifierDirectives.js";
import { FACT_ENRICHMENT_SYSTEM_DEFAULT } from "../lib/factEnrichmentConfig.js";

function buildEnrichment(over: {
  primaryArchetype: PrimaryArchetype;
  subtype: string;
  modifiers: string[];
}): Record<string, unknown> {
  return {
    primaryArchetype: over.primaryArchetype,
    subtype: over.subtype,
    modifiers: over.modifiers,
    visualLiteralness: "literal_dramatization",
    visualComplexity: "medium",
    overhypeFit: "strong",
    adultSuitability: "safe",
    adultSuitabilityNotes: "",
    suggestedHashtags: ["legendary", "overhype", "strength"],
    taxonomyConfidence: 0.95,
    adminReviewNotes: "",
    culturalReferences: [],
    semanticEntities: [],
    classificationPromptVersion: CLASSIFICATION_PROMPT_VERSION,
    enrichedBy: "openai",
  };
}

function assertHealthy(factText: string, raw: Record<string, unknown>): void {
  const h = evaluateFactTaxonomyHealth({
    fact: {
      factId: 1,
      factText,
      enrichment: raw,
      primaryArchetype: raw.primaryArchetype as string,
      subtype: raw.subtype as string,
      overhypeFit: "strong",
      adultSuitability: "safe",
    },
  });
  assert.equal(
    h.overallStatus,
    "healthy",
    `expected healthy, got ${h.overallStatus}; issues=${JSON.stringify(h.issues)}`,
  );
}

// ─── Part 1: the new modifier exists and is "known" ───────────────────────

describe("redundant-mechanism modifier catalog", () => {
  it("normal_function_rendered_unnecessary is a known modifier", () => {
    assert.ok(isKnownModifier("normal_function_rendered_unnecessary"));
    assert.ok(
      (KNOWN_FACT_MODIFIERS as readonly string[]).includes("normal_function_rendered_unnecessary"),
    );
  });

  it("projectile_impact_power is a known modifier", () => {
    assert.ok(isKnownModifier("projectile_impact_power"));
  });
});

// ─── Part 6 Test A & C: redundant-mechanism facts classify as physical feat ─

describe("redundant-mechanism classification shape", () => {
  it("Test A — grenade-then-exploded enriches as a physical feat with the redundant-mechanism modifier", () => {
    const factText = "David once threw a grenade and killed 50 people - then it exploded.";
    const raw = buildEnrichment({
      primaryArchetype: "superhuman_physical_feat",
      subtype: "force_scaled_action",
      modifiers: ["projectile_impact_power", "normal_function_rendered_unnecessary", "avoid_gore"],
    });

    const result = validateEnrichment(raw);
    assert.equal(result.ok, true, result.ok ? "" : result.error);
    assert.equal(result.ok && result.data.primaryArchetype, "superhuman_physical_feat");
    assert.notEqual(result.ok && result.data.primaryArchetype, "temporal_causality_inversion");
    assert.ok(result.ok && result.data.modifiers.includes("normal_function_rendered_unnecessary"));
    // archetype + subtype belong together
    const allowed = SUBTYPES_BY_ARCHETYPE.superhuman_physical_feat as readonly string[];
    assert.ok(allowed.includes("force_scaled_action"));
    assertHealthy(factText, raw);
  });

  it("Test C — bullet-then-fired enriches as a physical feat with the redundant-mechanism modifier", () => {
    const factText = "David threw a bullet through the target, then fired the gun.";
    const raw = buildEnrichment({
      primaryArchetype: "superhuman_physical_feat",
      subtype: "force_scaled_action",
      modifiers: ["normal_function_rendered_unnecessary"],
    });

    const result = validateEnrichment(raw);
    assert.equal(result.ok, true, result.ok ? "" : result.error);
    assert.equal(result.ok && result.data.primaryArchetype, "superhuman_physical_feat");
    assert.notEqual(result.ok && result.data.primaryArchetype, "temporal_causality_inversion");
    assert.ok(result.ok && result.data.modifiers.includes("normal_function_rendered_unnecessary"));
    assertHealthy(factText, raw);
  });
});

// ─── Part 6 Test B: legitimate temporal jokes still classify as temporal ───

describe("temporal inversion is NOT over-corrected away", () => {
  it("Test B — a genuine timeline-inversion fact still classifies as temporal_causality_inversion", () => {
    const factText = "David finished tomorrow's workout yesterday.";
    const raw = buildEnrichment({
      primaryArchetype: "temporal_causality_inversion",
      subtype: "pure_timeline_inversion",
      modifiers: [],
    });

    const result = validateEnrichment(raw);
    assert.equal(result.ok, true, result.ok ? "" : result.error);
    assert.equal(result.ok && result.data.primaryArchetype, "temporal_causality_inversion");
    assertHealthy(factText, raw);
  });
});

// ─── Part 6 Test D: render-time strategy text steers throw-not-explosion ───

describe("superhuman strategy steers the redundant-mechanism render", () => {
  const strategy = getVisualPromptStrategy("superhuman_physical_feat");
  const grenadeExample = strategy.visualizationExamples.find((e) =>
    e.fact.toLowerCase().includes("grenade"),
  );

  it("a grenade visualization example is authored under the physical-feat archetype", () => {
    assert.ok(grenadeExample, "grenade example must exist under superhuman_physical_feat");
    assert.equal(grenadeExample!.subtype, "force_scaled_action");
  });

  it("the strategy block + grenade example describe an impossible throw with an intact grenade", () => {
    const blob = [strategy.strategyBlock, grenadeExample!.visualApproach, grenadeExample!.whyItWorks].join("\n");
    assert.match(blob, /throw|threw|throwing|thrown/i);
    assert.match(blob, /intact|unexploded/i);
    assert.match(blob, /shockwave|motion trail|impact|force|trajectory/i);
  });

  it("the strategy never asks for an explosion-before-throw / time paradox", () => {
    // Check the affirmative scene text only. The `avoid` field is the home for
    // anti-guidance and is allowed to NAME the forbidden pattern to forbid it.
    const blob = [
      strategy.strategyBlock,
      grenadeExample!.visualApproach,
      grenadeExample!.whyItWorks,
    ].join("\n");
    assert.doesNotMatch(blob, /explosion.*before.*throw/i);
    assert.doesNotMatch(blob, /before.*grenade.*thrown/i);
    assert.doesNotMatch(blob, /impossible timing.*explosion/i);
    assert.doesNotMatch(blob, /time and causality/i);
    assert.doesNotMatch(blob, /time paradox/i);
  });

  it("the modifier directive stages the throw as the force and keeps the mechanism redundant", () => {
    const out = modifierDirectives(["normal_function_rendered_unnecessary"]).join(" ");
    assert.equal(modifierDirectives(["normal_function_rendered_unnecessary"]).length, 1);
    assert.match(out, /intact|unused|delayed|secondary|redundant/i);
    assert.doesNotMatch(out, /explosion.*before.*throw/i);
  });
});

// ─── Part 6 Test E: non-graphic rendering ──────────────────────────────────

describe("redundant-mechanism render stays non-graphic", () => {
  it("the grenade example does not ask the model to depict gore/bodies", () => {
    const strategy = getVisualPromptStrategy("superhuman_physical_feat");
    const grenadeExample = strategy.visualizationExamples.find((e) =>
      e.fact.toLowerCase().includes("grenade"),
    )!;
    // The "avoid" field may legitimately NAME gore to forbid it; the
    // visualApproach (what to draw) must not request it.
    assert.doesNotMatch(grenadeExample.visualApproach, /\b(blood|gore|corpses|dead bodies)\b/i);
  });

  it("the avoid-gore modifier directive carries no graphic request", () => {
    const out = modifierDirectives(["avoid_gore"]).join(" ").toLowerCase();
    assert.match(out, /non-graphic/);
  });
});

// ─── Temporal strategy carries explicit anti-guidance ──────────────────────

describe("temporal strategy warns against redundant-mechanism bleed-through", () => {
  it("the temporal strategy block tells the model not to stage grenade-then-exploded here", () => {
    const temporal = VISUAL_PROMPT_STRATEGIES.temporal_causality_inversion;
    assert.match(temporal.strategyBlock, /redundant-mechanism/i);
    assert.match(temporal.strategyBlock, /grenade/i);
    assert.match(temporal.strategyBlock, /then/i);
  });
});

// ─── Classifier prompt content regression ──────────────────────────────────

describe("classifier system prompt encodes the redundant-mechanism rule", () => {
  it("teaches that \"then\" does not automatically mean temporal inversion", () => {
    assert.match(
      FACT_ENRICHMENT_SYSTEM_DEFAULT,
      /"then" does not automatically mean temporal causality inversion/i,
    );
  });

  it("carries the grenade canonical example pointing at superhuman_physical_feat", () => {
    assert.match(FACT_ENRICHMENT_SYSTEM_DEFAULT, /threw a grenade and killed 50 people/i);
    assert.match(FACT_ENRICHMENT_SYSTEM_DEFAULT, /normal_function_rendered_unnecessary/);
  });

  it("no longer asserts the grenade fact is a pre-cause temporal inversion", () => {
    assert.doesNotMatch(
      FACT_ENRICHMENT_SYSTEM_DEFAULT,
      /grenade causing effects before exploding is temporal/i,
    );
  });
});
