/**
 * Phase 2A — visual prompt strategy map completeness + policy validation.
 *
 * Pure data/structure tests against the strategy map defined in
 * `@workspace/api-zod/visualPromptStrategies`. No network, no DB. Covers every
 * "Validation requirements" item in the Phase 2A doc.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  PRIMARY_ARCHETYPES,
  SUBTYPES_BY_ARCHETYPE,
  VISUAL_PROMPT_STRATEGIES,
  VISUAL_PROMPT_GLOBAL_RULES,
  VISUAL_STRATEGY_VERSION,
  getVisualPromptStrategy,
  getSubtypeGuidance,
  type PrimaryArchetype,
  type FactSubtype,
} from "@workspace/api-zod";

describe("visual prompt strategy map — completeness", () => {
  it("Req 1: every primary archetype has a strategy entry", () => {
    for (const archetype of PRIMARY_ARCHETYPES) {
      const entry = VISUAL_PROMPT_STRATEGIES[archetype];
      assert.ok(entry, `missing strategy entry for archetype ${archetype}`);
      assert.equal(entry.archetype, archetype, `entry.archetype mismatch for ${archetype}`);
    }
    assert.equal(
      Object.keys(VISUAL_PROMPT_STRATEGIES).length,
      PRIMARY_ARCHETYPES.length,
      "strategy-map keys != PRIMARY_ARCHETYPES length",
    );
  });

  it("Req 2: every subtype has subtype guidance", () => {
    for (const archetype of PRIMARY_ARCHETYPES) {
      const entry = VISUAL_PROMPT_STRATEGIES[archetype];
      const subtypes = SUBTYPES_BY_ARCHETYPE[archetype];
      for (const subtype of subtypes) {
        const guidance = entry.subtypeGuidance.find((g) => g.subtype === subtype);
        assert.ok(guidance, `missing subtype guidance for ${archetype}.${subtype}`);
        assert.ok(
          guidance.principle.trim().length > 0,
          `empty principle for ${archetype}.${subtype}`,
        );
      }
    }
  });

  it("Req 2 (inverse): every guidance entry references a real subtype", () => {
    for (const archetype of PRIMARY_ARCHETYPES) {
      const entry = VISUAL_PROMPT_STRATEGIES[archetype];
      const valid = new Set<string>(SUBTYPES_BY_ARCHETYPE[archetype]);
      for (const g of entry.subtypeGuidance) {
        assert.ok(
          valid.has(g.subtype),
          `${archetype}: subtype guidance for ${g.subtype} is not in SUBTYPES_BY_ARCHETYPE`,
        );
      }
    }
  });

  it("Req 3: every visualization example uses a valid (archetype, subtype) pair", () => {
    for (const archetype of PRIMARY_ARCHETYPES) {
      const entry = VISUAL_PROMPT_STRATEGIES[archetype];
      const validSubtypes = new Set<string>(SUBTYPES_BY_ARCHETYPE[archetype]);
      for (const ex of entry.visualizationExamples) {
        assert.equal(
          ex.archetype,
          archetype,
          `example "${ex.fact}" has archetype=${ex.archetype} but lives under ${archetype}`,
        );
        assert.ok(
          validSubtypes.has(ex.subtype),
          `example "${ex.fact}" under ${archetype} uses subtype ${ex.subtype} which is not valid for that archetype`,
        );
      }
    }
  });

  it("Req 4: every archetype has a non-empty lockedRule", () => {
    for (const archetype of PRIMARY_ARCHETYPES) {
      const entry = VISUAL_PROMPT_STRATEGIES[archetype];
      assert.ok(entry.lockedRule.trim().length > 0, `${archetype}: empty lockedRule`);
    }
  });

  it("Req 5: every archetype has ≥4 examples (or is explicitly documented as pending)", () => {
    for (const archetype of PRIMARY_ARCHETYPES) {
      const entry = VISUAL_PROMPT_STRATEGIES[archetype];
      const count = entry.visualizationExamples.length;
      // "unless intentionally documented" — examplesAuthoringStatus:"pending"
      // is the explicit documentation. Even pending archetypes are required to
      // carry at least their named-fact stubs (no empty archetypes).
      assert.ok(
        count >= 4 || entry.examplesAuthoringStatus === "pending",
        `${archetype}: only ${count} examples, must be ≥4 or marked examplesAuthoringStatus:"pending"`,
      );
      assert.ok(count >= 1, `${archetype}: no visualization examples at all`);
    }
  });

  it("Req 5b: examples marked 'complete' must have prose authored", () => {
    for (const archetype of PRIMARY_ARCHETYPES) {
      const entry = VISUAL_PROMPT_STRATEGIES[archetype];
      if (entry.examplesAuthoringStatus !== "complete") continue;
      for (const ex of entry.visualizationExamples) {
        assert.ok(
          ex.visualApproach.trim().length > 0,
          `${archetype} (complete) example "${ex.fact}" has empty visualApproach`,
        );
        assert.ok(
          ex.whyItWorks.trim().length > 0,
          `${archetype} (complete) example "${ex.fact}" has empty whyItWorks`,
        );
        assert.ok(
          ex.avoid.trim().length > 0,
          `${archetype} (complete) example "${ex.fact}" has empty avoid`,
        );
      }
    }
  });
});

describe("visual prompt strategy map — policy", () => {
  it("Req 6: the strategy map imports taxonomy enums from the canonical taxonomy module", () => {
    // Both PRIMARY_ARCHETYPES and SUBTYPES_BY_ARCHETYPE come from the same
    // `@workspace/api-zod` barrel that the strategy map imports. If the
    // imports diverged, this test (which uses both) would already not type-
    // check. As a runtime sanity check: every key in the strategy map equals
    // an entry in PRIMARY_ARCHETYPES.
    const mapKeys = new Set(Object.keys(VISUAL_PROMPT_STRATEGIES));
    for (const archetype of PRIMARY_ARCHETYPES) {
      assert.ok(mapKeys.has(archetype), `strategy map missing ${archetype}`);
    }
    for (const key of mapKeys) {
      assert.ok(
        (PRIMARY_ARCHETYPES as readonly string[]).includes(key),
        `strategy map has stale archetype key ${key} not in taxonomy`,
      );
    }
  });

  it("Req 7: the strategy map supports optional culturalReferences on examples", () => {
    // The Shark Week example (Arch 4) and the Victoria's Secret example
    // (Arch 8) are both authored by David in Doc 1 with culturalReferences.
    const sharks = VISUAL_PROMPT_STRATEGIES.authority_threat_reversal
      .visualizationExamples.find((e) => e.fact.includes("David Week"));
    assert.ok(sharks, "Sharks-have-a-David-Week example is present");
    assert.ok(
      sharks.culturalReferences && sharks.culturalReferences.length > 0,
      "Sharks example must carry a Shark Week cultural reference",
    );
    assert.equal(sharks.culturalReferences[0].reference, "Shark Week");

    const victorias = VISUAL_PROMPT_STRATEGIES.intellectual_omniscience
      .visualizationExamples.find((e) => e.fact.toLowerCase().includes("victoria"));
    assert.ok(victorias, "Victoria's Secret example is present");
    assert.ok(
      victorias.culturalReferences && victorias.culturalReferences.length > 0,
      "Victoria's Secret example must carry a brand cultural reference",
    );
    assert.equal(victorias.culturalReferences[0].reference, "Victoria's Secret");
  });

  it("Req 8: no global absolute no-text rule", () => {
    // The supportingTextPolicy must EXPLICITLY allow supporting text. An
    // absolute no-text rule would say "do not render any text" without
    // qualification — i.e. would not contain the explicit-allowance phrase.
    const policy = VISUAL_PROMPT_GLOBAL_RULES.supportingTextPolicy;
    assert.match(
      policy,
      /may be used when they are part of the visual joke/i,
      "global supporting-text policy must permit concise supporting text",
    );
    assert.equal(
      VISUAL_PROMPT_GLOBAL_RULES.supportingTextShortRule,
      "Supporting text is allowed when it is visual evidence. Caption text is not.",
    );
  });

  it("Req 9: no content moderation baked into archetype strategy blocks", () => {
    // Per Doc 1 §"Content and render-policy separation": "Do not bake content
    // moderation into archetype strategy blocks or visualization examples."
    // The render-policy layer handles NSFW / violence / brand restrictions
    // elsewhere. Smoke-check: no archetype block mentions NSFW / spicy /
    // mature / content-moderation terminology.
    const forbidden = [/\bnsfw\b/i, /\bspicy\b/i, /\bmature\b/i, /\bage[- ]gate\b/i, /\bcontent moderation\b/i];
    for (const archetype of PRIMARY_ARCHETYPES) {
      const entry = VISUAL_PROMPT_STRATEGIES[archetype];
      const blob = [
        entry.strategyBlock,
        entry.i2iDefault,
        entry.t2iFallback ?? "",
        entry.preservePhysique ?? "",
        ...entry.visualizationExamples.map((e) => [e.visualApproach, e.whyItWorks, e.avoid].join("\n")),
      ].join("\n");
      for (const pat of forbidden) {
        assert.ok(
          !pat.test(blob),
          `${archetype}: archetype block leaks content-moderation term ${pat}`,
        );
      }
    }
  });

  it("Req 10: removed `zero_division_impossibility` subtype is not used anywhere", () => {
    // In the taxonomy (Phase-1 source of truth).
    const logicSubtypes = SUBTYPES_BY_ARCHETYPE.logic_formal_impossibility as readonly string[];
    assert.ok(
      !logicSubtypes.includes("zero_division_impossibility"),
      "zero_division_impossibility must not be in SUBTYPES_BY_ARCHETYPE.logic_formal_impossibility",
    );
    // In the strategy map (Phase-2A subtype guidance + examples).
    const logic = VISUAL_PROMPT_STRATEGIES.logic_formal_impossibility;
    for (const g of logic.subtypeGuidance) {
      assert.notEqual(g.subtype, "zero_division_impossibility");
    }
    for (const ex of logic.visualizationExamples) {
      assert.notEqual(ex.subtype, "zero_division_impossibility");
    }
  });

  it("Req 10b: `paradox_or_undefined_impossibility` is present in place of the old `paradox_impossibility`", () => {
    const logicSubtypes = SUBTYPES_BY_ARCHETYPE.logic_formal_impossibility as readonly string[];
    assert.ok(
      logicSubtypes.includes("paradox_or_undefined_impossibility"),
      "paradox_or_undefined_impossibility must be the canonical paradox bucket",
    );
    assert.ok(
      !logicSubtypes.includes("paradox_impossibility"),
      "old paradox_impossibility name must be gone",
    );
  });

  it("Req 11: the removed inbox/email example is not present in mundane_act_made_legendary", () => {
    const mundane = VISUAL_PROMPT_STRATEGIES.mundane_act_made_legendary;
    for (const ex of mundane.visualizationExamples) {
      assert.ok(
        !/\b(inbox|email)\b/i.test(ex.fact),
        `mundane_act_made_legendary should not contain the removed inbox/email example; found "${ex.fact}"`,
      );
    }
  });
});

describe("visual prompt strategy map — helpers", () => {
  it("getVisualPromptStrategy returns the entry for every archetype", () => {
    for (const archetype of PRIMARY_ARCHETYPES) {
      const entry = getVisualPromptStrategy(archetype);
      assert.equal(entry.archetype, archetype);
    }
  });

  it("getSubtypeGuidance returns the matching guidance or null", () => {
    const arch: PrimaryArchetype = "superhuman_physical_feat";
    const subtype: FactSubtype = "force_scaled_action";
    const got = getSubtypeGuidance(arch, subtype);
    assert.ok(got);
    assert.equal(got!.subtype, subtype);

    // Cross-archetype: a valid subtype that lives under a DIFFERENT archetype
    // should return null when queried against the wrong archetype.
    const miss = getSubtypeGuidance("superhuman_physical_feat", "social_role_reversal" as FactSubtype);
    assert.equal(miss, null);
  });

  it("VISUAL_STRATEGY_VERSION is a non-empty string", () => {
    assert.ok(VISUAL_STRATEGY_VERSION.length > 0);
    // Phase 2 bumped to v2: added non-human i2i + t2i fallback +
    // anthropomorphic treatment policy to VISUAL_PROMPT_GLOBAL_RULES.
    // Per-archetype strategy entries unchanged from v1.
    assert.equal(VISUAL_STRATEGY_VERSION, "v2");
  });
});
