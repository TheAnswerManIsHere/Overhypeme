/**
 * Visual prompt strategy map — Phase 2A deliverable.
 *
 * Translates the Phase-1 taxonomy (archetype + subtype) into reusable visual-
 * prompt strategy data. Pure typed data + lookup helpers — no OpenAI calls,
 * no image/video generation, no model-specific compilation. Phase 2B will
 * consume this when generating engine-neutral visual plans and model-specific
 * prompts.
 *
 * Architecture principle: keep these layers separate
 *
 *   fact taxonomy        — what kind of absurd fact is this?
 *   visual strategy map  — how should this fact type become an image? (this file)
 *   identity policy      — how should the reference person be preserved/transformed?
 *   render policy        — what content level is allowed?
 *   style prompt         — what should the image look like aesthetically?
 *   engine-neutral plan  — what should the image depict? (Phase 2B)
 *   engine-specific      — how should the prompt be phrased for a target model?
 *
 * Content authored by David; this file is the typed home for it. Imports the
 * Phase-1 taxonomy enums to guarantee the two layers stay aligned.
 */

import type { PrimaryArchetype, FactSubtype } from "./taxonomy";
import {
  PRIMARY_ARCHETYPES,
  SUBTYPES_BY_ARCHETYPE,
} from "./taxonomy";

// v2: extends the global-rule set with non-human i2i + t2i fallback +
// anthropomorphic treatment policies (Phase 2 — non-human subject support).
// Per-archetype strategy entries are unchanged from v1.
export const VISUAL_STRATEGY_VERSION = "v2";

// ─── Global rules (apply across the whole visual strategy system) ──────────

export const VISUAL_PROMPT_GLOBAL_RULES = {
  identityBaseline: `Use the reference image as the facial identity source. Preserve the reference person's face and recognizability strongly.

Identity preservation means preserving the recognizable face, not necessarily preserving the reference person's exact body, physique, outfit, pose, age presentation, or setting.

Unless preservePhysique is enabled, the system may exaggerate the subject's body, physique, outfit, posture, costume, aura, and heroic presence as needed to sell the overhyped fact.`,

  preservePhysiqueOverride: `If preservePhysique is enabled, preserve the reference person's general body type and physique while still making the scene absurd, legendary, and overhyped through composition, lighting, expression, staging, environment, props, reactions, and visual consequences.`,

  ageAndLifeStagePolicy: `When the fact implies a specific age, life stage, era, or social role, transform the subject's apparent age and presentation to match the fact. In i2i mode, preserve identity as recognizable facial essence rather than exact current-age appearance. Adjust body, grooming, hair, facial hair, clothing, posture, and setting as needed so the role and joke are legible.

If the reference image shows an adult with features that conflict with the required age or role, such as a beard when the fact requires a school-age student, modify or remove those features. Role clarity and joke legibility take priority over preserving exact adult physique, grooming, or clothing.`,

  contentAndRenderPolicySeparation: `The visual strategy map should describe the strongest and funniest visual interpretation of the fact. Content filtering, NSFW eligibility, violence handling, child-context blocking, brand restrictions, and model/platform policy decisions are handled by a separate render-policy layer.

Do not bake content moderation into archetype strategy blocks or visualization examples. If an example has sensitive implications, capture that as render-policy metadata elsewhere.`,

  supportingTextPolicy: `The app composites the meme caption separately. Do not ask the image model to render the full fact text, meme caption, hashtags, watermarks, real logos, or brand marks.

However, concise supporting text, numbers, symbols, equations, UI fragments, labels, scoreboards, forms, documents, signs, or keypad digits may be used when they are part of the visual joke or make the image easier to understand. Supporting text should be minimal, intentional, legible, and subordinate to the scene.`,

  supportingTextShortRule: `Supporting text is allowed when it is visual evidence. Caption text is not.`,

  culturalReferencePolicy: `If a fact depends on a cultural reference, inside joke, professional context, phrase-specific meaning, brand context, or known media reference, preserve that context in the visual strategy.

The admin review process should expose cultural-reference metadata and a fully rendered text prompt preview so admins can confirm the system understood the reference.`,

  nonhumanSubjectIdentityPolicy: `Non-human image-to-image subject identity: Use the reference image as the visual identity source for the uploaded subject. The uploaded subject visually represents the named subject in the fact. Preserve the reference subject's recognizable visual identity, including species or object type, color, markings, shape, distinctive features, proportions, and overall appearance.

Do not replace the uploaded subject with a human. Do not invent a human face unless the user explicitly chooses an anthropomorphic humanization mode, which is out of scope for this phase.

If the fact requires human-like action, allow tasteful anthropomorphic staging, posing, costume, or environment interaction while keeping the reference subject recognizable.`,

  textToImageFallbackPolicy: `Text-to-image fallback: No usable reference subject is being used. Generate a new protagonist for the named subject. Use fallback subject gender/profile guidance so the generated protagonist matches the logged-in user as closely as possible without claiming facial likeness preservation. Do not claim to preserve a reference image's face — there is no reference identity in this mode.`,

  anthropomorphicTreatmentPolicy: `Allow anthropomorphic staging only as needed to make the fact visually coherent. Preserve the uploaded subject's recognizable identity. Do not transform the subject into a human.

Treatment levels (escalate only as the fact requires):
- none: animal/object behaves naturally.
- subtle_pose: pose or framing implies role (e.g. cat sitting upright at a desk).
- costume_and_pose: add costume + role pose (e.g. dog wearing a tiny suit in a boardroom).
- full_cartoonish_anthropomorphism: cartoon-style humanoid (only when the chosen visual style explicitly supports it).

For this phase, default to subtle_pose or costume_and_pose. Avoid defaulting to full cartoonish anthropomorphism unless the selected visual style explicitly supports it.`,
} as const;

// ─── Types ─────────────────────────────────────────────────────────────────

/**
 * Strategy-map-side cultural reference attached to a hand-authored
 * visualization example. Distinct from the per-fact `culturalReferences[]`
 * that the enrichment service emits at submission time — that one lives on the
 * stored enrichment blob, this one is hardcoded annotation for the examples.
 */
export interface ExampleCulturalReference {
  reference: string;
  type: string;
  meaning: string;
  visualImplication: string;
}

export interface VisualizationExample {
  fact: string;
  archetype: PrimaryArchetype;
  subtype: FactSubtype;
  /** Concrete description of the intended scene. Empty until David authors. */
  visualApproach: string;
  /** Why this visual treatment lands the joke. Empty until David authors. */
  whyItWorks: string;
  /** Failure-mode notes for this specific example. Empty until authored. */
  avoid: string;
  culturalReferences?: ExampleCulturalReference[];
}

export interface VisualSubtypeGuidance {
  subtype: FactSubtype;
  /** One-sentence visual principle for this subtype, from Doc 1. */
  principle: string;
  /** Optional richer guidance — when to apply this subtype. */
  useWhen?: string;
  /** Optional fact-pattern examples for pattern-matchers. */
  examplePatterns?: string[];
}

export interface FailureMode {
  failureMode: string;
  guardrail: string;
}

export interface FrameGuidance {
  frame: string;
  useWhen: string;
}

export interface VisualPromptStrategy {
  archetype: PrimaryArchetype;
  title: string;
  definition: string;
  coreVisualGoal: string;
  strategyBlock: string;
  i2iDefault: string;
  /** Optional: per-archetype preserve-physique override; the global rule covers
   *  most cases, so this is only filled when an archetype needs special handling. */
  preservePhysique?: string;
  /** Optional: per-archetype t2i fallback. Doc 1 only authors one for archetype 1;
   *  others rely on the global identity-baseline fallback. */
  t2iFallback?: string;
  subtypeGuidance: VisualSubtypeGuidance[];
  visualizationExamples: VisualizationExample[];
  /** Shape contract for the Phase 2B prompt generator's structured output. */
  promptGeneratorRequirements: Record<string, string>;
  /** Optional named visual frames the generator may select between. */
  frameSelectionGuidance?: FrameGuidance[];
  /** Archetype-level common pitfalls. Empty array until authored — per-example
   *  `avoid` already documents the obvious ones. */
  failureModes: FailureMode[];
  lockedRule: string;
  /** "complete" when ≥4 fully-authored visualization examples carry prose;
   *  "pending" when examples are placeholder fact-name stubs awaiting prose.
   *  Per Doc 1 validation #5 ("≥4 examples unless intentionally documented"). */
  examplesAuthoringStatus: "complete" | "pending";
}

