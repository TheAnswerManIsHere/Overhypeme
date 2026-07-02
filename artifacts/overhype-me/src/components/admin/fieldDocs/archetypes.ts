/**
 * Field docs — per-value docs for the Primary Archetype and Subtype dropdowns
 * (11 archetypes, 60 subtypes).
 *
 * Pure data. Meanings are extracted from the classifier system prompt
 * (FACT_ENRICHMENT_SYSTEM_DEFAULT) and render behavior from the authored
 * visual strategy map (visualPromptStrategies.ts) — see sourceRefs on each
 * record.
 */

import type { PrimaryArchetype, FactSubtype } from "@workspace/api-zod";
import type { ValueDoc, FieldDocSourceRef } from "./types";

// Shared source refs used across this file.
const CLASSIFIER_PROMPT: FieldDocSourceRef = {
  path: "artifacts/api-server/src/lib/factEnrichmentConfig.ts",
  symbol: "FACT_ENRICHMENT_SYSTEM_DEFAULT",
  note: "The classifier system prompt — the authoritative \"use when…\" rule and disambiguation guidance for this value.",
};
const ARCHETYPE_STRATEGY: FieldDocSourceRef = {
  path: "lib/api-zod/src/visualPromptStrategies.ts",
  symbol: "getVisualPromptStrategy",
  note: "The authored per-archetype strategy (strategy block, core visual goal, locked rule, visualization examples) this value selects for the planner.",
};
const SUBTYPE_GUIDANCE: FieldDocSourceRef = {
  path: "lib/api-zod/src/visualPromptStrategies.ts",
  symbol: "getSubtypeGuidance",
  note: "The authored one-sentence visual principle injected into the planner as subtype guidance.",
};

// ─── Primary archetypes (11) ─────────────────────────────────────────────────

