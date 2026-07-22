/**
 * Unit tests (pure, no DB / no LLM) for candidate Visual-concept generation
 * (Slice 2A):
 *   - api-zod schema/sanitize: exactly-3 validation, ≤1500 cap, {NAME}
 *     canonicalization, unknown-token → tokenValid:false.
 *   - the mode-agnostic candidate user message: OMITS the runtime blocks
 *     (source-image / subjectRenderMode / generationMode / identity / render
 *     controls / target engine) and INCLUDES fact text / taxonomy / render
 *     policy / authored strategy / cultural refs / semantic entities.
 *   - existing_draft_context vs. blank-field wording (distinct alternatives, NOT
 *     the authoritative directive).
 *   - generateVisualConceptsWithModel: sanitizes + validates count + retries once.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  validateCandidateConcepts,
  sanitizeCandidateSceneText,
  sanitizeCandidateConcept,
  sanitizeCandidateBubble,
  isCandidateConceptPickable,
  withCandidateConceptDraft,
  storedCandidateConceptSchema,
  EMPTY_VISUAL_STRATEGY_OVERRIDE,
  CANDIDATE_SCENE_MAX_CHARS,
  type FactEnrichment,
  type StoredCandidateConcept,
} from "@workspace/api-zod";
import {
  buildVisualConceptsUserMessage,
  generateVisualConceptsWithModel,
  validateAndSanitizeCandidateConcepts,
  type GenerateVisualConceptsInput,
} from "../lib/visualConcepts/generator.js";

const ENRICHMENT: FactEnrichment = {
  primaryArchetype: "superhuman_physical_feat",
  subtype: "force_scaled_action",
  modifiers: [],
  visualLiteralness: "literal_dramatization",
  visualComplexity: "medium",
  overhypeFit: "strong",
  adultSuitability: "safe",
  adultSuitabilityNotes: "",
  suggestedHashtags: [],
  taxonomyConfidence: 0.95,
  adminReviewNotes: "",
  culturalReferences: [
    {
      sourcePhrase: "Shark Week",
      referenceType: "tv",
      canonicalReference: "Discovery's Shark Week",
      explanation: "annual shark programming",
      visualImplication: "sharks on a TV",
      confidence: 0.95,
      requiresAdminReview: false,
    },
  ],
  semanticEntities: [
    {
      surfaceText: "Earth",
      normalizedText: "earth",
      entityKind: "celestial_body",
      visualReferent: "the planet Earth",
      capitalizationSignal: "capitalized_named_entity",
      materiallyAffectsVisualPrompt: true,
      requiresAdminReview: false,
      confidence: 0.95,
      notes: "",
    },
  ],
} as unknown as FactEnrichment;

function conceptWire(
  overrides: Partial<{ title: string; whyItWorks: string; sceneDescription: string; bubbles: unknown[] }> = {},
) {
  return {
    title: overrides.title ?? "Concept",
    whyItWorks: overrides.whyItWorks ?? "It lands.",
    sceneDescription: overrides.sceneDescription ?? "{NAME} lifts the planet overhead in a stadium.",
    bubbles: overrides.bubbles ?? [],
  };
}

describe("validateCandidateConcepts", () => {
  it("accepts exactly three non-empty concepts", () => {
    const res = validateCandidateConcepts({ concepts: [conceptWire(), conceptWire(), conceptWire()] });
    assert.equal(res.ok, true);
  });

  it("rejects a count other than three", () => {
    assert.equal(validateCandidateConcepts({ concepts: [conceptWire(), conceptWire()] }).ok, false);
    assert.equal(validateCandidateConcepts({ concepts: [conceptWire(), conceptWire(), conceptWire(), conceptWire()] }).ok, false);
  });

  it("rejects an empty title or sceneDescription", () => {
    assert.equal(validateCandidateConcepts({ concepts: [conceptWire({ title: "  " }), conceptWire(), conceptWire()] }).ok, false);
    assert.equal(validateCandidateConcepts({ concepts: [conceptWire(), conceptWire({ sceneDescription: "" }), conceptWire()] }).ok, false);
  });
});

describe("sanitizeCandidateSceneText", () => {
  it("canonicalizes {name}/{Name} → {NAME} and marks a valid scene tokenValid", () => {
    const out = sanitizeCandidateSceneText("{name} lifts {Name_Possessive} planet.");
    assert.match(out.text, /\{NAME\} lifts \{NAME_POSSESSIVE\} planet\./);
    assert.equal(out.tokenValid, true);
    assert.equal(out.tokenError, undefined);
  });

  it("flags an unknown token tokenValid:false with an error", () => {
    const out = sanitizeCandidateSceneText("{NAME} wields {WEATHER} in the storm.");
    assert.equal(out.tokenValid, false);
    assert.ok(out.tokenError && out.tokenError.length > 0);
  });

  it("caps the scene to the coreSceneOverride budget", () => {
    const out = sanitizeCandidateSceneText("x".repeat(CANDIDATE_SCENE_MAX_CHARS + 500));
    assert.equal(out.text.length, CANDIDATE_SCENE_MAX_CHARS);
  });

  it("sanitizeCandidateConcept trims title/whyItWorks and carries token validity", () => {
    const c = sanitizeCandidateConcept(conceptWire({ title: "  Big Lift  ", sceneDescription: "{NAME} lifts {BOGUS}." }) as never);
    assert.equal(c.title, "Big Lift");
    assert.equal(c.tokenValid, false);
    assert.ok(c.tokenError);
  });
});

describe("buildVisualConceptsUserMessage — mode-agnostic context", () => {
  const base: GenerateVisualConceptsInput = { factText: "{NAME} bench-presses the Earth.", enrichment: ENRICHMENT };

  it("INCLUDES the mode-agnostic context blocks", () => {
    const msg = buildVisualConceptsUserMessage(base);
    assert.match(msg, /factTextExact: \{NAME\} bench-presses the Earth\./);
    assert.match(msg, /TAXONOMY \(FIXED — DO NOT reclassify\)/);
    assert.match(msg, /RENDER POLICY/);
    assert.match(msg, /AUTHORED VISUAL STRATEGY/);
    assert.match(msg, /PER-FACT CULTURAL REFERENCES/);
    assert.match(msg, /SEMANTIC ENTITY INTERPRETATION/);
    assert.match(msg, /surfaceText="Earth"/);
  });

  it("OMITS every runtime / mode-specific block", () => {
    const msg = buildVisualConceptsUserMessage(base);
    assert.doesNotMatch(msg, /SOURCE-IMAGE ANALYSIS/);
    assert.doesNotMatch(msg, /RESOLVED subjectRenderMode/);
    assert.doesNotMatch(msg, /RESOLVED generationMode/);
    assert.doesNotMatch(msg, /IDENTITY POLICY/);
    assert.doesNotMatch(msg, /RENDER CONTROLS/);
    assert.doesNotMatch(msg, /TARGET ENGINE/);
  });

  it("OMITS the planner-only visualPlan/compiledPrompt echo-back directives (schema-incompatible with concept output)", () => {
    const msg = buildVisualConceptsUserMessage(base);
    // Data blocks stay (they carry the fact's locked interpretation)...
    assert.match(msg, /surfaceText="Earth"/);
    assert.match(msg, /sourcePhrase="Shark Week"/);
    // ...but the "populate visualPlan.*/compiledPrompt.*" directives must not.
    assert.doesNotMatch(msg, /visualPlan\.semanticEntitiesUsed/);
    assert.doesNotMatch(msg, /visualPlan\.culturalReferencesUsed/);
    assert.doesNotMatch(msg, /compiledPrompt\.prompt/);
  });

  it("blank field → fresh ideas: no moderator scene block at all", () => {
    const msg = buildVisualConceptsUserMessage(base);
    assert.doesNotMatch(msg, /MODERATOR-AUTHORED CORE SCENE/);
    assert.doesNotMatch(msg, /CURRENT MODERATOR DRAFT/);
  });

  it("a draft → existing_draft_context asks for DISTINCT alternatives, not an authoritative directive", () => {
    const msg = buildVisualConceptsUserMessage({ ...base, moderatorDraftScene: "{NAME} lifts a globe in a library." });
    assert.match(msg, /CURRENT MODERATOR DRAFT/);
    assert.match(msg, /\{NAME\} lifts a globe in a library\./);
    assert.match(msg.toLowerCase(), /distinct|different/);
    // Never the authoritative "realize this exact scene" directive.
    assert.doesNotMatch(msg, /MODERATOR-AUTHORED CORE SCENE \(AUTHORITATIVE/);
  });

  it("does NOT echo the moderator draft into an authoritative block three times", () => {
    const draft = "UNIQUEDRAFTMARKER duck stadium";
    const msg = buildVisualConceptsUserMessage({ ...base, moderatorDraftScene: draft });
    const occurrences = msg.split("UNIQUEDRAFTMARKER").length - 1;
    assert.equal(occurrences, 1, "draft appears once as context, not repeated as a directive");
  });
});