// ─── Strategy entries (per Doc 1 §1–§11) ───────────────────────────────────

const SUPERHUMAN_PHYSICAL_FEAT: VisualPromptStrategy = {
  archetype: "superhuman_physical_feat",
  title: "Superhuman physical feat",
  definition: `Use when a real physical action is exaggerated to impossible force, scale, speed, endurance, precision, sensory ability, or consequence.`,
  coreVisualGoal: `Show a recognizable physical action and the impossible physical consequence it causes.`,
  strategyBlock: `This fact describes a real physical action exaggerated to impossible scale. Create a grounded cinematic scene where the subject performs the action and the impossible consequence is visibly happening because of that action.

Make the causal relationship clear in the same image: the subject performs a recognizable physical action, and the world visibly reacts at an absurd scale.

The subject should be the star of the image and should appear powerful, heroic, physically exaggerated, and effortlessly in control. For strength-based feats, exaggerate the subject's body and physical presence as appropriate, such as a muscular or superheroic physique, dramatic posture, or larger-than-life stance. In i2i mode, the face must remain recognizable as the reference person.

Use concrete visual evidence to prove the scale of the feat: cracked ground, shockwaves, bent structures, displaced objects, dust, motion trails, scale contrast, extreme distance, or large background consequences.

Redundant-mechanism jokes (modifier normal_function_rendered_unnecessary): some facts mention a tool, weapon, or process whose normal mechanism (an explosion, a gunshot, a detonation) happens AFTER the subject's action. The joke is that the subject's physical force already accomplished the result, so the normal mechanism is comically redundant — it is NOT a time/causality inversion. For these:
- Stage the subject's action as the impossible force (the throw, the punch, the kick), with cinematic shockwaves, motion trails, craters, or debris proving its power.
- Keep the object's normal mechanism intact, unused, delayed, or secondary in the frame (e.g. an intact, unexploded grenade still in flight). Do NOT depict the normal mechanism as happening before the subject's action.
- For weapon or destruction facts, prove the scale through environmental impact — shockwaves, craters, debris, distant chaos, knocked-over targets — and depict the bodies, casualties, or aftermath the fact calls for; content suppression is owned by the render-policy layer, not this strategy.

Keep the composition clean, visually readable, and meme-ready, with the subject clearly connected to the impossible result.`,
  i2iDefault: `Use the reference image as the facial identity source. Preserve the reference person's face and recognizability strongly.

Unless preservePhysique is enabled, exaggerate the subject's body, physique, outfit, posture, and heroic physical presence as needed to sell the impossible physical feat. The subject should look powerful, larger-than-life, and effortlessly in control.`,
  t2iFallback: `Create a cinematic meme background representing the named subject as a legendary protagonist. Since no usable face reference is available, do not attempt facial likeness preservation. Use an exaggerated heroic body, pose, outfit, or physical presence as appropriate to the fact.`,
  subtypeGuidance: [
    { subtype: "force_scaled_action", principle: "Show force radiating outward from the action into the environment." },
    { subtype: "strength_scaled_action", principle: "Show the subject physically controlling an impossibly massive object while looking confident and in control." },
    { subtype: "speed_scaled_action", principle: "Show motion trails, displaced air, afterimages, or environmental blur while keeping the subject visually recognizable." },
    { subtype: "endurance_scaled_action", principle: "Show the world, equipment, or environment exhausted while the subject remains composed and powerful." },
    { subtype: "precision_scaled_action", principle: "Show the impossible trajectory or perfect result clearly enough that the precision is obvious." },
    { subtype: "sensory_scaled_action", principle: "Represent sensory power as a physical cinematic effect while keeping the subject central." },
    { subtype: "ordinary_action_extreme_consequence", principle: "Make the ordinary action clear, then show the consequence at a wildly exaggerated scale." },
  ],
  visualizationExamples: [
    {
      fact: "When David does pushups, he doesn't push himself up, he pushes the Earth down.",
      archetype: "superhuman_physical_feat",
      subtype: "force_scaled_action",
      visualApproach: "Show David in a pushup position on cracked pavement or ground. His body is steady and powerful, but instead of rising upward, the ground beneath his hands is visibly compressing downward. Dust ripples outward, pavement buckles, and nearby objects tilt slightly from the force.",
      whyItWorks: "The image shows both the normal action and the impossible consequence in the same frame. The viewer understands that the pushup is moving the Earth rather than David.",
      avoid: "Do not show only a generic bodybuilder doing pushups. Do not show random destruction without connecting it to his hands pressing into the ground.",
    },
    {
      fact: "David can bench press a house.",
      archetype: "superhuman_physical_feat",
      subtype: "strength_scaled_action",
      visualApproach: "Show David on a weight bench outdoors, lifting an entire small house like a barbell. The house should look massive and real, with clear scale contrast. David's face should remain recognizable, while his physique and heroic presence can be exaggerated. He should look calm and impossibly strong, not crushed or struggling.",
      whyItWorks: "The scene turns a normal strength exercise into an impossible scale feat. The house gives immediate visual proof of the exaggeration.",
      avoid: "Do not make the house look like a toy. Do not make David tiny or hidden under the object. Do not make the scene look like the house fell on him.",
    },
    {
      fact: "When David sneezes, the moon changes orbit.",
      archetype: "superhuman_physical_feat",
      subtype: "ordinary_action_extreme_consequence",
      visualApproach: "Show David in the foreground just after a casual sneeze, holding a handkerchief, with an exaggerated visible shockwave traveling into the night sky. Clouds are pushed aside and the moon appears subtly displaced, with the sky reacting to the force. David should look unbothered and legendary.",
      whyItWorks: "The image shows an ordinary human action producing an astronomical consequence. The moon is a modifier, not a separate archetype.",
      avoid: "Do not make the image only about space. Do not make David tiny or absent. The subject must remain the cause of the event.",
    },
    {
      fact: "David threw a baseball around the world and caught it from behind.",
      archetype: "superhuman_physical_feat",
      subtype: "precision_scaled_action",
      visualApproach: "Show David standing in a dramatic athletic pose, having just thrown or caught a baseball. A glowing curved motion trail wraps around the horizon or globe-like background, implying the ball traveled around the world and returned. David's face remains recognizable, and his body can be exaggerated into an athletic heroic form.",
      whyItWorks: "The impossible distance and precision are visualized through the trajectory, while the subject remains the star.",
      avoid: "Do not show a normal baseball throw. Do not rely on maps or labels alone to explain the around-the-world path.",
    },
    {
      fact: "David doesn't get tired on the treadmill. The treadmill gets tired of David.",
      archetype: "superhuman_physical_feat",
      subtype: "endurance_scaled_action",
      visualApproach: "Show David running confidently on a smoking, overheated treadmill that appears exhausted, broken, or slumped from trying to keep up. David is still composed, powerful, and barely sweating. The gym environment reinforces the physical endurance context.",
      whyItWorks: "The machine's failure proves David's endurance without needing to show time passing literally.",
      avoid: "Do not make David look exhausted. Do not make the treadmill the only focus. The joke is David outlasting the machine.",
    },
    {
      fact: "David once threw a grenade and killed 50 people, then it exploded.",
      archetype: "superhuman_physical_feat",
      subtype: "force_scaled_action",
      visualApproach: "Show David in a powerful throwing follow-through pose, calm and confident, as an intact, unexploded grenade rockets away from him like a meteor with a visible shockwave and motion trail. Prove the impossible force through shattered debris, a cracked-earth impact path, and distant environmental chaos. The grenade has clearly NOT detonated yet; its eventual explosion is unnecessary because the throw alone is overwhelming.",
      whyItWorks: "The humor is mechanism redundancy, not time travel: David's throw is so impossibly powerful that the grenade is already redundant. Keeping the grenade intact in flight makes the throw the cause and the later detonation an afterthought.",
      avoid: "Do not stage a detonation happening before or instead of the throw — this is NOT a temporal/causality inversion. Do not let the explosion be the focus; the throw is.",
    },
  ],
  promptGeneratorRequirements: {
    physicalAction: "the real action being exaggerated",
    absurdConsequence: "the impossible physical result",
    visualProof: "specific evidence that proves the consequence",
    subjectExaggeration: "how the body, posture, outfit, or heroic presence should be exaggerated",
    causalConnection: "how the image shows the subject caused the event",
  },
  failureModes: [],
  lockedRule: `Show a real physical action and its impossible physical consequence in the same image whenever possible. Preserve the face, exaggerate the legend.`,
  examplesAuthoringStatus: "complete",
};

