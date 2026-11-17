/**
 * Field docs — per-value docs for the known fact modifiers, plus the doc
 * shown for unknown (custom, amber-chip) modifiers.
 *
 * Pure data (see the purity invariant in ./types.ts): no React, no components.
 *
 * WHAT A MODIFIER DOES NOW: nothing a picture can see. Pictures are drawn
 * straight from the approved gag (plan docs/plans/PLAN_GAG_DIRECT_RENDER.md),
 * so the render-time planner that read modifiers as TAXONOMY context is gone,
 * and so are the few structural compiler signals they used to drive: age
 * transforms -> SUBJECT BINDING, avoid_duplicate_subject -> the single-instance
 * binding, action_comedy / cinematic_aftermath / projectile_impact_power ->
 * violence relevance, crowd_reaction / clear_causal_relationship /
 * subject_object_reversal -> failure-mode guards. Every picture now carries
 * one fixed violence sentence and no modifier-keyed wording. The gag writer's
 * message does not list modifiers either; they take part only in its
 * freshness check (`writerAffectingEnrichment`), so editing one marks stored
 * gag ideas out of date. Age handling and "one subject, no clones" belong to
 * the gag writer and the gag's scene.
 *
 * The retired text/brand suppression modifiers (no_readable_text,
 * avoid_readable_ui, avoid_real_logos) are no longer catalog values and have no
 * entry here — see RETIRED_TEXT_MODIFIERS in lib/api-zod/src/taxonomy.ts.
 */

import type { KnownFactModifier } from "@workspace/api-zod";
import type { ValueDoc, FieldDocSourceRef } from "./types";

// ─── Shared source refs ──────────────────────────────────────────────────────

const WRITER_HASH: FieldDocSourceRef = {
  path: "artifacts/api-server/src/lib/visualConcepts/inputHash.ts",
  symbol: "writerAffectingEnrichment",
  note: "The only place a modifier is still read: the gag writer's freshness projection. Editing one marks stored gag ideas out of date; it is never put in the writer's message and never reaches a picture.",
};
const TAXONOMY_CATALOG: FieldDocSourceRef = {
  path: "lib/api-zod/src/taxonomy.ts",
  symbol: "KNOWN_FACT_MODIFIERS",
  note: "The canonical known-modifier catalog this value belongs to.",
};
const CLASSIFIER_CATALOG: FieldDocSourceRef = {
  path: "artifacts/api-server/src/lib/factEnrichmentConfig.ts",
  symbol: "FACT_ENRICHMENT_SYSTEM_DEFAULT",
  note: "The classifier is told to prefer catalog modifiers that capture rendering, discovery, identity, setting, or safety constraints.",
};
const VIOLENCE: FieldDocSourceRef = {
  path: "artifacts/api-server/src/lib/imagePrompt/violenceRule.ts",
  symbol: "VIOLENCE_RULE",
  note: "The one fixed violence sentence every picture's prompt carries; no modifier changes it.",
};

/** The standard render-impact line for a modifier that no longer reaches a picture. */
const NO_PICTURE_IMPACT =
  "No effect on the picture: the compiler does not read it and the gag writer's message does not list it. It is recorded on the fact and is part of the gag writer's freshness check only (editing it marks stored gag ideas out of date). If the picture should show it, say it in the gag's scene.";

/** The render-impact shared by the three violence-relevance modifiers. */
const VIOLENCE_RELEVANCE_IMPACT =
  "No effect on the picture any more. It used to mark the fact violence-relevant for the compiler; that check was removed when pictures started being drawn straight from the gag (plan docs/plans/PLAN_GAG_DIRECT_RENDER.md). Every picture now carries the one fixed violence sentence (comedic violence and its consequences shown clearly, without intense gore), whatever the modifiers say.";