describe("generateVisualConceptsWithModel", () => {
  const input: GenerateVisualConceptsInput = { factText: "{NAME} bench-presses the Earth.", enrichment: ENRICHMENT };

  it("returns 3 sanitized candidates from a valid model response", async () => {
    const model = async () => JSON.stringify({ concepts: [conceptWire(), conceptWire(), conceptWire()] });
    const out = await generateVisualConceptsWithModel(input, model);
    assert.equal(out.length, 3);
    assert.equal(out[0]!.tokenValid, true);
  });

  it("retries once on an invalid count, then succeeds", async () => {
    let call = 0;
    const model = async () => {
      call += 1;
      return call === 1
        ? JSON.stringify({ concepts: [conceptWire()] })
        : JSON.stringify({ concepts: [conceptWire(), conceptWire(), conceptWire()] });
    };
    const out = await generateVisualConceptsWithModel(input, model);
    assert.equal(call, 2);
    assert.equal(out.length, 3);
  });

  it("throws after a second invalid response", async () => {
    const model = async () => JSON.stringify({ concepts: [conceptWire()] });
    await assert.rejects(() => generateVisualConceptsWithModel(input, model), /concepts/);
  });
});

describe("buildVisualConceptsUserMessage — no runtime bubble leakage", () => {
  it("existing moderator bubbles never reach candidate-concept context", () => {
    const base: GenerateVisualConceptsInput = { factText: "{NAME} bench-presses the Earth.", enrichment: ENRICHMENT };
    const withBubbles = {
      ...base,
      enrichment: {
        ...base.enrichment,
        visualPromptStrategyOverride: {
          version: 1,
          requiredVisualDetails: [], forbiddenVisualDetails: [], roleBindings: [],
          compositionGuidance: [], styleAgnosticPromptAdditions: [], negativePromptAdditions: [],
          bubbles: [{ type: "speech", entity: "subject", text: "RUNTIME BUBBLE STRING" }],
        },
      },
    } as typeof base;
    const msg = buildVisualConceptsUserMessage(withBubbles);
    assert.ok(!msg.includes("RUNTIME BUBBLE STRING"), "bubble text must not leak");
    assert.ok(!msg.includes("MODERATOR BUBBLE DIRECTIVES"), "no bubble staging block in candidate context");
  });
});