const OBJECT_LOGIC_IMPOSSIBILITY: VisualPromptStrategy = {
  archetype: "object_logic_impossibility",
  title: "Object-logic impossibility",
  definition: `Use when the fact is impossible because the object, tool, material, medium, or target cannot logically support the claimed action.`,
  coreVisualGoal: `Make the object, tool, material, medium, or target contradiction visually legible.`,
  strategyBlock: `This fact describes an impossible result caused by a contradiction in the object, tool, material, medium, or target. Create a grounded cinematic scene where the object's normal logic is visually clear, and the subject has made the impossible result happen anyway.

The image must make the contradiction legible. Show what the object, tool, material, medium, or target is, and show why the result should not be possible.

The subject should be the star of the image and should appear confident, legendary, and in control.

For some facts, the funniest visual treatment is not to show the action itself, but to show the impossible aftermath. The subject may stand confidently with or beside the impossible object while the result is already visible, leaving the viewer to infer how the impossible thing happened.

Use clear object staging. The revolving door, cordless phone, underwater fire, fish, fog, or other impossible object should be visually readable. Avoid clutter that hides the contradiction.`,
  i2iDefault: `Use the reference image as the facial identity source. Preserve the reference person's face and recognizability strongly.

Unless preservePhysique is enabled, exaggerate the subject's body, costume, posture, and heroic presence as needed to sell the impossible object-logic result. Keep the impossible object, tool, material, medium, or target clearly readable.`,
  subtypeGuidance: [
    { subtype: "mechanical_contradiction", principle: "Make the object's normal mechanism visible, then show it behaving in the impossible way." },
    { subtype: "semantic_instrument_contradiction", principle: "Show the impossible tool clearly and show the result or aftermath that should be impossible for that tool." },
    { subtype: "material_state_contradiction", principle: "Turn the impossible material property into a clear physical visual." },
    { subtype: "medium_contradiction", principle: "Make the hostile medium obvious, then show the impossible action succeeding inside that medium." },
    { subtype: "target_nature_contradiction", principle: "Show the target reacting in a way that contradicts what it naturally is." },
    { subtype: "object_agency_inversion", principle: "Show the object taking the active role while the subject remains calm and in control." },
  ],
  visualizationExamples: [
    {
      fact: "David can slam a revolving door.",
      archetype: "object_logic_impossibility",
      subtype: "mechanical_contradiction",
      visualApproach: "Show David standing confidently beside a glass revolving door that has been impossibly slammed shut like a normal hinged door. The circular rotating mechanism should still be visible, but bent or compressed into a hard stopped position. David should look powerful and casual, as if defeating the door's mechanics was effortless.",
      whyItWorks: "The image makes the viewer understand why the action should be impossible: the door is clearly a revolving door, yet it has somehow been slammed shut.",
      avoid: "Do not show a normal hinged door. Do not show random broken glass without making the revolving mechanism clear. Do not reduce the joke to generic destruction.",
    },
    {
      fact: "David can strangle someone with a cordless phone.",
      archetype: "object_logic_impossibility",
      subtype: "semantic_instrument_contradiction",
      visualApproach: "Show David standing confidently while holding an old cordless phone handset. The impossible consequence is already visible at his feet or nearby, letting the viewer infer that the cordless phone somehow caused it. The cordless phone should be clearly readable as cordless, and David should look legendary and unbothered.",
      whyItWorks: "The image does not need to show the action. The humor comes from the impossible aftermath: a cordless phone somehow produced a result that should require a cord.",
      avoid: "Do not show a normal corded phone. Do not make the phone unclear or modern in a way that loses the cordless-phone joke. Do not focus only on violence while losing the object contradiction.",
    },
    {
      fact: "David can start a fire underwater.",
      archetype: "object_logic_impossibility",
      subtype: "medium_contradiction",
      visualApproach: "Show David underwater, calm and heroic, holding or standing beside a bright flame that burns clearly despite being fully submerged. Blue water, bubbles, floating fabric or hair, and refracted light should make the underwater setting obvious. The flame should look real and impossible.",
      whyItWorks: "The underwater environment proves the medium contradiction, and the flame proves David has broken the rule.",
      avoid: "Do not show fire merely near water. Do not show a torch above the surface. The flame must be visibly underwater.",
    },
    {
      fact: "David can stack fog.",
      archetype: "object_logic_impossibility",
      subtype: "material_state_contradiction",
      visualApproach: "Show David calmly stacking translucent blocks or slabs of fog like bricks. The fog should still look vaporous and misty at the edges, but it holds an impossible solid shape in his hands. David should appear focused, powerful, and completely in control of the impossible material.",
      whyItWorks: "The image turns an ungraspable material into a physical object while keeping enough fog-like texture for the contradiction to be clear.",
      avoid: "Do not make the fog look like ordinary stone or ice. Do not lose the misty, vapor-like quality that makes the action impossible.",
    },
    {
      fact: "David can drown a fish.",
      archetype: "object_logic_impossibility",
      subtype: "target_nature_contradiction",
      visualApproach: "Show David standing confidently near a fish in a water-filled setting where the fish appears overwhelmed by the very water it should naturally survive in. The scene should make the fish's nature clear while implying that David has somehow reversed the normal rules of survival.",
      whyItWorks: "The target's nature is the contradiction: fish belong in water, but David has made water defeat the fish.",
      avoid: "Do not make the fish look like a generic object with no water context. Do not show David simply fishing. The contradiction must be that the fish is defeated by its own natural environment.",
    },
  ],
  promptGeneratorRequirements: {
    impossibleObjectOrSetup: "the object, tool, material, medium, or target",
    objectLogicContradiction: "why the claimed action or result should be impossible",
    absurdResult: "what impossible result has happened",
    bestVisualFrame: "direct_action | implied_aftermath | object_transformation | target_reaction",
    visualProof: "specific visual details that make the contradiction clear",
    subjectTreatment: "how the subject should appear legendary and in control",
  },
  frameSelectionGuidance: [
    { frame: "direct_action", useWhen: "Showing the impossible action in progress is the strongest read." },
    { frame: "implied_aftermath", useWhen: "The result is funnier than the action; let the viewer infer the cause." },
    { frame: "object_transformation", useWhen: "The object itself visibly contradicts its normal state." },
    { frame: "target_reaction", useWhen: "The target's reaction is the joke (e.g. fish overwhelmed by water)." },
  ],
  failureModes: [],
  lockedRule: `Make the object contradiction visually legible. When the action itself is less funny or less clear to show directly, show the impossible aftermath and let the viewer infer how the subject made it happen.`,
  examplesAuthoringStatus: "complete",
};