/** The render-impact shared by the age/life-stage transform modifiers. */
const AGE_BINDING_IMPACT =
  "No effect on the picture any more. Age transforms used to drive a SUBJECT BINDING section (the subject IS the transformed person, never a second generic baby/elder) plus anti-split constraints; that code was removed when pictures started being drawn straight from the gag (plan docs/plans/PLAN_GAG_DIRECT_RENDER.md). The gag writer owns age handling now: the de-aging or aging has to be written into the gag's scene.";

// ─── Unmapped-setting helper ─────────────────────────────────────────────────

/** ValueDoc for a pure setting/location flag — honestly advisory-only. */
function settingDoc(place: string, meaning: string, example: string): ValueDoc {
  return {
    meaning,
    renderImpact: `No effect on the picture: setting/location flags are not read by the compiler or put in the gag writer's message. The gag's scene decides the environment, so say the ${place} setting there if the picture needs it.`,
    example,
    sourceRefs: [TAXONOMY_CATALOG, WRITER_HASH],
    authoredStatus: "authored-needs-david-review",
  };
}

// ─── The known-modifier docs (one per KNOWN_FACT_MODIFIERS entry) ────────────

export const KNOWN_MODIFIER_DOCS = {
  single_subject_focus: {
    meaning:
      "Composition flag: the image should center on the subject alone, with no competing characters sharing the spotlight.",
    renderImpact: NO_PICTURE_IMPACT,
    example:
      '"{NAME} is the gym\'s entire membership" → a label only; the picture follows the gag\'s scene, so say it there if it should show.',
    sourceRefs: [TAXONOMY_CATALOG, WRITER_HASH],
    authoredStatus: "authored-needs-david-review",
  },
  identity_strict: {
    meaning:
      "Identity-policy flag: the subject's recognizable likeness should be preserved strictly — the joke fails if the rendered person doesn't clearly read as the reference photo's person.",
    renderImpact: "No effect on the picture: no compiler directive or identity policy keys off this flag, and the gag writer's message does not list it. Likeness preservation is owned by the subject render mode and the fixed identity wording every picture carries.",
    example:
      '"{NAME} was recognized from space" → a label only; the picture follows the gag\'s scene, so say it there if it should show.',
    sourceRefs: [TAXONOMY_CATALOG, CLASSIFIER_CATALOG],
    authoredStatus: "authored-needs-david-review",
  },
  identity_essence_only: {
    meaning:
      "Identity-policy flag: strict likeness may be relaxed — the render only needs to carry the subject's essence (build, hair, vibe), e.g. through a heavy transformation or symbolic treatment.",
    renderImpact: "No effect on the picture: like identity_strict, nothing in the compiler or the gag writer's message reads it. It is recorded on the fact and takes part only in the gag writer's freshness check.",
    example:
      '"{NAME} turned into pure motivation" → a label only; the picture follows the gag\'s scene, so say it there if it should show.',
    sourceRefs: [TAXONOMY_CATALOG, CLASSIFIER_CATALOG],
    authoredStatus: "authored-needs-david-review",
  },
  face_prominent: {
    meaning:
      "Framing flag: the joke depends on the subject's face and expression reading clearly, so the face must be framed large and unobstructed.",
    renderImpact: NO_PICTURE_IMPACT,
    example:
      '"{NAME}\'s wink restarted the power grid" → a label only; the picture follows the gag\'s scene, so say it there if it should show.',
    sourceRefs: [TAXONOMY_CATALOG, WRITER_HASH],
    authoredStatus: "authored-needs-david-review",
  },
  full_body_needed: {
    meaning:
      "Framing flag: the joke needs the whole body visible (a pose, a feat, a stance) — a chest-up crop would lose it.",
    renderImpact: NO_PICTURE_IMPACT,
    example:
      '"{NAME} deadlifts a city bus" → a label only; the picture follows the gag\'s scene, so say it there if it should show.',
    sourceRefs: [TAXONOMY_CATALOG, WRITER_HASH],
    authoredStatus: "authored-needs-david-review",
  },
  age_transform: {
    meaning:
      "The fact requires the subject rendered at a different age or life stage than the reference photo — the generic form of the baby/older variants below.",
    renderImpact: AGE_BINDING_IMPACT,
    example:
      '"{NAME} was born flexing" → a label only; the picture follows the gag\'s scene, so say it there if it should show.',
    sourceRefs: [TAXONOMY_CATALOG, WRITER_HASH],
    authoredStatus: "code-derived",
  },
  baby_child_version: {
    meaning:
      "The fact describes the subject as a baby or young child — the reference person must be de-aged, not accompanied by a random infant.",
    renderImpact: AGE_BINDING_IMPACT,
    example:
      '"{NAME} as a baby negotiated their own bedtime" → a label only; the picture follows the gag\'s scene, so say it there if it should show.',
    sourceRefs: [TAXONOMY_CATALOG, WRITER_HASH],
    authoredStatus: "code-derived",
  },
  infant_version: {
    meaning:
      "A finer-grained age stage than baby_child_version: the fact needs the subject rendered specifically as a newborn/infant. The compiler used to render it distinctly (that effect was removed); the classifier's suggestion catalog doesn't list it, so it's typically moderator-added.",
    renderImpact: AGE_BINDING_IMPACT,
    example:
      '"{NAME} filed taxes from the womb" → a label only; the picture follows the gag\'s scene, so say it there if it should show.',
    sourceRefs: [TAXONOMY_CATALOG, WRITER_HASH],
    authoredStatus: "code-derived",
  },
  child_version: {
    meaning:
      "A finer-grained age stage than baby_child_version: the fact needs the subject rendered specifically as a young child (past infancy). The compiler used to render it distinctly (that effect was removed); the classifier's suggestion catalog doesn't list it, so it's typically moderator-added.",
    renderImpact: AGE_BINDING_IMPACT,
    example:
      '"{NAME} won a Nobel Prize in third grade" → a label only; the picture follows the gag\'s scene, so say it there if it should show.',
    sourceRefs: [TAXONOMY_CATALOG, WRITER_HASH],
    authoredStatus: "code-derived",
  },
  older_self_version: {
    meaning:
      "The fact describes the subject as a much older version of themselves — the same person aged, not an unrelated elderly extra.",
    renderImpact: AGE_BINDING_IMPACT,
    example:
      '"At 90, {NAME} still outruns ambulances" → a label only; the picture follows the gag\'s scene, so say it there if it should show.',
    sourceRefs: [TAXONOMY_CATALOG, WRITER_HASH],
    authoredStatus: "code-derived",
  },
  grounded_realism: {
    meaning:
      "Staging flag: keep physics and rendering realistic — the impossibility should live in what's happening (roles, outcomes), not in cartoon physics or surreal style.",
    renderImpact: NO_PICTURE_IMPACT,
    example:
      '"A baby drove {NAME}\'s mother home" → a label only; the picture follows the gag\'s scene, so say it there if it should show.',
    sourceRefs: [TAXONOMY_CATALOG, WRITER_HASH],
    authoredStatus: "authored-needs-david-review",
  },
  mock_heroic: {
    meaning:
      "The comedy comes from treating something trivial with epic gravitas — the subject should be staged like a monument to a mundane act.",
    renderImpact: NO_PICTURE_IMPACT,
    example:
      '"{NAME} plugged in a USB right on the first try" → a label only; the picture follows the gag\'s scene, so say it there if it should show.',
    sourceRefs: [TAXONOMY_CATALOG, WRITER_HASH],
    authoredStatus: "authored-needs-david-review",
  },
  action_comedy: {
    meaning:
      "The fact is an action joke — energetic, slapstick, physical comedy staging suits it better than solemn cinematics.",
    renderImpact: VIOLENCE_RELEVANCE_IMPACT,
    example:
      '"{NAME} fought the office printer and won" → a label only; the picture follows the gag\'s scene, so say it there if it should show.',
    sourceRefs: [TAXONOMY_CATALOG, WRITER_HASH, VIOLENCE],
    authoredStatus: "code-derived",
  },
  cinematic_aftermath: {
    meaning:
      "The funniest frame is AFTER the action — the crater, the dust, the stunned onlookers — rather than the action itself.",
    renderImpact: VIOLENCE_RELEVANCE_IMPACT,
    example:
      '"{NAME} high-fived a mountain" → a label only; the picture follows the gag\'s scene, so say it there if it should show.',
    sourceRefs: [TAXONOMY_CATALOG, WRITER_HASH, VIOLENCE],
    authoredStatus: "code-derived",
  },
  symbolic_abstraction_required: {
    meaning:
      "The fact cannot be shown literally at all — it demands symbolic visual language (the modifier-flag counterpart of the symbolic_abstraction literalness rating).",
    renderImpact: NO_PICTURE_IMPACT,
    example:
      '"{NAME} counted to infinity. Twice." → a label only; the picture follows the gag\'s scene, so say it there if it should show.',
    sourceRefs: [TAXONOMY_CATALOG, WRITER_HASH],
    authoredStatus: "authored-needs-david-review",
  },
  metaphorical_visualization: {
    meaning:
      "The joke should land as one concrete visual metaphor — a phrase made physically true in the image (the modifier-flag counterpart of the same-named literalness rating).",
    renderImpact: NO_PICTURE_IMPACT,
    example:
      '"{NAME}\'s handshake seals deals" → a label only; the picture follows the gag\'s scene, so say it there if it should show.',
    sourceRefs: [TAXONOMY_CATALOG, WRITER_HASH],
    authoredStatus: "authored-needs-david-review",
  },
  clear_causal_relationship: {
    meaning:
      "The joke is a cause→effect gag, and it only lands if the viewer instantly sees which action caused which consequence.",
    renderImpact: "No effect on the picture any more. It used to add a failure-mode guard (\"show the cause and its effect together\") to the strict constraints; that guard was removed when pictures started being drawn straight from the gag (plan docs/plans/PLAN_GAG_DIRECT_RENDER.md). Make the cause and effect legible in the gag's scene.",
    example:
      '"{NAME} clapped and the thunder answered" → a label only; the picture follows the gag\'s scene, so say it there if it should show.',
    sourceRefs: [TAXONOMY_CATALOG, WRITER_HASH],
    authoredStatus: "code-derived",
  },
  crowd_reaction: {
    meaning:
      "Witnesses are part of the joke — the scene needs a visible crowd whose reaction sells how impressive the subject is.",
    renderImpact: "No effect on the picture any more. It used to add a crowd focus/relationship guard to the strict constraints; that guard was removed when pictures started being drawn straight from the gag (plan docs/plans/PLAN_GAG_DIRECT_RENDER.md). Describe the crowd, and who it reacts to, in the gag's scene.",
    example:
      '"{NAME} parallel-parked on the first attempt" → a label only; the picture follows the gag\'s scene, so say it there if it should show.',
    sourceRefs: [TAXONOMY_CATALOG, WRITER_HASH],
    authoredStatus: "code-derived",
  },
  environmental_reaction: {
    meaning:
      "The environment itself should visibly respond to the subject — nature, buildings, or weather reacting is the punchline's proof.",
    renderImpact: NO_PICTURE_IMPACT,
    example:
      '"{NAME} whispered and the forest leaned in" → a label only; the picture follows the gag\'s scene, so say it there if it should show.',
    sourceRefs: [TAXONOMY_CATALOG, WRITER_HASH],
    authoredStatus: "authored-needs-david-review",
  },
  object_transformation: {
    meaning:
      "An object changes state because of the subject, and the change itself must be legible — best shown mid-transformation.",
    renderImpact: NO_PICTURE_IMPACT,
    example:
      '"{NAME} stared at coal until it became a diamond" → a label only; the picture follows the gag\'s scene, so say it there if it should show.',
    sourceRefs: [TAXONOMY_CATALOG, WRITER_HASH],
    authoredStatus: "authored-needs-david-review",
  },
  technology_reaction: {
    meaning:
      "Devices and machines visibly respond to the subject — screens, routers, robots reacting is the gag's evidence.",
    renderImpact: NO_PICTURE_IMPACT,
    example:
      '"WiFi gets stronger when {NAME} walks by" → a label only; the picture follows the gag\'s scene, so say it there if it should show.',
    sourceRefs: [TAXONOMY_CATALOG, WRITER_HASH],
    authoredStatus: "authored-needs-david-review",
  },
  official_setting: settingDoc(
    "formal/ceremonial",
    '"{NAME} was sworn in as everyone\'s emergency contact" → a label only; the picture follows the gag\'s scene, so say it there if it should show.',
    '"{NAME} was sworn in as everyone\'s emergency contact" → a label only; the picture follows the gag\'s scene, so say it there if it should show.',
  ),
  professional_context: {
    meaning:
      "Context flag: the fact lives in a professional/expert domain (consultants, doctors, engineers at work). Also an adult-suitability signal — professional contexts are on the classifier's adult-incompatible list.",
    renderImpact: "No effect on the picture: nothing compiles it and the gag writer's message does not list it. Its firmer role is taxonomy/safety context (adult-suitability review). It also takes part in the gag writer's freshness check.",
    example:
      '"{NAME} closed the deal by nodding" → a label only; the picture follows the gag\'s scene, so say it there if it should show.',
    sourceRefs: [TAXONOMY_CATALOG, WRITER_HASH, CLASSIFIER_CATALOG],
    authoredStatus: "authored-needs-david-review",
  },
  domestic_setting: settingDoc(
    "home/domestic",
    '"{NAME}\'s houseplants water themselves out of respect" → a label only; the picture follows the gag\'s scene, so say it there if it should show.',
    '"{NAME}\'s houseplants water themselves out of respect" → a label only; the picture follows the gag\'s scene, so say it there if it should show.',
  ),
  office_setting: settingDoc(
    "office",
    '"The office printer works only for {NAME}" → a label only; the picture follows the gag\'s scene, so say it there if it should show.',
    '"The office printer works only for {NAME}" → a label only; the picture follows the gag\'s scene, so say it there if it should show.',
  ),
  school_setting: settingDoc(
    "school",
    '"Teachers ask {NAME} for hall passes" → a label only; the picture follows the gag\'s scene, so say it there if it should show.',
    '"Teachers ask {NAME} for hall passes" → a label only; the picture follows the gag\'s scene, so say it there if it should show.',
  ),
  hospital_setting: settingDoc(
    "hospital/medical",
    '"Doctors check {NAME}\'s pulse to calibrate their watches" → a label only; the picture follows the gag\'s scene, so say it there if it should show.',
    '"Doctors check {NAME}\'s pulse to calibrate their watches" → a label only; the picture follows the gag\'s scene, so say it there if it should show.',
  ),
  courtroom_setting: settingDoc(
    "courtroom",
    '"{NAME} was called as an expert witness on being impressive" → a label only; the picture follows the gag\'s scene, so say it there if it should show.',
    '"{NAME} was called as an expert witness on being impressive" → a label only; the picture follows the gag\'s scene, so say it there if it should show.',
  ),
  airport_setting: settingDoc(
    "airport",
    '"TSA waves {NAME} through with applause" → a label only; the picture follows the gag\'s scene, so say it there if it should show.',
    '"TSA waves {NAME} through with applause" → a label only; the picture follows the gag\'s scene, so say it there if it should show.',
  ),
  gym_setting: settingDoc(
    "gym",
    '"The gym renamed leg day after {NAME}" → a label only; the picture follows the gag\'s scene, so say it there if it should show.',
    '"The gym renamed leg day after {NAME}" → a label only; the picture follows the gag\'s scene, so say it there if it should show.',
  ),
  bar_setting: settingDoc(
    "bar",
    '"Bartenders tip {NAME}" → a label only; the picture follows the gag\'s scene, so say it there if it should show.',
    '"Bartenders tip {NAME}" → a label only; the picture follows the gag\'s scene, so say it there if it should show.',
  ),
  battlefield_setting: settingDoc(
    "battlefield",
    '"{NAME} won the battle by showing up" → a label only; the picture follows the gag\'s scene, so say it there if it should show.',
    '"{NAME} won the battle by showing up" → a label only; the picture follows the gag\'s scene, so say it there if it should show.',
  ),
  technology_setting: settingDoc(
    "tech/data-center",
    '"Servers cool down when {NAME} logs on" → a label only; the picture follows the gag\'s scene, so say it there if it should show.',
    '"Servers cool down when {NAME} logs on" → a label only; the picture follows the gag\'s scene, so say it there if it should show.',
  ),
  underwater_setting: settingDoc(
    "underwater",
    '"Sharks have a {NAME} Week" → a label only; the picture follows the gag\'s scene, so say it there if it should show.',
    '"Sharks have a {NAME} Week" → a label only; the picture follows the gag\'s scene, so say it there if it should show.',
  ),
  space_setting: settingDoc(
    "outer-space",
    '"{NAME} waved at the ISS and it waved back" → a label only; the picture follows the gag\'s scene, so say it there if it should show.',
    '"{NAME} waved at the ISS and it waved back" → a label only; the picture follows the gag\'s scene, so say it there if it should show.',
  ),
  outdoor_nature_setting: settingDoc(
    "outdoor/nature",
    '"Mountains adjust their height for {NAME}\'s photos" → a label only; the picture follows the gag\'s scene, so say it there if it should show.',
    '"Mountains adjust their height for {NAME}\'s photos" → a label only; the picture follows the gag\'s scene, so say it there if it should show.',
  ),
  city_setting: settingDoc(
    "urban/city",
    '"Traffic lights turn green when {NAME} approaches" → a label only; the picture follows the gag\'s scene, so say it there if it should show.',
    '"Traffic lights turn green when {NAME} approaches" → a label only; the picture follows the gag\'s scene, so say it there if it should show.',
  ),
  avoid_weapons_focus: {
    meaning:
      "Presentation constraint (not moderation): a weapon may appear if the fact requires it, but it must not be the visual centerpiece of the scene.",
    renderImpact: NO_PICTURE_IMPACT,
    example:
      '"{NAME} caught the arrow mid-flight" → a label only; the picture follows the gag\'s scene, so say it there if it should show.',
    sourceRefs: [TAXONOMY_CATALOG, WRITER_HASH],
    authoredStatus: "authored-needs-david-review",
  },
  avoid_gross_literalization: {
    meaning:
      "Taste constraint: a literal rendering of the fact would be gross or off-putting — the idea should be staged tastefully instead.",
    renderImpact: NO_PICTURE_IMPACT,
    example:
      '"{NAME} sweats pure espresso" → a label only; the picture follows the gag\'s scene, so say it there if it should show.',
    sourceRefs: [TAXONOMY_CATALOG, WRITER_HASH],
    authoredStatus: "authored-needs-david-review",
  },
  avoid_extra_faces: {
    meaning:
      "Focus constraint: background faces dilute the subject and risk identity confusion — keep other faces minimal so the subject stays the one clear face.",
    renderImpact: NO_PICTURE_IMPACT,
    example:
      '"{NAME} won the marathon running backwards" → a label only; the picture follows the gag\'s scene, so say it there if it should show.',
    sourceRefs: [TAXONOMY_CATALOG, WRITER_HASH],
    authoredStatus: "authored-needs-david-review",
  },
  avoid_duplicate_subject: {
    meaning:
      "Anti-clone constraint: image models love to render the reference person twice — this flag pins the subject to exactly one instance.",
    renderImpact: "No effect on the picture any more. It used to trigger the single-instance SUBJECT BINDING and the no-clone strict constraint; both were removed when pictures started being drawn straight from the gag (plan docs/plans/PLAN_GAG_DIRECT_RENDER.md). Keep the subject to one copy by saying so in the gag's scene.",
    example:
      '"{NAME} raced their own shadow" → a label only; the picture follows the gag\'s scene, so say it there if it should show.',
    sourceRefs: [TAXONOMY_CATALOG, WRITER_HASH],
    authoredStatus: "code-derived",
  },
  astronomical_consequence: {
    meaning:
      "The fact's consequence is planetary/cosmic scale — the image must stage that scale, not shrink it to a local effect.",
    renderImpact: NO_PICTURE_IMPACT,
    example:
      '"{NAME} sneezed and the moon left orbit" → a label only; the picture follows the gag\'s scene, so say it there if it should show.',
    sourceRefs: [TAXONOMY_CATALOG, WRITER_HASH],
    authoredStatus: "authored-needs-david-review",
  },
  celestial_object: {
    meaning:
      "A specific celestial body (planet, moon, star) is a load-bearing prop in the joke and must be clearly rendered in frame.",
    renderImpact: NO_PICTURE_IMPACT,
    example:
      '"The moon waves back at {NAME}" → a label only; the picture follows the gag\'s scene, so say it there if it should show.',
    sourceRefs: [TAXONOMY_CATALOG, WRITER_HASH],
    authoredStatus: "authored-needs-david-review",
  },
  subject_object_reversal: {
    meaning:
      "The joke inverts the normal actor/acted-on relationship — the object does to the subject what the subject would normally do to it.",
    renderImpact: "No effect on the picture any more. It used to add a failure-mode guard keeping the reversed roles legible; that guard was removed when pictures started being drawn straight from the gag (plan docs/plans/PLAN_GAG_DIRECT_RENDER.md). Make the object's action on the subject clear in the gag's scene.",
    example:
      '"The dumbbells ask {NAME} for a lighter set" → a label only; the picture follows the gag\'s scene, so say it there if it should show.',
    sourceRefs: [TAXONOMY_CATALOG, WRITER_HASH],
    authoredStatus: "code-derived",
  },
  normal_function_rendered_unnecessary: {
    meaning:
      "Redundant-mechanism jokes: the subject's impossible power accomplishes the result BEFORE an object/tool/weapon's normal mechanism is needed — the mechanism may still fire afterward, but comically redundantly. Explicitly NOT a temporal/causality inversion (the canonical example: \"threw a grenade and killed 50 people, then it exploded\").",
    renderImpact: NO_PICTURE_IMPACT +
      " (This modifier's main job is taxonomy: it marks the redundant-mechanism pattern so the fact is not misclassified as a temporal/causality inversion.)",
    example:
      '"{NAME} threw a grenade and killed 50 people, then it exploded" → a label only; the picture follows the gag\'s scene, so say it there if it should show.',
    sourceRefs: [
      WRITER_HASH,
      {
        path: "lib/api-zod/src/taxonomy.ts",
        symbol: "KNOWN_FACT_MODIFIERS",
        note: "The catalog's source comment defines the redundant-mechanism pattern this flag marks.",
      },
    ],
    authoredStatus: "code-derived",
  },
  projectile_impact_power: {
    meaning:
      "A thrown/launched object carries impossible force — the image needs visual evidence of that power (shockwave, trail, impact path).",
    renderImpact: VIOLENCE_RELEVANCE_IMPACT,
    example:
      '"{NAME}\'s paper airplane broke the sound barrier" → a label only; the picture follows the gag\'s scene, so say it there if it should show.',
    sourceRefs: [TAXONOMY_CATALOG, WRITER_HASH, VIOLENCE],
    authoredStatus: "code-derived",
  },
  brand_context: {
    meaning:
      "Context flag: the joke depends on a brand or company reference. Pairs with the culturalReferences brand_reference entries; brands are also on the adult-suitability incompatible list.",
    renderImpact: "No effect on the picture: nothing compiles it. It tells reviewers the joke leans on a brand. Real brand MARKS never render regardless: the always-on overlay-text exclusion bans logos and brand marks on every image.",
    example:
      '"A rental company sends {NAME} thank-you flowers" → a label only; the picture follows the gag\'s scene, so say it there if it should show.',
    sourceRefs: [TAXONOMY_CATALOG, WRITER_HASH, CLASSIFIER_CATALOG],
    authoredStatus: "authored-needs-david-review",
  },
  workplace_context: {
    meaning:
      "Context flag: the fact assumes workplace framing — bosses, HR, coworkers, office politics. Workplace context is also on the classifier's adult-incompatible list, so this doubles as a safety signal.",
    renderImpact: "No effect on the picture: nothing compiles it and the gag writer's message does not list it. Its more concrete role is taxonomy/adult-suitability context.",
    example:
      '"HR studies {NAME}\'s emails as literature" → a label only; the picture follows the gag\'s scene, so say it there if it should show.',
    sourceRefs: [TAXONOMY_CATALOG, WRITER_HASH, CLASSIFIER_CATALOG],
    authoredStatus: "authored-needs-david-review",
  },
  audience_inside_reference: {
    meaning:
      "Context flag: the joke's audience exists INSIDE the reference — the in-scene watchers/consumers belong to the referenced format or world (e.g. the sharks watching \"{NAME} Week\"), and the joke collapses if who-is-watching-whom gets lost.",
    renderImpact: NO_PICTURE_IMPACT,
    example:
      '"Sharks have a {NAME} Week" → a label only; the picture follows the gag\'s scene, so say it there if it should show.',
    sourceRefs: [TAXONOMY_CATALOG, WRITER_HASH],
    authoredStatus: "authored-needs-david-review",
  },
} satisfies Record<KnownFactModifier, ValueDoc>;

