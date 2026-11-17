/**
 * People and pets only (plan docs/plans/PLAN_GAG_EXAMPLES.md, increment 2,
 * Testing Plan items 9 and 10; Issue #964): a picture's subject is a person or
 * a pet.
 *
 *   - classification: a vehicle-only or object-only photo has no usable
 *     subject, and a person or a pet photo classifies as before;
 *   - prompts: no shipped prompt offers a vehicle, an object or a mascot as the
 *     personalised subject. Vehicles and objects stay legitimate as props, so
 *     the check reads the subject-defining lines, not every mention.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyTier2 } from "../lib/sourceImageAnalysis/tier2Heuristics.js";
import { FACT_SOURCE_CLASSIFIER_SYSTEM_DEFAULT, FACT_IMAGE_PROMPT_SYSTEM_DEFAULT } from "../lib/imagePromptConfig.js";
import { FACT_VISUAL_CONCEPTS_SYSTEM_DEFAULT } from "../lib/visualConceptsConfig.js";
import { baselineRecipeFor } from "../lib/imagePrompt/recipe.js";
import { VISUAL_PROMPT_GLOBAL_RULES, SOURCE_SUBJECT_KIND_VALUES, RENDER_SCENARIO_KEYS, REFERENCE_IDENTITY_TYPES, EVALUATION_PHOTO_TYPES } from "@workspace/api-zod";

const box = { x: 0.2, y: 0.2, width: 0.6, height: 0.6 };
const det = (label: string, score = 0.9) => ({ label, score, box });

describe("classification: people and pets only", () => {
  for (const label of ["car", "truck", "toy", "statue", "mascot", "laptop", "boat"]) {
    it(`a photo whose only subject is a ${label} has no usable subject`, () => {
      const { analysis } = classifyTier2([det(label)]);
      assert.equal(analysis.subjectKind, "scene_no_clear_subject");
      assert.equal(analysis.hasUsableSubject, false);
      assert.deepEqual(analysis.warnings, ["No person or pet in this image."]);
    });
  }

  it("a pet photo is an animal subject, rendered from the pet", () => {
    const { analysis } = classifyTier2([det("cat")]);
    assert.equal(analysis.subjectKind, "animal_subject");
    assert.equal(analysis.hasUsableSubject, true);
    assert.equal(analysis.suggestedRenderMode, "nonhuman_subject_i2i");
  });

  it("a person beside a car is the person", () => {
    const { analysis } = classifyTier2([det("car", 0.95), det("face", 0.9)]);
    assert.equal(analysis.subjectKind, "human_face");
  });

  it("a pet beside a car is the pet, not multiple subjects", () => {
    const { analysis } = classifyTier2([det("car", 0.95), det("dog", 0.9)]);
    assert.equal(analysis.subjectKind, "animal_subject");
  });
});

describe("the subject vocabulary names no vehicle, object or mascot", () => {
  it("the subject kinds, scenarios, reference types and evaluation photo types", () => {
    const all = [...SOURCE_SUBJECT_KIND_VALUES, ...RENDER_SCENARIO_KEYS, ...REFERENCE_IDENTITY_TYPES, ...EVALUATION_PHOTO_TYPES.map((t) => t.label)];
    for (const v of all) assert.doesNotMatch(String(v), /vehicle|object|mascot/i, v);
  });
});

describe("prompts: no vehicle, object or mascot as the subject", () => {
  // A vehicle or object as a prop elsewhere in a prompt is legitimate content,
  // so these read the subject-defining lines or the exact retired phrasings.
  const subjectLines = (text: string) => text.split(/(?<=[.!?])\s+|\n/).filter((s) => /subject|\bpets?\b/i.test(s));

  it("the gag writer's locked prompt names only people and pets as the subject", () => {
    for (const s of subjectLines(FACT_VISUAL_CONCEPTS_SYSTEM_DEFAULT)) {
      assert.doesNotMatch(s, /\bvehicles?\b|\bvehicle model\b/i, s);
    }
    assert.match(FACT_VISUAL_CONCEPTS_SYSTEM_DEFAULT, /The subject can also be themselves or a pet\./);
  });

  it("the classifier and planner prompts", () => {
    // Every phrasing that offered a vehicle, object or mascot as the subject.
    const OFFERS = [
      /object_subject|vehicle_subject|mascot_or_character_subject/,
      /\b(an? )?(vehicle|object|mascot\/character) subject\b/i,
      /animal\/object\/vehicle\/mascot/i,
      /\(cat, dog, car, object, mascot\)/i,
      /species or object type/i,
      /for objects\/vehicles/i,
      /\(human face, animal, object, vehicle, mascot\)/i,
    ];
    for (const text of [FACT_SOURCE_CLASSIFIER_SYSTEM_DEFAULT, FACT_IMAGE_PROMPT_SYSTEM_DEFAULT]) {
      for (const re of OFFERS) assert.doesNotMatch(text, re);
    }
    assert.match(FACT_SOURCE_CLASSIFIER_SYSTEM_DEFAULT, /a vehicle, an object, a toy, a statue or a mascot costume is never the subject/);
  });

  it("the non-human identity rules and every family's pet identity piece", () => {
    assert.doesNotMatch(VISUAL_PROMPT_GLOBAL_RULES.nonhumanSubjectIdentityPolicy, /object|vehicle|mascot/i);
    for (const family of [null, "gpt-image-2-6", "nano-banana-2-1"]) {
      const pieces = baselineRecipeFor(family).pieces as Record<string, string>;
      assert.equal(pieces["identity.object"], undefined, `${family}: no object identity piece`);
      assert.doesNotMatch(pieces["identity.pet"] ?? "", /object|vehicle|mascot/i, `${family}`);
    }
  });
});
