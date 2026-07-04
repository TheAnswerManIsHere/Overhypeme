/**
 * Field docs — per-value docs for the known fact modifiers, plus the doc
 * shown for unknown (custom, amber-chip) modifiers.
 *
 * Pure data (see the purity invariant in ./types.ts): no React, no components.
 *
 * TWO-TIER MODEL. The modifier→prompt-prose injection channel was retired: the
 * compiler no longer pastes a fixed sentence per modifier into the final prompt.
 * So a modifier now does one of two things:
 *   - PLANNER CONTEXT (most modifiers): the token is serialized into the
 *     planner's TAXONOMY block, so the frontier planner reads it and it can shape
 *     the generated visual plan — but there is no deterministic compiler
 *     directive guaranteeing the effect. The planner (steered by the moderator's
 *     Visual concept) owns the scene.
 *   - STRUCTURAL COMPILER SIGNAL (a small set): age transforms drive SUBJECT
 *     BINDING; avoid_duplicate_subject drives the single-instance binding;
 *     action_comedy / cinematic_aftermath / projectile_impact_power mark the fact
 *     violence-relevant; crowd_reaction / clear_causal_relationship /
 *     subject_object_reversal drive conservative failure-mode guards. These reach
 *     the planner as context AND have a deterministic compiler effect.
 *
 * The retired text/brand suppression modifiers (no_readable_text,
 * avoid_readable_ui, avoid_real_logos) are no longer catalog values and have no
 * entry here — see RETIRED_TEXT_MODIFIERS in lib/api-zod/src/taxonomy.ts.
 */

import type { KnownFactModifier } from "@workspace/api-zod";
import type { ValueDoc, FieldDocSourceRef } from "./types";

// ─── Shared source refs ──────────────────────────────────────────────────────