const ENVIRONMENTAL_OBEDIENCE_IMMUNITY: VisualPromptStrategy = {
  archetype: "environmental_obedience_immunity",
  title: "Environmental obedience / immunity",
  definition: `Use when nature, weather, darkness, water, fire, gravity, light, the sun, or another environmental force fails to affect the subject, avoids the subject, obeys the subject, or behaves as if it recognizes the subject's authority.`,
  coreVisualGoal: `Show the environment reacting to the subject, not the subject reacting to the environment.`,
  strategyBlock: `This fact describes a natural or environmental force behaving as if the subject has authority over it. Create a grounded cinematic scene where the environment is visibly reacting to the subject, avoiding the subject, obeying the subject, yielding to the subject, or failing to affect the subject.

The image should make the environmental force visually obvious. Show enough rain, water, darkness, fire, wind, gravity, sunlight, storm, snow, or other environmental evidence that the viewer understands what force is being defied.

The subject should be the star of the image and should appear calm, legendary, and effortlessly in control.

For facts where the literal wording is hard to show, visualize the proof of the claim rather than every word. If the fact says "water gets David," show water bending away, recoiling, parting, hovering, or failing to touch him while the rest of the scene proves the water is real.

Use clear environmental staging. The image should not feel like a generic portrait with weather added. The environmental reaction is the joke.`,
  i2iDefault: `Use the reference image as the facial identity source. Preserve the reference person's face and recognizability strongly.

Unless preservePhysique is enabled, exaggerate the subject's body, outfit, posture, aura, and heroic presence as needed to make them appear naturally dominant over the environmental force. Make the environmental reaction visually clear.`,
  subtypeGuidance: [
    { subtype: "environmental_immunity", principle: "Show the environmental condition affecting the surrounding world while the subject remains untouched." },
    { subtype: "environmental_agency_inversion", principle: "Show the environmental force behaving like it is the affected party, victim, or subordinate." },
    { subtype: "environmental_control_interface", principle: "Make the abstract force feel physically controllable." },
    { subtype: "environmental_retreat_obedience", principle: "Show the force parting, bending, clearing, or retreating around the subject." },
    { subtype: "personified_natural_force", principle: "Give the natural force a readable reaction while keeping it cinematic and not overly cartoonish unless style calls for it." },
  ],
  visualizationExamples: [
    { fact: "Water gets David.", archetype: "environmental_obedience_immunity", subtype: "environmental_agency_inversion", visualApproach: "", whyItWorks: "", avoid: "" },
    { fact: "David turns the dark off.", archetype: "environmental_obedience_immunity", subtype: "environmental_control_interface", visualApproach: "", whyItWorks: "", avoid: "" },
    { fact: "The sun blinked.", archetype: "environmental_obedience_immunity", subtype: "personified_natural_force", visualApproach: "", whyItWorks: "", avoid: "" },
    { fact: "Rain avoids David.", archetype: "environmental_obedience_immunity", subtype: "environmental_retreat_obedience", visualApproach: "", whyItWorks: "", avoid: "" },
    { fact: "Gravity asks David for permission.", archetype: "environmental_obedience_immunity", subtype: "environmental_control_interface", visualApproach: "", whyItWorks: "", avoid: "" },
  ],
  promptGeneratorRequirements: {
    environmentalForce: "the natural or environmental force involved",
    normalEffect: "what the force normally does",
    davidEffect: "how the subject reverses, controls, avoids, or dominates that force",
    visualProof: "specific evidence that makes the environmental reaction clear",
    bestVisualFrame: "immunity | retreat | control_interface | personified_reaction | agency_inversion",
    subjectTreatment: "how the subject should appear legendary and in control",
  },
  failureModes: [],
  lockedRule: `Show the environment reacting to the subject, not the subject reacting to the environment.`,
  examplesAuthoringStatus: "pending",
};

const AUTHORITY_THREAT_REVERSAL: VisualPromptStrategy = {
  archetype: "authority_threat_reversal",
  title: "Authority / threat reversal",
  definition: `Use when the fact reverses a normal power relationship. The subject is normally supposed to be subordinate to someone or something else, but the fact flips it so that the authority, role, predator, danger, institution, or threat responds to the subject.`,
  coreVisualGoal: `Show the normal power structure and make the reversal obvious.`,
  strategyBlock: `This fact describes a reversal of normal authority, responsibility, danger, or power. Create a grounded cinematic scene where the usual power relationship is visibly inverted and the subject is clearly the one with authority.

The image must show who normally has power and how that power has shifted to the subject. Use body language, facial reactions, staging, distance, deference, surrender, confusion, ceremony, or fear to make the reversal legible.

The subject should be the star of the image and should appear confident, legendary, and naturally in control.

The visual treatment depends on subtype:
- Social role reversal should feel like grounded human comedy.
- Institutional authority reversal should use official settings, procedures, uniforms, barriers, desks, scanners, courtrooms, or ceremonies.
- Predator/danger reversal should show the normal threat recoiling, submitting, fearing, admiring, or failing against the subject.

Do not make the scene generic. The viewer should understand which relationship has been reversed.`,
  i2iDefault: `Use the reference image as the facial identity source. Preserve the reference person's face and recognizability strongly.

Unless preservePhysique is enabled, exaggerate the subject's body, costume, posture, authority, and heroic presence as needed to sell the reversal. The subject should appear naturally in control of the authority, role, predator, danger, or threat.`,
  subtypeGuidance: [
    { subtype: "social_role_reversal", principle: "Stage realistically so the humor comes from the wrong person holding authority or responsibility." },
    { subtype: "institutional_authority_reversal", principle: "Use official environments and procedural symbols to show the institution submitting or reversing its normal role." },
    { subtype: "predator_danger_reversal", principle: "Show the normally dangerous thing reacting as if the subject is the real threat, authority, or spectacle." },
  ],
  visualizationExamples: [
    {
      fact: "Baby David drives his mom home from the hospital.",
      archetype: "authority_threat_reversal",
      subtype: "social_role_reversal",
      visualApproach: "",
      whyItWorks: "Apply the global age-and-life-stage policy: transform the subject to infant/baby presentation while preserving recognizable facial essence.",
      avoid: "",
    },
    {
      fact: "David's teachers raised their hands when they had questions.",
      archetype: "authority_threat_reversal",
      subtype: "institutional_authority_reversal",
      visualApproach: "School-age David must remain seated among students while the adult teacher raises their hand to ask him a question. Apply the global age-and-life-stage policy.",
      whyItWorks: "",
      avoid: "",
    },
    {
      fact: "Airport security removes its shoes when David walks through.",
      archetype: "authority_threat_reversal",
      subtype: "institutional_authority_reversal",
      visualApproach: "Use a generic security checkpoint. No real marks or logos.",
      whyItWorks: "",
      avoid: "Do not render real airline or agency logos.",
    },
    {
      fact: "The law follows David around.",
      archetype: "authority_threat_reversal",
      subtype: "institutional_authority_reversal",
      visualApproach: "Legal-system imagery (uniformed figures, court materials) visibly trailing behind David rather than directing him.",
      whyItWorks: "",
      avoid: "",
    },
    {
      fact: "Sharks have a David Week.",
      archetype: "authority_threat_reversal",
      subtype: "predator_danger_reversal",
      visualApproach: "Sharks gathered around a TV or glowing screen, watching David with rapt attention. The Shark Week framing is reversed: sharks are the audience, David is the spectacle.",
      whyItWorks: "The cultural reference is the joke. Generic sharks attacking or fearing David misses it.",
      avoid: "Do not render real network logos or readable channel marks.",
      culturalReferences: [
        {
          reference: "Shark Week",
          type: "broadcast_tv_reference",
          meaning: "A famous week of shark-focused television programming associated with Discovery Channel.",
          visualImplication: "Represent sharks as the viewers and David as the thrilling subject of the broadcast. Do not use real network logos.",
        },
      ],
    },
    {
      fact: "Death had a near-David experience.",
      archetype: "authority_threat_reversal",
      subtype: "predator_danger_reversal",
      visualApproach: "Death is shaken or visibly rattled, David is calm and composed.",
      whyItWorks: "",
      avoid: "",
    },
  ],
  promptGeneratorRequirements: {
    normalPowerHolder: "who or what normally has authority or danger",
    reversedPowerHolder: "the subject",
    reversalMechanism: "how the power dynamic is inverted",
    visualProof: "specific staging details that show the reversal",
    bestVisualFrame: "social_role | institutional_procedure | threat_recoils",
    subjectTreatment: "how the subject should appear legendary and in control",
  },
  failureModes: [],
  lockedRule: `Show the normal power relationship, then make the reversal visually obvious. The subject should be the one the authority, role, predator, or threat now responds to.`,
  examplesAuthoringStatus: "pending",
};