// ─── §E: candidate bubble proposals ─────────────────────────────────────────

describe("candidate bubbles — wire + business validation (retryable contract errors)", () => {
  const bubble = (partial: Record<string, unknown> = {}) => ({
    type: "speech", entity: "subject", text: "You're the man of the house now.", ...partial,
  });

  it("a response missing the required bubbles array fails validation (→ corrective retry)", () => {
    const noBubbles = { concepts: [conceptWire(), conceptWire(), { title: "T", whyItWorks: "W", sceneDescription: "{NAME} waves." }] };
    assert.equal(validateCandidateConcepts(noBubbles).ok, false);
  });

  it("bubbles: [] is the normal valid case; a valid quote proposal passes", () => {
    const ok = validateCandidateConcepts({
      concepts: [conceptWire({ bubbles: [bubble()] }), conceptWire(), conceptWire()],
    });
    assert.equal(ok.ok, true);
  });

  it("rejects >4 bubbles, empty entity/text, over-cap entity/text (never truncates)", () => {
    const five = conceptWire({ bubbles: [bubble(), bubble(), bubble(), bubble(), bubble()] });
    assert.equal(validateCandidateConcepts({ concepts: [five, conceptWire(), conceptWire()] }).ok, false);
    const emptyEntity = conceptWire({ bubbles: [bubble({ entity: " " })] });
    assert.equal(validateCandidateConcepts({ concepts: [emptyEntity, conceptWire(), conceptWire()] }).ok, false);
    const overText = conceptWire({ bubbles: [bubble({ text: "x".repeat(81) })] });
    const overRes = validateCandidateConcepts({ concepts: [overText, conceptWire(), conceptWire()] });
    assert.equal(overRes.ok, false);
    if (!overRes.ok) assert.match(overRes.error, /exceeds 80 characters.*exact/i);
  });

  it("single-channel: a scene that authors a balloon, or restates the bubble text, fails", () => {
    const balloonScene = conceptWire({
      sceneDescription: '{NAME} hugs his father; a speech bubble reading "goodbye" floats above.',
      bubbles: [bubble()],
    });
    assert.equal(validateCandidateConcepts({ concepts: [balloonScene, conceptWire(), conceptWire()] }).ok, false);
    const restatedScene = conceptWire({
      sceneDescription: "{NAME} says You're the man of the house now. while hugging his father.",
      bubbles: [bubble()],
    });
    assert.equal(validateCandidateConcepts({ concepts: [restatedScene, conceptWire(), conceptWire()] }).ok, false);
    // Ordinary dialogue-context staging language stays legal.
    const stagingScene = conceptWire({
      sceneDescription: "{NAME} hugs his father in a doorway; the father looks moved by what {NAME} just said, clear space above their heads.",
      bubbles: [bubble()],
    });
    assert.equal(validateCandidateConcepts({ concepts: [stagingScene, conceptWire(), conceptWire()] }).ok, true);
  });
});