// ─── Custom (unknown, amber-chip) modifiers ──────────────────────────────────

/** Doc shown for any modifier value NOT in the known catalog. */
export const CUSTOM_MODIFIER_DOC: ValueDoc = {
  meaning:
    "A free-form modifier outside the known catalog (rendered as an amber chip). The classifier is only allowed to invent one when no known modifier captures an important rendering, discovery, identity, setting, or safety constraint — and admins can add their own. Legacy retired text/logo modifiers (no_readable_text, avoid_readable_ui, avoid_real_logos) may also appear here on old facts.",
  renderImpact:
    "No effect on the picture, by definition: no compiler directive exists for it and the gag writer's message does not list it. It is recorded on the fact and takes part in the gag writer's freshness check only; the retired text/logo names are filtered out of that check, so an old chip of that kind is inert display-only provenance.",
  example:
    'You add "sepia_flashback" (amber chip) → nothing draws it; put a sepia flashback in the gag\'s scene if you want one. A leftover "no_readable_text" chip does nothing at all.',
  sourceRefs: [
    {
      path: "lib/api-zod/src/taxonomy.ts",
      symbol: "isKnownModifier",
      note: "The known/custom split the amber chip reflects.",
    },
    {
      path: "lib/api-zod/src/taxonomy.ts",
      symbol: "RETIRED_TEXT_MODIFIERS",
      note: "The retired text/logo names that are filtered out of the gag writer's freshness check, so a legacy chip of that kind is inert.",
    },
  ],
  authoredStatus: "code-derived",
};