const TEMPORAL_CAUSALITY_INVERSION: VisualPromptStrategy = {
  archetype: "temporal_causality_inversion",
  title: "Temporal / causality inversion",
  definition: `Use when the fact breaks time, sequence, cause/effect, process order, aging, history, or reversibility.`,
  coreVisualGoal: `Show the broken sequence. The viewer should understand what should have happened first, and how the subject made the order impossible.`,
  strategyBlock: `This fact describes time, sequence, cause/effect, history, age, or process order breaking around the subject. Create a grounded cinematic scene where the impossible timing is visually clear.

The image should show the key impossible moment: a result appearing before its cause, a timeline contradiction made visible, or a normally irreversible process running backward.

The subject should be the star of the image and should appear confident, legendary, and effortlessly in control of the impossible sequence.

The visual should not feel like random chaos. It should make the time or causality inversion readable through staging, before-and-after contrast, frozen action, reversed motion cues, impossible age relationships, or process-reversal evidence.

Do NOT use this strategy for redundant-mechanism jokes — facts where the subject's impossible power makes a tool's, weapon's, or process's normal mechanism unnecessary, even when the sentence contains "then" or "before". Example: "{NAME} threw a grenade and killed 50 people, then it exploded" is a superhuman physical feat (the throw is the impossible force; the later explosion is redundant), and must be staged as impossible throwing force with an intact grenade — NOT as an explosion occurring before the throw. The presence of "then" or a normal mechanism happening after the result does not by itself make a fact a temporal inversion; only use this archetype when the humor depends on impossible event order, time reversal, retrocausality, or the effect clearly occurring before its cause.`,
  i2iDefault: `Use the reference image as the facial identity source. Preserve the reference person's face and recognizability strongly.

Unless preservePhysique is enabled, exaggerate the subject's body, outfit, posture, aura, and heroic presence as needed to sell the time-defying or causality-breaking scene. The subject should appear calm and in control of the impossible sequence.`,
  subtypeGuidance: [
    { subtype: "pure_timeline_inversion", principle: "Show one clear contradiction in timeline, age, sequence, or event order." },
    { subtype: "pre_cause_consequence", principle: "Show the cause still pending while the effect is already visible." },
    { subtype: "reverse_process_entropy_reversal", principle: "Show the completed mess or changed state reassembling into its earlier form." },
  ],
  visualizationExamples: [
    { fact: "David was born before his parents.", archetype: "temporal_causality_inversion", subtype: "pure_timeline_inversion", visualApproach: "", whyItWorks: "", avoid: "" },
    { fact: "David finished the race before it started.", archetype: "temporal_causality_inversion", subtype: "pre_cause_consequence", visualApproach: "", whyItWorks: "", avoid: "" },
    { fact: "The grenade went off in consequence before the explosion.", archetype: "temporal_causality_inversion", subtype: "pre_cause_consequence", visualApproach: "", whyItWorks: "", avoid: "" },
    { fact: "The punching bag was bruised before David hit it.", archetype: "temporal_causality_inversion", subtype: "pre_cause_consequence", visualApproach: "", whyItWorks: "", avoid: "" },
    { fact: "David can unscramble an egg.", archetype: "temporal_causality_inversion", subtype: "reverse_process_entropy_reversal", visualApproach: "", whyItWorks: "", avoid: "" },
    { fact: "David can put toothpaste back in the tube.", archetype: "temporal_causality_inversion", subtype: "reverse_process_entropy_reversal", visualApproach: "", whyItWorks: "", avoid: "" },
  ],
  promptGeneratorRequirements: {
    timeOrCausalityBreak: "what sequence, timeline, or process is broken",
    normalOrder: "what should normally happen first",
    impossibleOrder: "what happens instead",
    bestVisualFrame: "timeline_contradiction | pre_cause_consequence | reverse_process",
    visualProof: "specific details that make the broken sequence visible",
    subjectTreatment: "how the subject should appear legendary and in control",
  },
  failureModes: [],
  lockedRule: `Show the broken sequence. The viewer should understand what should have happened first, and how the subject made the order impossible.`,
  examplesAuthoringStatus: "pending",
};

const PRESENCE_INDUCED_REACTION_AURA: VisualPromptStrategy = {
  archetype: "presence_induced_reaction_aura",
  title: "Presence-induced reaction / aura",
  definition: `Use when the subject does little or nothing, but people, objects, opportunities, crowds, conflicts, or situations react dramatically because of their presence, reputation, aura, tiny gesture, charisma, prestige, or implied dominance.`,
  coreVisualGoal: `The subject barely acts, but the world around them reacts intensely.`,
  strategyBlock: `This fact describes the subject's presence, reputation, aura, or tiny gesture causing a dramatic reaction. Create a grounded cinematic scene where the subject is calm, composed, and barely acting, while the surrounding people, objects, opportunities, conflicts, or situations react as if the subject is overwhelmingly legendary.

The image should make the reaction visually obvious. Show the contrast between the subject's minimal action and the exaggerated response around them.

The subject should be the star of the image and should appear magnetic, powerful, admired, respected, intimidating, prestigious, or impossibly cool depending on the fact.

Unless preserve-physique is enabled, exaggerate the subject's body, outfit, posture, aura, charisma, or heroic presence as needed to sell the overhyped reaction.

Do not make the subject look confused by the reaction. The subject should look like this is normal.`,
  i2iDefault: `Use the reference image as the facial identity source. Preserve the reference person's face and recognizability strongly.

Unless preservePhysique is enabled, exaggerate the subject's body, physique, outfit, posture, charisma, aura, and heroic presence as needed to make them feel like an overhyped legendary version of themselves. The subject should look calm, magnetic, and unsurprised by the reaction around them.`,
  subtypeGuidance: [
    { subtype: "surrender", principle: "Show the subject calm and still while others visibly give up or submit." },
    { subtype: "awe_deference", principle: "Show people or environment treating the subject as naturally important." },
    { subtype: "prestige_transfer", principle: "Show brief contact with the subject transferring status." },
    { subtype: "world_waits_for_subject", principle: "Show the world paused, prepared, or expectant around the subject." },
    { subtype: "object_obsession", principle: "Show an object emotionally or socially fixated on the subject." },
    { subtype: "respectful_refusal", principle: "Show a nuisance or obstacle voluntarily holding back." },
    { subtype: "tiny_gesture_massive_reaction", principle: "Make the tiny gesture visible and the reaction huge." },
  ],
  visualizationExamples: [
    { fact: "A bar fight ends when David raises an eyebrow.", archetype: "presence_induced_reaction_aura", subtype: "tiny_gesture_massive_reaction", visualApproach: "", whyItWorks: "", avoid: "" },
    { fact: "Battlefield conflict stops when David arrives.", archetype: "presence_induced_reaction_aura", subtype: "surrender", visualApproach: "", whyItWorks: "", avoid: "" },
    { fact: "Opportunity waits for David.", archetype: "presence_induced_reaction_aura", subtype: "world_waits_for_subject", visualApproach: "", whyItWorks: "", avoid: "" },
    { fact: "A pat on the back from David is resume-worthy.", archetype: "presence_induced_reaction_aura", subtype: "prestige_transfer", visualApproach: "", whyItWorks: "", avoid: "" },
    { fact: "David's phone is addicted to him.", archetype: "presence_induced_reaction_aura", subtype: "object_obsession", visualApproach: "", whyItWorks: "", avoid: "" },
    { fact: "Mosquitoes refuse to bite David.", archetype: "presence_induced_reaction_aura", subtype: "respectful_refusal", visualApproach: "", whyItWorks: "", avoid: "" },
  ],
  promptGeneratorRequirements: {
    minimalSubjectAction: "what the subject does or does not do",
    reactingEntity: "who or what reacts",
    reactionType: "surrender | awe | prestige | waiting | obsession | refusal | massive_response",
    reactionEvidence: "specific visual details that prove the reaction",
    contrast: "how the image contrasts the subject's calm minimal action with the exaggerated response",
    subjectTreatment: "how the subject should appear legendary, magnetic, and in control",
  },
  failureModes: [],
  lockedRule: `The subject barely acts. The world reacts.`,
  examplesAuthoringStatus: "pending",
};