export const PRIMARY_ARCHETYPE_DOCS = {
  superhuman_physical_feat: {
    meaning:
      "Use when a real physical action is exaggerated to impossible force, scale, speed, endurance, precision, sensory ability, or consequence. This is also where redundant-mechanism jokes belong: when a tool or weapon's normal mechanism (an explosion, a gunshot) happens AFTER the subject's power already achieved the result, classify here (with the normal_function_rendered_unnecessary modifier), NOT as temporal inversion.",
    renderImpact:
      "Selects the superhuman-feat strategy: a grounded cinematic scene showing the recognizable action AND its impossible consequence in the same image, with concrete visual proof (cracked ground, shockwaves, motion trails, scale contrast). Locked rule: \"Show a real physical action and its impossible physical consequence in the same image whenever possible. Preserve the face, exaggerate the legend.\" The only archetype with its own authored t2i fallback; its six visualization examples are fully authored (including the canonical grenade redundant-mechanism example).",
    example:
      "\"{NAME} once threw a grenade and killed 50 people, then it exploded.\" → the throw is the impossible force; the grenade is staged intact and unexploded in flight.",
    sourceRefs: [CLASSIFIER_PROMPT, ARCHETYPE_STRATEGY],
    authoredStatus: "code-derived",
  },
  object_logic_impossibility: {
    meaning:
      "Use when the object, tool, material, medium, or semantic object logic makes the action impossible — the joke is that the thing itself cannot logically support what the subject did with it (slamming a revolving door, strangling with a cordless phone).",
    renderImpact:
      "Selects the object-logic strategy: make the contradiction visually legible — show what the object is and why the result should be impossible, with the subject confident and in control. Uniquely has frame-selection guidance (direct_action / implied_aftermath / object_transformation / target_reaction). Locked rule: when the action is less funny to show directly, show the impossible aftermath and let the viewer infer the cause. Its five visualization examples are fully authored.",
    example:
      "\"{NAME} can slam a revolving door.\" → the rotating mechanism is clearly visible, yet impossibly slammed shut; {NAME} stands beside it, casual and powerful.",
    sourceRefs: [CLASSIFIER_PROMPT, ARCHETYPE_STRATEGY],
    authoredStatus: "code-derived",
  },
  environmental_obedience_immunity: {
    meaning:
      "Use when nature, weather, darkness, water, fire, gravity, or another natural/environmental force avoids, obeys, yields to, personifies itself around, or fails to affect the subject. Per the mechanism-not-topic rule, a sun-blinking fact lands here (personified natural force), not in any cosmic category.",
    renderImpact:
      "Selects the environmental strategy: make the force visually obvious (enough rain/darkness/fire/wind that the viewer knows what is being defied) and show it reacting to the subject. Locked rule: \"Show the environment reacting to the subject, not the subject reacting to the environment.\" Its visualization examples are marked authoring-pending in the strategy file (fact stubs without prose).",
    example:
      "\"Rain avoids {NAME}.\" → a downpour drenches the whole street while the rain visibly parts around a dry, unbothered {NAME}.",
    sourceRefs: [CLASSIFIER_PROMPT, ARCHETYPE_STRATEGY],
    authoredStatus: "code-derived",
  },
  authority_threat_reversal: {
    meaning:
      "Use when a normal power, danger, authority, role, predator, institution, or responsibility relationship is inverted — the subject is normally the subordinate one, but the authority/threat now responds to them. The prompt's canonical example: a baby driving their mother home is this archetype (social role reversal), not a physics joke.",
    renderImpact:
      "Selects the reversal strategy: show who normally has power and make the inversion legible through body language, deference, ceremony, or fear. Per-subtype treatments diverge: social reversals stage grounded human comedy, institutional ones use official settings/procedure, predator ones show the threat recoiling or submitting. Locked rule: show the normal power relationship, then make the reversal visually obvious. Examples are marked authoring-pending (stubs, though the \"Sharks have a {NAME} Week\" stub carries an authored Shark Week cultural-reference annotation).",
    example:
      "\"A baby drove {NAME}'s mother home.\" → a realistic car interior where the impossibility is who holds the driver's role, not the physics.",
    sourceRefs: [CLASSIFIER_PROMPT, ARCHETYPE_STRATEGY],
    authoredStatus: "code-derived",
  },
  temporal_causality_inversion: {
    meaning:
      "Use ONLY when the humor depends on impossible event order, time reversal, retrocausality, or an effect clearly occurring before its cause — broken time, sequence, process order, history, age, or reversibility. Critical disambiguation: \"then\" does NOT automatically mean temporal inversion. If a normal mechanism (grenade exploding, gun firing) happens after the result but the joke is that the subject's power made it unnecessary, that is a redundant mechanism → classify as superhuman_physical_feat (or the relevant power archetype) with normal_function_rendered_unnecessary instead. Before choosing this, ask: is the joke primarily about impossible time order, or did the subject's power simply beat the normal mechanism?",
    renderImpact:
      "Selects the temporal strategy: show the broken sequence so the viewer understands what should have happened first — before/after contrast, frozen action, reversed motion cues, impossible age relationships. The strategy block itself repeats the warning to never stage redundant-mechanism facts (e.g. the grenade) as an explosion before the throw. Locked rule: \"Show the broken sequence.\" Examples are marked authoring-pending (fact stubs only).",
    example:
      "\"{NAME} finished the race before it started.\" → {NAME} calmly crossing the finish line while the starting gun is still being raised behind them.",
    sourceRefs: [CLASSIFIER_PROMPT, ARCHETYPE_STRATEGY],
    authoredStatus: "code-derived",
  },
  presence_induced_reaction_aura: {
    meaning:
      "Use when the subject does little or nothing, but people, objects, opportunities, conflicts, crowds, or situations react because of their presence, reputation, aura, or tiny gesture. The prompt's disambiguation example: a bar fight ending because the subject raises an eyebrow is this archetype, not temporal inversion.",
    renderImpact:
      "Selects the aura strategy: contrast the subject's minimal, composed action against an exaggerated reaction around them — and the subject must look like this is normal, never confused by it. Locked rule: \"The subject barely acts. The world reacts.\" Examples are marked authoring-pending (fact stubs only).",
    example:
      "\"A bar fight ends when {NAME} raises an eyebrow.\" → brawlers frozen mid-swing, all eyes on {NAME}'s single raised eyebrow.",
    sourceRefs: [CLASSIFIER_PROMPT, ARCHETYPE_STRATEGY],
    authoredStatus: "code-derived",
  },
  logic_formal_impossibility: {
    meaning:
      "Use when the fact violates formal logic, math, infinity, probability, rules, games, paradox, or formal language. Per the mechanism-not-topic rule, counting to infinity is a logic/formal impossibility, not physical scale.",
    renderImpact:
      "Selects the formal-logic strategy: a symbolic scene where the broken rule feels physically real (impossible geometry, paradoxical objects, infinite loops, collapsing probability), with concise supporting numbers/symbols/equations explicitly permitted when they make the rule funnier to read. Locked rule: turn the formal impossibility into a physical visual metaphor. Examples are marked authoring-pending (though the pi-PIN stub carries partial authored guidance: show four crisp digits, never long streams of pi).",
    example:
      "\"{NAME} counted to infinity. Twice.\" → an endless symbolic number-scape resolving around a calm {NAME}, rather than someone mouthing numbers.",
    sourceRefs: [CLASSIFIER_PROMPT, ARCHETYPE_STRATEGY],
    authoredStatus: "code-derived",
  },
  intellectual_omniscience: {
    meaning:
      "Use when the subject knows, predicts, solves, remembers, understands, or deduces something impossible — knowledge that should be hidden, unavailable, unwritten, or unknowable.",
    renderImpact:
      "Selects the omniscience strategy: show the knowledge barrier AND the subject's effortless access to it (sealed vaults, future reflections, overwhelmed experts) — never ordinary studying or hacking. Locked rule: \"The subject knows what cannot be known, and the image must show why that knowledge should have been impossible.\" Examples are marked authoring-pending (though the \"knows Victoria's secret\" stub carries an authored brand cultural-reference annotation).",
    example:
      "\"{NAME} knows what the Magic 8 Ball will say before it's shaken.\" → the answer already visible to {NAME} while the ball sits untouched.",
    sourceRefs: [CLASSIFIER_PROMPT, ARCHETYPE_STRATEGY],
    authoredStatus: "code-derived",
  },
  technology_system_reaction: {
    meaning:
      "Use when machines, apps, computers, passwords, AI, digital systems, networks, devices, or software react to, obey, defer to, or fail against the subject.",
    renderImpact:
      "Selects the technology strategy: the system must visibly change behavior because the subject is present (gates opening, screens changing state, robots pausing, AI deferring) — never a passive background prop or ordinary computer use. Concise supporting UI text/status messages are permitted when they help the reaction read. Locked rule: \"The system reacts to the subject. Technology becomes the subordinate user.\" Examples are marked authoring-pending (fact stubs only).",
    example:
      "\"{NAME}'s chess computer resigns while unplugged.\" → a dead, unplugged machine displaying its resignation to a calm {NAME}.",
    sourceRefs: [CLASSIFIER_PROMPT, ARCHETYPE_STRATEGY],
    authoredStatus: "code-derived",
  },
  intrinsic_legendary_attribute: {
    meaning:
      "Use when the subject has an impossible built-in trait, aura, body feature, biological property, personal field, possession, or metaphorical property made physical — the impossibility is part of who they are, not something they did.",
    renderImpact:
      "Selects the intrinsic-attribute strategy: make the impossible property feel intrinsic to the subject (body detail, aura, shadow, personal objects, the world's reaction), enhancing their mythic status rather than reading as a random external event; metaphorical facts get converted into a concrete visual form. Locked rule: \"The subject is not just legendary because of what they do. Something about them is inherently impossible.\" Examples are marked authoring-pending (fact stubs only).",
    example:
      "\"Under {NAME}'s beard is another fist.\" → the body feature itself is the impossible legend.",
    sourceRefs: [CLASSIFIER_PROMPT, ARCHETYPE_STRATEGY],
    authoredStatus: "code-derived",
  },
  mundane_act_made_legendary: {
    meaning:
      "Use when an ordinary everyday action, task, habit, errand, work activity, food/drink activity, or social behavior is treated as absurdly epic, mythic, dominant, or legendary.",
    renderImpact:
      "Selects the mundane-made-legendary strategy: keep the ordinary act clearly visible and specific (the comedy dies if it becomes generic hero imagery), then elevate it through staging, lighting, reactions, and ceremony. Locked rule: \"Make the ordinary act visible, then stage it like a legendary event.\" Examples are marked authoring-pending (fact stubs only).",
    example:
      "\"{NAME} doesn't prepare for demos. Demos prepare for {NAME}.\" → an ordinary work task staged like a world-changing ceremony.",
    sourceRefs: [CLASSIFIER_PROMPT, ARCHETYPE_STRATEGY],
    authoredStatus: "code-derived",
  },
} satisfies Record<PrimaryArchetype, ValueDoc>;