describe("candidate bubbles — sanitize + pickability + pick helper", () => {
  it("sanitizes: canonicalizes tokens, normalizes whitespace, collapses Subject case-insensitively", () => {
    const b = sanitizeCandidateBubble({ type: "speech", entity: "  SUBJECT ", text: "  {name}   rules  " });
    assert.equal(b.entity, "subject");
    assert.equal(b.text, "{NAME} rules");
    assert.equal(b.tokenValid, true);
  });

  it("a concrete personal name is NOT collapsed (no name context at candidate time)", () => {
    const b = sanitizeCandidateBubble({ type: "speech", entity: "David Franklin", text: "Hi." });
    assert.equal(b.entity, "David Franklin");
    assert.equal(b.tokenValid, true);
  });

  it("a token in entity, or an unknown token in text, marks the bubble invalid (stored, not truncated)", () => {
    const entityTok = sanitizeCandidateBubble({ type: "speech", entity: "{NAME}", text: "Hi." });
    assert.equal(entityTok.tokenValid, false);
    assert.match(entityTok.tokenError ?? "", /personalization tokens are not allowed/);
    const badText = sanitizeCandidateBubble({ type: "thought", entity: "subject", text: "{BOGUS} thought" });
    assert.equal(badText.tokenValid, false);
    assert.equal(badText.text, "{BOGUS} thought", "text stored as-is, never truncated/repaired");
  });

  it("concept pickability is ATOMIC: one invalid bubble makes the whole concept unpickable", () => {
    const stored = sanitizeCandidateConcept(conceptWire({
      bubbles: [
        { type: "speech", entity: "subject", text: "Fine." },
        { type: "thought", entity: "{NAME}", text: "Broken." },
      ],
    }) as never);
    assert.equal(stored.tokenValid, true, "scene itself is valid");
    assert.equal(isCandidateConceptPickable(stored), false);
  });

  it("v1 stored blobs without bubbles parse to [] (stale, not malformed)", () => {
    const v1 = storedCandidateConceptSchema.parse({
      title: "T", whyItWorks: "W", sceneDescription: "{NAME} waves.", tokenValid: true,
    });
    assert.deepEqual(v1.bubbles, []);
    assert.equal(isCandidateConceptPickable(v1), true);
  });

  it("withCandidateConceptDraft preserves unrelated fields, replaces scene + bubbles (presence-based, no enable flip)", () => {
    const existing = {
      ...EMPTY_VISUAL_STRATEGY_OVERRIDE,
      requiredVisualDetails: ["a glowing scoreboard"],
      roleBindings: [{ entity: "the father", visualRole: "standing in the doorway" }],
      bubbles: [{ type: "thought" as const, entity: "subject", text: "old bubble" }],
      coreSceneOverride: "old scene",
    };
    const candidate: StoredCandidateConcept = {
      title: "T", whyItWorks: "W",
      sceneDescription: "{NAME} hugs his father in a doorway.",
      tokenValid: true,
      bubbles: [{ type: "speech", entity: "subject", text: "You're the man of the house now.", tokenValid: true }],
    };
    const next = withCandidateConceptDraft(existing, candidate);
    // No `enabled` field exists anymore — presence-based activation means the scene +
    // bubbles apply because they're non-empty; unrelated fields keep applying too.
    assert.equal("enabled" in next, false);
    assert.equal(next.coreSceneOverride, "{NAME} hugs his father in a doorway.");
    assert.deepEqual(next.bubbles, [{ type: "speech", entity: "subject", text: "You're the man of the house now." }]);
    assert.deepEqual(next.requiredVisualDetails, ["a glowing scoreboard"], "unrelated fields preserved");
    assert.deepEqual(next.roleBindings, existing.roleBindings);
  });
});