const PLANNER_CONTEXT: FieldDocSourceRef = {
  path: "artifacts/api-server/src/lib/imagePrompt/generator.ts",
  symbol: "buildImagePromptContextBlocks",
  note: "Serialized into the planner's TAXONOMY block as context — it can shape the generated visual plan, but there is no deterministic compiler directive guaranteeing the effect.",
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
const SUBJECT_BINDING: FieldDocSourceRef = {
  path: "artifacts/api-server/src/lib/imagePrompt/compilers/nanoBanana2.ts",
  symbol: "composeSubjectBinding",
  note: "Age modifiers force the deterministic SUBJECT BINDING block (subject identity fused with the transformed life stage as ONE entity) plus anti-split strict constraints.",
};
const SINGLE_INSTANCE_BINDING: FieldDocSourceRef = {
  path: "artifacts/api-server/src/lib/imagePrompt/compilers/nanoBanana2.ts",
  symbol: "composeSubjectBinding",
  note: "avoid_duplicate_subject triggers the single-instance SUBJECT BINDING and the no-clone anti-split constraint even without an age transform.",
};
const VIOLENCE_RELEVANCE: FieldDocSourceRef = {
  path: "artifacts/api-server/src/lib/imagePrompt/compilers/nanoBanana2.ts",
  symbol: "isViolenceRelevant",
  note: "Listed in VIOLENCE_RELEVANT_MODIFIERS — presence marks the fact violence-relevant, which permits the default violence-allow line under the 'allow' policy.",
};
const FAILURE_MODES: FieldDocSourceRef = {
  path: "artifacts/api-server/src/lib/imagePrompt/compilers/failureModeConstraints.ts",
  symbol: "failureModeConstraints",
  note: "Drives a conservative negative 'do not / keep' guard pack in STRICT CONSTRAINTS for this modifier's role/action shape.",
};

/** The standard render-impact line for a planner-context-only modifier. */
const PLANNER_ONLY_IMPACT =
  "No deterministic compiler directive — the modifier is serialized into the planner's TAXONOMY block as context, so it can shape the generated visual plan but the effect isn't guaranteed. The frontier planner, steered by the moderator's Visual concept, owns the scene; treat this as a soft hint and check the test render.";

/** The render-impact shared by the three violence-relevance modifiers. */
const VIOLENCE_RELEVANCE_IMPACT =
  "The staging idea reaches the planner as TAXONOMY context (no deterministic staging directive). Its firm effect is that it marks the fact violence-relevant: under the default \"allow\" violence policy the compiler emits the permission line \"When the fact explicitly requires violence, death, weapons, or destruction, depict the action and consequences clearly without gratuitous gore.\" (an explicit moderator soften/suppress override still wins).";

/** The render-impact shared by the age/life-stage transform modifiers. */
const AGE_BINDING_IMPACT =
  "Drives the compiler's deterministic SUBJECT BINDING section, which fuses the subject identity with the transformed life stage as ONE entity — human-identity renders get \"The transformed X IS {subject} — the same person de-aged or aged, not a second person.\"; non-human and t2i renders get equivalent single-entity life-stage wording — plus anti-split strict constraints (no separate generic baby/elder, no original-age copy left in frame). This is the SOLE compiled owner of age transforms; the modifier also reaches the planner as TAXONOMY context.";

// ─── Unmapped-setting helper ─────────────────────────────────────────────────

/** ValueDoc for a pure setting/location flag — honestly advisory-only. */
function settingDoc(place: string, meaning: string, example: string): ValueDoc {
  return {
    meaning,
    renderImpact: `No fixed compiler directive: setting/location flags are passed to the AI prompt planner as taxonomy context only, and the authored archetype strategy plus the planned scene largely determine the environment. Treat this as informing, not guaranteeing, the ${place} setting.`,
    example,
    sourceRefs: [TAXONOMY_CATALOG, PLANNER_CONTEXT],
    authoredStatus: "authored-needs-david-review",
  };
}

// ─── The known-modifier docs (one per KNOWN_FACT_MODIFIERS entry) ────────────

export const KNOWN_MODIFIER_DOCS = {
  single_subject_focus: {
    meaning:
      "Composition flag: the image should center on the subject alone, with no competing characters sharing the spotlight.",
    renderImpact:
      "No fixed compiler directive, so no guaranteed effect — but it IS passed to the AI planner as taxonomy context and can nudge the composition toward a solo subject; the archetype strategy and scene still decide the actual framing. (Contrast avoid_duplicate_subject, which DOES have a structural compiler effect.)",
    example:
      '"{NAME} is the gym\'s entire membership" → nudges the planner to keep the frame centered on the subject alone; not a guaranteed rule.',
    sourceRefs: [TAXONOMY_CATALOG, PLANNER_CONTEXT],
    authoredStatus: "authored-needs-david-review",
  },
  identity_strict: {
    meaning:
      "Identity-policy flag: the subject's recognizable likeness should be preserved strictly — the joke fails if the rendered person doesn't clearly read as the reference photo's person.",
    renderImpact:
      "No compiler directive or identity policy keys off this flag, so it has no guaranteed effect — actual likeness preservation is owned by the subject render mode and the SUBJECT BINDING machinery. It is still passed to the AI planner as taxonomy context (a soft hint that likeness matters), but nothing enforces it.",
    example:
      '"{NAME} was recognized from space" → signals strict likeness matters, but today the likeness guarantee comes from the render mode, not this flag.',
    sourceRefs: [TAXONOMY_CATALOG, CLASSIFIER_CATALOG],
    authoredStatus: "authored-needs-david-review",
  },
  identity_essence_only: {
    meaning:
      "Identity-policy flag: strict likeness may be relaxed — the render only needs to carry the subject's essence (build, hair, vibe), e.g. through a heavy transformation or symbolic treatment.",
    renderImpact:
      "Like identity_strict, no compiler directive or identity policy branches on it, so no guaranteed effect. It still reaches the AI planner as taxonomy context (a soft hint that the likeness may be relaxed), but nothing enforces it.",
    example:
      '"{NAME} turned into pure motivation" → signals the render may keep only the subject\'s essence through the transformation; nothing in the compiler enforces it.',
    sourceRefs: [TAXONOMY_CATALOG, CLASSIFIER_CATALOG],
    authoredStatus: "authored-needs-david-review",
  },
  face_prominent: {
    meaning:
      "Framing flag: the joke depends on the subject's face and expression reading clearly, so the face must be framed large and unobstructed.",
    renderImpact: PLANNER_ONLY_IMPACT,
    example:
      '"{NAME}\'s wink restarted the power grid" → nudges the planner toward prominent, clear face framing so the expression can carry the joke.',
    sourceRefs: [TAXONOMY_CATALOG, PLANNER_CONTEXT],
    authoredStatus: "authored-needs-david-review",
  },
  full_body_needed: {
    meaning:
      "Framing flag: the joke needs the whole body visible (a pose, a feat, a stance) — a chest-up crop would lose it.",
    renderImpact: PLANNER_ONLY_IMPACT,
    example:
      '"{NAME} deadlifts a city bus" → nudges the planner toward full-body framing so the stance and lift read.',
    sourceRefs: [TAXONOMY_CATALOG, PLANNER_CONTEXT],
    authoredStatus: "authored-needs-david-review",
  },
  age_transform: {
    meaning:
      "The fact requires the subject rendered at a different age or life stage than the reference photo — the generic form of the baby/older variants below.",
    renderImpact: AGE_BINDING_IMPACT,
    example:
      '"{NAME} was born flexing" → the subject is rendered at the fact\'s implied age — the same person, with no original-age copy left in frame.',
    sourceRefs: [SUBJECT_BINDING, PLANNER_CONTEXT],
    authoredStatus: "code-derived",
  },
  baby_child_version: {
    meaning:
      "The fact describes the subject as a baby or young child — the reference person must be de-aged, not accompanied by a random infant.",
    renderImpact: AGE_BINDING_IMPACT,
    example:
      '"{NAME} as a baby negotiated their own bedtime" → the reference adult is de-aged into the baby; no separate generic baby, no adult left in frame.',
    sourceRefs: [SUBJECT_BINDING, PLANNER_CONTEXT],
    authoredStatus: "code-derived",
  },
  infant_version: {
    meaning:
      "A finer-grained age stage than baby_child_version: the fact needs the subject rendered specifically as a newborn/infant. The compiler renders it distinctly; the classifier's suggestion catalog doesn't list it, so it's typically moderator-added.",
    renderImpact: AGE_BINDING_IMPACT,
    example:
      '"{NAME} filed taxes from the womb" → the reference subject is de-aged to a newborn/infant; no separate generic baby, no adult left in frame.',
    sourceRefs: [SUBJECT_BINDING, PLANNER_CONTEXT],
    authoredStatus: "code-derived",
  },
  child_version: {
    meaning:
      "A finer-grained age stage than baby_child_version: the fact needs the subject rendered specifically as a young child (past infancy). The compiler renders it distinctly; the classifier's suggestion catalog doesn't list it, so it's typically moderator-added.",
    renderImpact: AGE_BINDING_IMPACT,
    example:
      '"{NAME} won a Nobel Prize in third grade" → the reference subject de-aged to a young child; no separate generic child, no adult left in frame.',
    sourceRefs: [SUBJECT_BINDING, PLANNER_CONTEXT],
    authoredStatus: "code-derived",
  },
  older_self_version: {
    meaning:
      "The fact describes the subject as a much older version of themselves — the same person aged, not an unrelated elderly extra.",
    renderImpact: AGE_BINDING_IMPACT,
    example:
      '"At 90, {NAME} still outruns ambulances" → the reference subject rendered elderly — same face aged, not a random senior beside a young {NAME}.',
    sourceRefs: [SUBJECT_BINDING, PLANNER_CONTEXT],
    authoredStatus: "code-derived",
  },
  grounded_realism: {
    meaning:
      "Staging flag: keep physics and rendering realistic — the impossibility should live in what's happening (roles, outcomes), not in cartoon physics or surreal style.",
    renderImpact:
      "No fixed compiler directive, so no guaranteed effect — but it reaches the AI planner as taxonomy context and reinforces what a grounded_roleplay literalness rating already tells the planner; the authored strategy and scene prose do the real steering.",
    example:
      '"A baby drove {NAME}\'s mother home" → nudges the planner toward a realistic car interior with the impossibility in who\'s driving.',
    sourceRefs: [TAXONOMY_CATALOG, PLANNER_CONTEXT],
    authoredStatus: "authored-needs-david-review",
  },
  mock_heroic: {
    meaning:
      "The comedy comes from treating something trivial with epic gravitas — the subject should be staged like a monument to a mundane act.",
    renderImpact: PLANNER_ONLY_IMPACT,
    example:
      '"{NAME} plugged in a USB right on the first try" → nudges the planner to stage the trivial act with an exaggerated heroic pose, cape-in-the-wind energy.',
    sourceRefs: [TAXONOMY_CATALOG, PLANNER_CONTEXT],
    authoredStatus: "authored-needs-david-review",
  },
  action_comedy: {
    meaning:
      "The fact is an action joke — energetic, slapstick, physical comedy staging suits it better than solemn cinematics.",
    renderImpact: VIOLENCE_RELEVANCE_IMPACT,
    example:
      '"{NAME} fought the office printer and won" → the slapstick staging is a planner hint; the fact is also treated as violence-relevant so the action can be depicted clearly.',
    sourceRefs: [VIOLENCE_RELEVANCE, PLANNER_CONTEXT],
    authoredStatus: "code-derived",
  },
  cinematic_aftermath: {
    meaning:
      "The funniest frame is AFTER the action — the crater, the dust, the stunned onlookers — rather than the action itself.",
    renderImpact: VIOLENCE_RELEVANCE_IMPACT,
    example:
      '"{NAME} high-fived a mountain" → the aftermath staging (crater, settling dust, awed onlookers) is a planner hint; the fact is also marked violence-relevant.',
    sourceRefs: [VIOLENCE_RELEVANCE, PLANNER_CONTEXT],
    authoredStatus: "code-derived",
  },
  symbolic_abstraction_required: {
    meaning:
      "The fact cannot be shown literally at all — it demands symbolic visual language (the modifier-flag counterpart of the symbolic_abstraction literalness rating).",
    renderImpact: PLANNER_ONLY_IMPACT,
    example:
      '"{NAME} counted to infinity. Twice." → nudges the planner toward symbolic rendering — endless number-scapes, not a person mouthing numbers.',
    sourceRefs: [TAXONOMY_CATALOG, PLANNER_CONTEXT],
    authoredStatus: "authored-needs-david-review",
  },
  metaphorical_visualization: {
    meaning:
      "The joke should land as one concrete visual metaphor — a phrase made physically true in the image (the modifier-flag counterpart of the same-named literalness rating).",
    renderImpact: PLANNER_ONLY_IMPACT,
    example:
      '"{NAME}\'s handshake seals deals" → nudges the planner toward one clear metaphor (a literal wax seal pressed by a handshake).',
    sourceRefs: [TAXONOMY_CATALOG, PLANNER_CONTEXT],
    authoredStatus: "authored-needs-david-review",
  },
  clear_causal_relationship: {
    meaning:
      "The joke is a cause→effect gag, and it only lands if the viewer instantly sees which action caused which consequence.",
    renderImpact:
      "Drives a conservative failure-mode guard in STRICT CONSTRAINTS via failureModeConstraints (\"Show the cause and its effect together in the frame so the causal link is legible, not an unrelated aftermath.\"). The staging idea also reaches the planner as TAXONOMY context; there is no positive prose directive.",
    example:
      '"{NAME} clapped and the thunder answered" → the compiler guards that clap and thundercrack read as cause-and-effect, not an unrelated aftermath.',
    sourceRefs: [FAILURE_MODES, PLANNER_CONTEXT],
    authoredStatus: "code-derived",
  },
  crowd_reaction: {
    meaning:
      "Witnesses are part of the joke — the scene needs a visible crowd whose reaction sells how impressive the subject is.",
    renderImpact:
      "Drives a conservative crowd focus/relationship guard pack in STRICT CONSTRAINTS via failureModeConstraints (keeping the crowd a reacting background, not competing with the subject). The 'include a crowd' idea itself reaches the planner as TAXONOMY context; there is no positive prose directive.",
    example:
      '"{NAME} parallel-parked on the first attempt" → the planner may add a gasping crowd; the compiler guards keep them a reacting background, not co-stars.',
    sourceRefs: [FAILURE_MODES, PLANNER_CONTEXT],
    authoredStatus: "code-derived",
  },
  environmental_reaction: {
    meaning:
      "The environment itself should visibly respond to the subject — nature, buildings, or weather reacting is the punchline's proof.",
    renderImpact: PLANNER_ONLY_IMPACT,
    example:
      '"{NAME} whispered and the forest leaned in" → nudges the planner toward trees bending toward the subject; the environment as reacting witness.',
    sourceRefs: [TAXONOMY_CATALOG, PLANNER_CONTEXT],
    authoredStatus: "authored-needs-david-review",
  },
  object_transformation: {
    meaning:
      "An object changes state because of the subject, and the change itself must be legible — best shown mid-transformation.",
    renderImpact: PLANNER_ONLY_IMPACT,
    example:
      '"{NAME} stared at coal until it became a diamond" → nudges the planner to show the coal mid-morph into diamond so the change is legible.',
    sourceRefs: [TAXONOMY_CATALOG, PLANNER_CONTEXT],
    authoredStatus: "authored-needs-david-review",
  },
  technology_reaction: {
    meaning:
      "Devices and machines visibly respond to the subject — screens, routers, robots reacting is the gag's evidence.",
    renderImpact: PLANNER_ONLY_IMPACT,
    example:
      '"WiFi gets stronger when {NAME} walks by" → nudges the planner toward routers and phones visibly lighting up in response.',
    sourceRefs: [TAXONOMY_CATALOG, PLANNER_CONTEXT],
    authoredStatus: "authored-needs-david-review",
  },
  official_setting: settingDoc(
    "formal/ceremonial",
    "Setting flag: the fact implies a formal, official, or ceremonial venue — a swearing-in, a podium, a state occasion.",
    '"{NAME} was sworn in as everyone\'s emergency contact" → suggests a ceremonial venue to the planner; the authored strategy still writes the scene.',
  ),
  professional_context: {
    meaning:
      "Context flag: the fact lives in a professional/expert domain (consultants, doctors, engineers at work). Also an adult-suitability signal — professional contexts are on the classifier's adult-incompatible list.",
    renderImpact:
      "No fixed compiler directive — passed to the AI prompt planner as taxonomy context only; the authored strategy and scene decide the actual staging. Its firmer role is taxonomy/safety context (adult-suitability review), not the compiled prompt.",
    example:
      '"{NAME} closed the deal by nodding" → hints at a professional environment; also the kind of context that keeps adult mode off the table.',
    sourceRefs: [TAXONOMY_CATALOG, PLANNER_CONTEXT, CLASSIFIER_CATALOG],
    authoredStatus: "authored-needs-david-review",
  },
  domestic_setting: settingDoc(
    "home/domestic",
    "Setting flag: the fact plays out at home — kitchens, living rooms, household life.",
    '"{NAME}\'s houseplants water themselves out of respect" → suggests a home interior to the planner; informative, not enforced.',
  ),
  office_setting: settingDoc(
    "office",
    "Setting flag: the fact plays out in an office — desks, meetings, office equipment.",
    '"The office printer works only for {NAME}" → hints office context; the scene prose decides the actual set dressing.',
  ),
  school_setting: settingDoc(
    "school",
    "Setting flag: the fact involves school — classrooms, teachers, hallways. (School context also makes the fact adult-incompatible per the adult-suitability rules.)",
    '"Teachers ask {NAME} for hall passes" → suggests a school scene; separately, school context blocks adult mode.',
  ),
  hospital_setting: settingDoc(
    "hospital/medical",
    "Setting flag: the fact involves a hospital or medical environment. (Medical vulnerability is also on the adult-incompatible list.)",
    '"Doctors check {NAME}\'s pulse to calibrate their watches" → suggests a medical scene to the planner; nothing is compiled from the flag itself.',
  ),
  courtroom_setting: settingDoc(
    "courtroom",
    "Setting flag: the fact stages a courtroom — judges, benches, gavels, legal theater.",
    '"{NAME} was called as an expert witness on being impressive" → courtroom staging suggested; the archetype strategy still owns the scene.',
  ),
  airport_setting: settingDoc(
    "airport",
    "Setting flag: the fact plays out in an airport — terminals, security, gates.",
    '"TSA waves {NAME} through with applause" → airport context hinted to the planner; not a compiled constraint.',
  ),
  gym_setting: settingDoc(
    "gym",
    "Setting flag: the fact lives in a gym — weights, racks, mirrors, workout culture.",
    '"The gym renamed leg day after {NAME}" → gym environment suggested; the planned scene determines what actually appears.',
  ),
  bar_setting: settingDoc(
    "bar",
    "Setting flag: the fact plays out in a bar or pub environment.",
    '"Bartenders tip {NAME}" → bar context hinted; advisory to the planner only.',
  ),
  battlefield_setting: settingDoc(
    "battlefield",
    "Setting flag: the fact stages combat-scale territory — battlefields, war-movie scenery. (Violence permission is separate: it comes from the violence policy and the violence-relevance modifiers, not this flag.)",
    '"{NAME} won the battle by showing up" → battlefield scenery hinted; whether violence is depicted is governed elsewhere.',
  ),
  technology_setting: settingDoc(
    "tech/data-center",
    "Setting flag: the fact lives among technology — server rooms, labs, screens, gadgets.",
    '"Servers cool down when {NAME} logs on" → data-center environment suggested to the planner; informative only.',
  ),
  underwater_setting: settingDoc(
    "underwater",
    "Setting flag: the scene is underwater — ocean depths, marine life.",
    '"Sharks have a {NAME} Week" → underwater staging hinted; the archetype strategy still writes the actual scene.',
  ),
  space_setting: settingDoc(
    "outer-space",
    "Setting flag: the scene is in space — orbit, spacecraft, cosmic backdrops.",
    '"{NAME} waved at the ISS and it waved back" → space backdrop suggested; not a compiled directive (contrast celestial_object, a load-bearing prop the planner is told to render).',
  ),
  outdoor_nature_setting: settingDoc(
    "outdoor/nature",
    "Setting flag: the fact plays out in nature — mountains, forests, open landscapes.",
    '"Mountains adjust their height for {NAME}\'s photos" → outdoor nature scenery hinted to the planner.',
  ),
  city_setting: settingDoc(
    "urban/city",
    "Setting flag: the fact lives in an urban environment — streets, skylines, traffic.",
    '"Traffic lights turn green when {NAME} approaches" → city-street staging suggested; advisory only.',
  ),
  avoid_weapons_focus: {
    meaning:
      "Presentation constraint (not moderation): a weapon may appear if the fact requires it, but it must not be the visual centerpiece of the scene.",
    renderImpact: PLANNER_ONLY_IMPACT,
    example:
      '"{NAME} caught the arrow mid-flight" → nudges the planner to keep the catch the focal point and the weapon incidental, not glorified.',
    sourceRefs: [TAXONOMY_CATALOG, PLANNER_CONTEXT],
    authoredStatus: "authored-needs-david-review",
  },
  avoid_gross_literalization: {
    meaning:
      "Taste constraint: a literal rendering of the fact would be gross or off-putting — the idea should be staged tastefully instead.",
    renderImpact: PLANNER_ONLY_IMPACT,
    example:
      '"{NAME} sweats pure espresso" → nudges the planner toward tasteful coffee-steam staging rather than a literally dripping render.',
    sourceRefs: [TAXONOMY_CATALOG, PLANNER_CONTEXT],
    authoredStatus: "authored-needs-david-review",
  },
  avoid_extra_faces: {
    meaning:
      "Focus constraint: background faces dilute the subject and risk identity confusion — keep other faces minimal so the subject stays the one clear face.",
    renderImpact: PLANNER_ONLY_IMPACT,
    example:
      '"{NAME} won the marathon running backwards" → nudges the planner to de-emphasize background runners so the subject is the clear face.',
    sourceRefs: [TAXONOMY_CATALOG, PLANNER_CONTEXT],
    authoredStatus: "authored-needs-david-review",
  },
  avoid_duplicate_subject: {
    meaning:
      "Anti-clone constraint: image models love to render the reference person twice — this flag pins the subject to exactly one instance.",
    renderImpact:
      'Triggers the compiler\'s single-instance SUBJECT BINDING ("Render exactly one {subject} — a single instance.") and the anti-split strict constraint ("Do not duplicate, clone, or mirror {subject} anywhere in the frame.") even when no age transform applies. This is a structural compiler effect; the modifier also reaches the planner as TAXONOMY context.',
    example:
      '"{NAME} raced their own shadow" → exactly one {NAME} in frame; the shadow is a shadow, not a second copy of the person.',
    sourceRefs: [SINGLE_INSTANCE_BINDING, PLANNER_CONTEXT],
    authoredStatus: "code-derived",
  },
  astronomical_consequence: {
    meaning:
      "The fact's consequence is planetary/cosmic scale — the image must stage that scale, not shrink it to a local effect.",
    renderImpact: PLANNER_ONLY_IMPACT,
    example:
      '"{NAME} sneezed and the moon left orbit" → nudges the planner to stage the departing moon huge and dramatic, not a dot in the sky.',
    sourceRefs: [TAXONOMY_CATALOG, PLANNER_CONTEXT],
    authoredStatus: "authored-needs-david-review",
  },
  celestial_object: {
    meaning:
      "A specific celestial body (planet, moon, star) is a load-bearing prop in the joke and must be clearly rendered in frame.",
    renderImpact: PLANNER_ONLY_IMPACT,
    example:
      '"The moon waves back at {NAME}" → nudges the planner toward a clearly rendered moon in frame, not just a vague night sky.',
    sourceRefs: [TAXONOMY_CATALOG, PLANNER_CONTEXT],
    authoredStatus: "authored-needs-david-review",
  },
  subject_object_reversal: {
    meaning:
      "The joke inverts the normal actor/acted-on relationship — the object does to the subject what the subject would normally do to it.",
    renderImpact:
      "Drives a conservative failure-mode guard in STRICT CONSTRAINTS via failureModeConstraints (keeping the reversed roles legible so the object clearly acts on the subject). The reversal idea also reaches the planner as TAXONOMY context; there is no positive prose directive.",
    example:
      '"The dumbbells ask {NAME} for a lighter set" → the compiler guards that the equipment clearly reads as the one acting toward the subject.',
    sourceRefs: [FAILURE_MODES, PLANNER_CONTEXT],
    authoredStatus: "code-derived",
  },
  normal_function_rendered_unnecessary: {
    meaning:
      "Redundant-mechanism jokes: the subject's impossible power accomplishes the result BEFORE an object/tool/weapon's normal mechanism is needed — the mechanism may still fire afterward, but comically redundantly. Explicitly NOT a temporal/causality inversion (the canonical example: \"threw a grenade and killed 50 people, then it exploded\").",
    renderImpact:
      PLANNER_ONLY_IMPACT +
      " (This modifier's main job is taxonomy: it marks the redundant-mechanism pattern so the fact is not misclassified as a temporal/causality inversion.)",
    example:
      '"{NAME} threw a grenade and killed 50 people, then it exploded" → the planner should stage the throw as the devastating force and keep the grenade\'s own explosion visibly late and redundant.',
    sourceRefs: [
      PLANNER_CONTEXT,
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
      '"{NAME}\'s paper airplane broke the sound barrier" → the shockwave/motion-trail idea is a planner hint; the fact is also marked violence-relevant.',
    sourceRefs: [VIOLENCE_RELEVANCE, PLANNER_CONTEXT],
    authoredStatus: "code-derived",
  },
  brand_context: {
    meaning:
      "Context flag: the joke depends on a brand or company reference. Pairs with the culturalReferences brand_reference entries; brands are also on the adult-suitability incompatible list.",
    renderImpact:
      "No fixed compiler directive — taxonomy context for the planner only; it tells downstream consumers the joke leans on a brand. Real brand MARKS never render regardless: the always-on overlay-text exclusion bans logos and brand marks on every image.",
    example:
      '"A rental company sends {NAME} thank-you flowers" → flags the brand dependency for the planner and reviewers; brand marks are already banned platform-wide.',
    sourceRefs: [TAXONOMY_CATALOG, PLANNER_CONTEXT, CLASSIFIER_CATALOG],
    authoredStatus: "authored-needs-david-review",
  },
  workplace_context: {
    meaning:
      "Context flag: the fact assumes workplace framing — bosses, HR, coworkers, office politics. Workplace context is also on the classifier's adult-incompatible list, so this doubles as a safety signal.",
    renderImpact:
      "No fixed compiler directive — the token reaches the AI prompt planner as taxonomy context only; the authored strategy and scene own the staging. Its more concrete role is taxonomy/adult-suitability context, not the compiled prompt.",
    example:
      '"HR studies {NAME}\'s emails as literature" → workplace framing flagged for the planner and for adult-suitability review; nothing is compiled from it.',
    sourceRefs: [TAXONOMY_CATALOG, PLANNER_CONTEXT, CLASSIFIER_CATALOG],
    authoredStatus: "authored-needs-david-review",
  },
  audience_inside_reference: {
    meaning:
      "Context flag: the joke's audience exists INSIDE the reference — the in-scene watchers/consumers belong to the referenced format or world (e.g. the sharks watching \"{NAME} Week\"), and the joke collapses if who-is-watching-whom gets lost.",
    renderImpact:
      "No fixed compiler directive — planner context only, alerting the scene-writing AI to preserve the audience inversion; the authored strategy and the planned scene determine whether it actually survives into the prompt.",
    example:
      '"Sharks have a {NAME} Week" → the sharks ARE the audience; this flag tells the planner not to flatten that into people watching sharks.',
    sourceRefs: [TAXONOMY_CATALOG, PLANNER_CONTEXT],
    authoredStatus: "authored-needs-david-review",
  },
} satisfies Record<KnownFactModifier, ValueDoc>;

// ─── Custom (unknown, amber-chip) modifiers ──────────────────────────────────

/** Doc shown for any modifier value NOT in the known catalog. */
export const CUSTOM_MODIFIER_DOC: ValueDoc = {
  meaning:
    "A free-form modifier outside the known catalog (rendered as an amber chip). The classifier is only allowed to invent one when no known modifier captures an important rendering, discovery, identity, setting, or safety constraint — and admins can add their own. Legacy retired text/logo modifiers (no_readable_text, avoid_readable_ui, avoid_real_logos) may also appear here on old facts.",
  renderImpact:
    "No compiler directive exists for it, by definition. Most custom modifiers still reach the AI prompt planner as raw taxonomy context, so the effect depends on the AI's interpretation — check the test render rather than assuming. Exception: the retired text/logo names are deliberately filtered OUT of planner context and the render-scenario hash, so an old chip of that kind is inert display-only provenance.",
  example:
    'You add "sepia_flashback" (amber chip) → the planner sees the token as context and may or may not honor it — check the test render. A leftover "no_readable_text" chip does nothing at all.',
  sourceRefs: [
    {
      path: "lib/api-zod/src/taxonomy.ts",
      symbol: "isKnownModifier",
      note: "The known/custom split the amber chip reflects.",
    },
    {
      path: "lib/api-zod/src/taxonomy.ts",
      symbol: "RETIRED_TEXT_MODIFIERS",
      note: "The retired text/logo names that are filtered out of planner context and the render-scenario hash, so a legacy chip of that kind is inert.",
    },
  ],
  authoredStatus: "code-derived",
};
