/**
 * Field docs — per-value docs for the known fact modifiers, plus the doc
 * shown for unknown (custom, amber-chip) modifiers.
 *
 * Pure data (see the purity invariant in ./types.ts): no React, no components.
 * Directive quotes are copied VERBATIM from `modifierDirectives()` in
 * artifacts/api-server/src/lib/imagePrompt/modifierDirectives.ts — if that file
 * changes, these quotes must change with it. Modifiers with no entry there are
 * deliberately unmapped (pure setting/location flags and taxonomy-only signals).
 * "Unmapped" does NOT mean inert: every modifier is still serialized into the
 * planner's TAXONOMY block, so the AI reads it and it can shape the generated
 * visual plan — there just isn't a fixed compiler directive guaranteeing the
 * effect. So the split is "hard, deterministic directive" (mapped) vs. "soft AI
 * hint" (unmapped), not "does something" vs. "does nothing."
 *
 * Note the compiler de-dupes injected directives against the assembled prompt
 * prose (composeModifierDirective), so a quoted sentence may be dropped when the
 * AI plan already says the same thing — the CONSTRAINT still holds either way.
 */

import type { KnownFactModifier } from "@workspace/api-zod";
import type { ValueDoc, FieldDocSourceRef } from "./types";

// ─── Shared source refs ──────────────────────────────────────────────────────