describe("validateAndSanitizeCandidateConcepts — deterministic matrix", () => {
  it("a valid response with a quote bubble passes and keeps the quote ONLY in bubbles[].text", () => {
    const res = validateAndSanitizeCandidateConcepts({
      concepts: [
        conceptWire({
          sceneDescription: "{NAME} hugs his father in a doorway, both smiling, clear space overhead.",
          bubbles: [{ type: "speech", entity: "subject", text: "You're the man of the house now." }],
        }),
        conceptWire(), conceptWire(),
      ],
    });
    assert.equal(res.ok, true);
    if (res.ok) {
      const withBubble = res.candidates[0]!;
      assert.equal(withBubble.bubbles[0]?.text, "You're the man of the house now.");
      assert.ok(!withBubble.sceneDescription.includes("man of the house"), "quote lives only in the bubble");
      assert.equal(isCandidateConceptPickable(withBubble), true);
    }
  });

  it("an all-unpickable response is a retryable failure, never stored as ok", () => {
    const bad = conceptWire({ bubbles: [{ type: "speech", entity: "{NAME}", text: "Hi." }] });
    const res = validateAndSanitizeCandidateConcepts({
      concepts: [bad, { ...conceptWire(), sceneDescription: "{BOGUS} waves." }, { ...conceptWire(), sceneDescription: "{ALSO_BOGUS} waves." }],
    });
    assert.equal(res.ok, false);
    if (!res.ok) assert.match(res.error, /invalid personalization token|invalid token/i);
  });

  it("a partially-unpickable response stores ok with the invalid concept flagged", () => {
    const res = validateAndSanitizeCandidateConcepts({
      concepts: [
        conceptWire({ bubbles: [{ type: "speech", entity: "{NAME}", text: "Hi." }] }),
        conceptWire(), conceptWire(),
      ],
    });
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(isCandidateConceptPickable(res.candidates[0]!), false);
      assert.equal(isCandidateConceptPickable(res.candidates[1]!), true);
    }
  });

  it("retry flow: missing bubbles on first response is corrected by the second", async () => {
    let call = 0;
    const model = async () => {
      call++;
      return call === 1
        ? JSON.stringify({ concepts: [{ title: "T", whyItWorks: "W", sceneDescription: "{NAME} waves." }, conceptWire(), conceptWire()] })
        : JSON.stringify({ concepts: [conceptWire(), conceptWire(), conceptWire()] });
    };
    const input: GenerateVisualConceptsInput = { factText: "{NAME} waves.", enrichment: ENRICHMENT };
    const out = await generateVisualConceptsWithModel(input, model);
    assert.equal(call, 2);
    assert.equal(out.length, 3);
  });
});