// ─── Subtypes (60) ───────────────────────────────────────────────────────────

export const SUBTYPE_DOCS = {
  // superhuman_physical_feat
  force_scaled_action: {
    meaning:
      "A physical action (a throw, punch, kick, impact) whose FORCE is exaggerated to impossible scale — the environment takes the hit. Also the home of redundant-mechanism weapon facts (with the normal_function_rendered_unnecessary modifier).",
    renderImpact:
      "Planner receives the principle: \"Show force radiating outward from the action into the environment.\"",
    example:
      "\"When {NAME} does pushups, they don't push themselves up — they push the Earth down.\" → the ground visibly compresses beneath their hands.",
    sourceRefs: [CLASSIFIER_PROMPT, SUBTYPE_GUIDANCE],
    authoredStatus: "code-derived",
  },
  strength_scaled_action: {
    meaning:
      "Lifting, carrying, holding, or manipulating something impossibly massive — raw strength is the exaggerated dimension.",
    renderImpact:
      "Planner receives the principle: \"Show the subject physically controlling an impossibly massive object while looking confident and in control.\"",
    example:
      "\"{NAME} can bench press a house.\" → a real-scale house lifted like a barbell, {NAME} calm, never crushed or struggling.",
    sourceRefs: [CLASSIFIER_PROMPT, SUBTYPE_GUIDANCE],
    authoredStatus: "code-derived",
  },
  speed_scaled_action: {
    meaning: "Movement or action performed at impossible speed.",
    renderImpact:
      "Planner receives the principle: \"Show motion trails, displaced air, afterimages, or environmental blur while keeping the subject visually recognizable.\"",
    example:
      "\"{NAME} once ran a marathon in a single stride.\" → motion trails and displaced air across the whole course, {NAME} crisp and recognizable at the center.",
    sourceRefs: [CLASSIFIER_PROMPT, SUBTYPE_GUIDANCE],
    authoredStatus: "code-derived",
  },
  endurance_scaled_action: {
    meaning:
      "The subject outlasts anything — effort, exhaustion, or wear simply never reaches them; the world gives out first.",
    renderImpact:
      "Planner receives the principle: \"Show the world, equipment, or environment exhausted while the subject remains composed and powerful.\"",
    example:
      "\"{NAME} doesn't get tired on the treadmill. The treadmill gets tired of {NAME}.\" → a smoking, slumped treadmill; {NAME} composed and barely sweating.",
    sourceRefs: [CLASSIFIER_PROMPT, SUBTYPE_GUIDANCE],
    authoredStatus: "code-derived",
  },
  precision_scaled_action: {
    meaning: "Impossible accuracy, trajectory, or perfection of a physical action.",
    renderImpact:
      "Planner receives the principle: \"Show the impossible trajectory or perfect result clearly enough that the precision is obvious.\"",
    example:
      "\"{NAME} threw a baseball around the world and caught it from behind.\" → a glowing curved motion trail wrapping the horizon back into {NAME}'s glove.",
    sourceRefs: [CLASSIFIER_PROMPT, SUBTYPE_GUIDANCE],
    authoredStatus: "code-derived",
  },
  sensory_scaled_action: {
    meaning: "A sense (sight, hearing, smell, touch, taste) operating at impossible range or resolution.",
    renderImpact:
      "Planner receives the principle: \"Represent sensory power as a physical cinematic effect while keeping the subject central.\"",
    example:
      "\"{NAME} can hear WiFi.\" → visible signal waves bending toward {NAME}'s ear as a physical cinematic effect.",
    sourceRefs: [CLASSIFIER_PROMPT, SUBTYPE_GUIDANCE],
    authoredStatus: "code-derived",
  },
  ordinary_action_extreme_consequence: {
    meaning:
      "A completely normal action (a sneeze, a step, a clap) produces a wildly disproportionate physical consequence — the moon-sneeze fact is the canonical case (classified by mechanism, not by its space topic).",
    renderImpact:
      "Planner receives the principle: \"Make the ordinary action clear, then show the consequence at a wildly exaggerated scale.\"",
    example:
      "\"When {NAME} sneezes, the moon changes orbit.\" → a casual sneeze in the foreground, a shockwave into the night sky, the moon subtly displaced.",
    sourceRefs: [CLASSIFIER_PROMPT, SUBTYPE_GUIDANCE],
    authoredStatus: "code-derived",
  },

  // object_logic_impossibility
  mechanical_contradiction: {
    meaning: "The object's mechanism physically cannot do what the fact claims (you cannot slam a door that revolves).",
    renderImpact:
      "Planner receives the principle: \"Make the object's normal mechanism visible, then show it behaving in the impossible way.\"",
    example:
      "\"{NAME} can slam a revolving door.\" → the rotating mechanism still visible, but bent into a hard-stopped, slammed position.",
    sourceRefs: [CLASSIFIER_PROMPT, SUBTYPE_GUIDANCE],
    authoredStatus: "code-derived",
  },
  semantic_instrument_contradiction: {
    meaning:
      "The tool's defining property (its NAME says what it can't do) contradicts the action — a cordless phone used for something that requires a cord.",
    renderImpact:
      "Planner receives the principle: \"Show the impossible tool clearly and show the result or aftermath that should be impossible for that tool.\"",
    example:
      "\"{NAME} can strangle someone with a cordless phone.\" → {NAME} holds a clearly cordless handset; the impossible aftermath is visible nearby, cause left to inference.",
    sourceRefs: [CLASSIFIER_PROMPT, SUBTYPE_GUIDANCE],
    authoredStatus: "code-derived",
  },
  material_state_contradiction: {
    meaning: "A material behaves in a state it cannot hold — vapor stacked like bricks, liquid folded like cloth.",
    renderImpact:
      "Planner receives the principle: \"Turn the impossible material property into a clear physical visual.\"",
    example:
      "\"{NAME} can stack fog.\" → translucent slabs of fog held in a neat stack, still misty at the edges so the impossibility reads.",
    sourceRefs: [CLASSIFIER_PROMPT, SUBTYPE_GUIDANCE],
    authoredStatus: "code-derived",
  },
  medium_contradiction: {
    meaning: "The surrounding medium (water, vacuum, fire) should make the action impossible, yet it succeeds inside that medium.",
    renderImpact:
      "Planner receives the principle: \"Make the hostile medium obvious, then show the impossible action succeeding inside that medium.\"",
    example:
      "\"{NAME} can start a fire underwater.\" → a bright flame burning fully submerged, bubbles and refracted light proving the water is real.",
    sourceRefs: [CLASSIFIER_PROMPT, SUBTYPE_GUIDANCE],
    authoredStatus: "code-derived",
  },
  target_nature_contradiction: {
    meaning: "The TARGET's own nature makes the result impossible — drowning a fish, sunburning a shadow.",
    renderImpact:
      "Planner receives the principle: \"Show the target reacting in a way that contradicts what it naturally is.\"",
    example:
      "\"{NAME} can drown a fish.\" → the fish visibly overwhelmed by the very water it should thrive in, {NAME} standing confidently by.",
    sourceRefs: [CLASSIFIER_PROMPT, SUBTYPE_GUIDANCE],
    authoredStatus: "code-derived",
  },
  object_agency_inversion: {
    meaning: "The object becomes the actor — it does the work, takes the initiative, or acts on its own because of the subject.",
    renderImpact:
      "Planner receives the principle: \"Show the object taking the active role while the subject remains calm and in control.\"",
    example:
      "\"The punching bag hits itself so {NAME} doesn't have to.\" → the bag mid-swing against itself while {NAME} watches, arms crossed.",
    sourceRefs: [CLASSIFIER_PROMPT, SUBTYPE_GUIDANCE],
    authoredStatus: "code-derived",
  },

  // environmental_obedience_immunity
  environmental_immunity: {
    meaning: "An environmental condition affects everything and everyone — except the subject, who is untouched.",
    renderImpact:
      "Planner receives the principle: \"Show the environmental condition affecting the surrounding world while the subject remains untouched.\"",
    example:
      "\"{NAME} walks through blizzards in a t-shirt.\" → the whole street buried and frozen while {NAME} strolls through untouched.",
    sourceRefs: [CLASSIFIER_PROMPT, SUBTYPE_GUIDANCE],
    authoredStatus: "code-derived",
  },
  environmental_agency_inversion: {
    meaning:
      "The natural force and the subject swap roles — the force becomes the affected party, victim, or subordinate (\"Water gets {NAME}\" instead of {NAME} getting wet).",
    renderImpact:
      "Planner receives the principle: \"Show the environmental force behaving like it is the affected party, victim, or subordinate.\"",
    example:
      "\"Water gets {NAME}.\" → water recoiling, cowering, or drenched-looking around a dominant, dry {NAME}.",
    sourceRefs: [CLASSIFIER_PROMPT, SUBTYPE_GUIDANCE],
    authoredStatus: "code-derived",
  },
  environmental_control_interface: {
    meaning: "The subject operates a natural force like a device — switching darkness off, adjusting gravity, dialing the wind.",
    renderImpact: "Planner receives the principle: \"Make the abstract force feel physically controllable.\"",
    example:
      "\"{NAME} turns the dark off.\" → {NAME}'s hand on a physical switch as darkness visibly drains out of the scene.",
    sourceRefs: [CLASSIFIER_PROMPT, SUBTYPE_GUIDANCE],
    authoredStatus: "code-derived",
  },
  environmental_retreat_obedience: {
    meaning: "The force actively avoids, parts around, or clears a path for the subject, as if obeying them.",
    renderImpact:
      "Planner receives the principle: \"Show the force parting, bending, clearing, or retreating around the subject.\"",
    example:
      "\"Rain avoids {NAME}.\" → a heavy downpour with a visible dry corridor bending around {NAME}.",
    sourceRefs: [CLASSIFIER_PROMPT, SUBTYPE_GUIDANCE],
    authoredStatus: "code-derived",
  },
  personified_natural_force: {
    meaning:
      "A natural force behaves like a person around the subject — the sun blinking is the classifier prompt's canonical case (this, not a cosmic category).",
    renderImpact:
      "Planner receives the principle: \"Give the natural force a readable reaction while keeping it cinematic and not overly cartoonish unless style calls for it.\"",
    example:
      "\"The sun blinked when it saw {NAME}.\" → the sun given a readable, cinematic reaction — dimming mid-blink — over an unbothered {NAME}.",
    sourceRefs: [CLASSIFIER_PROMPT, SUBTYPE_GUIDANCE],
    authoredStatus: "code-derived",
  },

  // authority_threat_reversal
  social_role_reversal: {
    meaning:
      "An everyday social role or responsibility is held by the wrong person — the baby driving {NAME}'s mother home is the canonical example.",
    renderImpact:
      "Planner receives the principle: \"Stage realistically so the humor comes from the wrong person holding authority or responsibility.\"",
    example:
      "\"Baby {NAME} drives their mom home from the hospital.\" → grounded, realistic car interior; the joke is entirely who is behind the wheel.",
    sourceRefs: [CLASSIFIER_PROMPT, SUBTYPE_GUIDANCE],
    authoredStatus: "code-derived",
  },
  institutional_authority_reversal: {
    meaning:
      "An institution (school, court, security, the law) submits to or reverses its normal role toward the subject.",
    renderImpact:
      "Planner receives the principle: \"Use official environments and procedural symbols to show the institution submitting or reversing its normal role.\"",
    example:
      "\"{NAME}'s teachers raised their hands when they had questions.\" → a classroom where the adult teacher raises a hand toward school-age {NAME}.",
    sourceRefs: [CLASSIFIER_PROMPT, SUBTYPE_GUIDANCE],
    authoredStatus: "code-derived",
  },
  predator_danger_reversal: {
    meaning:
      "Something normally dangerous (a predator, Death, a threat) treats the subject as the real threat, authority, or spectacle.",
    renderImpact:
      "Planner receives the principle: \"Show the normally dangerous thing reacting as if the subject is the real threat, authority, or spectacle.\"",
    example:
      "\"Sharks have a {NAME} Week.\" → sharks gathered as the rapt audience around a screen showing {NAME} — the Shark Week framing reversed, no real network logos.",
    sourceRefs: [CLASSIFIER_PROMPT, SUBTYPE_GUIDANCE],
    authoredStatus: "code-derived",
  },

  // temporal_causality_inversion
  pure_timeline_inversion: {
    meaning:
      "The timeline itself is impossible — ages, birth order, or event order contradict history. Only for genuine time-order jokes, never redundant-mechanism facts.",
    renderImpact:
      "Planner receives the principle: \"Show one clear contradiction in timeline, age, sequence, or event order.\"",
    example:
      "\"{NAME} was born before their parents.\" → one clear, readable age/timeline contradiction staged in a single frame.",
    sourceRefs: [CLASSIFIER_PROMPT, SUBTYPE_GUIDANCE],
    authoredStatus: "code-derived",
  },
  pre_cause_consequence: {
    meaning:
      "The effect exists before its cause has happened. Careful: if the cause still happens later but is merely redundant (the grenade that explodes after the kill), that is superhuman_physical_feat with normal_function_rendered_unnecessary, NOT this.",
    renderImpact:
      "Planner receives the principle: \"Show the cause still pending while the effect is already visible.\"",
    example:
      "\"The punching bag was bruised before {NAME} hit it.\" → the bruise already there while {NAME}'s first punch is still mid-air.",
    sourceRefs: [CLASSIFIER_PROMPT, SUBTYPE_GUIDANCE],
    authoredStatus: "code-derived",
  },
  reverse_process_entropy_reversal: {
    meaning: "A normally irreversible process runs backward for the subject — unscrambling eggs, un-squeezing toothpaste.",
    renderImpact:
      "Planner receives the principle: \"Show the completed mess or changed state reassembling into its earlier form.\"",
    example:
      "\"{NAME} can unscramble an egg.\" → the scrambled egg visibly reassembling into a pristine whole egg in {NAME}'s hand.",
    sourceRefs: [CLASSIFIER_PROMPT, SUBTYPE_GUIDANCE],
    authoredStatus: "code-derived",
  },

  // presence_induced_reaction_aura
  surrender: {
    meaning: "Conflict, opposition, or enemies simply give up because the subject is present.",
    renderImpact:
      "Planner receives the principle: \"Show the subject calm and still while others visibly give up or submit.\"",
    example:
      "\"Battlefield conflict stops when {NAME} arrives.\" → both sides lowering weapons the moment {NAME} steps into frame, calm and still.",
    sourceRefs: [CLASSIFIER_PROMPT, SUBTYPE_GUIDANCE],
    authoredStatus: "code-derived",
  },
  awe_deference: {
    meaning: "People or the environment treat the subject as naturally, unquestionably important — reverence without any threat.",
    renderImpact:
      "Planner receives the principle: \"Show people or environment treating the subject as naturally important.\"",
    example:
      "\"Rooms stand up when {NAME} walks in.\" → an entire room rising in spontaneous deference while {NAME} strolls through as if it's normal.",
    sourceRefs: [CLASSIFIER_PROMPT, SUBTYPE_GUIDANCE],
    authoredStatus: "code-derived",
  },
  prestige_transfer: {
    meaning: "Mere contact with or acknowledgment from the subject confers status on someone or something else.",
    renderImpact: "Planner receives the principle: \"Show brief contact with the subject transferring status.\"",
    example:
      "\"A pat on the back from {NAME} is resume-worthy.\" → someone proudly framing the moment of the pat like a diploma.",
    sourceRefs: [CLASSIFIER_PROMPT, SUBTYPE_GUIDANCE],
    authoredStatus: "code-derived",
  },
  world_waits_for_subject: {
    meaning: "Events, opportunities, or the world itself pause and wait for the subject rather than proceeding without them.",
    renderImpact:
      "Planner receives the principle: \"Show the world paused, prepared, or expectant around the subject.\"",
    example:
      "\"Opportunity waits for {NAME}.\" → opportunity personified standing patiently at {NAME}'s door, hand raised but not knocking, while {NAME} finishes their coffee.",
    sourceRefs: [CLASSIFIER_PROMPT, SUBTYPE_GUIDANCE],
    authoredStatus: "code-derived",
  },
  object_obsession: {
    meaning: "An object is emotionally or socially fixated on the subject — devotion inverted from user-to-thing into thing-to-subject.",
    renderImpact:
      "Planner receives the principle: \"Show an object emotionally or socially fixated on the subject.\"",
    example:
      "\"{NAME}'s phone is addicted to them.\" → the phone straining toward {NAME}, screen lighting up with longing notifications.",
    sourceRefs: [CLASSIFIER_PROMPT, SUBTYPE_GUIDANCE],
    authoredStatus: "code-derived",
  },
  respectful_refusal: {
    meaning: "A nuisance, pest, or obstacle voluntarily declines to bother the subject, out of respect.",
    renderImpact: "Planner receives the principle: \"Show a nuisance or obstacle voluntarily holding back.\"",
    example:
      "\"Mosquitoes refuse to bite {NAME}.\" → a swarm hovering at a respectful distance, one almost bowing, while {NAME} lounges unbitten.",
    sourceRefs: [CLASSIFIER_PROMPT, SUBTYPE_GUIDANCE],
    authoredStatus: "code-derived",
  },
  tiny_gesture_massive_reaction: {
    meaning:
      "A minimal gesture (a raised eyebrow, a nod) triggers a massive response — the eyebrow-ends-the-bar-fight fact is the classifier prompt's canonical case.",
    renderImpact: "Planner receives the principle: \"Make the tiny gesture visible and the reaction huge.\"",
    example:
      "\"A bar fight ends when {NAME} raises an eyebrow.\" → the eyebrow clearly readable in the frame; the entire brawl frozen because of it.",
    sourceRefs: [CLASSIFIER_PROMPT, SUBTYPE_GUIDANCE],
    authoredStatus: "code-derived",
  },

  // logic_formal_impossibility
  infinity_impossibility: {
    meaning: "The fact completes, exceeds, or manipulates infinity — the canonical \"counted to infinity, twice\" territory.",
    renderImpact:
      "Planner receives the principle: \"Visualize completed infinity, infinite loops, or impossible scale through cinematic metaphor.\"",
    example:
      "\"{NAME} counted to infinity. Twice.\" → a cinematic infinite number-scape visibly completed — twice — around a calm {NAME}.",
    sourceRefs: [CLASSIFIER_PROMPT, SUBTYPE_GUIDANCE],
    authoredStatus: "code-derived",
  },
  probability_impossibility: {
    meaning: "An outcome that probability makes impossible, not just unlikely — a seven on a six-sided die.",
    renderImpact:
      "Planner receives the principle: \"Show the impossible outcome with enough context that the probability rule is obvious (e.g. a seven on a six-sided die).\"",
    example:
      "\"{NAME} rolled a seven on a six-sided die.\" → the die large and legible with seven pips, its six-sidedness clearly readable.",
    sourceRefs: [CLASSIFIER_PROMPT, SUBTYPE_GUIDANCE],
    authoredStatus: "code-derived",
  },
  rule_system_impossibility: {
    meaning: "A game or defined rule system is beaten in a way its own rules make impossible.",
    renderImpact:
      "Planner receives the principle: \"Show the impossible game/system state in a way that makes the rule legible.\"",
    example:
      "\"{NAME} can win Connect Four in three moves.\" → the board state itself shows the impossible win, legible to anyone who knows the game.",
    sourceRefs: [CLASSIFIER_PROMPT, SUBTYPE_GUIDANCE],
    authoredStatus: "code-derived",
  },
  paradox_or_undefined_impossibility: {
    meaning:
      "A logical paradox or mathematically undefined operation — divide-by-zero and square-circle facts land here.",
    renderImpact:
      "Planner receives the principle: \"Use paradoxical objects or impossible geometry; covers divide-by-zero and undefined-state cases.\"",
    example:
      "\"{NAME} can divide by zero.\" → reality rendered as impossible geometry gracefully resolving around {NAME} instead of erroring.",
    sourceRefs: [CLASSIFIER_PROMPT, SUBTYPE_GUIDANCE],
    authoredStatus: "code-derived",
  },
  formal_language_impossibility: {
    meaning:
      "A formal-language, notation, or symbol-system rule is broken — like knowing the LAST four digits of pi, which has no last digits.",
    renderImpact:
      "Planner receives the principle: \"Visualize the broken language/syntax rule through a symbolic concrete scene.\" (The authored pi-PIN example adds: showing four crisp digits is encouraged; never render long streams of pi.)",
    example:
      "\"{NAME}'s PIN is the last four digits of pi.\" → a keypad showing four crisp digits, the joke concrete without walls of pi.",
    sourceRefs: [CLASSIFIER_PROMPT, SUBTYPE_GUIDANCE],
    authoredStatus: "code-derived",
  },

  // intellectual_omniscience
  hidden_knowledge: {
    meaning: "The subject knows secrets, mysteries, confidential truths, or inaccessible information.",
    renderImpact:
      "Planner receives the principle: \"Secrets, mysteries, confidential truths, inaccessible information.\" — stage the barrier and the subject's effortless access.",
    example:
      "\"{NAME} knows Victoria's secret.\" → elegant fashion-boutique secret-keeping visual language (the brand is the joke), no real logos.",
    sourceRefs: [CLASSIFIER_PROMPT, SUBTYPE_GUIDANCE],
    authoredStatus: "code-derived",
  },
  future_prediction: {
    meaning: "The subject knows future answers, outcomes, or random results before they happen.",
    renderImpact:
      "Planner receives the principle: \"Future answers, outcomes, or random results known early.\"",
    example:
      "\"{NAME} knows what the Magic 8 Ball will say before it's shaken.\" → the ball untouched, its answer already reflected in {NAME}'s knowing look.",
    sourceRefs: [CLASSIFIER_PROMPT, SUBTYPE_GUIDANCE],
    authoredStatus: "code-derived",
  },
  impossible_problem_solving: {
    meaning: "The subject solves problems before they are available, posed, or solvable.",
    renderImpact:
      "Planner receives the principle: \"Problems solved before available or solvable.\"",
    example:
      "\"{NAME} solves the crossword before the clues are printed.\" → a completed grid beside a printing press still producing the blank puzzle.",
    sourceRefs: [CLASSIFIER_PROMPT, SUBTYPE_GUIDANCE],
    authoredStatus: "code-derived",
  },
  memory_omniscience: {
    meaning: "Impossible memory — remembering the future, the unwitnessed, or the forgotten.",
    renderImpact:
      "Planner receives the principle: \"Impossible memories, future memories, forgotten or unwitnessed events.\"",
    example:
      "\"{NAME} remembers tomorrow.\" → tomorrow rendered as a crisp photograph already in {NAME}'s album.",
    sourceRefs: [CLASSIFIER_PROMPT, SUBTYPE_GUIDANCE],
    authoredStatus: "code-derived",
  },
  strategic_omniscience: {
    meaning: "The subject knows entire strategies, opponents' moves, or plans before they unfold.",
    renderImpact:
      "Planner receives the principle: \"Entire strategies, opponent moves, or plans known ahead.\"",
    example:
      "\"{NAME} knows your next move before you do.\" → the opponent's undecided move already marked and countered on {NAME}'s side of the board.",
    sourceRefs: [CLASSIFIER_PROMPT, SUBTYPE_GUIDANCE],
    authoredStatus: "code-derived",
  },
  secret_mastery: {
    meaning: "The subject has mastered hidden systems, elite knowledge, forbidden techniques, or secret skills.",
    renderImpact:
      "Planner receives the principle: \"Hidden systems, elite knowledge, forbidden techniques, secret skills.\"",
    example:
      "\"{NAME} knows the secret menu before the restaurant opens.\" → staff stunned as {NAME} orders from a menu no one has written yet.",
    sourceRefs: [CLASSIFIER_PROMPT, SUBTYPE_GUIDANCE],
    authoredStatus: "code-derived",
  },

  // technology_system_reaction
  security_system_submission: {
    meaning: "Access-control systems (passwords, locks, checkpoints, logins) unlock, grant access, or submit to the subject.",
    renderImpact:
      "Planner receives the principle: \"Access systems unlock, grant access, or submit.\"",
    example:
      "\"The system logs itself in for {NAME}.\" → a login screen visibly completing itself as {NAME} approaches, no keys touched.",
    sourceRefs: [CLASSIFIER_PROMPT, SUBTYPE_GUIDANCE],
    authoredStatus: "code-derived",
  },
  device_obedience: {
    meaning: "Hardware anticipates, obeys, or serves the subject like a loyal attendant.",
    renderImpact: "Planner receives the principle: \"Hardware anticipates, obeys, or serves.\"",
    example:
      "\"The printer apologizes to {NAME} first.\" → a printer displaying a contrite status message before {NAME} even reaches it.",
    sourceRefs: [CLASSIFIER_PROMPT, SUBTYPE_GUIDANCE],
    authoredStatus: "code-derived",
  },
  software_permission_inversion: {
    meaning: "The normal permission flow is inverted — the software asks the subject for permission instead of the reverse.",
    renderImpact:
      "Planner receives the principle: \"App or software asks the subject for permission.\"",
    example:
      "\"Apps ask {NAME} for permission.\" → a phone screen with a permission dialog politely addressed to {NAME}, Allow/Deny buttons awaiting their verdict.",
    sourceRefs: [CLASSIFIER_PROMPT, SUBTYPE_GUIDANCE],
    authoredStatus: "code-derived",
  },
  ai_deference: {
    meaning: "AI or robots treat the subject as the higher intelligence, deferring to their judgment.",
    renderImpact:
      "Planner receives the principle: \"AI or robots treat the subject as higher intelligence.\"",
    example:
      "\"AI asks {NAME} for permission to think.\" → a glowing AI interface in a visibly deferential waiting state, cursor paused for {NAME}'s nod.",
    sourceRefs: [CLASSIFIER_PROMPT, SUBTYPE_GUIDANCE],
    authoredStatus: "code-derived",
  },
  machine_intimidation: {
    meaning: "A machine reacts to the subject with defeat, hesitation, or submission — beaten without a contest.",
    renderImpact:
      "Planner receives the principle: \"Machine reacts with defeat, hesitation, or submission.\"",
    example:
      "\"{NAME}'s chess computer resigns while unplugged.\" → the machine dark and unplugged, yet its resignation unmistakably displayed.",
    sourceRefs: [CLASSIFIER_PROMPT, SUBTYPE_GUIDANCE],
    authoredStatus: "code-derived",
  },
  network_system_reaction: {
    meaning: "Large-scale digital infrastructure — networks, servers, the internet itself — responds to the subject.",
    renderImpact:
      "Planner receives the principle: \"Large-scale networks, servers, or infrastructure respond.\"",
    example:
      "\"The servers stand at attention when {NAME} walks in.\" → whole server racks lighting up in synchronized salute as {NAME} enters the data center.",
    sourceRefs: [CLASSIFIER_PROMPT, SUBTYPE_GUIDANCE],
    authoredStatus: "code-derived",
  },

  // intrinsic_legendary_attribute
  body_feature_impossibility: {
    meaning: "A body feature (beard, fist, jawline, eyes, hands) has an impossible legendary property.",
    renderImpact:
      "Planner receives the principle: \"Beard, fist, jawline, eyes, hands, or other body feature with an impossible legendary property.\"",
    example:
      "\"Under {NAME}'s beard is another fist.\" → the impossible feature staged as a natural, mythic part of {NAME}'s body.",
    sourceRefs: [CLASSIFIER_PROMPT, SUBTYPE_GUIDANCE],
    authoredStatus: "code-derived",
  },
  aura_property: {
    meaning: "An invisible personal quality (confidence, charisma, presence) manifests as a visible aura, field, or atmosphere.",
    renderImpact:
      "Planner receives the principle: \"Invisible quality represented as aura, field, atmosphere, or distortion.\"",
    example:
      "\"{NAME}'s confidence has its own gravitational pull.\" → a visible field around {NAME} that bends light and pulls loose objects inward.",
    sourceRefs: [CLASSIFIER_PROMPT, SUBTYPE_GUIDANCE],
    authoredStatus: "code-derived",
  },
  biological_impossibility: {
    meaning:
      "A biological property, bodily output, or life-sign (tears, blood, breath, heartbeat, fingerprints, DNA, voice) has an impossible legendary effect.",
    renderImpact:
      "Planner receives the principle: \"Biological property, bodily output, biometric marker, or life-sign with an impossible legendary effect (tears, blood, breath, heartbeat, fingerprints, DNA, voice).\"",
    example:
      "\"{NAME}'s tears cure disease. They have never cried.\" → the miraculous property implied and mythic, the composure intact.",
    sourceRefs: [CLASSIFIER_PROMPT, SUBTYPE_GUIDANCE],
    authoredStatus: "code-derived",
  },
  metaphor_made_physical: {
    meaning: "A common phrase or figure of speech is literally, physically true of the subject.",
    renderImpact: "Planner receives the principle: \"Common phrase becomes physically true.\"",
    example:
      "\"When {NAME} speaks, their words carry weight.\" → spoken words rendered as heavy physical objects visibly bowing the table they land on.",
    sourceRefs: [CLASSIFIER_PROMPT, SUBTYPE_GUIDANCE],
    authoredStatus: "code-derived",
  },
  personal_effect_field: {
    meaning: "The immediate space around the subject behaves differently from the rest of the world.",
    renderImpact:
      "Planner receives the principle: \"Immediate space around the subject behaves differently.\"",
    example:
      "\"WiFi is stronger within ten feet of {NAME}.\" → full signal bars blooming on every device inside a visible radius around {NAME}.",
    sourceRefs: [CLASSIFIER_PROMPT, SUBTYPE_GUIDANCE],
    authoredStatus: "code-derived",
  },
  legendary_possession: {
    meaning: "An ordinary possession has impossible properties purely because it belongs to the subject.",
    renderImpact:
      "Planner receives the principle: \"Ordinary possession has impossible properties because it belongs to the subject.\"",
    example:
      "\"{NAME}'s sunglasses block the sun from seeing them.\" → ordinary sunglasses, but it is the sun squinting and failing to make {NAME} out.",
    sourceRefs: [CLASSIFIER_PROMPT, SUBTYPE_GUIDANCE],
    authoredStatus: "code-derived",
  },

  // mundane_act_made_legendary
  domestic_task_mythologized: {
    meaning: "A household chore is treated as a legendary act.",
    renderImpact: "Planner receives the principle: \"Household chore becomes legendary.\"",
    example:
      "\"Dust surrenders before {NAME} even starts vacuuming.\" → the chore staged like a decisive victory, vacuum readable, dust in visible retreat.",
    sourceRefs: [CLASSIFIER_PROMPT, SUBTYPE_GUIDANCE],
    authoredStatus: "code-derived",
  },
  ordinary_errand_mythologized: {
    meaning: "A normal errand (shopping, mail, returns) becomes ceremonial or mythic.",
    renderImpact:
      "Planner receives the principle: \"Normal errand becomes ceremonial or mythic.\"",
    example:
      "\"Grocery carts steer perfectly straight for {NAME}.\" → a supermarket aisle staged like a ceremonial procession, the everyday errand still clearly readable.",
    sourceRefs: [CLASSIFIER_PROMPT, SUBTYPE_GUIDANCE],
    authoredStatus: "code-derived",
  },
  food_drink_ritualized: {
    meaning: "Food, drink, or cooking becomes a ritual, interrogation, or act of command.",
    renderImpact:
      "Planner receives the principle: \"Food, drink, or cooking becomes a ritual, interrogation, or act of command.\"",
    example:
      "\"Coffee beans confess to {NAME}.\" → a morning brew staged like an interrogation scene, beans under the lamp, {NAME} calmly in command.",
    sourceRefs: [CLASSIFIER_PROMPT, SUBTYPE_GUIDANCE],
    authoredStatus: "code-derived",
  },
  commute_travel_mythologized: {
    meaning: "Driving, parking, commuting, flying, or travel is treated as legendary.",
    renderImpact:
      "Planner receives the principle: \"Driving, parking, commuting, flying, or travel is treated as legendary.\"",
    example:
      "\"The curb moves over for {NAME} when they parallel park.\" → the curb itself visibly shifting to make room, the ordinary parking maneuver staged like an event.",
    sourceRefs: [CLASSIFIER_PROMPT, SUBTYPE_GUIDANCE],
    authoredStatus: "code-derived",
  },
  social_habit_mythologized: {
    meaning: "A normal greeting or social habit becomes a ceremony.",
    renderImpact:
      "Planner receives the principle: \"Normal greeting or social habit becomes a ceremony.\"",
    example:
      "\"Hands apply for the privilege of being shaken by {NAME}.\" → a formal application line of outstretched hands, the humble handshake turned ceremonial.",
    sourceRefs: [CLASSIFIER_PROMPT, SUBTYPE_GUIDANCE],
    authoredStatus: "code-derived",
  },
  work_task_mythologized: {
    meaning: "An ordinary professional task is treated as absurdly overhyped.",
    renderImpact:
      "Planner receives the principle: \"Ordinary professional task becomes overhyped.\"",
    example:
      "\"{NAME} doesn't prepare for demos. Demos prepare for {NAME}.\" → the demo setup arranging and rehearsing itself while {NAME} arrives, composed and worthy of it.",
    sourceRefs: [CLASSIFIER_PROMPT, SUBTYPE_GUIDANCE],
    authoredStatus: "code-derived",
  },
} satisfies Record<FactSubtype, ValueDoc>;