const LOGIC_FORMAL_IMPOSSIBILITY: VisualPromptStrategy = {
  archetype: "logic_formal_impossibility",
  title: "Logic / formal impossibility",
  definition: `Use when the fact violates formal logic, mathematics, infinity, probability, game rules, paradox, language rules, or a defined rule system.`,
  coreVisualGoal: `Make it obvious that the subject has broken a formal rule.`,
  strategyBlock: `This fact describes the subject breaking a rule of logic, mathematics, probability, infinity, language, or a formal system. Create a visually clear symbolic scene where an impossible formal rule appears to bend, collapse, or resolve around the subject.

The image should make the formal impossibility feel physically real. Use cinematic metaphors such as impossible geometry, paradoxical objects, infinite loops, broken rule systems, impossible game states, collapsing probability, supporting symbols, or reality behaving like a solved equation.

The subject should be the star of the image and should appear calm, brilliant, legendary, and in control of the impossible logic. The visual should not feel like a generic genius portrait. It should show the specific formal impossibility being defeated.

When the fact is too abstract to show literally, choose the strongest visual metaphor that makes the impossibility intuitive. Concise supporting numbers, symbols, equations, scoreboards, or UI fragments may be used when they make the impossible rule easier and funnier to understand.`,
  i2iDefault: `Use the reference image as the facial identity source. Preserve the reference person's face and recognizability strongly.

Unless preservePhysique is enabled, exaggerate the subject's outfit, posture, aura, intellect, authority, and heroic presence as needed to make them feel like the calm source of the impossible logic-breaking event.`,
  subtypeGuidance: [
    { subtype: "infinity_impossibility", principle: "Visualize completed infinity, infinite loops, or impossible scale through cinematic metaphor." },
    { subtype: "probability_impossibility", principle: "Show the impossible outcome with enough context that the probability rule is obvious (e.g. a seven on a six-sided die)." },
    { subtype: "rule_system_impossibility", principle: "Show the impossible game/system state in a way that makes the rule legible." },
    { subtype: "paradox_or_undefined_impossibility", principle: "Use paradoxical objects or impossible geometry; covers divide-by-zero and undefined-state cases." },
    { subtype: "formal_language_impossibility", principle: "Visualize the broken language/syntax rule through a symbolic concrete scene." },
  ],
  visualizationExamples: [
    { fact: "David counted to infinity. Twice.", archetype: "logic_formal_impossibility", subtype: "infinity_impossibility", visualApproach: "", whyItWorks: "", avoid: "" },
    { fact: "David's PIN is the last four digits of pi.", archetype: "logic_formal_impossibility", subtype: "formal_language_impossibility", visualApproach: "Showing four crisp random digits (e.g. 7319) is encouraged — it makes the joke concrete. Do not render the full fact text or long streams of pi digits.", whyItWorks: "", avoid: "Do not render the full fact text. Do not render long streams of pi digits." },
    { fact: "David can divide by zero.", archetype: "logic_formal_impossibility", subtype: "paradox_or_undefined_impossibility", visualApproach: "", whyItWorks: "", avoid: "" },
    { fact: "David can win Connect Four in three moves.", archetype: "logic_formal_impossibility", subtype: "rule_system_impossibility", visualApproach: "", whyItWorks: "", avoid: "" },
    { fact: "David rolled a seven on a six-sided die.", archetype: "logic_formal_impossibility", subtype: "probability_impossibility", visualApproach: "", whyItWorks: "", avoid: "" },
    { fact: "David drew a square circle.", archetype: "logic_formal_impossibility", subtype: "paradox_or_undefined_impossibility", visualApproach: "", whyItWorks: "", avoid: "" },
  ],
  promptGeneratorRequirements: {
    formalSystem: "math | infinity | probability | game_rules | paradox | language | logic",
    formalRule: "the rule that should make the fact impossible",
    impossibleViolation: "how the subject violates or defeats the rule",
    bestVisualFrame: "completed_infinity | impossible_probability | impossible_game_state | paradox_or_undefined | symbolic_language_break",
    visualProof: "specific visual details that make the formal impossibility clear",
    supportingTextUse: "whether concise numbers, symbols, equations, scoreboards, or UI fragments would help the joke",
    subjectTreatment: "how the subject should appear calm, brilliant, legendary, and in control",
  },
  failureModes: [],
  lockedRule: `Turn the formal impossibility into a physical visual metaphor, and use concise supporting numbers, symbols, or text when they make the impossible rule easier and funnier to understand.`,
  examplesAuthoringStatus: "pending",
};

const INTELLECTUAL_OMNISCIENCE: VisualPromptStrategy = {
  archetype: "intellectual_omniscience",
  title: "Intellectual omniscience",
  definition: `Use when the fact says the subject knows, predicts, solves, remembers, deduces, understands, or discovers something impossible.`,
  coreVisualGoal: `Show that the subject has access to knowledge, predictions, secrets, answers, or understanding that should be impossible.`,
  strategyBlock: `This fact describes the subject knowing, solving, predicting, remembering, or understanding something that should be hidden, unavailable, unwritten, unknowable, or impossible to infer. Create a grounded cinematic scene where impossible knowledge is made visually tangible.

The image should show the knowledge barrier and the subject's effortless access to it. Use visual devices such as sealed vaults, hidden files, unwritten clues, future reflections, prediction objects, impossible puzzles, overwhelmed experts, or information revealing itself to the subject.

The subject should be the star of the image and should appear calm, brilliant, legendary, and naturally in possession of the answer. The visual should not look like ordinary studying, hacking, or research. It should show that the answer should be impossible for anyone else to know.

When the information itself is abstract, choose a concrete visual metaphor that makes the hidden, future, secret, or unsolved knowledge feel physically present.`,
  i2iDefault: `Use the reference image as the facial identity source. Preserve the reference person's face and recognizability strongly.

Unless preservePhysique is enabled, exaggerate the subject's outfit, posture, aura, intellect, authority, and heroic presence as needed to make them feel like an overhyped legendary version of themselves. The subject should look effortlessly brilliant, not stressed or confused.`,
  subtypeGuidance: [
    { subtype: "hidden_knowledge", principle: "Secrets, mysteries, confidential truths, inaccessible information." },
    { subtype: "future_prediction", principle: "Future answers, outcomes, or random results known early." },
    { subtype: "impossible_problem_solving", principle: "Problems solved before available or solvable." },
    { subtype: "memory_omniscience", principle: "Impossible memories, future memories, forgotten or unwitnessed events." },
    { subtype: "strategic_omniscience", principle: "Entire strategies, opponent moves, or plans known ahead." },
    { subtype: "secret_mastery", principle: "Hidden systems, elite knowledge, forbidden techniques, secret skills." },
  ],
  visualizationExamples: [
    {
      fact: "David knows Victoria's secret.",
      archetype: "intellectual_omniscience",
      subtype: "hidden_knowledge",
      visualApproach: "Elegant fashion-retail, boutique, runway, or guarded luxury-secret visual language. Do not use a generic mystery vault alone.",
      whyItWorks: "The cultural reference (Victoria's Secret brand) is the joke. Generic mystery imagery misses it.",
      avoid: "Do not render real brand logos or word marks.",
      culturalReferences: [
        {
          reference: "Victoria's Secret",
          type: "brand_or_retail_reference",
          meaning: "A well-known lingerie and fashion retailer; the joke plays on the phrase 'Victoria's secret' as both hidden knowledge and the name of the brand.",
          visualImplication: "Use an elegant fashion-retail, boutique, runway, or guarded luxury-secret visual language rather than a generic mystery vault.",
        },
      ],
    },
    { fact: "David solves the crossword before the clues are printed.", archetype: "intellectual_omniscience", subtype: "impossible_problem_solving", visualApproach: "", whyItWorks: "", avoid: "" },
    { fact: "David knows what the Magic 8 Ball will say before it's shaken.", archetype: "intellectual_omniscience", subtype: "future_prediction", visualApproach: "", whyItWorks: "", avoid: "" },
    { fact: "David knows your next move before you do.", archetype: "intellectual_omniscience", subtype: "strategic_omniscience", visualApproach: "", whyItWorks: "", avoid: "" },
    { fact: "David remembers tomorrow.", archetype: "intellectual_omniscience", subtype: "memory_omniscience", visualApproach: "", whyItWorks: "", avoid: "" },
    { fact: "David knows the secret menu before the restaurant opens.", archetype: "intellectual_omniscience", subtype: "secret_mastery", visualApproach: "", whyItWorks: "", avoid: "" },
  ],
  promptGeneratorRequirements: {
    knowledgeType: "secret | future | solution | memory | strategy | mastery",
    knowledgeBarrier: "why the information should be hidden, unavailable, unknowable, unwritten, or impossible to infer",
    davidAccess: "how the subject appears to know or access it anyway",
    bestVisualFrame: "revealed_secret | prewritten_solution | future_answer | strategic_field | impossible_memory_archive | hidden_mastery",
    visualProof: "specific visual details that make the impossible knowledge clear",
    subjectTreatment: "how the subject should appear calm, brilliant, legendary, and unsurprised",
  },
  failureModes: [],
  lockedRule: `The subject knows what cannot be known, and the image must show why that knowledge should have been impossible.`,
  examplesAuthoringStatus: "pending",
};