const DIRECTIVES: FieldDocSourceRef = {
  path: "artifacts/api-server/src/lib/imagePrompt/modifierDirectives.ts",
  symbol: "modifierDirectives",
  note: "Literal directive quoted.",
};
const DIRECTIVES_SKIP: FieldDocSourceRef = {
  path: "artifacts/api-server/src/lib/imagePrompt/modifierDirectives.ts",
  symbol: "modifierDirectives",
  note: "Deliberately unmapped — the file's header comment skips pure setting/location flags and taxonomy-only signals; the authored strategy + scene already cover them.",
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
  note: "Age modifiers force the deterministic SUBJECT BINDING block (reference identity fused with the transformed life stage as ONE entity) plus anti-split strict constraints.",
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

/** The extra sentence shared by the three violence-relevance modifiers. */
const VIOLENCE_EXTRA =
  " Additionally marks the fact violence-relevant: under the default \"allow\" violence policy the compiler emits the permission line \"When the fact explicitly requires violence, death, weapons, or destruction, depict the action and consequences clearly without gratuitous gore.\" (an explicit moderator soften/suppress override still wins).";

/** The extra sentence shared by the age/life-stage transform modifiers. */
const AGE_BINDING_EXTRA =
  " Additionally forces the compiler's deterministic SUBJECT BINDING section, which fuses the reference identity with the transformed life stage as ONE entity (\"The transformed X IS {subject} — the same person de-aged or aged, not a second person.\") plus anti-split strict constraints (no separate generic baby/elder, no original-age copy left in frame). Applies to human-identity i2i renders.";

// ─── Unmapped-setting helper ─────────────────────────────────────────────────

/** ValueDoc for a pure setting/location flag — honestly advisory-only. */
function settingDoc(place: string, meaning: string, example: string): ValueDoc {
  return {
    meaning,
    renderImpact: `No fixed compiler directive — deliberately unmapped: setting/location flags are passed to the AI prompt planner as taxonomy context only, and the authored archetype strategy plus the planned scene largely determine the environment. Treat this as informing, not guaranteeing, the ${place} setting.`,
    example,
    sourceRefs: [TAXONOMY_CATALOG, DIRECTIVES_SKIP],
    authoredStatus: "authored-needs-david-review",
  };
}

// ─── The known-modifier docs (one per KNOWN_FACT_MODIFIERS entry) ────────────

export const KNOWN_MODIFIER_DOCS = {
  single_subject_focus: {
    meaning:
      "Composition flag: the image should center on the subject alone, with no competing characters sharing the spotlight.",
    renderImpact:
      "No fixed compiler directive, so no guaranteed effect — but it IS passed to the AI planner as taxonomy context and can nudge the composition toward a solo subject; the archetype strategy and scene still decide the actual framing. (Contrast avoid_extra_faces and avoid_duplicate_subject, which DO compile to directives.)",
    example:
      '"{NAME} is the gym\'s entire membership" → nudges the planner to keep the frame centered on the subject alone; not a guaranteed rule.',
    sourceRefs: [TAXONOMY_CATALOG, DIRECTIVES_SKIP],
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
    renderImpact: 'Injects: "Frame the subject\'s face prominently and clearly."',
    example:
      '"{NAME}\'s wink restarted the power grid" → the compiled prompt orders prominent, clear face framing so the expression carries the joke.',
    sourceRefs: [DIRECTIVES],
    authoredStatus: "code-derived",
  },
  full_body_needed: {
    meaning:
      "Framing flag: the joke needs the whole body visible (a pose, a feat, a stance) — a chest-up crop would lose it.",
    renderImpact: 'Injects: "Show the subject\'s full body within the frame."',
    example:
      '"{NAME} deadlifts a city bus" → full-body framing so the stance and lift read; no waist-up crop.',
    sourceRefs: [DIRECTIVES],
    authoredStatus: "code-derived",
  },
  age_transform: {
    meaning:
      "The fact requires the subject rendered at a different age or life stage than the reference photo — the generic form of the baby/older variants below.",
    renderImpact:
      'Injects: "Transform the reference subject\'s apparent age and life stage to match the fact — the same person rendered at that age. Do not add a separate person for the transformed age, and do not keep the original-age version in the frame."' +
      AGE_BINDING_EXTRA,
    example:
      '"{NAME} was born flexing" → the subject is rendered at the fact\'s implied age — the same person, with no original-age copy left in frame.',
    sourceRefs: [DIRECTIVES, SUBJECT_BINDING],
    authoredStatus: "code-derived",
  },
  baby_child_version: {
    meaning:
      "The fact describes the subject as a baby or young child — the reference person must be de-aged, not accompanied by a random infant.",
    renderImpact:
      'Injects: "De-age the reference subject into the baby/child the fact describes — the same person rendered at that life stage, with infant/child proportions, skin, and hair. Do not add a separate, generic baby or child, and do not keep an adult version in the frame."' +
      AGE_BINDING_EXTRA,
    example:
      '"{NAME} as a baby negotiated their own bedtime" → the reference adult is de-aged into the baby; no separate generic baby, no adult left in frame.',
    sourceRefs: [DIRECTIVES, SUBJECT_BINDING],
    authoredStatus: "code-derived",
  },
  infant_version: {
    meaning:
      "A finer-grained age stage than baby_child_version: the fact needs the subject rendered specifically as a newborn/infant. The compiler renders it distinctly; the classifier's suggestion catalog doesn't list it, so it's typically moderator-added.",
    renderImpact:
      'Injects: "De-age the reference subject into an infant — the same person rendered as a baby, with newborn/infant proportions and features. Do not add a separate, generic baby, and do not keep an adult version in the frame."' +
      AGE_BINDING_EXTRA,
    example:
      '"{NAME} filed taxes from the womb" → the reference subject is de-aged to a newborn/infant; no separate generic baby, no adult left in frame.',
    sourceRefs: [DIRECTIVES, SUBJECT_BINDING],
    authoredStatus: "code-derived",
  },
  child_version: {
    meaning:
      "A finer-grained age stage than baby_child_version: the fact needs the subject rendered specifically as a young child (past infancy). The compiler renders it distinctly; the classifier's suggestion catalog doesn't list it, so it's typically moderator-added.",
    renderImpact:
      'Injects: "Render the reference subject as the young child the fact describes — the same person de-aged to childhood, with child proportions and features. Do not add a separate, generic child, and do not keep an adult version in the frame."' +
      AGE_BINDING_EXTRA,
    example:
      '"{NAME} won a Nobel Prize in third grade" → the reference subject de-aged to a young child; no separate generic child, no adult left in frame.',
    sourceRefs: [DIRECTIVES, SUBJECT_BINDING],
    authoredStatus: "code-derived",
  },
  older_self_version: {
    meaning:
      "The fact describes the subject as a much older version of themselves — the same person aged, not an unrelated elderly extra.",
    renderImpact:
      'Injects: "Age the reference subject into the much older version the fact describes — the same person with aged skin, greyed/thinned hair, and elderly posture. Do not add a separate, generic elderly person, and do not keep a young version in the frame."' +
      AGE_BINDING_EXTRA,
    example:
      '"At 90, {NAME} still outruns ambulances" → the reference subject rendered elderly — same face aged, not a random senior beside a young {NAME}.',
    sourceRefs: [DIRECTIVES, SUBJECT_BINDING],
    authoredStatus: "code-derived",
  },
  grounded_realism: {
    meaning:
      "Staging flag: keep physics and rendering realistic — the impossibility should live in what's happening (roles, outcomes), not in cartoon physics or surreal style.",
    renderImpact:
      "No fixed compiler directive, so no guaranteed effect — but it reaches the AI planner as taxonomy context and reinforces what a grounded_roleplay literalness rating already tells the planner; the authored strategy and scene prose do the real steering.",
    example:
      '"A baby drove {NAME}\'s mother home" → nudges the planner toward a realistic car interior with the impossibility in who\'s driving.',
    sourceRefs: [TAXONOMY_CATALOG, DIRECTIVES_SKIP],
    authoredStatus: "authored-needs-david-review",
  },
  mock_heroic: {
    meaning:
      "The comedy comes from treating something trivial with epic gravitas — the subject should be staged like a monument to a mundane act.",
    renderImpact: 'Injects: "Stage the subject in an exaggerated, mock-heroic pose."',
    example:
      '"{NAME} plugged in a USB right on the first try" → the trivial act staged with an exaggerated heroic pose, cape-in-the-wind energy.',
    sourceRefs: [DIRECTIVES],
    authoredStatus: "code-derived",
  },
  action_comedy: {
    meaning:
      "The fact is an action joke — energetic, slapstick, physical comedy staging suits it better than solemn cinematics.",
    renderImpact:
      'Injects: "Lean into energetic, slapstick action-comedy staging."' + VIOLENCE_EXTRA,
    example:
      '"{NAME} fought the office printer and won" → energetic slapstick staging; the fact is also treated as violence-relevant so the action can be depicted clearly.',
    sourceRefs: [DIRECTIVES, VIOLENCE_RELEVANCE],
    authoredStatus: "code-derived",
  },
  cinematic_aftermath: {
    meaning:
      "The funniest frame is AFTER the action — the crater, the dust, the stunned onlookers — rather than the action itself.",
    renderImpact:
      'Injects: "Capture the cinematic aftermath of the action."' + VIOLENCE_EXTRA,
    example:
      '"{NAME} high-fived a mountain" → the scene shows the aftermath: the crater, settling dust, awed onlookers.',
    sourceRefs: [DIRECTIVES, VIOLENCE_RELEVANCE],
    authoredStatus: "code-derived",
  },
  symbolic_abstraction_required: {
    meaning:
      "The fact cannot be shown literally at all — it demands symbolic visual language (the modifier-flag counterpart of the symbolic_abstraction literalness rating).",
    renderImpact: 'Injects: "Render the idea symbolically rather than literally."',
    example:
      '"{NAME} counted to infinity. Twice." → the compiled prompt orders symbolic rendering — endless number-scapes, not a person mouthing numbers.',
    sourceRefs: [DIRECTIVES],
    authoredStatus: "code-derived",
  },
  metaphorical_visualization: {
    meaning:
      "The joke should land as one concrete visual metaphor — a phrase made physically true in the image (the modifier-flag counterpart of the same-named literalness rating).",
    renderImpact: 'Injects: "Carry the joke through a clear visual metaphor."',
    example:
      '"{NAME}\'s handshake seals deals" → one clear metaphor (a literal wax seal pressed by a handshake) carries the image.',
    sourceRefs: [DIRECTIVES],
    authoredStatus: "code-derived",
  },
  clear_causal_relationship: {
    meaning:
      "The joke is a cause→effect gag, and it only lands if the viewer instantly sees which action caused which consequence.",
    renderImpact: 'Injects: "Make the scene\'s cause-and-effect visually unmistakable."',
    example:
      '"{NAME} clapped and the thunder answered" → clap and thundercrack composed so the cause-and-effect reads at a glance.',
    sourceRefs: [DIRECTIVES],
    authoredStatus: "code-derived",
  },
  crowd_reaction: {
    meaning:
      "Witnesses are part of the joke — the scene needs a visible crowd whose reaction sells how impressive the subject is.",
    renderImpact: 'Injects: "Include a visible crowd reacting to the subject."',
    example:
      '"{NAME} parallel-parked on the first attempt" → a visible crowd gasping and applauding in frame.',
    sourceRefs: [DIRECTIVES],
    authoredStatus: "code-derived",
  },
  environmental_reaction: {
    meaning:
      "The environment itself should visibly respond to the subject — nature, buildings, or weather reacting is the punchline's proof.",
    renderImpact: 'Injects: "Show the surrounding environment visibly reacting to the action."',
    example:
      '"{NAME} whispered and the forest leaned in" → trees bending toward the subject; the environment is the reacting witness.',
    sourceRefs: [DIRECTIVES],
    authoredStatus: "code-derived",
  },
  object_transformation: {
    meaning:
      "An object changes state because of the subject, and the change itself must be legible — best shown mid-transformation.",
    renderImpact: 'Injects: "Show the object mid-transformation so the change reads at a glance."',
    example:
      '"{NAME} stared at coal until it became a diamond" → the coal shown mid-morph into diamond so the change is unmistakable.',
    sourceRefs: [DIRECTIVES],
    authoredStatus: "code-derived",
  },
  technology_reaction: {
    meaning:
      "Devices and machines visibly respond to the subject — screens, routers, robots reacting is the gag's evidence.",
    renderImpact: 'Injects: "Show nearby technology visibly reacting to the subject."',
    example:
      '"WiFi gets stronger when {NAME} walks by" → routers and phones visibly lighting up in response.',
    sourceRefs: [DIRECTIVES],
    authoredStatus: "code-derived",
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
    sourceRefs: [TAXONOMY_CATALOG, DIRECTIVES_SKIP, CLASSIFIER_CATALOG],
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
    '"{NAME} waved at the ISS and it waved back" → space backdrop suggested; not a compiled directive (contrast celestial_object, which is).',
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
  no_readable_text: {
    meaning:
      "Text-safety flag: the render must not contain readable text anywhere — AI-generated signage/captions tend to come out as gibberish and break the image.",
    renderImpact: 'Injects: "Keep all surfaces free of readable text, captions, and labels."',
    example:
      '"{NAME} renamed the airport" → signage renders as clean, non-readable surfaces instead of garbled fake lettering.',
    sourceRefs: [DIRECTIVES],
    authoredStatus: "code-derived",
  },
  avoid_real_logos: {
    meaning:
      "Brand-safety flag: no real-world logos or trademarks may appear — generic stand-ins replace any brand the fact evokes.",
    renderImpact:
      'Injects: "Do not depict any real-world logos or brand marks; use generic stand-ins."',
    example:
      '"{NAME} out-delivered the delivery company" → generic unbranded vans and uniforms, no recognizable brand marks.',
    sourceRefs: [DIRECTIVES],
    authoredStatus: "code-derived",
  },
  avoid_readable_ui: {
    meaning:
      "Screen-safety flag: any phone/computer screens in frame must stay abstract — fake readable UI text comes out garbled and distracts.",
    renderImpact: 'Injects: "Keep any on-screen UI abstract and non-readable."',
    example:
      '"{NAME}\'s selfie crashed the app" → the phone screen stays an abstract glow, no fake readable interface.',
    sourceRefs: [DIRECTIVES],
    authoredStatus: "code-derived",
  },
  avoid_weapons_focus: {
    meaning:
      "Presentation constraint (not moderation): a weapon may appear if the fact requires it, but it must not be the visual centerpiece of the scene.",
    renderImpact: 'Injects: "Do not make weapons the visual focus of the scene."',
    example:
      '"{NAME} caught the arrow mid-flight" → the catch is the focal point; the weapon is incidental, not glorified.',
    sourceRefs: [DIRECTIVES],
    authoredStatus: "code-derived",
  },
  avoid_gross_literalization: {
    meaning:
      "Taste constraint: a literal rendering of the fact would be gross or off-putting — the idea should be staged tastefully instead.",
    renderImpact: 'Injects: "Render the idea tastefully rather than grossly literal."',
    example:
      '"{NAME} sweats pure espresso" → tasteful coffee-steam staging rather than a literally dripping render.',
    sourceRefs: [DIRECTIVES],
    authoredStatus: "code-derived",
  },
  avoid_extra_faces: {
    meaning:
      "Focus constraint: background faces dilute the subject and risk identity confusion — keep other faces minimal so the subject stays the one clear face.",
    renderImpact:
      'Injects: "Keep extra background faces to a minimum; the subject stays the clear focal point."',
    example:
      '"{NAME} won the marathon running backwards" → background runners de-emphasized/turned away; the subject is the only clear face.',
    sourceRefs: [DIRECTIVES],
    authoredStatus: "code-derived",
  },
  avoid_duplicate_subject: {
    meaning:
      "Anti-clone constraint: image models love to render the reference person twice — this flag pins the subject to exactly one instance.",
    renderImpact:
      'Injects: "Show exactly one instance of the subject — no duplicates or clones." Additionally triggers the compiler\'s single-instance SUBJECT BINDING ("Render exactly one {subject} — a single instance.") and the anti-split strict constraint ("Do not duplicate, clone, or mirror {subject} anywhere in the frame.") even when no age transform applies.',
    example:
      '"{NAME} raced their own shadow" → exactly one {NAME} in frame; the shadow is a shadow, not a second copy of the person.',
    sourceRefs: [DIRECTIVES, SINGLE_INSTANCE_BINDING],
    authoredStatus: "code-derived",
  },
  astronomical_consequence: {
    meaning:
      "The fact's consequence is planetary/cosmic scale — the image must stage that scale, not shrink it to a local effect.",
    renderImpact: 'Injects: "Stage a dramatic astronomical or planetary-scale consequence."',
    example:
      '"{NAME} sneezed and the moon left orbit" → the departing moon staged huge and dramatic, not a dot in the sky.',
    sourceRefs: [DIRECTIVES],
    authoredStatus: "code-derived",
  },
  celestial_object: {
    meaning:
      "A specific celestial body (planet, moon, star) is a load-bearing prop in the joke and must be clearly rendered in frame.",
    renderImpact:
      'Injects: "Include a clearly rendered celestial object (planet, moon, star, or sky body)."',
    example:
      '"The moon waves back at {NAME}" → a clearly rendered moon in frame, not just a vague night sky.',
    sourceRefs: [DIRECTIVES],
    authoredStatus: "code-derived",
  },
  subject_object_reversal: {
    meaning:
      "The joke inverts the normal actor/acted-on relationship — the object does to the subject what the subject would normally do to it.",
    renderImpact:
      'Injects: "Reverse the expected roles so the object acts on the subject, not the other way around."',
    example:
      '"The dumbbells ask {NAME} for a lighter set" → roles reversed: the equipment is the one acting toward the subject.',
    sourceRefs: [DIRECTIVES],
    authoredStatus: "code-derived",
  },
  normal_function_rendered_unnecessary: {
    meaning:
      "Redundant-mechanism jokes: the subject's impossible power accomplishes the result BEFORE an object/tool/weapon's normal mechanism is needed — the mechanism may still fire afterward, but comically redundantly. Explicitly NOT a temporal/causality inversion (the canonical example: \"threw a grenade and killed 50 people, then it exploded\").",
    renderImpact:
      'Injects: "Stage the subject\'s own action as the overwhelming force; keep the object\'s normal mechanism intact, unused, delayed, or secondary so it reads as redundant — do not depict that mechanism happening before the subject\'s action."',
    example:
      '"{NAME} threw a grenade and killed 50 people, then it exploded" → the throw is the devastating force; the grenade\'s own explosion stays visibly late and redundant.',
    sourceRefs: [
      DIRECTIVES,
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
    renderImpact:
      'Injects: "Show the thrown or launched object carrying impossible force through a shockwave, motion trail, or impact path."' +
      VIOLENCE_EXTRA,
    example:
      '"{NAME}\'s paper airplane broke the sound barrier" → the airplane rendered with a shockwave and motion trail carrying impossible force.',
    sourceRefs: [DIRECTIVES, VIOLENCE_RELEVANCE],
    authoredStatus: "code-derived",
  },
  brand_context: {
    meaning:
      "Context flag: the joke depends on a brand or company reference. Pairs with the culturalReferences brand_reference entries; brands are also on the adult-suitability incompatible list.",
    renderImpact:
      "No fixed compiler directive — taxonomy context for the planner only. If the concern is brand MARKS appearing in the image, that is avoid_real_logos' job (which does compile); this flag just tells downstream consumers the joke leans on a brand.",
    example:
      '"A rental company sends {NAME} thank-you flowers" → flags the brand dependency for the planner and reviewers; add avoid_real_logos if marks must not render.',
    sourceRefs: [TAXONOMY_CATALOG, DIRECTIVES_SKIP, CLASSIFIER_CATALOG],
    authoredStatus: "authored-needs-david-review",
  },
  workplace_context: {
    meaning:
      "Context flag: the fact assumes workplace framing — bosses, HR, coworkers, office politics. Workplace context is also on the classifier's adult-incompatible list, so this doubles as a safety signal.",
    renderImpact:
      "No fixed compiler directive — the token reaches the AI prompt planner as taxonomy context only; the authored strategy and scene own the staging. Its more concrete role is taxonomy/adult-suitability context, not the compiled prompt.",
    example:
      '"HR studies {NAME}\'s emails as literature" → workplace framing flagged for the planner and for adult-suitability review; nothing is compiled from it.',
    sourceRefs: [TAXONOMY_CATALOG, DIRECTIVES_SKIP, CLASSIFIER_CATALOG],
    authoredStatus: "authored-needs-david-review",
  },
  audience_inside_reference: {
    meaning:
      "Context flag: the joke's audience exists INSIDE the reference — the in-scene watchers/consumers belong to the referenced format or world (e.g. the sharks watching \"{NAME} Week\"), and the joke collapses if who-is-watching-whom gets lost.",
    renderImpact:
      "No fixed compiler directive — planner context only, alerting the scene-writing AI to preserve the audience inversion; the authored strategy and the planned scene determine whether it actually survives into the prompt.",
    example:
      '"Sharks have a {NAME} Week" → the sharks ARE the audience; this flag tells the planner not to flatten that into people watching sharks.',
    sourceRefs: [TAXONOMY_CATALOG, DIRECTIVES_SKIP],
    authoredStatus: "authored-needs-david-review",
  },
} satisfies Record<KnownFactModifier, ValueDoc>;

// ─── Custom (unknown, amber-chip) modifiers ──────────────────────────────────

/** Doc shown for any modifier value NOT in the known catalog. */
export const CUSTOM_MODIFIER_DOC: ValueDoc = {
  meaning:
    "A free-form modifier outside the 50-value known catalog (rendered as an amber chip). The classifier is only allowed to invent one when no known modifier captures an important rendering, discovery, identity, setting, or safety constraint — and admins can add their own.",
  renderImpact:
    "No compiler directive exists for it, by definition — the token reaches the AI prompt planner as raw taxonomy context only, so its effect depends entirely on the AI's interpretation. If a custom modifier should have a guaranteed effect, engineering must add a directive for it in modifierDirectives.ts.",
  example:
    'You add "sepia_flashback" (amber chip) → the planner sees the token as context and may or may not honor it — check the test render rather than assuming.',
  sourceRefs: [
    {
      path: "lib/api-zod/src/taxonomy.ts",
      symbol: "isKnownModifier",
      note: "The known/custom split the amber chip reflects.",
    },
    {
      path: "artifacts/api-server/src/lib/imagePrompt/modifierDirectives.ts",
      symbol: "modifierDirectives",
      note: "Where a directive would have to be added to give a custom modifier a guaranteed effect.",
    },
  ],
  authoredStatus: "code-derived",
};
