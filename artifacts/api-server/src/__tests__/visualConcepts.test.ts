/**
 * Unit tests (pure, no DB / no LLM) for candidate Visual-concept generation:
 *   - api-zod schema/sanitize: exactly-3 validation (with a jokeRead), the
 *     scene cap, {NAME} canonicalization, unknown-token → tokenValid:false.
 *   - the gag-writer request (PLAN_GAG_GENERATOR.md C): the caption with the
 *     stand-in name, meanings, mechanism, limits, note, saved gag and draft.
 *   - the stand-in name converted by the tokenizer, and failed conversions.
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

const keepTokens = async (t: string) => ({ template: t });

const POLICY = { supportingText: { mode: "allow" }, violence: { mode: "allow", intensity: "strong" } } as const;
function input(over: Partial<GenerateVisualConceptsInput> = {}): GenerateVisualConceptsInput {
  return { factText: "{NAME} bench-presses the Earth.", enrichment: ENRICHMENT, renderPolicy: POLICY as never, humorNote: null, savedGag: null, draft: null, ...over };
}

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
    const res = validateCandidateConcepts({ jokeRead: "R", concepts: [conceptWire(), conceptWire(), conceptWire()] });
    assert.equal(res.ok, true);
  });

  it("rejects a count other than three", () => {
    assert.equal(validateCandidateConcepts({ jokeRead: "R", concepts: [conceptWire(), conceptWire()] }).ok, false);
    assert.equal(validateCandidateConcepts({ jokeRead: "R", concepts: [conceptWire(), conceptWire(), conceptWire(), conceptWire()] }).ok, false);
  });

  it("rejects an empty title or sceneDescription", () => {
    assert.equal(validateCandidateConcepts({ jokeRead: "R", concepts: [conceptWire({ title: "  " }), conceptWire(), conceptWire()] }).ok, false);
    assert.equal(validateCandidateConcepts({ jokeRead: "R", concepts: [conceptWire(), conceptWire({ sceneDescription: "" }), conceptWire()] }).ok, false);
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

describe("buildVisualConceptsUserMessage — the gag-writer request (PLAN_GAG_GENERATOR.md C)", () => {
  it("writes the caption with the stand-in name and no curly-brace token anywhere", () => {
    const msg = buildVisualConceptsUserMessage(input({ factText: "{NAME} lifts {POSS} car while {SUBJ} {sleeps|sleep}." }));
    assert.match(msg, /FACT \(the caption\):\nAlex lifts their car while they sleep\./);
    assert.ok(!/\{[A-Za-z_|]+\}/.test(msg), "no token reaches the gag writer");
  });

  it("carries meanings, the mechanism and the limits; never a strategy example or a taxonomy score", () => {
    const msg = buildVisualConceptsUserMessage(input());
    assert.match(msg, /WHAT THE REFERENCES MEAN:/);
    assert.match(msg, /"Shark Week" refers to Discovery's Shark Week: annual shark programming/);
    assert.match(msg, /"Earth" means the planet Earth\./);
    assert.match(msg, /JOKE MECHANISM:\nsuperhuman physical feat, force scaled action/);
    assert.match(msg, /LIMITS:\nViolence: Allowed \(strong\)/);
    for (const banned of ["visualizationExamples", "Visualization examples", "taxonomyConfidence", "overhypeFit", "i2i default", "t2i fallback", "OUTPUT CONTRACT"]) {
      assert.ok(!msg.includes(banned), `no ${banned}`);
    }
  });

  it("passes a moderator's soften and no-text policy through", () => {
    const msg = buildVisualConceptsUserMessage(input({ renderPolicy: { supportingText: { mode: "forbid" }, violence: { mode: "soften", intensity: "strong" } } as never }));
    assert.match(msg, /Violence: Reduce explicit violent consequences/);
    assert.match(msg, /Text in the picture: No signs, labels or other words/);
  });

  it("omits absent blocks; carries the note, the saved gag and the draft (with bubbles) when present", () => {
    const bare = buildVisualConceptsUserMessage(input());
    assert.ok(!bare.includes("APPROVED HUMOR NOTE") && !bare.includes("ALREADY HAS") && !bare.includes("WORKING DRAFT"));
    const msg = buildVisualConceptsUserMessage(input({
      humorNote: "Alex's strength is the joke; the planet stays round.",
      savedGag: { scene: "{NAME} presses the Earth on a bench.", bubbles: [] },
      draft: { scene: "{NAME} spots for Atlas.", bubbles: [{ type: "speech", entity: "subject", text: "One more rep, {Subj}." }] },
    }));
    assert.match(msg, /APPROVED HUMOR NOTE[^\n]*\nAlex's strength is the joke/);
    assert.match(msg, /GAG THIS FACT ALREADY HAS[^\n]*\nAlex presses the Earth on a bench\./);
    assert.match(msg, /MODERATOR'S WORKING DRAFT[^\n]*\nAlex spots for Atlas\.\n- speech bubble, Alex: "One more rep, They\."/);
  });
});

describe("generateVisualConceptsWithModel", () => {
  it("returns 3 sanitized candidates from a valid model response", async () => {
    const model = async () => JSON.stringify({ jokeRead: "R", concepts: [conceptWire(), conceptWire(), conceptWire()] });
    const out = await generateVisualConceptsWithModel(input(), model, keepTokens);
    assert.equal(out.candidates.length, 3);
    assert.equal(out.jokeRead, "R");
    assert.equal(out.candidates[0]!.tokenValid, true);
  });

  it("retries once on an invalid count, then succeeds", async () => {
    let call = 0;
    const model = async () => {
      call += 1;
      return call === 1
        ? JSON.stringify({ jokeRead: "R", concepts: [conceptWire()] })
        : JSON.stringify({ jokeRead: "R", concepts: [conceptWire(), conceptWire(), conceptWire()] });
    };
    const out = await generateVisualConceptsWithModel(input(), model, keepTokens);
    assert.equal(call, 2);
    assert.equal(out.candidates.length, 3);
  });

  it("throws after a second invalid response", async () => {
    const model = async () => JSON.stringify({ jokeRead: "R", concepts: [conceptWire()] });
    await assert.rejects(() => generateVisualConceptsWithModel(input(), model, keepTokens), /concepts/);
  });
});

// ─── §E: candidate bubble proposals ─────────────────────────────────────────

describe("candidate bubbles — wire + business validation (retryable contract errors)", () => {
  const bubble = (partial: Record<string, unknown> = {}) => ({
    type: "speech", entity: "subject", text: "You're the man of the house now.", ...partial,
  });

  it("a response missing the required bubbles array fails validation (→ corrective retry)", () => {
    const noBubbles = { jokeRead: "R", concepts: [conceptWire(), conceptWire(), { title: "T", whyItWorks: "W", sceneDescription: "{NAME} waves." }] };
    assert.equal(validateCandidateConcepts(noBubbles).ok, false);
  });

  it("bubbles: [] is the normal valid case; a valid quote proposal passes", () => {
    const ok = validateCandidateConcepts({
      jokeRead: "R",
      concepts: [conceptWire({ bubbles: [bubble()] }), conceptWire(), conceptWire()],
    });
    assert.equal(ok.ok, true);
  });

  it("rejects >4 bubbles, empty entity/text, over-cap entity/text (never truncates)", () => {
    const five = conceptWire({ bubbles: [bubble(), bubble(), bubble(), bubble(), bubble()] });
    assert.equal(validateCandidateConcepts({ jokeRead: "R", concepts: [five, conceptWire(), conceptWire()] }).ok, false);
    const emptyEntity = conceptWire({ bubbles: [bubble({ entity: " " })] });
    assert.equal(validateCandidateConcepts({ jokeRead: "R", concepts: [emptyEntity, conceptWire(), conceptWire()] }).ok, false);
    const overText = conceptWire({ bubbles: [bubble({ text: "x".repeat(81) })] });
    const overRes = validateCandidateConcepts({ jokeRead: "R", concepts: [overText, conceptWire(), conceptWire()] });
    assert.equal(overRes.ok, false);
    if (!overRes.ok) assert.match(overRes.error, /exceeds 80 characters.*exact/i);
  });

  it("single-channel: a scene that authors a balloon, or restates the bubble text, fails", () => {
    const balloonScene = conceptWire({
      sceneDescription: '{NAME} hugs his father; a speech bubble reading "goodbye" floats above.',
      bubbles: [bubble()],
    });
    assert.equal(validateCandidateConcepts({ jokeRead: "R", concepts: [balloonScene, conceptWire(), conceptWire()] }).ok, false);
    const restatedScene = conceptWire({
      sceneDescription: "{NAME} says You're the man of the house now. while hugging his father.",
      bubbles: [bubble()],
    });
    assert.equal(validateCandidateConcepts({ jokeRead: "R", concepts: [restatedScene, conceptWire(), conceptWire()] }).ok, false);
    // Ordinary dialogue-context staging language stays legal.
    const stagingScene = conceptWire({
      sceneDescription: "{NAME} hugs his father in a doorway; the father looks moved by what {NAME} just said, clear space above their heads.",
      bubbles: [bubble()],
    });
    assert.equal(validateCandidateConcepts({ jokeRead: "R", concepts: [stagingScene, conceptWire(), conceptWire()] }).ok, true);
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
      jokeRead: "R",
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
      jokeRead: "R",
      concepts: [bad, { ...conceptWire(), sceneDescription: "{BOGUS} waves." }, { ...conceptWire(), sceneDescription: "{ALSO_BOGUS} waves." }],
    });
    assert.equal(res.ok, false);
    if (!res.ok) assert.match(res.error, /no concept could be used/i);
  });

  it("a partially-unpickable response stores ok with the invalid concept flagged", () => {
    const res = validateAndSanitizeCandidateConcepts({
      jokeRead: "R",
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
        ? JSON.stringify({ jokeRead: "R", concepts: [{ title: "T", whyItWorks: "W", sceneDescription: "{NAME} waves." }, conceptWire(), conceptWire()] })
        : JSON.stringify({ jokeRead: "R", concepts: [conceptWire(), conceptWire(), conceptWire()] });
    };
    const out = await generateVisualConceptsWithModel(input({ factText: "{NAME} waves." }), model, keepTokens);
    assert.equal(call, 2);
    assert.equal(out.candidates.length, 3);
  });
});

describe("the stand-in name is converted by the tokenizer (PLAN_GAG_GENERATOR.md D)", () => {
  const alex = (scene: string, bubbles: unknown[] = []) => ({ title: "T", whyItWorks: "W", sceneDescription: scene, bubbles });

  it("a scene and a bubble line come back as tokens; another character's pronoun is left alone", async () => {
    const tokenize = async (t: string) => ({
      template: t.replace(/\bAlex's\b/g, "{NAME_POSSESSIVE}").replace(/\bAlex\b/g, "{NAME}"),
    });
    const model = async () => JSON.stringify({ jokeRead: "R", concepts: [
      alex("Alex hands Dad the car keys. Dad nods; he takes it seriously.", [{ type: "speech", entity: "subject", text: "You're the man of the house now." }]),
      alex("Alex's suitcase sits by the door."), alex("Alex waves from the car."),
    ] });
    const out = await generateVisualConceptsWithModel(input(), model, tokenize);
    assert.equal(out.candidates[0]!.sceneDescription, "{NAME} hands Dad the car keys. Dad nods; he takes it seriously.");
    assert.equal(out.candidates[1]!.sceneDescription, "{NAME_POSSESSIVE} suitcase sits by the door.");
    assert.equal(out.candidates[0]!.bubbles[0]!.text, "You're the man of the house now.");
    assert.ok(out.candidates.every(isCandidateConceptPickable));
  });

  it("a tokenizer that returns its input unchanged yields an unpickable gag, never a stored \"Alex\"", async () => {
    let tokenizerCalls = 0;
    const tokenize = async (t: string) => { tokenizerCalls++; return { template: t.includes("Alex waves") ? t : t.replace(/\bAlex\b/g, "{NAME}") }; };
    const model = async () => JSON.stringify({ jokeRead: "R", concepts: [alex("Alex waves."), alex("Alex lifts a bus."), alex("Alex reads.")] });
    const out = await generateVisualConceptsWithModel(input(), model, tokenize);
    assert.ok(tokenizerCalls >= 3);
    const failed = out.candidates[0]!;
    assert.equal(isCandidateConceptPickable(failed), false);
    assert.match(failed.tokenError ?? "", /CONVERSION_FAILED|token/i);
    assert.ok(out.candidates.slice(1).every(isCandidateConceptPickable));
  });

  it("a scene that never names the subject is not pickable", async () => {
    const tokenize = async (t: string) => ({ template: t });
    const model = async () => JSON.stringify({ jokeRead: "R", concepts: [alex("A bus floats."), alex("Alex lifts a bus."), alex("Alex reads.")] });
    const out = await generateVisualConceptsWithModel(input(), model, async (t) => (t.includes("Alex") ? { template: t.replace(/\bAlex\b/g, "{NAME}") } : tokenize(t)));
    assert.equal(isCandidateConceptPickable(out.candidates[0]!), false);
  });
});

describe("bubble lines convert when they refer to the subject (PR #936 round 1)", () => {
  const scene = (bubbles: unknown[]) => ({ title: "T", whyItWorks: "W", sceneDescription: "Alex stands in the square.", bubbles });

  it("a supporting character's pronoun-only line about the subject is converted; unrelated and hero-spoken lines stay exact", async () => {
    const calls: string[] = [];
    const tokenize = async (t: string) => {
      calls.push(t);
      return { template: t.replace(/\bAlex\b/g, "{NAME}").replace(/^Their\b/, "{Poss}") };
    };
    const model = async () => JSON.stringify({ jokeRead: "R", concepts: [
      scene([{ type: "speech", entity: "the coach", text: "Their strength is impossible!" }]),
      scene([{ type: "speech", entity: "the coach", text: "Nobody lifts a bus." }]),
      scene([{ type: "speech", entity: "subject", text: "I heard that, and yes, they're real." }]),
    ] });
    const out = await generateVisualConceptsWithModel(input(), model, tokenize);
    assert.equal(out.candidates[0]!.bubbles[0]!.text, "{Poss} strength is impossible!");
    assert.equal(out.candidates[1]!.bubbles[0]!.text, "Nobody lifts a bus.");
    assert.equal(out.candidates[2]!.bubbles[0]!.text, "I heard that, and yes, they're real.");
    assert.ok(calls.includes("Their strength is impossible!"));
    assert.ok(!calls.includes("Nobody lifts a bus."), "no tokenizer call for a line with no subject reference");
    assert.ok(!calls.includes("I heard that, and yes, they're real."), "no tokenizer call for the hero's own line without the name");
    assert.ok(out.candidates.every(isCandidateConceptPickable));
  });
});