const TECHNOLOGY_SYSTEM_REACTION: VisualPromptStrategy = {
  archetype: "technology_system_reaction",
  title: "Technology / system reaction",
  definition: `Use when machines, software, apps, AI, passwords, computers, networks, devices, security systems, robots, servers, or digital systems react to the subject, obey them, defer to them, submit to them, or fail against them.`,
  coreVisualGoal: `Show the technology system recognizing the subject as the authority and changing behavior around them.`,
  strategyBlock: `This fact describes a machine, software system, app, AI, network, password gate, security system, device, or digital process reacting to the subject as if the subject outranks it. Create a grounded cinematic scene where the technology system visibly recognizes, obeys, submits to, fears, admires, or reconfigures itself around the subject.

The image should show both the technology system and its reaction. The system should not feel like a passive background prop. It should visibly change behavior because the subject is present.

The subject should be the star of the image and should appear calm, legendary, and naturally in command of the technology. The scene should not look like ordinary computer use, hacking, or troubleshooting. It should show the system itself reacting to the subject.

Use visual system cues such as access gates opening, devices orienting toward the subject, screens changing state, robots pausing, servers lighting up, AI interfaces deferring, security panels unlocking, apps requesting permission, or machines surrendering. Concise supporting UI text, symbols, status messages, or interface elements may be used when they help the system reaction read clearly.`,
  i2iDefault: `Use the reference image as the facial identity source. Preserve the reference person's face and recognizability strongly.

Unless preservePhysique is enabled, exaggerate the subject's body, outfit, posture, aura, and technological command presence as needed to show that machines, software, AI, devices, or systems are reacting to them.`,
  subtypeGuidance: [
    { subtype: "security_system_submission", principle: "Access systems unlock, grant access, or submit." },
    { subtype: "device_obedience", principle: "Hardware anticipates, obeys, or serves." },
    { subtype: "software_permission_inversion", principle: "App or software asks the subject for permission." },
    { subtype: "ai_deference", principle: "AI or robots treat the subject as higher intelligence." },
    { subtype: "machine_intimidation", principle: "Machine reacts with defeat, hesitation, or submission." },
    { subtype: "network_system_reaction", principle: "Large-scale networks, servers, or infrastructure respond." },
  ],
  visualizationExamples: [
    { fact: "The system logs itself in for David.", archetype: "technology_system_reaction", subtype: "security_system_submission", visualApproach: "", whyItWorks: "", avoid: "" },
    { fact: "Apps ask David for permission.", archetype: "technology_system_reaction", subtype: "software_permission_inversion", visualApproach: "", whyItWorks: "", avoid: "" },
    { fact: "The chess computer resigns while unplugged.", archetype: "technology_system_reaction", subtype: "machine_intimidation", visualApproach: "", whyItWorks: "", avoid: "" },
    { fact: "AI asks David for permission to think.", archetype: "technology_system_reaction", subtype: "ai_deference", visualApproach: "", whyItWorks: "", avoid: "" },
    { fact: "The printer apologizes first.", archetype: "technology_system_reaction", subtype: "device_obedience", visualApproach: "", whyItWorks: "", avoid: "" },
    { fact: "The servers stand at attention when David walks in.", archetype: "technology_system_reaction", subtype: "network_system_reaction", visualApproach: "", whyItWorks: "", avoid: "" },
  ],
  promptGeneratorRequirements: {
    technologySystem: "the machine, app, AI, software, security system, device, or network involved",
    normalSystemBehavior: "what the system normally does to users",
    reversedSystemBehavior: "how the system reacts differently to the subject",
    reactionType: "submission | obedience | permission_inversion | deference | intimidation | infrastructure_reaction",
    visualProof: "specific visual details that show the system reacting",
    supportingTextUse: "whether short UI text, symbols, digits, icons, or status messages would help the joke",
    subjectTreatment: "how the subject should appear calm, legendary, and technologically dominant",
  },
  failureModes: [],
  lockedRule: `The system reacts to the subject. Technology becomes the subordinate user.`,
  examplesAuthoringStatus: "pending",
};

const INTRINSIC_LEGENDARY_ATTRIBUTE: VisualPromptStrategy = {
  archetype: "intrinsic_legendary_attribute",
  title: "Intrinsic legendary attribute",
  definition: `Use when the subject has an impossible built-in trait, body feature, aura, biological property, personal field, possession, or metaphorical property made physical.`,
  coreVisualGoal: `Show that the subject possesses an impossible legendary trait that is visible as part of who they are.`,
  strategyBlock: `This fact describes the subject as possessing an impossible built-in trait, body feature, aura, biological property, possession, personal field, or metaphorical property made physical. Create a grounded cinematic scene where the impossible attribute is visibly connected to the subject.

The image should make the legendary attribute feel intrinsic, not like a random external event. Show the impossible property through body detail, aura, shadow, reflection, voice, breath, tears, blood, personal objects, physical evidence, or the reaction of the surrounding world.

The subject should be the star of the image and should appear legendary, composed, and naturally defined by the impossible trait. The attribute should enhance the subject's mythic status rather than distract from them.

When the fact is metaphorical, convert the metaphor into a concrete visual form that makes the joke immediately understandable.`,
  i2iDefault: `Use the reference image as the facial identity source. Preserve the reference person's face and recognizability strongly.

Unless preservePhysique is enabled, exaggerate the subject's body, aura, posture, physical presence, costume, or impossible personal trait as needed to make the legendary attribute visually clear. The subject should feel like the impossible trait naturally belongs to them.`,
  subtypeGuidance: [
    { subtype: "body_feature_impossibility", principle: "Beard, fist, jawline, eyes, hands, or other body feature with an impossible legendary property." },
    { subtype: "aura_property", principle: "Invisible quality represented as aura, field, atmosphere, or distortion." },
    { subtype: "biological_impossibility", principle: "Biological property, bodily output, biometric marker, or life-sign with an impossible legendary effect (tears, blood, breath, heartbeat, fingerprints, DNA, voice)." },
    { subtype: "metaphor_made_physical", principle: "Common phrase becomes physically true." },
    { subtype: "personal_effect_field", principle: "Immediate space around the subject behaves differently." },
    { subtype: "legendary_possession", principle: "Ordinary possession has impossible properties because it belongs to the subject." },
  ],
  visualizationExamples: [
    { fact: "Under David's beard is another fist.", archetype: "intrinsic_legendary_attribute", subtype: "body_feature_impossibility", visualApproach: "", whyItWorks: "", avoid: "" },
    { fact: "David's shadow has a black belt.", archetype: "intrinsic_legendary_attribute", subtype: "metaphor_made_physical", visualApproach: "", whyItWorks: "", avoid: "" },
    { fact: "David's tears cure disease. He has never cried.", archetype: "intrinsic_legendary_attribute", subtype: "biological_impossibility", visualApproach: "", whyItWorks: "", avoid: "" },
    { fact: "David's two cents are worth $37.", archetype: "intrinsic_legendary_attribute", subtype: "metaphor_made_physical", visualApproach: "", whyItWorks: "", avoid: "" },
    { fact: "When David speaks, his words carry weight.", archetype: "intrinsic_legendary_attribute", subtype: "metaphor_made_physical", visualApproach: "", whyItWorks: "", avoid: "" },
    { fact: "David's sunglasses block the sun from seeing him.", archetype: "intrinsic_legendary_attribute", subtype: "legendary_possession", visualApproach: "", whyItWorks: "", avoid: "" },
  ],
  promptGeneratorRequirements: {
    intrinsicAttribute: "the body feature, aura, biological property, possession, metaphor, or personal field",
    normalMeaning: "what the trait or phrase normally means",
    legendaryTransformation: "how the trait becomes impossible, physical, or mythic",
    bestVisualFrame: "body_feature | aura_field | biological_miracle | physicalized_metaphor | personal_effect_field | legendary_possession",
    visualProof: "specific visual details that connect the attribute to the subject",
    subjectTreatment: "how the subject should appear legendary and naturally defined by the trait",
    supportingTextUse: "whether short words, symbols, numbers, labels, or typographic elements would help the joke",
  },
  failureModes: [],
  lockedRule: `The subject is not just legendary because of what they do. Something about them is inherently impossible.`,
  examplesAuthoringStatus: "pending",
};

const MUNDANE_ACT_MADE_LEGENDARY: VisualPromptStrategy = {
  archetype: "mundane_act_made_legendary",
  title: "Mundane act made legendary",
  definition: `Use when an ordinary everyday action is treated as absurdly epic, mythic, dominant, ceremonial, or world-changing.`,
  coreVisualGoal: `Make the ordinary act visible, then stage it like a legendary event.`,
  strategyBlock: `This fact describes an ordinary everyday action treated as absurdly epic, mythic, dominant, ceremonial, or legendary. Create a grounded cinematic scene where the subject performs the mundane act with the presence and seriousness of a world-changing event.

The image should preserve the ordinary action clearly enough that the joke lands. The task, object, errand, chore, habit, work activity, or social behavior should be visually readable.

The subject should be the star of the image and should appear heroic, focused, composed, and larger-than-life. The environment, objects, lighting, reactions, or staging should elevate the mundane action into something absurdly important.

The visual should not become generic hero imagery. The ordinary act must remain visible and specific, because the comedy comes from treating that ordinary act as legendary.`,
  i2iDefault: `Use the reference image as the facial identity source. Preserve the reference person's face and recognizability strongly.

Unless preservePhysique is enabled, exaggerate the subject's body, outfit, posture, seriousness, aura, and heroic presence as needed to make an ordinary action feel absurdly epic, mythic, or overhyped.`,
  subtypeGuidance: [
    { subtype: "domestic_task_mythologized", principle: "Household chore becomes legendary." },
    { subtype: "ordinary_errand_mythologized", principle: "Normal errand becomes ceremonial or mythic." },
    { subtype: "food_drink_ritualized", principle: "Food, drink, or cooking becomes a ritual, interrogation, or act of command." },
    { subtype: "commute_travel_mythologized", principle: "Driving, parking, commuting, flying, or travel is treated as legendary." },
    { subtype: "social_habit_mythologized", principle: "Normal greeting or social habit becomes a ceremony." },
    { subtype: "work_task_mythologized", principle: "Ordinary professional task becomes overhyped." },
  ],
  visualizationExamples: [
    { fact: "The grass stands at attention when David walks by.", archetype: "mundane_act_made_legendary", subtype: "social_habit_mythologized", visualApproach: "", whyItWorks: "", avoid: "" },
    { fact: "Coffee beans confess to David.", archetype: "mundane_act_made_legendary", subtype: "food_drink_ritualized", visualApproach: "", whyItWorks: "", avoid: "" },
    { fact: "The curb moves over for David when he parallel parks.", archetype: "mundane_act_made_legendary", subtype: "commute_travel_mythologized", visualApproach: "", whyItWorks: "", avoid: "" },
    { fact: "David doesn't prepare for demos. Demos prepare for David. #Yardi", archetype: "mundane_act_made_legendary", subtype: "work_task_mythologized", visualApproach: "", whyItWorks: "", avoid: "" },
    { fact: "Hands apply for the privilege of being shaken by David.", archetype: "mundane_act_made_legendary", subtype: "social_habit_mythologized", visualApproach: "", whyItWorks: "", avoid: "" },
  ],
  promptGeneratorRequirements: {
    mundaneAction: "the ordinary task, habit, errand, chore, work activity, or social behavior",
    normalContext: "where and how this action normally happens",
    legendaryReframe: "how the ordinary action becomes epic, mythic, ceremonial, dominant, or absurdly important",
    reactingElements: "objects, environment, people, tools, or workflow elements that elevate the act",
    bestVisualFrame: "domestic_command | errand_ceremony | food_ritual | travel_environment_rearranges | social_ceremony | work_task_self_organizes",
    supportingTextUse: "whether short UI, labels, documents, numbers, or symbols help the ordinary context read clearly",
    subjectTreatment: "how the subject should appear heroic, serious, composed, and naturally worthy of the overhyped treatment",
  },
  failureModes: [],
  lockedRule: `Make the ordinary act visible, then stage it like a legendary event.`,
  examplesAuthoringStatus: "pending",
};

// ─── The map (every PrimaryArchetype must have an entry) ───────────────────

export const VISUAL_PROMPT_STRATEGIES: Record<PrimaryArchetype, VisualPromptStrategy> = {
  superhuman_physical_feat: SUPERHUMAN_PHYSICAL_FEAT,
  object_logic_impossibility: OBJECT_LOGIC_IMPOSSIBILITY,
  environmental_obedience_immunity: ENVIRONMENTAL_OBEDIENCE_IMMUNITY,
  authority_threat_reversal: AUTHORITY_THREAT_REVERSAL,
  temporal_causality_inversion: TEMPORAL_CAUSALITY_INVERSION,
  presence_induced_reaction_aura: PRESENCE_INDUCED_REACTION_AURA,
  logic_formal_impossibility: LOGIC_FORMAL_IMPOSSIBILITY,
  intellectual_omniscience: INTELLECTUAL_OMNISCIENCE,
  technology_system_reaction: TECHNOLOGY_SYSTEM_REACTION,
  intrinsic_legendary_attribute: INTRINSIC_LEGENDARY_ATTRIBUTE,
  mundane_act_made_legendary: MUNDANE_ACT_MADE_LEGENDARY,
};

// ─── Lookup helpers ────────────────────────────────────────────────────────

export function getVisualPromptStrategy(
  archetype: PrimaryArchetype,
): VisualPromptStrategy {
  return VISUAL_PROMPT_STRATEGIES[archetype];
}

export function getSubtypeGuidance(
  archetype: PrimaryArchetype,
  subtype: FactSubtype,
): VisualSubtypeGuidance | null {
  const strategy = VISUAL_PROMPT_STRATEGIES[archetype];
  const found = strategy.subtypeGuidance.find((g) => g.subtype === subtype);
  return found ?? null;
}

// ─── Re-exports for completeness assertions (used by tests) ────────────────

export { PRIMARY_ARCHETYPES, SUBTYPES_BY_ARCHETYPE };
