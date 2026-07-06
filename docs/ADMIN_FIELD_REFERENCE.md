# Admin Field Reference — Enrichment Editor

> **GENERATED — do not edit by hand.** This document is rendered from the in-app
> field-documentation registry (`artifacts/overhype-me/src/components/admin/fieldDocs/`).
> To change it, edit the registry and run:
> `pnpm --filter @workspace/overhype-me run generate:field-docs`
> A CI test fails when this file is out of date with the registry.

The same content powers the info icons beside every field in the admin enrichment
editor (moderation Step 2 → Advanced Options, and Admin → Facts). Fields marked
*authored — verify* have no upstream prose in code and were written from traced
behavior; David's spot-check is requested.

## Contents

- [AI Visual Classification](#ai-visual-classification)
  - [Joke Mechanism (Archetype)](#joke-mechanism-archetype)
  - [Mechanism Subtype](#mechanism-subtype)
  - [Depiction Style](#depiction-style)
  - [Visualization Difficulty](#visualization-difficulty)
  - [Overhype Fit](#overhype-fit)
  - [Adult-Mode Compatibility](#adult-mode-compatibility)
  - [Adult-Mode Notes](#adult-mode-notes)
  - [Render Modifiers](#render-modifiers)
  - [Final hashtags — these ship on approval](#final-hashtags-these-ship-on-approval)
  - [AI suggested](#ai-suggested)
  - [Suggested Hashtags (3–8)](#suggested-hashtags-38)
  - [AI Classification Confidence](#ai-classification-confidence)
  - [Admin Review Notes](#admin-review-notes)
- [Visual Strategy Override](#visual-strategy-override)
  - [Visual Strategy Override](#visual-strategy-override)
  - [Visual Concept (Core Scene)](#visual-concept-core-scene)
  - [Moderator Intent (admin-only, not rendered)](#moderator-intent-admin-only-not-rendered)
  - [Subject Depiction Mode](#subject-depiction-mode)
  - [Subject Depiction Description](#subject-depiction-description)
  - [Required Visual Details](#required-visual-details)
  - [Forbidden Visual Details](#forbidden-visual-details)
  - [Scene Role Assignments](#scene-role-assignments)
  - [Composition Guidance](#composition-guidance)
  - [Extra Prompt Details (any style)](#extra-prompt-details-any-style)
  - [Do-Not-Render Additions](#do-not-render-additions)
  - [Override supporting-text policy](#override-supporting-text-policy)
  - [Override violence policy](#override-violence-policy)
- [References & Scene Entities](#references-scene-entities)
  - [Cultural / Inside References](#cultural-inside-references)
  - [Source phrase](#source-phrase)
  - [Reference type](#reference-type)
  - [Canonical reference](#canonical-reference)
  - [Explanation](#explanation)
  - [Visual implication](#visual-implication)
  - [Confidence](#confidence)
  - [Requires admin review](#requires-admin-review)
  - [Semantic Entities / Visual Referents](#semantic-entities-visual-referents)
  - [Surface text (verbatim case)](#surface-text-verbatim-case)
  - [Normalized text](#normalized-text)
  - [Entity kind](#entity-kind)
  - [Capitalization signal](#capitalization-signal)
  - [Visual referent](#visual-referent)
  - [Notes](#notes)
  - [Materially affects visual prompt](#materially-affects-visual-prompt)
  - [Requires admin review](#requires-admin-review)
  - [Confidence](#confidence)

## AI Visual Classification

### Joke Mechanism (Archetype)

*The joke's MECHANISM — the single most important classification on this form.*

- **Effect:** Render-affecting — feeds the prompt pipeline
- **Staleness:** Editing re-flags render scenarios as stale.
- **Editor surface:** field-label

**What it is**

The primary archetype classifies HOW the fact's joke works (its mechanism), not what it is superficially about. The classifier's own rule: "Classify by the joke mechanism, not by superficial topic" — a moon fact caused by a sneeze is a superhuman physical feat with an astronomical-consequence modifier, not a cosmic category.

There are 11 archetypes, each with its own hand-authored visual strategy. Getting this wrong sends the renderer down the wrong strategy entirely, so it is the first thing to check when a test render misses the joke.

**How the AI sets it**

The enrichment classifier reads the fact rendered to the canonical subject ("Alex", they/them) and picks exactly one archetype using per-archetype "use when…" rules, plus explicit disambiguation guidance (e.g. the redundant-mechanism rule: "threw a grenade and killed 50 people, then it exploded" is a superhuman physical feat, NOT temporal inversion — the explosion is a redundant normal mechanism).

A deterministic repair guard also runs after classification: a low-confidence temporal_causality_inversion on a thrown-weapon/redundant-mechanism pattern is auto-repaired to superhuman_physical_feat with the normal_function_rendered_unnecessary modifier.

**How it affects the render**

Selects the authored visual strategy template: the archetype's strategyBlock, core visual goal, i2i/t2i defaults, locked rules, and visualization examples are injected verbatim into the image-prompt planner under "AUTHORED VISUAL STRATEGY (apply this — do not improvise)".

Also echoed into the planner's TAXONOMY block marked "FIXED — DO NOT reclassify", and the plan validator requires the plan to keep this archetype.

Editing it flips existing test renders stale — rerun them to see the new strategy.

**Values (11)**

- `superhuman_physical_feat` — Use when a real physical action is exaggerated to impossible force, scale, speed, endurance, precision, sensory ability, or consequence. This is also where redundant-mechanism jokes belong: when a tool or weapon's normal mechanism (an explosion, a gunshot) happens AFTER the subject's power already achieved the result, classify here (with the normal_function_rendered_unnecessary modifier), NOT as temporal inversion.
  - *Render:* Selects the superhuman-feat strategy: a grounded cinematic scene showing the recognizable action AND its impossible consequence in the same image, with concrete visual proof (cracked ground, shockwaves, motion trails, scale contrast). Locked rule: "Show a real physical action and its impossible physical consequence in the same image whenever possible. Preserve the face, exaggerate the legend." The only archetype with its own authored t2i fallback; its six visualization examples are fully authored (including the canonical grenade redundant-mechanism example).
  - *Example:* "{NAME} once threw a grenade and killed 50 people, then it exploded." → the throw is the impossible force; the grenade is staged intact and unexploded in flight.
- `object_logic_impossibility` — Use when the object, tool, material, medium, or semantic object logic makes the action impossible — the joke is that the thing itself cannot logically support what the subject did with it (slamming a revolving door, strangling with a cordless phone).
  - *Render:* Selects the object-logic strategy: make the contradiction visually legible — show what the object is and why the result should be impossible, with the subject confident and in control. Uniquely has frame-selection guidance (direct_action / implied_aftermath / object_transformation / target_reaction). Locked rule: when the action is less funny to show directly, show the impossible aftermath and let the viewer infer the cause. Its five visualization examples are fully authored.
  - *Example:* "{NAME} can slam a revolving door." → the rotating mechanism is clearly visible, yet impossibly slammed shut; {NAME} stands beside it, casual and powerful.
- `environmental_obedience_immunity` — Use when nature, weather, darkness, water, fire, gravity, or another natural/environmental force avoids, obeys, yields to, personifies itself around, or fails to affect the subject. Per the mechanism-not-topic rule, a sun-blinking fact lands here (personified natural force), not in any cosmic category.
  - *Render:* Selects the environmental strategy: make the force visually obvious (enough rain/darkness/fire/wind that the viewer knows what is being defied) and show it reacting to the subject. Locked rule: "Show the environment reacting to the subject, not the subject reacting to the environment." Its visualization examples are marked authoring-pending in the strategy file (fact stubs without prose).
  - *Example:* "Rain avoids {NAME}." → a downpour drenches the whole street while the rain visibly parts around a dry, unbothered {NAME}.
- `authority_threat_reversal` — Use when a normal power, danger, authority, role, predator, institution, or responsibility relationship is inverted — the subject is normally the subordinate one, but the authority/threat now responds to them. The prompt's canonical example: a baby driving their mother home is this archetype (social role reversal), not a physics joke.
  - *Render:* Selects the reversal strategy: show who normally has power and make the inversion legible through body language, deference, ceremony, or fear. Per-subtype treatments diverge: social reversals stage grounded human comedy, institutional ones use official settings/procedure, predator ones show the threat recoiling or submitting. Locked rule: show the normal power relationship, then make the reversal visually obvious. Examples are marked authoring-pending (stubs, though the "Sharks have a {NAME} Week" stub carries an authored Shark Week cultural-reference annotation).
  - *Example:* "A baby drove {NAME}'s mother home." → a realistic car interior where the impossibility is who holds the driver's role, not the physics.
- `temporal_causality_inversion` — Use ONLY when the humor depends on impossible event order, time reversal, retrocausality, or an effect clearly occurring before its cause — broken time, sequence, process order, history, age, or reversibility. Critical disambiguation: "then" does NOT automatically mean temporal inversion. If a normal mechanism (grenade exploding, gun firing) happens after the result but the joke is that the subject's power made it unnecessary, that is a redundant mechanism → classify as superhuman_physical_feat (or the relevant power archetype) with normal_function_rendered_unnecessary instead. Before choosing this, ask: is the joke primarily about impossible time order, or did the subject's power simply beat the normal mechanism?
  - *Render:* Selects the temporal strategy: show the broken sequence so the viewer understands what should have happened first — before/after contrast, frozen action, reversed motion cues, impossible age relationships. The strategy block itself repeats the warning to never stage redundant-mechanism facts (e.g. the grenade) as an explosion before the throw. Locked rule: "Show the broken sequence." Examples are marked authoring-pending (fact stubs only).
  - *Example:* "{NAME} finished the race before it started." → {NAME} calmly crossing the finish line while the starting gun is still being raised behind them.
- `presence_induced_reaction_aura` — Use when the subject does little or nothing, but people, objects, opportunities, conflicts, crowds, or situations react because of their presence, reputation, aura, or tiny gesture. The prompt's disambiguation example: a bar fight ending because the subject raises an eyebrow is this archetype, not temporal inversion.
  - *Render:* Selects the aura strategy: contrast the subject's minimal, composed action against an exaggerated reaction around them — and the subject must look like this is normal, never confused by it. Locked rule: "The subject barely acts. The world reacts." Examples are marked authoring-pending (fact stubs only).
  - *Example:* "A bar fight ends when {NAME} raises an eyebrow." → brawlers frozen mid-swing, all eyes on {NAME}'s single raised eyebrow.
- `logic_formal_impossibility` — Use when the fact violates formal logic, math, infinity, probability, rules, games, paradox, or formal language. Per the mechanism-not-topic rule, counting to infinity is a logic/formal impossibility, not physical scale.
  - *Render:* Selects the formal-logic strategy: a symbolic scene where the broken rule feels physically real (impossible geometry, paradoxical objects, infinite loops, collapsing probability), with concise supporting numbers/symbols/equations explicitly permitted when they make the rule funnier to read. Locked rule: turn the formal impossibility into a physical visual metaphor. Examples are marked authoring-pending (though the pi-PIN stub carries partial authored guidance: show four crisp digits, never long streams of pi).
  - *Example:* "{NAME} counted to infinity. Twice." → an endless symbolic number-scape resolving around a calm {NAME}, rather than someone mouthing numbers.
- `intellectual_omniscience` — Use when the subject knows, predicts, solves, remembers, understands, or deduces something impossible — knowledge that should be hidden, unavailable, unwritten, or unknowable.
  - *Render:* Selects the omniscience strategy: show the knowledge barrier AND the subject's effortless access to it (sealed vaults, future reflections, overwhelmed experts) — never ordinary studying or hacking. Locked rule: "The subject knows what cannot be known, and the image must show why that knowledge should have been impossible." Examples are marked authoring-pending (though the "knows Victoria's secret" stub carries an authored brand cultural-reference annotation).
  - *Example:* "{NAME} knows what the Magic 8 Ball will say before it's shaken." → the answer already visible to {NAME} while the ball sits untouched.
- `technology_system_reaction` — Use when machines, apps, computers, passwords, AI, digital systems, networks, devices, or software react to, obey, defer to, or fail against the subject.
  - *Render:* Selects the technology strategy: the system must visibly change behavior because the subject is present (gates opening, screens changing state, robots pausing, AI deferring) — never a passive background prop or ordinary computer use. Concise supporting UI text/status messages are permitted when they help the reaction read. Locked rule: "The system reacts to the subject. Technology becomes the subordinate user." Examples are marked authoring-pending (fact stubs only).
  - *Example:* "{NAME}'s chess computer resigns while unplugged." → a dead, unplugged machine displaying its resignation to a calm {NAME}.
- `intrinsic_legendary_attribute` — Use when the subject has an impossible built-in trait, aura, body feature, biological property, personal field, possession, or metaphorical property made physical — the impossibility is part of who they are, not something they did.
  - *Render:* Selects the intrinsic-attribute strategy: make the impossible property feel intrinsic to the subject (body detail, aura, shadow, personal objects, the world's reaction), enhancing their mythic status rather than reading as a random external event; metaphorical facts get converted into a concrete visual form. Locked rule: "The subject is not just legendary because of what they do. Something about them is inherently impossible." Examples are marked authoring-pending (fact stubs only).
  - *Example:* "Under {NAME}'s beard is another fist." → the body feature itself is the impossible legend.
- `mundane_act_made_legendary` — Use when an ordinary everyday action, task, habit, errand, work activity, food/drink activity, or social behavior is treated as absurdly epic, mythic, dominant, or legendary.
  - *Render:* Selects the mundane-made-legendary strategy: keep the ordinary act clearly visible and specific (the comedy dies if it becomes generic hero imagery), then elevate it through staging, lighting, reactions, and ceremony. Locked rule: "Make the ordinary act visible, then stage it like a legendary event." Examples are marked authoring-pending (fact stubs only).
  - *Example:* "{NAME} doesn't prepare for demos. Demos prepare for {NAME}." → an ordinary work task staged like a world-changing ceremony.

**Examples**

- **Scenario:** "{NAME} once threw a grenade and killed 50 people, then it exploded."
  - **Input:** primaryArchetype: superhuman_physical_feat (NOT temporal_causality_inversion)
  - **Outcome:** The superhuman-feat strategy stages the throw as the overwhelming force with the explosion redundant — the canonical redundant-mechanism example from the classifier prompt.
- **Scenario:** "{NAME} sneezed and the moon left orbit."
  - **Input:** primaryArchetype: superhuman_physical_feat + modifier astronomical_consequence
  - **Outcome:** Classified by mechanism (a physical act at impossible scale), not topic (space) — no cosmic archetype exists.
- **Scenario:** "A baby drove {NAME}'s mother home."
  - **Input:** primaryArchetype: authority_threat_reversal, subtype social_role_reversal
  - **Outcome:** The reversal strategy stages grounded human comedy — the wrong person holding the role — rather than physics.

**Sources**

- `artifacts/api-server/src/lib/factEnrichmentConfig.ts` `FACT_ENRICHMENT_SYSTEM_DEFAULT` — The classifier system prompt — the authoritative definition of what the AI is told this field means.
- `artifacts/api-server/src/lib/imagePrompt/generator.ts` `buildImagePromptUserMessage` — Where the enrichment is injected into the image-prompt planner message (the TAXONOMY block is marked FIXED — DO NOT reclassify).
- `lib/api-zod/src/visualPromptStrategies.ts` `getVisualPromptStrategy` — The 11 authored per-archetype strategy templates the archetype selects between.
- `artifacts/api-server/src/lib/factRenderScenarios.ts` `renderAffectingEnrichment` — The render-input hash projection — fields listed here flip render-scenario tiles stale when edited.

### Mechanism Subtype

*The archetype's refinement — picks the one-sentence visual principle the planner must apply.*

- **Effect:** Render-affecting — feeds the prompt pipeline
- **Staleness:** Editing re-flags render scenarios as stale.
- **Editor surface:** field-label

**What it is**

Each archetype has 3–7 subtypes that pin down the joke's specific flavor (e.g. superhuman_physical_feat splits into force/strength/speed/endurance/precision/sensory scaling and ordinary-action-extreme-consequence). The subtype dropdown only offers subtypes valid for the selected archetype, and validation rejects a mismatched pair.

**How the AI sets it**

The classifier picks the subtype from the allowed list for its chosen archetype, using the per-archetype subtype rules in its system prompt. If it emits an invalid pair, one corrective retry re-asks with the allowed list.

**How it affects the render**

Injects the subtype's authored one-sentence visual principle into the planner as "Subtype guidance for {subtype}: …" — e.g. strength_scaled_action → "Show the subject physically controlling an impossibly massive object while looking confident and in control."

Echoed in the planner's FIXED taxonomy block; editing flips test renders stale.

**Values (60)**

- `force_scaled_action` — A physical action (a throw, punch, kick, impact) whose FORCE is exaggerated to impossible scale — the environment takes the hit. Also the home of redundant-mechanism weapon facts (with the normal_function_rendered_unnecessary modifier).
  - *Render:* Planner receives the principle: "Show force radiating outward from the action into the environment."
  - *Example:* "When {NAME} does pushups, they don't push themselves up — they push the Earth down." → the ground visibly compresses beneath their hands.
- `strength_scaled_action` — Lifting, carrying, holding, or manipulating something impossibly massive — raw strength is the exaggerated dimension.
  - *Render:* Planner receives the principle: "Show the subject physically controlling an impossibly massive object while looking confident and in control."
  - *Example:* "{NAME} can bench press a house." → a real-scale house lifted like a barbell, {NAME} calm, never crushed or struggling.
- `speed_scaled_action` — Movement or action performed at impossible speed.
  - *Render:* Planner receives the principle: "Show motion trails, displaced air, afterimages, or environmental blur while keeping the subject visually recognizable."
  - *Example:* "{NAME} once ran a marathon in a single stride." → motion trails and displaced air across the whole course, {NAME} crisp and recognizable at the center.
- `endurance_scaled_action` — The subject outlasts anything — effort, exhaustion, or wear simply never reaches them; the world gives out first.
  - *Render:* Planner receives the principle: "Show the world, equipment, or environment exhausted while the subject remains composed and powerful."
  - *Example:* "{NAME} doesn't get tired on the treadmill. The treadmill gets tired of {NAME}." → a smoking, slumped treadmill; {NAME} composed and barely sweating.
- `precision_scaled_action` — Impossible accuracy, trajectory, or perfection of a physical action.
  - *Render:* Planner receives the principle: "Show the impossible trajectory or perfect result clearly enough that the precision is obvious."
  - *Example:* "{NAME} threw a baseball around the world and caught it from behind." → a glowing curved motion trail wrapping the horizon back into {NAME}'s glove.
- `sensory_scaled_action` — A sense (sight, hearing, smell, touch, taste) operating at impossible range or resolution.
  - *Render:* Planner receives the principle: "Represent sensory power as a physical cinematic effect while keeping the subject central."
  - *Example:* "{NAME} can hear WiFi." → visible signal waves bending toward {NAME}'s ear as a physical cinematic effect.
- `ordinary_action_extreme_consequence` — A completely normal action (a sneeze, a step, a clap) produces a wildly disproportionate physical consequence — the moon-sneeze fact is the canonical case (classified by mechanism, not by its space topic).
  - *Render:* Planner receives the principle: "Make the ordinary action clear, then show the consequence at a wildly exaggerated scale."
  - *Example:* "When {NAME} sneezes, the moon changes orbit." → a casual sneeze in the foreground, a shockwave into the night sky, the moon subtly displaced.
- `mechanical_contradiction` — The object's mechanism physically cannot do what the fact claims (you cannot slam a door that revolves).
  - *Render:* Planner receives the principle: "Make the object's normal mechanism visible, then show it behaving in the impossible way."
  - *Example:* "{NAME} can slam a revolving door." → the rotating mechanism still visible, but bent into a hard-stopped, slammed position.
- `semantic_instrument_contradiction` — The tool's defining property (its NAME says what it can't do) contradicts the action — a cordless phone used for something that requires a cord.
  - *Render:* Planner receives the principle: "Show the impossible tool clearly and show the result or aftermath that should be impossible for that tool."
  - *Example:* "{NAME} can strangle someone with a cordless phone." → {NAME} holds a clearly cordless handset; the impossible aftermath is visible nearby, cause left to inference.
- `material_state_contradiction` — A material behaves in a state it cannot hold — vapor stacked like bricks, liquid folded like cloth.
  - *Render:* Planner receives the principle: "Turn the impossible material property into a clear physical visual."
  - *Example:* "{NAME} can stack fog." → translucent slabs of fog held in a neat stack, still misty at the edges so the impossibility reads.
- `medium_contradiction` — The surrounding medium (water, vacuum, fire) should make the action impossible, yet it succeeds inside that medium.
  - *Render:* Planner receives the principle: "Make the hostile medium obvious, then show the impossible action succeeding inside that medium."
  - *Example:* "{NAME} can start a fire underwater." → a bright flame burning fully submerged, bubbles and refracted light proving the water is real.
- `target_nature_contradiction` — The TARGET's own nature makes the result impossible — drowning a fish, sunburning a shadow.
  - *Render:* Planner receives the principle: "Show the target reacting in a way that contradicts what it naturally is."
  - *Example:* "{NAME} can drown a fish." → the fish visibly overwhelmed by the very water it should thrive in, {NAME} standing confidently by.
- `object_agency_inversion` — The object becomes the actor — it does the work, takes the initiative, or acts on its own because of the subject.
  - *Render:* Planner receives the principle: "Show the object taking the active role while the subject remains calm and in control."
  - *Example:* "The punching bag hits itself so {NAME} doesn't have to." → the bag mid-swing against itself while {NAME} watches, arms crossed.
- `environmental_immunity` — An environmental condition affects everything and everyone — except the subject, who is untouched.
  - *Render:* Planner receives the principle: "Show the environmental condition affecting the surrounding world while the subject remains untouched."
  - *Example:* "{NAME} walks through blizzards in a t-shirt." → the whole street buried and frozen while {NAME} strolls through untouched.
- `environmental_agency_inversion` — The natural force and the subject swap roles — the force becomes the affected party, victim, or subordinate ("Water gets {NAME}" instead of {NAME} getting wet).
  - *Render:* Planner receives the principle: "Show the environmental force behaving like it is the affected party, victim, or subordinate."
  - *Example:* "Water gets {NAME}." → water recoiling, cowering, or drenched-looking around a dominant, dry {NAME}.
- `environmental_control_interface` — The subject operates a natural force like a device — switching darkness off, adjusting gravity, dialing the wind.
  - *Render:* Planner receives the principle: "Make the abstract force feel physically controllable."
  - *Example:* "{NAME} turns the dark off." → {NAME}'s hand on a physical switch as darkness visibly drains out of the scene.
- `environmental_retreat_obedience` — The force actively avoids, parts around, or clears a path for the subject, as if obeying them.
  - *Render:* Planner receives the principle: "Show the force parting, bending, clearing, or retreating around the subject."
  - *Example:* "Rain avoids {NAME}." → a heavy downpour with a visible dry corridor bending around {NAME}.
- `personified_natural_force` — A natural force behaves like a person around the subject — the sun blinking is the classifier prompt's canonical case (this, not a cosmic category).
  - *Render:* Planner receives the principle: "Give the natural force a readable reaction while keeping it cinematic and not overly cartoonish unless style calls for it."
  - *Example:* "The sun blinked when it saw {NAME}." → the sun given a readable, cinematic reaction — dimming mid-blink — over an unbothered {NAME}.
- `social_role_reversal` — An everyday social role or responsibility is held by the wrong person — the baby driving {NAME}'s mother home is the canonical example.
  - *Render:* Planner receives the principle: "Stage realistically so the humor comes from the wrong person holding authority or responsibility."
  - *Example:* "Baby {NAME} drives their mom home from the hospital." → grounded, realistic car interior; the joke is entirely who is behind the wheel.
- `institutional_authority_reversal` — An institution (school, court, security, the law) submits to or reverses its normal role toward the subject.
  - *Render:* Planner receives the principle: "Use official environments and procedural symbols to show the institution submitting or reversing its normal role."
  - *Example:* "{NAME}'s teachers raised their hands when they had questions." → a classroom where the adult teacher raises a hand toward school-age {NAME}.
- `predator_danger_reversal` — Something normally dangerous (a predator, Death, a threat) treats the subject as the real threat, authority, or spectacle.
  - *Render:* Planner receives the principle: "Show the normally dangerous thing reacting as if the subject is the real threat, authority, or spectacle."
  - *Example:* "Sharks have a {NAME} Week." → sharks gathered as the rapt audience around a screen showing {NAME} — the Shark Week framing reversed, no real network logos.
- `pure_timeline_inversion` — The timeline itself is impossible — ages, birth order, or event order contradict history. Only for genuine time-order jokes, never redundant-mechanism facts.
  - *Render:* Planner receives the principle: "Show one clear contradiction in timeline, age, sequence, or event order."
  - *Example:* "{NAME} was born before their parents." → one clear, readable age/timeline contradiction staged in a single frame.
- `pre_cause_consequence` — The effect exists before its cause has happened. Careful: if the cause still happens later but is merely redundant (the grenade that explodes after the kill), that is superhuman_physical_feat with normal_function_rendered_unnecessary, NOT this.
  - *Render:* Planner receives the principle: "Show the cause still pending while the effect is already visible."
  - *Example:* "The punching bag was bruised before {NAME} hit it." → the bruise already there while {NAME}'s first punch is still mid-air.
- `reverse_process_entropy_reversal` — A normally irreversible process runs backward for the subject — unscrambling eggs, un-squeezing toothpaste.
  - *Render:* Planner receives the principle: "Show the completed mess or changed state reassembling into its earlier form."
  - *Example:* "{NAME} can unscramble an egg." → the scrambled egg visibly reassembling into a pristine whole egg in {NAME}'s hand.
- `surrender` — Conflict, opposition, or enemies simply give up because the subject is present.
  - *Render:* Planner receives the principle: "Show the subject calm and still while others visibly give up or submit."
  - *Example:* "Battlefield conflict stops when {NAME} arrives." → both sides lowering weapons the moment {NAME} steps into frame, calm and still.
- `awe_deference` — People or the environment treat the subject as naturally, unquestionably important — reverence without any threat.
  - *Render:* Planner receives the principle: "Show people or environment treating the subject as naturally important."
  - *Example:* "Rooms stand up when {NAME} walks in." → an entire room rising in spontaneous deference while {NAME} strolls through as if it's normal.
- `prestige_transfer` — Mere contact with or acknowledgment from the subject confers status on someone or something else.
  - *Render:* Planner receives the principle: "Show brief contact with the subject transferring status."
  - *Example:* "A pat on the back from {NAME} is resume-worthy." → someone proudly framing the moment of the pat like a diploma.
- `world_waits_for_subject` — Events, opportunities, or the world itself pause and wait for the subject rather than proceeding without them.
  - *Render:* Planner receives the principle: "Show the world paused, prepared, or expectant around the subject."
  - *Example:* "Opportunity waits for {NAME}." → opportunity personified standing patiently at {NAME}'s door, hand raised but not knocking, while {NAME} finishes their coffee.
- `object_obsession` — An object is emotionally or socially fixated on the subject — devotion inverted from user-to-thing into thing-to-subject.
  - *Render:* Planner receives the principle: "Show an object emotionally or socially fixated on the subject."
  - *Example:* "{NAME}'s phone is addicted to them." → the phone straining toward {NAME}, screen lighting up with longing notifications.
- `respectful_refusal` — A nuisance, pest, or obstacle voluntarily declines to bother the subject, out of respect.
  - *Render:* Planner receives the principle: "Show a nuisance or obstacle voluntarily holding back."
  - *Example:* "Mosquitoes refuse to bite {NAME}." → a swarm hovering at a respectful distance, one almost bowing, while {NAME} lounges unbitten.
- `tiny_gesture_massive_reaction` — A minimal gesture (a raised eyebrow, a nod) triggers a massive response — the eyebrow-ends-the-bar-fight fact is the classifier prompt's canonical case.
  - *Render:* Planner receives the principle: "Make the tiny gesture visible and the reaction huge."
  - *Example:* "A bar fight ends when {NAME} raises an eyebrow." → the eyebrow clearly readable in the frame; the entire brawl frozen because of it.
- `infinity_impossibility` — The fact completes, exceeds, or manipulates infinity — the canonical "counted to infinity, twice" territory.
  - *Render:* Planner receives the principle: "Visualize completed infinity, infinite loops, or impossible scale through cinematic metaphor."
  - *Example:* "{NAME} counted to infinity. Twice." → a cinematic infinite number-scape visibly completed — twice — around a calm {NAME}.
- `probability_impossibility` — An outcome that probability makes impossible, not just unlikely — a seven on a six-sided die.
  - *Render:* Planner receives the principle: "Show the impossible outcome with enough context that the probability rule is obvious (e.g. a seven on a six-sided die)."
  - *Example:* "{NAME} rolled a seven on a six-sided die." → the die large and legible with seven pips, its six-sidedness clearly readable.
- `rule_system_impossibility` — A game or defined rule system is beaten in a way its own rules make impossible.
  - *Render:* Planner receives the principle: "Show the impossible game/system state in a way that makes the rule legible."
  - *Example:* "{NAME} can win Connect Four in three moves." → the board state itself shows the impossible win, legible to anyone who knows the game.
- `paradox_or_undefined_impossibility` — A logical paradox or mathematically undefined operation — divide-by-zero and square-circle facts land here.
  - *Render:* Planner receives the principle: "Use paradoxical objects or impossible geometry; covers divide-by-zero and undefined-state cases."
  - *Example:* "{NAME} can divide by zero." → reality rendered as impossible geometry gracefully resolving around {NAME} instead of erroring.
- `formal_language_impossibility` — A formal-language, notation, or symbol-system rule is broken — like knowing the LAST four digits of pi, which has no last digits.
  - *Render:* Planner receives the principle: "Visualize the broken language/syntax rule through a symbolic concrete scene." (The authored pi-PIN example adds: showing four crisp digits is encouraged; never render long streams of pi.)
  - *Example:* "{NAME}'s PIN is the last four digits of pi." → a keypad showing four crisp digits, the joke concrete without walls of pi.
- `hidden_knowledge` — The subject knows secrets, mysteries, confidential truths, or inaccessible information.
  - *Render:* Planner receives the principle: "Secrets, mysteries, confidential truths, inaccessible information." — stage the barrier and the subject's effortless access.
  - *Example:* "{NAME} knows Victoria's secret." → elegant fashion-boutique secret-keeping visual language (the brand is the joke), no real logos.
- `future_prediction` — The subject knows future answers, outcomes, or random results before they happen.
  - *Render:* Planner receives the principle: "Future answers, outcomes, or random results known early."
  - *Example:* "{NAME} knows what the Magic 8 Ball will say before it's shaken." → the ball untouched, its answer already reflected in {NAME}'s knowing look.
- `impossible_problem_solving` — The subject solves problems before they are available, posed, or solvable.
  - *Render:* Planner receives the principle: "Problems solved before available or solvable."
  - *Example:* "{NAME} solves the crossword before the clues are printed." → a completed grid beside a printing press still producing the blank puzzle.
- `memory_omniscience` — Impossible memory — remembering the future, the unwitnessed, or the forgotten.
  - *Render:* Planner receives the principle: "Impossible memories, future memories, forgotten or unwitnessed events."
  - *Example:* "{NAME} remembers tomorrow." → tomorrow rendered as a crisp photograph already in {NAME}'s album.
- `strategic_omniscience` — The subject knows entire strategies, opponents' moves, or plans before they unfold.
  - *Render:* Planner receives the principle: "Entire strategies, opponent moves, or plans known ahead."
  - *Example:* "{NAME} knows your next move before you do." → the opponent's undecided move already marked and countered on {NAME}'s side of the board.
- `secret_mastery` — The subject has mastered hidden systems, elite knowledge, forbidden techniques, or secret skills.
  - *Render:* Planner receives the principle: "Hidden systems, elite knowledge, forbidden techniques, secret skills."
  - *Example:* "{NAME} knows the secret menu before the restaurant opens." → staff stunned as {NAME} orders from a menu no one has written yet.
- `security_system_submission` — Access-control systems (passwords, locks, checkpoints, logins) unlock, grant access, or submit to the subject.
  - *Render:* Planner receives the principle: "Access systems unlock, grant access, or submit."
  - *Example:* "The system logs itself in for {NAME}." → a login screen visibly completing itself as {NAME} approaches, no keys touched.
- `device_obedience` — Hardware anticipates, obeys, or serves the subject like a loyal attendant.
  - *Render:* Planner receives the principle: "Hardware anticipates, obeys, or serves."
  - *Example:* "The printer apologizes to {NAME} first." → a printer displaying a contrite status message before {NAME} even reaches it.
- `software_permission_inversion` — The normal permission flow is inverted — the software asks the subject for permission instead of the reverse.
  - *Render:* Planner receives the principle: "App or software asks the subject for permission."
  - *Example:* "Apps ask {NAME} for permission." → a phone screen with a permission dialog politely addressed to {NAME}, Allow/Deny buttons awaiting their verdict.
- `ai_deference` — AI or robots treat the subject as the higher intelligence, deferring to their judgment.
  - *Render:* Planner receives the principle: "AI or robots treat the subject as higher intelligence."
  - *Example:* "AI asks {NAME} for permission to think." → a glowing AI interface in a visibly deferential waiting state, cursor paused for {NAME}'s nod.
- `machine_intimidation` — A machine reacts to the subject with defeat, hesitation, or submission — beaten without a contest.
  - *Render:* Planner receives the principle: "Machine reacts with defeat, hesitation, or submission."
  - *Example:* "{NAME}'s chess computer resigns while unplugged." → the machine dark and unplugged, yet its resignation unmistakably displayed.
- `network_system_reaction` — Large-scale digital infrastructure — networks, servers, the internet itself — responds to the subject.
  - *Render:* Planner receives the principle: "Large-scale networks, servers, or infrastructure respond."
  - *Example:* "The servers stand at attention when {NAME} walks in." → whole server racks lighting up in synchronized salute as {NAME} enters the data center.
- `body_feature_impossibility` — A body feature (beard, fist, jawline, eyes, hands) has an impossible legendary property.
  - *Render:* Planner receives the principle: "Beard, fist, jawline, eyes, hands, or other body feature with an impossible legendary property."
  - *Example:* "Under {NAME}'s beard is another fist." → the impossible feature staged as a natural, mythic part of {NAME}'s body.
- `aura_property` — An invisible personal quality (confidence, charisma, presence) manifests as a visible aura, field, or atmosphere.
  - *Render:* Planner receives the principle: "Invisible quality represented as aura, field, atmosphere, or distortion."
  - *Example:* "{NAME}'s confidence has its own gravitational pull." → a visible field around {NAME} that bends light and pulls loose objects inward.
- `biological_impossibility` — A biological property, bodily output, or life-sign (tears, blood, breath, heartbeat, fingerprints, DNA, voice) has an impossible legendary effect.
  - *Render:* Planner receives the principle: "Biological property, bodily output, biometric marker, or life-sign with an impossible legendary effect (tears, blood, breath, heartbeat, fingerprints, DNA, voice)."
  - *Example:* "{NAME}'s tears cure disease. They have never cried." → the miraculous property implied and mythic, the composure intact.
- `metaphor_made_physical` — A common phrase or figure of speech is literally, physically true of the subject.
  - *Render:* Planner receives the principle: "Common phrase becomes physically true."
  - *Example:* "When {NAME} speaks, their words carry weight." → spoken words rendered as heavy physical objects visibly bowing the table they land on.
- `personal_effect_field` — The immediate space around the subject behaves differently from the rest of the world.
  - *Render:* Planner receives the principle: "Immediate space around the subject behaves differently."
  - *Example:* "WiFi is stronger within ten feet of {NAME}." → full signal bars blooming on every device inside a visible radius around {NAME}.
- `legendary_possession` — An ordinary possession has impossible properties purely because it belongs to the subject.
  - *Render:* Planner receives the principle: "Ordinary possession has impossible properties because it belongs to the subject."
  - *Example:* "{NAME}'s sunglasses block the sun from seeing them." → ordinary sunglasses, but it is the sun squinting and failing to make {NAME} out.
- `domestic_task_mythologized` — A household chore is treated as a legendary act.
  - *Render:* Planner receives the principle: "Household chore becomes legendary."
  - *Example:* "Dust surrenders before {NAME} even starts vacuuming." → the chore staged like a decisive victory, vacuum readable, dust in visible retreat.
- `ordinary_errand_mythologized` — A normal errand (shopping, mail, returns) becomes ceremonial or mythic.
  - *Render:* Planner receives the principle: "Normal errand becomes ceremonial or mythic."
  - *Example:* "Grocery carts steer perfectly straight for {NAME}." → a supermarket aisle staged like a ceremonial procession, the everyday errand still clearly readable.
- `food_drink_ritualized` — Food, drink, or cooking becomes a ritual, interrogation, or act of command.
  - *Render:* Planner receives the principle: "Food, drink, or cooking becomes a ritual, interrogation, or act of command."
  - *Example:* "Coffee beans confess to {NAME}." → a morning brew staged like an interrogation scene, beans under the lamp, {NAME} calmly in command.
- `commute_travel_mythologized` — Driving, parking, commuting, flying, or travel is treated as legendary.
  - *Render:* Planner receives the principle: "Driving, parking, commuting, flying, or travel is treated as legendary."
  - *Example:* "The curb moves over for {NAME} when they parallel park." → the curb itself visibly shifting to make room, the ordinary parking maneuver staged like an event.
- `social_habit_mythologized` — A normal greeting or social habit becomes a ceremony.
  - *Render:* Planner receives the principle: "Normal greeting or social habit becomes a ceremony."
  - *Example:* "Hands apply for the privilege of being shaken by {NAME}." → a formal application line of outstretched hands, the humble handshake turned ceremonial.
- `work_task_mythologized` — An ordinary professional task is treated as absurdly overhyped.
  - *Render:* Planner receives the principle: "Ordinary professional task becomes overhyped."
  - *Example:* "{NAME} doesn't prepare for demos. Demos prepare for {NAME}." → the demo setup arranging and rehearsing itself while {NAME} arrives, composed and worthy of it.

**Examples**

- **Scenario:** "{NAME} bench-presses the Earth." (superhuman_physical_feat)
  - **Input:** subtype: strength_scaled_action
  - **Outcome:** Planner receives: "Show the subject physically controlling an impossibly massive object while looking confident and in control."
- **Scenario:** "{NAME} rolled a seven on a six-sided die." (logic_formal_impossibility)
  - **Input:** subtype: probability_impossibility
  - **Outcome:** Planner shows the impossible outcome with enough context that the broken probability rule is obvious.

**Sources**

- `artifacts/api-server/src/lib/factEnrichmentConfig.ts` `FACT_ENRICHMENT_SYSTEM_DEFAULT` — The classifier system prompt — the authoritative definition of what the AI is told this field means.
- `lib/api-zod/src/visualPromptStrategies.ts` `getSubtypeGuidance` — The per-subtype principle sentences injected into the planner.
- `artifacts/api-server/src/lib/factRenderScenarios.ts` `renderAffectingEnrichment` — The render-input hash projection — fields listed here flip render-scenario tiles stale when edited.

### Depiction Style

*How literally vs. symbolically the fact should be depicted.*

- **Effect:** Advisory only — AI-planner context, no fixed compiler directive
- **Staleness:** Editing re-flags render scenarios as stale.
- **Editor surface:** field-label

**What it is**

A five-way classification of the depiction approach: show the fact literally as an event, abstract it symbolically, turn it into a concrete metaphor, stage it as realistic social roleplay, or mix literal and symbolic elements.

**How the AI sets it**

The classifier judges whether the fact CAN be shown literally (most physical feats) or needs symbolic/metaphorical treatment (logic, infinity, wordplay), per the definitions in its system prompt.

**How it affects the render**

Advisory to the planner: it is echoed in the TAXONOMY block so the scene-writing AI weighs it, but no deterministic compiler directive keys off it — the authored archetype strategy and modifiers do the hard steering.

Despite being advisory, it IS part of the render-input hash — editing it flips test renders stale so you can rerun and compare.

**Values (5)**

- `literal_dramatization` — The fact should be depicted directly, as if it literally happened — the scene shows the impossible thing itself, dramatized cinematically.
  - *Render:* The planner writes a scene that stages the fact as a real event. Most physical-feat and reversal facts land here.
  - *Example:* "{NAME} bench-presses a bus" → a scene of the subject actually lifting a bus, full cinematic staging.
- `symbolic_abstraction` — The fact is too conceptual to show literally and needs symbolic visual language — the image represents the idea, not the event.
  - *Render:* The planner leans on symbols, scale metaphors, and abstract staging instead of a literal event. Common for logic/infinity facts.
  - *Example:* "{NAME} counted to infinity. Twice." → an endless number-scape receding past the horizon rather than a person counting.
- `metaphorical_visualization` — The fact should become a concrete visual metaphor — a phrase or concept made physically true in the image.
  - *Render:* The planner picks one clear metaphor and renders it as a real object/scene (a 'metaphor made physical').
  - *Example:* "{NAME}'s handshake seals deals" → a literal wax-seal stamp pressed by a handshake onto a giant contract.
- `grounded_roleplay` — The fact should be staged as a realistic human/social scene — the comedy comes from people behaving impossibly, not from physics.
  - *Render:* The planner keeps the scene physically plausible and puts the impossibility in the social roles and reactions (e.g. authority reversals).
  - *Example:* "A baby drove {NAME}'s mother home" → a realistic car interior; the impossibility is who's driving, not the physics.
- `mixed` — The fact needs both literal and symbolic elements to land.
  - *Render:* The planner combines a literal core event with symbolic supporting elements; expect a busier scene.
  - *Example:* "{NAME} argued with gravity and won" → a literal courtroom (roleplay) with gravity personified as a defeated force (symbolic).

**Examples**

- **Scenario:** "{NAME} counted to infinity. Twice."
  - **Input:** visualLiteralness: symbolic_abstraction
  - **Outcome:** The planner reaches for symbolic visual language (endless recursion imagery) instead of a person mouthing numbers.
- **Scenario:** "A baby drove {NAME}'s mother home."
  - **Input:** visualLiteralness: grounded_roleplay
  - **Outcome:** The planner keeps physics realistic and puts the impossibility in the social roles.

**Sources**

- `artifacts/api-server/src/lib/factEnrichmentConfig.ts` `FACT_ENRICHMENT_SYSTEM_DEFAULT` — The classifier system prompt — the authoritative definition of what the AI is told this field means.
- `artifacts/api-server/src/lib/imagePrompt/generator.ts` `buildImagePromptUserMessage` — Where the enrichment is injected into the image-prompt planner message (the TAXONOMY block is marked FIXED — DO NOT reclassify).
- `artifacts/api-server/src/lib/factRenderScenarios.ts` `renderAffectingEnrichment` — The render-input hash projection — fields listed here flip render-scenario tiles stale when edited.

### Visualization Difficulty

*The AI's rating of how hard this fact is to visualize.*

- **Effect:** Advisory only — AI-planner context, no fixed compiler directive
- **Staleness:** Editing re-flags render scenarios as stale.
- **Editor surface:** field-label

**What it is**

A low/medium/high rating of visualization difficulty. High-complexity facts (abstract, wordplay-heavy, ambiguous) are where AI renders most often miss — the admin UI shows a "Hard to visualize" warning for them in both the editor and the Step-2 visual review summary.

**How the AI sets it**

The classifier rates difficulty per its prompt definitions: low = straightforward, medium = needs interpretation but has clear anchors, high = abstract/wordplay/ambiguous.

**How it affects the render**

Advisory to the planner only — no compiler directive branches on it. Treat 'high' as a cue to inspect test renders closely and reach for a Visual Strategy Override when the AI's interpretation misses.

In the render-input hash: editing it flips test renders stale.

**Values (3)**

- `low` — Straightforward visual representation — the fact translates to an image with no interpretation needed.
  - *Render:* No special handling; the planner stages it directly.
  - *Example:* "{NAME} lifts a car" → one subject, one car, one action.
- `medium` — Needs interpretation but has clear visual anchors — the AI has to make a staging choice, but the ingredients are obvious.
  - *Render:* The planner picks an interpretation; the test renders are worth a quick sanity check.
  - *Example:* "Sharks have a {NAME} Week" → needs the 'sharks as audience' inversion, but sharks + TV are clear anchors.
- `high` — Abstract, wordplay-heavy, ambiguous, or hard to make visually clear. The admin UI surfaces a 'Hard to visualize' warning for these.
  - *Render:* Advisory to the planner only — but treat it as a signal to review the test renders closely and consider a Visual Strategy Override if the AI's interpretation misses.
  - *Example:* "{NAME} divided by zero and survived" → no natural image; expect symbolic staging and check it actually reads.

**Examples**

- **Scenario:** The Step-2 "How the AI read this fact" summary shows a warning.
  - **Input:** visualComplexity: high
  - **Outcome:** "Hard to visualize (high complexity)." appears — your cue to scrutinize the test renders.

**Sources**

- `artifacts/api-server/src/lib/factEnrichmentConfig.ts` `FACT_ENRICHMENT_SYSTEM_DEFAULT` — The classifier system prompt — the authoritative definition of what the AI is told this field means.
- `artifacts/api-server/src/lib/imagePrompt/generator.ts` `buildImagePromptUserMessage` — Where the enrichment is injected into the image-prompt planner message (the TAXONOMY block is marked FIXED — DO NOT reclassify).
- `artifacts/api-server/src/lib/factRenderScenarios.ts` `renderAffectingEnrichment` — The render-input hash projection — fields listed here flip render-scenario tiles stale when edited.

### Overhype Fit

*Does this fact fit the positive Overhype.me product rule?*

- **Effect:** Gating only — approval/health gate, never compiled into the prompt
- **Staleness:** Editing does not re-flag render scenarios.
- **Editor surface:** field-label

**What it is**

A three-way product-fit verdict against the core rule: the subject must be portrayed positively — legendary, impressive, dominant, magnetic, respected, superhuman — never pathetic, weak, humiliated, gross, or cruel.

**How the AI sets it**

The classifier applies the core product rule from its system prompt: strong = clearly positive; questionable = funny but possibly confusing/negative/gross/non-visual/weakly overhyped; reject = doesn't fit without a rewrite.

**How it affects the render**

NOT compiled into the prompt — this is a quality/approval gate. Taxonomy Health raises a warning for 'questionable' and an error for 'reject' (both mark the fact needs_admin_review), and the value is a filterable projected column in the admin fact list.

It is NOT in the render-input hash, so editing it does not flip test renders stale (the compiled prompt doesn't depend on it).

**Values (3)**

- `strong` — Clearly positive Overhype.me fact — the subject is legendary/impressive/dominant per the core product rule.
  - *Render:* None at render time. No taxonomy-health flags; the fact proceeds normally.
  - *Example:* "{NAME} bench-presses the Earth" → unambiguously positive superhuman framing.
- `questionable` — Funny or interesting, but may be confusing, too negative, gross, cruel, non-visual, or weakly overhyped — a human should weigh in.
  - *Render:* None at render time. Taxonomy Health raises a warning ('admin should weigh in') and marks the fact needs_admin_review.
  - *Example:* A fact whose joke edges on humiliating the subject — the classifier flags it rather than rejecting outright.
- `reject` — Does not fit positive Overhype.me without a rewrite — the core joke makes the subject pathetic, weak, humiliated, or cruel.
  - *Render:* None at render time. Taxonomy Health raises an error ('fact should likely be removed or rewritten') and marks needs_admin_review.
  - *Example:* A fact whose only punchline is the subject failing — violates the "portray positively" product rule.

**Examples**

- **Scenario:** A submitted fact whose punchline is the subject failing.
  - **Input:** overhypeFit: reject
  - **Outcome:** Taxonomy Health errors with 'fact should likely be removed or rewritten'; nothing about the render pipeline changes.

**Sources**

- `artifacts/api-server/src/lib/factEnrichmentConfig.ts` `FACT_ENRICHMENT_SYSTEM_DEFAULT` — The classifier system prompt — the authoritative definition of what the AI is told this field means.
- `artifacts/api-server/src/lib/taxonomyHealth/index.ts` `computeTaxonomyHealth` — The questionable/reject health flags and needs_admin_review gating.

### Adult-Mode Compatibility

*Whether this FACT could support adult/spicy rendering — NOT the render's SFW control.*

- **Effect:** Gating only — approval/health gate, never compiled into the prompt
- **Staleness:** Editing does not re-flag render scenarios.
- **Editor surface:** field-label

**What it is**

A fact-level compatibility rating for adult/suggestive rendering. Important distinction: this does NOT set the SFW level of any render — the actual content level is the separate contentMode render control chosen at render time. This field only says whether the fact itself could ever support a spicy variant.

It is explicitly not permission: runtime gates (paid status, age verification, source-image eligibility, policy) still enforce everything at render time.

**How the AI sets it**

The classifier applies the definitions in its system prompt — notably the 'incompatible' list: minors, childhood, family, school, medical vulnerability, workplace/professional contexts, brands, institutions.

**How it affects the render**

None on the compiled prompt. 'requires_review' raises a Taxonomy Health flag for a human decision; the value is a projected, filterable column.

NOT in the render-input hash, so editing it does not flip test renders stale — the render's actual SFW/spicy level is the separate contentMode render control, not this field.

**Values (4)**

- `safe` — Appropriate for normal SFW rendering, but not especially suited to suggestive/spicy rendering.
  - *Render:* None — the actual SFW/spicy level of a render is the separate contentMode render control, not this field.
  - *Example:* A gym-feat fact: fine as SFW, nothing about it supports a spicy variant.
- `compatible` — Can reasonably support suggestive/spicy rendering if the user and source image are eligible.
  - *Render:* None directly — it is a fact-level compatibility signal only. Runtime gates (paid status, age verification, source-image eligibility, policy) still decide what actually renders.
  - *Example:* A confident-aura fact that could carry a spicy variant for an eligible adult user.
- `incompatible` — Should not be rendered in adult mode — the fact involves minors, childhood, family, school, medical vulnerability, workplace/professional context, brands, institutions, or another incompatible context.
  - *Render:* None at render time in SFW mode; blocks adult-mode consideration for this fact.
  - *Example:* Any fact involving "{NAME} as a baby" — childhood context makes adult mode categorically incompatible.
- `requires_review` — May be compatible but needs human review — ambiguity, brand/professional context, authority context, violence-adjacent context, or unusual framing.
  - *Render:* None at render time. Taxonomy Health flags the fact (adultRequiresReview) for a human decision.
  - *Example:* A workplace-adjacent fact where spicy compatibility depends on framing a human should judge.

**Examples**

- **Scenario:** "{NAME} as a baby negotiated their own bedtime."
  - **Input:** adultSuitability: incompatible
  - **Outcome:** Childhood context — categorically incompatible with adult mode, regardless of user eligibility.

**Sources**

- `artifacts/api-server/src/lib/factEnrichmentConfig.ts` `FACT_ENRICHMENT_SYSTEM_DEFAULT` — The classifier system prompt — the authoritative definition of what the AI is told this field means.

### Adult-Mode Notes

*The classifier's free-text reasoning behind the adult-suitability rating.*

- **Effect:** Human-only — never leaves the admin UI
- **Staleness:** Editing does not re-flag render scenarios.
- **Editor surface:** field-label

**What it is**

Free text (max 500 chars) where the classifier explains WHY it chose the adult-suitability value — especially useful for 'requires_review', where it should name the ambiguity a human needs to resolve.

**How the AI sets it**

Written by the classifier alongside the rating; empty when there is nothing to explain.

**How it affects the render**

None — human-only. Never enters the planner message or the compiled prompt, and it is explicitly EXCLUDED from the render-input hash, so editing it does not flip test renders stale.

**Examples**

- **Scenario:** adultSuitability came back requires_review.
  - **Input:** adultSuitabilityNotes: "Workplace demo context — compatible only if framed outside the office."
  - **Outcome:** You read the note, decide, and adjust the rating; renders are untouched.

**Sources**

- `artifacts/api-server/src/lib/factEnrichmentConfig.ts` `FACT_ENRICHMENT_SYSTEM_DEFAULT` — The classifier system prompt — the authoritative definition of what the AI is told this field means.
- `artifacts/api-server/src/lib/factRenderScenarios.ts` `renderAffectingEnrichment` — The render-input hash projection — fields listed here flip render-scenario tiles stale when edited.

### Render Modifiers

*Flags that steer the image — most as planner context, a few as structural compiler signals.*

- **Effect:** Render-affecting — feeds the prompt pipeline
- **Staleness:** Editing re-flags render scenarios as stale.
- **Editor surface:** field-label

**What it is**

A list of flags from a known catalog (custom values allowed) that mark rendering, identity, setting, and safety constraints. They work in two tiers: MOST are serialized into the planner's TAXONOMY block as context (the frontier planner reads them and they can shape the plan, but nothing guarantees the effect); a SMALL set have a deterministic compiler effect (see renderImpact).

Unknown (custom) modifiers render as amber chips. They carry no fixed directive — the prompt planner sees them as raw context only, so their effect depends on the AI's interpretation.

**How the AI sets it**

The classifier prefers known modifiers from its catalog and may add a custom one only when no known modifier captures an important rendering, discovery, identity, setting, or safety constraint. Admins freely add/remove them here.

**How it affects the render**

Most modifiers are planner-context only: they inform the frontier planner (which, steered by the moderator's Visual concept, owns the scene) but there is no fixed directive guaranteeing the effect. See the per-value docs below.

Structural signals (guaranteed compiler effect): age/life-stage modifiers (baby_child_version, older_self_version, age_transform, …) drive the SUBJECT BINDING section so the subject IS the transformed person (never a separate generic baby/elder beside them); avoid_duplicate_subject drives the single-instance binding; crowd_reaction / clear_causal_relationship / subject_object_reversal drive conservative failure-mode guards.

Three modifiers (cinematic_aftermath, projectile_impact_power, action_comedy) also mark the fact violence-relevant, which permits the default violence-allow line in the prompt.

Editing modifiers flips test renders stale (except the inert legacy text/logo names, which are filtered out of the render hash).

**Values (49)**

- `single_subject_focus` *(authored — verify)* — Composition flag: the image should center on the subject alone, with no competing characters sharing the spotlight.
  - *Render:* No fixed compiler directive, so no guaranteed effect — but it IS passed to the AI planner as taxonomy context and can nudge the composition toward a solo subject; the archetype strategy and scene still decide the actual framing. (Contrast avoid_duplicate_subject, which DOES have a structural compiler effect.)
  - *Example:* "{NAME} is the gym's entire membership" → nudges the planner to keep the frame centered on the subject alone; not a guaranteed rule.
- `identity_strict` *(authored — verify)* — Identity-policy flag: the subject's recognizable likeness should be preserved strictly — the joke fails if the rendered person doesn't clearly read as the reference photo's person.
  - *Render:* No compiler directive or identity policy keys off this flag, so it has no guaranteed effect — actual likeness preservation is owned by the subject render mode and the SUBJECT BINDING machinery. It is still passed to the AI planner as taxonomy context (a soft hint that likeness matters), but nothing enforces it.
  - *Example:* "{NAME} was recognized from space" → signals strict likeness matters, but today the likeness guarantee comes from the render mode, not this flag.
- `identity_essence_only` *(authored — verify)* — Identity-policy flag: strict likeness may be relaxed — the render only needs to carry the subject's essence (build, hair, vibe), e.g. through a heavy transformation or symbolic treatment.
  - *Render:* Like identity_strict, no compiler directive or identity policy branches on it, so no guaranteed effect. It still reaches the AI planner as taxonomy context (a soft hint that the likeness may be relaxed), but nothing enforces it.
  - *Example:* "{NAME} turned into pure motivation" → signals the render may keep only the subject's essence through the transformation; nothing in the compiler enforces it.
- `face_prominent` *(authored — verify)* — Framing flag: the joke depends on the subject's face and expression reading clearly, so the face must be framed large and unobstructed.
  - *Render:* No deterministic compiler directive — the modifier is serialized into the planner's TAXONOMY block as context, so it can shape the generated visual plan but the effect isn't guaranteed. The frontier planner, steered by the moderator's Visual concept, owns the scene; treat this as a soft hint and check the test render.
  - *Example:* "{NAME}'s wink restarted the power grid" → nudges the planner toward prominent, clear face framing so the expression can carry the joke.
- `full_body_needed` *(authored — verify)* — Framing flag: the joke needs the whole body visible (a pose, a feat, a stance) — a chest-up crop would lose it.
  - *Render:* No deterministic compiler directive — the modifier is serialized into the planner's TAXONOMY block as context, so it can shape the generated visual plan but the effect isn't guaranteed. The frontier planner, steered by the moderator's Visual concept, owns the scene; treat this as a soft hint and check the test render.
  - *Example:* "{NAME} deadlifts a city bus" → nudges the planner toward full-body framing so the stance and lift read.
- `age_transform` — The fact requires the subject rendered at a different age or life stage than the reference photo — the generic form of the baby/older variants below.
  - *Render:* Drives the compiler's deterministic SUBJECT BINDING section, which fuses the subject identity with the transformed life stage as ONE entity — human-identity renders get "The transformed X IS {subject} — the same person de-aged or aged, not a second person."; non-human and t2i renders get equivalent single-entity life-stage wording — plus anti-split strict constraints (no separate generic baby/elder, no original-age copy left in frame). This is the SOLE compiled owner of age transforms; the modifier also reaches the planner as TAXONOMY context.
  - *Example:* "{NAME} was born flexing" → the subject is rendered at the fact's implied age — the same person, with no original-age copy left in frame.
- `baby_child_version` — The fact describes the subject as a baby or young child — the reference person must be de-aged, not accompanied by a random infant.
  - *Render:* Drives the compiler's deterministic SUBJECT BINDING section, which fuses the subject identity with the transformed life stage as ONE entity — human-identity renders get "The transformed X IS {subject} — the same person de-aged or aged, not a second person."; non-human and t2i renders get equivalent single-entity life-stage wording — plus anti-split strict constraints (no separate generic baby/elder, no original-age copy left in frame). This is the SOLE compiled owner of age transforms; the modifier also reaches the planner as TAXONOMY context.
  - *Example:* "{NAME} as a baby negotiated their own bedtime" → the reference adult is de-aged into the baby; no separate generic baby, no adult left in frame.
- `infant_version` — A finer-grained age stage than baby_child_version: the fact needs the subject rendered specifically as a newborn/infant. The compiler renders it distinctly; the classifier's suggestion catalog doesn't list it, so it's typically moderator-added.
  - *Render:* Drives the compiler's deterministic SUBJECT BINDING section, which fuses the subject identity with the transformed life stage as ONE entity — human-identity renders get "The transformed X IS {subject} — the same person de-aged or aged, not a second person."; non-human and t2i renders get equivalent single-entity life-stage wording — plus anti-split strict constraints (no separate generic baby/elder, no original-age copy left in frame). This is the SOLE compiled owner of age transforms; the modifier also reaches the planner as TAXONOMY context.
  - *Example:* "{NAME} filed taxes from the womb" → the reference subject is de-aged to a newborn/infant; no separate generic baby, no adult left in frame.
- `child_version` — A finer-grained age stage than baby_child_version: the fact needs the subject rendered specifically as a young child (past infancy). The compiler renders it distinctly; the classifier's suggestion catalog doesn't list it, so it's typically moderator-added.
  - *Render:* Drives the compiler's deterministic SUBJECT BINDING section, which fuses the subject identity with the transformed life stage as ONE entity — human-identity renders get "The transformed X IS {subject} — the same person de-aged or aged, not a second person."; non-human and t2i renders get equivalent single-entity life-stage wording — plus anti-split strict constraints (no separate generic baby/elder, no original-age copy left in frame). This is the SOLE compiled owner of age transforms; the modifier also reaches the planner as TAXONOMY context.
  - *Example:* "{NAME} won a Nobel Prize in third grade" → the reference subject de-aged to a young child; no separate generic child, no adult left in frame.
- `older_self_version` — The fact describes the subject as a much older version of themselves — the same person aged, not an unrelated elderly extra.
  - *Render:* Drives the compiler's deterministic SUBJECT BINDING section, which fuses the subject identity with the transformed life stage as ONE entity — human-identity renders get "The transformed X IS {subject} — the same person de-aged or aged, not a second person."; non-human and t2i renders get equivalent single-entity life-stage wording — plus anti-split strict constraints (no separate generic baby/elder, no original-age copy left in frame). This is the SOLE compiled owner of age transforms; the modifier also reaches the planner as TAXONOMY context.
  - *Example:* "At 90, {NAME} still outruns ambulances" → the reference subject rendered elderly — same face aged, not a random senior beside a young {NAME}.
- `grounded_realism` *(authored — verify)* — Staging flag: keep physics and rendering realistic — the impossibility should live in what's happening (roles, outcomes), not in cartoon physics or surreal style.
  - *Render:* No fixed compiler directive, so no guaranteed effect — but it reaches the AI planner as taxonomy context and reinforces what a grounded_roleplay literalness rating already tells the planner; the authored strategy and scene prose do the real steering.
  - *Example:* "A baby drove {NAME}'s mother home" → nudges the planner toward a realistic car interior with the impossibility in who's driving.
- `mock_heroic` *(authored — verify)* — The comedy comes from treating something trivial with epic gravitas — the subject should be staged like a monument to a mundane act.
  - *Render:* No deterministic compiler directive — the modifier is serialized into the planner's TAXONOMY block as context, so it can shape the generated visual plan but the effect isn't guaranteed. The frontier planner, steered by the moderator's Visual concept, owns the scene; treat this as a soft hint and check the test render.
  - *Example:* "{NAME} plugged in a USB right on the first try" → nudges the planner to stage the trivial act with an exaggerated heroic pose, cape-in-the-wind energy.
- `action_comedy` — The fact is an action joke — energetic, slapstick, physical comedy staging suits it better than solemn cinematics.
  - *Render:* The staging idea reaches the planner as TAXONOMY context (no deterministic staging directive). Its firm effect is that it marks the fact violence-relevant: under the default "allow" violence policy the compiler emits the permission line "When the fact explicitly requires violence, death, weapons, or destruction, depict the action and consequences clearly without gratuitous gore." (an explicit moderator soften/suppress override still wins).
  - *Example:* "{NAME} fought the office printer and won" → the slapstick staging is a planner hint; the fact is also treated as violence-relevant so the action can be depicted clearly.
- `cinematic_aftermath` — The funniest frame is AFTER the action — the crater, the dust, the stunned onlookers — rather than the action itself.
  - *Render:* The staging idea reaches the planner as TAXONOMY context (no deterministic staging directive). Its firm effect is that it marks the fact violence-relevant: under the default "allow" violence policy the compiler emits the permission line "When the fact explicitly requires violence, death, weapons, or destruction, depict the action and consequences clearly without gratuitous gore." (an explicit moderator soften/suppress override still wins).
  - *Example:* "{NAME} high-fived a mountain" → the aftermath staging (crater, settling dust, awed onlookers) is a planner hint; the fact is also marked violence-relevant.
- `symbolic_abstraction_required` *(authored — verify)* — The fact cannot be shown literally at all — it demands symbolic visual language (the modifier-flag counterpart of the symbolic_abstraction literalness rating).
  - *Render:* No deterministic compiler directive — the modifier is serialized into the planner's TAXONOMY block as context, so it can shape the generated visual plan but the effect isn't guaranteed. The frontier planner, steered by the moderator's Visual concept, owns the scene; treat this as a soft hint and check the test render.
  - *Example:* "{NAME} counted to infinity. Twice." → nudges the planner toward symbolic rendering — endless number-scapes, not a person mouthing numbers.
- `metaphorical_visualization` *(authored — verify)* — The joke should land as one concrete visual metaphor — a phrase made physically true in the image (the modifier-flag counterpart of the same-named literalness rating).
  - *Render:* No deterministic compiler directive — the modifier is serialized into the planner's TAXONOMY block as context, so it can shape the generated visual plan but the effect isn't guaranteed. The frontier planner, steered by the moderator's Visual concept, owns the scene; treat this as a soft hint and check the test render.
  - *Example:* "{NAME}'s handshake seals deals" → nudges the planner toward one clear metaphor (a literal wax seal pressed by a handshake).
- `clear_causal_relationship` — The joke is a cause→effect gag, and it only lands if the viewer instantly sees which action caused which consequence.
  - *Render:* Drives a conservative failure-mode guard in STRICT CONSTRAINTS via failureModeConstraints ("Show the cause and its effect together in the frame so the causal link is legible, not an unrelated aftermath."). The staging idea also reaches the planner as TAXONOMY context; there is no positive prose directive.
  - *Example:* "{NAME} clapped and the thunder answered" → the compiler guards that clap and thundercrack read as cause-and-effect, not an unrelated aftermath.
- `crowd_reaction` — Witnesses are part of the joke — the scene needs a visible crowd whose reaction sells how impressive the subject is.
  - *Render:* Drives a conservative crowd focus/relationship guard pack in STRICT CONSTRAINTS via failureModeConstraints (keeping the crowd a reacting background, not competing with the subject). The 'include a crowd' idea itself reaches the planner as TAXONOMY context; there is no positive prose directive.
  - *Example:* "{NAME} parallel-parked on the first attempt" → the planner may add a gasping crowd; the compiler guards keep them a reacting background, not co-stars.
- `environmental_reaction` *(authored — verify)* — The environment itself should visibly respond to the subject — nature, buildings, or weather reacting is the punchline's proof.
  - *Render:* No deterministic compiler directive — the modifier is serialized into the planner's TAXONOMY block as context, so it can shape the generated visual plan but the effect isn't guaranteed. The frontier planner, steered by the moderator's Visual concept, owns the scene; treat this as a soft hint and check the test render.
  - *Example:* "{NAME} whispered and the forest leaned in" → nudges the planner toward trees bending toward the subject; the environment as reacting witness.
- `object_transformation` *(authored — verify)* — An object changes state because of the subject, and the change itself must be legible — best shown mid-transformation.
  - *Render:* No deterministic compiler directive — the modifier is serialized into the planner's TAXONOMY block as context, so it can shape the generated visual plan but the effect isn't guaranteed. The frontier planner, steered by the moderator's Visual concept, owns the scene; treat this as a soft hint and check the test render.
  - *Example:* "{NAME} stared at coal until it became a diamond" → nudges the planner to show the coal mid-morph into diamond so the change is legible.
- `technology_reaction` *(authored — verify)* — Devices and machines visibly respond to the subject — screens, routers, robots reacting is the gag's evidence.
  - *Render:* No deterministic compiler directive — the modifier is serialized into the planner's TAXONOMY block as context, so it can shape the generated visual plan but the effect isn't guaranteed. The frontier planner, steered by the moderator's Visual concept, owns the scene; treat this as a soft hint and check the test render.
  - *Example:* "WiFi gets stronger when {NAME} walks by" → nudges the planner toward routers and phones visibly lighting up in response.
- `official_setting` *(authored — verify)* — Setting flag: the fact implies a formal, official, or ceremonial venue — a swearing-in, a podium, a state occasion.
  - *Render:* No fixed compiler directive: setting/location flags are passed to the AI prompt planner as taxonomy context only, and the authored archetype strategy plus the planned scene largely determine the environment. Treat this as informing, not guaranteeing, the formal/ceremonial setting.
  - *Example:* "{NAME} was sworn in as everyone's emergency contact" → suggests a ceremonial venue to the planner; the authored strategy still writes the scene.
- `professional_context` *(authored — verify)* — Context flag: the fact lives in a professional/expert domain (consultants, doctors, engineers at work). Also an adult-suitability signal — professional contexts are on the classifier's adult-incompatible list.
  - *Render:* No fixed compiler directive — passed to the AI prompt planner as taxonomy context only; the authored strategy and scene decide the actual staging. Its firmer role is taxonomy/safety context (adult-suitability review), not the compiled prompt.
  - *Example:* "{NAME} closed the deal by nodding" → hints at a professional environment; also the kind of context that keeps adult mode off the table.
- `domestic_setting` *(authored — verify)* — Setting flag: the fact plays out at home — kitchens, living rooms, household life.
  - *Render:* No fixed compiler directive: setting/location flags are passed to the AI prompt planner as taxonomy context only, and the authored archetype strategy plus the planned scene largely determine the environment. Treat this as informing, not guaranteeing, the home/domestic setting.
  - *Example:* "{NAME}'s houseplants water themselves out of respect" → suggests a home interior to the planner; informative, not enforced.
- `office_setting` *(authored — verify)* — Setting flag: the fact plays out in an office — desks, meetings, office equipment.
  - *Render:* No fixed compiler directive: setting/location flags are passed to the AI prompt planner as taxonomy context only, and the authored archetype strategy plus the planned scene largely determine the environment. Treat this as informing, not guaranteeing, the office setting.
  - *Example:* "The office printer works only for {NAME}" → hints office context; the scene prose decides the actual set dressing.
- `school_setting` *(authored — verify)* — Setting flag: the fact involves school — classrooms, teachers, hallways. (School context also makes the fact adult-incompatible per the adult-suitability rules.)
  - *Render:* No fixed compiler directive: setting/location flags are passed to the AI prompt planner as taxonomy context only, and the authored archetype strategy plus the planned scene largely determine the environment. Treat this as informing, not guaranteeing, the school setting.
  - *Example:* "Teachers ask {NAME} for hall passes" → suggests a school scene; separately, school context blocks adult mode.
- `hospital_setting` *(authored — verify)* — Setting flag: the fact involves a hospital or medical environment. (Medical vulnerability is also on the adult-incompatible list.)
  - *Render:* No fixed compiler directive: setting/location flags are passed to the AI prompt planner as taxonomy context only, and the authored archetype strategy plus the planned scene largely determine the environment. Treat this as informing, not guaranteeing, the hospital/medical setting.
  - *Example:* "Doctors check {NAME}'s pulse to calibrate their watches" → suggests a medical scene to the planner; nothing is compiled from the flag itself.
- `courtroom_setting` *(authored — verify)* — Setting flag: the fact stages a courtroom — judges, benches, gavels, legal theater.
  - *Render:* No fixed compiler directive: setting/location flags are passed to the AI prompt planner as taxonomy context only, and the authored archetype strategy plus the planned scene largely determine the environment. Treat this as informing, not guaranteeing, the courtroom setting.
  - *Example:* "{NAME} was called as an expert witness on being impressive" → courtroom staging suggested; the archetype strategy still owns the scene.
- `airport_setting` *(authored — verify)* — Setting flag: the fact plays out in an airport — terminals, security, gates.
  - *Render:* No fixed compiler directive: setting/location flags are passed to the AI prompt planner as taxonomy context only, and the authored archetype strategy plus the planned scene largely determine the environment. Treat this as informing, not guaranteeing, the airport setting.
  - *Example:* "TSA waves {NAME} through with applause" → airport context hinted to the planner; not a compiled constraint.
- `gym_setting` *(authored — verify)* — Setting flag: the fact lives in a gym — weights, racks, mirrors, workout culture.
  - *Render:* No fixed compiler directive: setting/location flags are passed to the AI prompt planner as taxonomy context only, and the authored archetype strategy plus the planned scene largely determine the environment. Treat this as informing, not guaranteeing, the gym setting.
  - *Example:* "The gym renamed leg day after {NAME}" → gym environment suggested; the planned scene determines what actually appears.
- `bar_setting` *(authored — verify)* — Setting flag: the fact plays out in a bar or pub environment.
  - *Render:* No fixed compiler directive: setting/location flags are passed to the AI prompt planner as taxonomy context only, and the authored archetype strategy plus the planned scene largely determine the environment. Treat this as informing, not guaranteeing, the bar setting.
  - *Example:* "Bartenders tip {NAME}" → bar context hinted; advisory to the planner only.
- `battlefield_setting` *(authored — verify)* — Setting flag: the fact stages combat-scale territory — battlefields, war-movie scenery. (Violence permission is separate: it comes from the violence policy and the violence-relevance modifiers, not this flag.)
  - *Render:* No fixed compiler directive: setting/location flags are passed to the AI prompt planner as taxonomy context only, and the authored archetype strategy plus the planned scene largely determine the environment. Treat this as informing, not guaranteeing, the battlefield setting.
  - *Example:* "{NAME} won the battle by showing up" → battlefield scenery hinted; whether violence is depicted is governed elsewhere.
- `technology_setting` *(authored — verify)* — Setting flag: the fact lives among technology — server rooms, labs, screens, gadgets.
  - *Render:* No fixed compiler directive: setting/location flags are passed to the AI prompt planner as taxonomy context only, and the authored archetype strategy plus the planned scene largely determine the environment. Treat this as informing, not guaranteeing, the tech/data-center setting.
  - *Example:* "Servers cool down when {NAME} logs on" → data-center environment suggested to the planner; informative only.
- `underwater_setting` *(authored — verify)* — Setting flag: the scene is underwater — ocean depths, marine life.
  - *Render:* No fixed compiler directive: setting/location flags are passed to the AI prompt planner as taxonomy context only, and the authored archetype strategy plus the planned scene largely determine the environment. Treat this as informing, not guaranteeing, the underwater setting.
  - *Example:* "Sharks have a {NAME} Week" → underwater staging hinted; the archetype strategy still writes the actual scene.
- `space_setting` *(authored — verify)* — Setting flag: the scene is in space — orbit, spacecraft, cosmic backdrops.
  - *Render:* No fixed compiler directive: setting/location flags are passed to the AI prompt planner as taxonomy context only, and the authored archetype strategy plus the planned scene largely determine the environment. Treat this as informing, not guaranteeing, the outer-space setting.
  - *Example:* "{NAME} waved at the ISS and it waved back" → space backdrop suggested; not a compiled directive (contrast celestial_object, a load-bearing prop the planner is told to render).
- `outdoor_nature_setting` *(authored — verify)* — Setting flag: the fact plays out in nature — mountains, forests, open landscapes.
  - *Render:* No fixed compiler directive: setting/location flags are passed to the AI prompt planner as taxonomy context only, and the authored archetype strategy plus the planned scene largely determine the environment. Treat this as informing, not guaranteeing, the outdoor/nature setting.
  - *Example:* "Mountains adjust their height for {NAME}'s photos" → outdoor nature scenery hinted to the planner.
- `city_setting` *(authored — verify)* — Setting flag: the fact lives in an urban environment — streets, skylines, traffic.
  - *Render:* No fixed compiler directive: setting/location flags are passed to the AI prompt planner as taxonomy context only, and the authored archetype strategy plus the planned scene largely determine the environment. Treat this as informing, not guaranteeing, the urban/city setting.
  - *Example:* "Traffic lights turn green when {NAME} approaches" → city-street staging suggested; advisory only.
- `avoid_weapons_focus` *(authored — verify)* — Presentation constraint (not moderation): a weapon may appear if the fact requires it, but it must not be the visual centerpiece of the scene.
  - *Render:* No deterministic compiler directive — the modifier is serialized into the planner's TAXONOMY block as context, so it can shape the generated visual plan but the effect isn't guaranteed. The frontier planner, steered by the moderator's Visual concept, owns the scene; treat this as a soft hint and check the test render.
  - *Example:* "{NAME} caught the arrow mid-flight" → nudges the planner to keep the catch the focal point and the weapon incidental, not glorified.
- `avoid_gross_literalization` *(authored — verify)* — Taste constraint: a literal rendering of the fact would be gross or off-putting — the idea should be staged tastefully instead.
  - *Render:* No deterministic compiler directive — the modifier is serialized into the planner's TAXONOMY block as context, so it can shape the generated visual plan but the effect isn't guaranteed. The frontier planner, steered by the moderator's Visual concept, owns the scene; treat this as a soft hint and check the test render.
  - *Example:* "{NAME} sweats pure espresso" → nudges the planner toward tasteful coffee-steam staging rather than a literally dripping render.
- `avoid_extra_faces` *(authored — verify)* — Focus constraint: background faces dilute the subject and risk identity confusion — keep other faces minimal so the subject stays the one clear face.
  - *Render:* No deterministic compiler directive — the modifier is serialized into the planner's TAXONOMY block as context, so it can shape the generated visual plan but the effect isn't guaranteed. The frontier planner, steered by the moderator's Visual concept, owns the scene; treat this as a soft hint and check the test render.
  - *Example:* "{NAME} won the marathon running backwards" → nudges the planner to de-emphasize background runners so the subject is the clear face.
- `avoid_duplicate_subject` — Anti-clone constraint: image models love to render the reference person twice — this flag pins the subject to exactly one instance.
  - *Render:* Triggers the compiler's single-instance SUBJECT BINDING ("Render exactly one {subject} — a single instance.") and the anti-split strict constraint ("Do not duplicate, clone, or mirror {subject} anywhere in the frame.") even when no age transform applies. This is a structural compiler effect; the modifier also reaches the planner as TAXONOMY context.
  - *Example:* "{NAME} raced their own shadow" → exactly one {NAME} in frame; the shadow is a shadow, not a second copy of the person.
- `astronomical_consequence` *(authored — verify)* — The fact's consequence is planetary/cosmic scale — the image must stage that scale, not shrink it to a local effect.
  - *Render:* No deterministic compiler directive — the modifier is serialized into the planner's TAXONOMY block as context, so it can shape the generated visual plan but the effect isn't guaranteed. The frontier planner, steered by the moderator's Visual concept, owns the scene; treat this as a soft hint and check the test render.
  - *Example:* "{NAME} sneezed and the moon left orbit" → nudges the planner to stage the departing moon huge and dramatic, not a dot in the sky.
- `celestial_object` *(authored — verify)* — A specific celestial body (planet, moon, star) is a load-bearing prop in the joke and must be clearly rendered in frame.
  - *Render:* No deterministic compiler directive — the modifier is serialized into the planner's TAXONOMY block as context, so it can shape the generated visual plan but the effect isn't guaranteed. The frontier planner, steered by the moderator's Visual concept, owns the scene; treat this as a soft hint and check the test render.
  - *Example:* "The moon waves back at {NAME}" → nudges the planner toward a clearly rendered moon in frame, not just a vague night sky.
- `subject_object_reversal` — The joke inverts the normal actor/acted-on relationship — the object does to the subject what the subject would normally do to it.
  - *Render:* Drives a conservative failure-mode guard in STRICT CONSTRAINTS via failureModeConstraints (keeping the reversed roles legible so the object clearly acts on the subject). The reversal idea also reaches the planner as TAXONOMY context; there is no positive prose directive.
  - *Example:* "The dumbbells ask {NAME} for a lighter set" → the compiler guards that the equipment clearly reads as the one acting toward the subject.
- `normal_function_rendered_unnecessary` — Redundant-mechanism jokes: the subject's impossible power accomplishes the result BEFORE an object/tool/weapon's normal mechanism is needed — the mechanism may still fire afterward, but comically redundantly. Explicitly NOT a temporal/causality inversion (the canonical example: "threw a grenade and killed 50 people, then it exploded").
  - *Render:* No deterministic compiler directive — the modifier is serialized into the planner's TAXONOMY block as context, so it can shape the generated visual plan but the effect isn't guaranteed. The frontier planner, steered by the moderator's Visual concept, owns the scene; treat this as a soft hint and check the test render. (This modifier's main job is taxonomy: it marks the redundant-mechanism pattern so the fact is not misclassified as a temporal/causality inversion.)
  - *Example:* "{NAME} threw a grenade and killed 50 people, then it exploded" → the planner should stage the throw as the devastating force and keep the grenade's own explosion visibly late and redundant.
- `projectile_impact_power` — A thrown/launched object carries impossible force — the image needs visual evidence of that power (shockwave, trail, impact path).
  - *Render:* The staging idea reaches the planner as TAXONOMY context (no deterministic staging directive). Its firm effect is that it marks the fact violence-relevant: under the default "allow" violence policy the compiler emits the permission line "When the fact explicitly requires violence, death, weapons, or destruction, depict the action and consequences clearly without gratuitous gore." (an explicit moderator soften/suppress override still wins).
  - *Example:* "{NAME}'s paper airplane broke the sound barrier" → the shockwave/motion-trail idea is a planner hint; the fact is also marked violence-relevant.
- `brand_context` *(authored — verify)* — Context flag: the joke depends on a brand or company reference. Pairs with the culturalReferences brand_reference entries; brands are also on the adult-suitability incompatible list.
  - *Render:* No fixed compiler directive — taxonomy context for the planner only; it tells downstream consumers the joke leans on a brand. Real brand MARKS never render regardless: the always-on overlay-text exclusion bans logos and brand marks on every image.
  - *Example:* "A rental company sends {NAME} thank-you flowers" → flags the brand dependency for the planner and reviewers; brand marks are already banned platform-wide.
- `workplace_context` *(authored — verify)* — Context flag: the fact assumes workplace framing — bosses, HR, coworkers, office politics. Workplace context is also on the classifier's adult-incompatible list, so this doubles as a safety signal.
  - *Render:* No fixed compiler directive — the token reaches the AI prompt planner as taxonomy context only; the authored strategy and scene own the staging. Its more concrete role is taxonomy/adult-suitability context, not the compiled prompt.
  - *Example:* "HR studies {NAME}'s emails as literature" → workplace framing flagged for the planner and for adult-suitability review; nothing is compiled from it.
- `audience_inside_reference` *(authored — verify)* — Context flag: the joke's audience exists INSIDE the reference — the in-scene watchers/consumers belong to the referenced format or world (e.g. the sharks watching "{NAME} Week"), and the joke collapses if who-is-watching-whom gets lost.
  - *Render:* No fixed compiler directive — planner context only, alerting the scene-writing AI to preserve the audience inversion; the authored strategy and the planned scene determine whether it actually survives into the prompt.
  - *Example:* "Sharks have a {NAME} Week" → the sharks ARE the audience; this flag tells the planner not to flatten that into people watching sharks.

**Examples**

- **Scenario:** "{NAME} as a baby negotiated their own bedtime." — render shows an adult plus a random baby.
  - **Input:** Add modifier: "baby_child_version"
  - **Outcome:** The compiler emits a SUBJECT BINDING section fusing the subject with the transformed life stage as ONE entity ("the same person de-aged… no separate generic baby, no adult version left in frame"), plus anti-split strict constraints. The modifier also reaches the planner as context.
- **Scenario:** A render keeps drawing readable gibberish signage, but the scene has NO text that should appear.
  - **Input:** Turn ON the Visual Strategy Override and set Supporting-text policy → forbid.
  - **Outcome:** STRICT CONSTRAINTS emits "Avoid readable in-scene text unless required by a higher-priority instruction." (Incidental background gibberish is already steered clean by an always-on guard; a full ban is this moderator override — the old no_readable_text modifier was retired.)
- **Scenario:** You add a custom modifier "sepia_flashback".
  - **Input:** modifiers: [..., "sepia_flashback"] (amber chip)
  - **Outcome:** No fixed directive exists — the planner sees the token as context and may or may not honor it. Check the test render.

**Sources**

- `artifacts/api-server/src/lib/imagePrompt/generator.ts` `buildImagePromptContextBlocks` — Where modifiers are serialized into the planner's TAXONOMY context block.
- `artifacts/api-server/src/lib/factEnrichmentConfig.ts` `FACT_ENRICHMENT_SYSTEM_DEFAULT` — The classifier system prompt — the authoritative definition of what the AI is told this field means.
- `artifacts/api-server/src/lib/factRenderScenarios.ts` `renderAffectingEnrichment` — The render-input hash projection — fields listed here flip render-scenario tiles stale when edited.

### Final hashtags — these ship on approval

*The discovery tags that actually attach to the live fact when you approve.*

- **Effect:** Product metadata — ships with the fact, no render effect
- **Staleness:** Editing does not re-flag render scenarios.
- **Editor surface:** field-label

**What it is**

The authoritative tag list for this fact. Whatever chips are here when you click Approve become the fact's live discovery hashtags. The 'AI suggested' row below feeds this list but ships nothing by itself.

**How the AI sets it**

Priority on approval: tags you set here win; if empty, the submitter's tags are used; if those are empty too, the AI's suggested hashtags are the fallback. All are normalized (lowercase alphanumeric) and the subject/app names ('alex', 'overhype') are always stripped.

**How it affects the render**

None — hashtags never enter the render pipeline. They are product metadata for discovery/browse.

**Examples**

- **Scenario:** AI suggested [strength, legendary, earth]; you want a different focus.
  - **Input:** Final hashtags: ["gymlife", "legendary", "strength"]
  - **Outcome:** Exactly those three attach to the live fact on approval; the unused AI suggestions are discarded.

**Sources**

- `artifacts/api-server/src/lib/hashtags.ts` `resolveFinalApprovalTags` — The moderator > submitter > AI-suggested priority and normalization at approval.

### AI suggested

*The classifier's tag ideas — a source list you can pull from, never shipped directly.*

- **Effect:** Product metadata — ships with the fact, no render effect
- **Staleness:** Editing does not re-flag render scenarios.
- **Editor surface:** field-label

**What it is**

Read-only chips showing what the enrichment AI proposed (3–8 tags). Use '+' to pull one into Final hashtags, or 'Add all'. If Final hashtags is left empty at approval, these become the fallback source.

**How the AI sets it**

Generated by the enrichment classifier under its hashtag rules: 3–8 reusable lowercase discovery tags; never the subject's name ('alex' — the canonical placeholder) or the app's name ('overhype'/'overhypeme') — both are also stripped deterministically after the model runs, with an automatic re-ask if stripping drops the list below 3.

**How it affects the render**

None — never enters the render pipeline.

**Examples**

- **Scenario:** Fact: "{NAME} can hear WiFi."
  - **Input:** AI suggested: [wifi, superhearing, technology]
  - **Outcome:** You tap '+' on the ones worth keeping; they move into Final hashtags.

**Sources**

- `artifacts/api-server/src/lib/factEnrichmentConfig.ts` `FACT_ENRICHMENT_SYSTEM_DEFAULT` — The classifier system prompt — the authoritative definition of what the AI is told this field means.

### Suggested Hashtags (3–8)

*The AI's stored tag list on a live fact — editable here, used as the fallback tag source.*

- **Effect:** Product metadata — ships with the fact, no render effect
- **Staleness:** Editing does not re-flag render scenarios.
- **Editor surface:** field-label

**What it is**

On the Facts page (live facts), this edits the enrichment blob's stored suggestedHashtags directly: 3–8 lowercase alphanumeric tags, normalized and de-duplicated on entry.

**How the AI sets it**

Same classifier rules as 'AI suggested' (this IS that list, stored). The subject name and app name are excluded by prompt rule + a deterministic post-filter.

**How it affects the render**

None — never enters the render pipeline, and explicitly excluded from the render-input hash.

**Examples**

- **Scenario:** A live fact's tags feel off.
  - **Input:** Edit to: ["strength", "legendary", "gym"]
  - **Outcome:** Saved with the enrichment; render scenarios are NOT flagged stale (hashtags are excluded from the hash).

**Sources**

- `artifacts/api-server/src/lib/factEnrichmentConfig.ts` `FACT_ENRICHMENT_SYSTEM_DEFAULT` — The classifier system prompt — the authoritative definition of what the AI is told this field means.
- `artifacts/api-server/src/lib/factRenderScenarios.ts` `renderAffectingEnrichment` — The render-input hash projection — fields listed here flip render-scenario tiles stale when edited.

### AI Classification Confidence

*The classifier's 0–1 confidence in its own archetype/subtype call. Read-only.*

- **Effect:** Advisory only — AI-planner context, no fixed compiler directive
- **Editor surface:** field-label

**What it is**

The model's self-reported confidence (0–1) in the taxonomy classification. Below 0.75, Taxonomy Health raises a low-confidence flag and marks the fact needs_admin_review — your cue to sanity-check the archetype/subtype yourself.

Read-only here: it describes the AI's classification event and is not meaningfully hand-editable.

**How the AI sets it**

Emitted by the classifier with each classification; the deterministic redundant-mechanism repair caps it at 0.49 when it rewrites a misclassification, keeping the fact flagged for review.

**How it affects the render**

Advisory only: echoed to the planner as context, never compiled, and explicitly excluded from the render-input hash.

**Examples**

- **Scenario:** The Step-2 summary shows 'Low classification confidence — sanity-check it.'
  - **Input:** taxonomyConfidence: 0.62
  - **Outcome:** Below the 0.75 threshold — review the archetype/subtype before trusting the renders.

**Sources**

- `artifacts/api-server/src/lib/factEnrichmentConfig.ts` `FACT_ENRICHMENT_SYSTEM_DEFAULT` — The classifier system prompt — the authoritative definition of what the AI is told this field means.
- `artifacts/api-server/src/lib/taxonomyHealth/index.ts` `LOW_CONFIDENCE_THRESHOLD` — The 0.75 low-confidence health threshold.

### Admin Review Notes

*Your notes to yourself and other admins — never seen by any AI or user.*

- **Effect:** Human-only — never leaves the admin UI
- **Staleness:** Editing does not re-flag render scenarios.
- **Editor surface:** field-label

**What it is**

Free text (max 800 chars) for human context: why you overrode something, what to watch for, open questions. The deterministic repair guard also appends its own notes here when it auto-corrects a misclassification.

Taxonomy Health treats a non-empty note as evidence a human has reviewed the fact.

**How the AI sets it**

Written by admins (and appended to by the repair guard). The classifier itself starts it empty.

**How it affects the render**

None — human-only. Never enters the planner or compiled prompt; excluded from the render-input hash, so editing it never flips renders stale.

**Examples**

- **Scenario:** You approved despite a questionable fit.
  - **Input:** adminReviewNotes: "Fit is borderline but the visual is great — approved 7/2."
  - **Outcome:** Context preserved for the next admin; nothing else in the system changes.

**Sources**

- `artifacts/api-server/src/lib/factRenderScenarios.ts` `renderAffectingEnrichment` — The render-input hash projection — fields listed here flip render-scenario tiles stale when edited.

## Visual Strategy Override

### Visual Strategy Override

*Moderator art-direction merged into the compiled prompt's labeled sections — it corrects the AI plan, never replaces it.*

- **Effect:** Render-affecting — feeds the prompt pipeline
- **Staleness:** Editing re-flags render scenarios as stale.
- **Editor surface:** panel-level

**What it is**

A per-fact, style-agnostic override object a human moderator edits to correct or sharpen the AI's visual strategy WITHOUT hand-editing the brittle final engine prompt. It is stored inside the enrichment blob (enrichment.visualPromptStrategyOverride) and merged into the deterministic compiler's labeled sections at render time — so the final prompt still adapts to subject, pronouns, reference image, style, render mode, aspect ratio, and the render policy.

The enabled toggle is the master switch: when OFF, the ENTIRE override is ignored by the compiler (every sub-field, both policies) — the object is kept but has zero render effect. When ON, each populated sub-field merges into its own compiled section.

Token system: rendered text fields accept the personalization tokens ({NAME}, {NAME_POSSESSIVE}, {SUBJ}, and the other pronoun tokens — the editor's chip bar inserts them). On save, name-token case/possessive variants are canonicalized ({name}/{Name} → {NAME}) and any UNKNOWN token is rejected with a clear message; the compiler resolves tokens per render, so one override serves every subject the fact is personalized to. Never type a real name.

The violence policy override here is the ONLY thing that can suppress violent depiction — the auto-sanitizing modifiers were retired, and the planner is told the render policy 'is the ONLY layer that may suppress; do not self-censor beyond it'.

**How the AI sets it**

Authored by moderators only — the AI never generates it. The save path stamps server-owned provenance (updatedBy/updatedAt, shown as 'Last edited …' at the panel's foot), and the whole object is preserved verbatim across re-classification, so re-running enrichment never wipes your art direction.

**How it affects the render**

The Visual Concept (CORE SCENE) LEADS the compiled prompt; every other section is operational or additive. Each sub-field lands in its own compiled section: subject realization → SUBJECT REALIZATION (required); required details → REQUIRED VISUAL DETAILS (required); forbidden/negative entries → 'Do not …' lines in STRICT CONSTRAINTS (required); role bindings → ROLE DETAILS (additive — only what the Concept didn't already state); composition guidance → COMPOSITION; style-agnostic additions → ADDITIONAL DETAILS. Required-priority sections always survive the engine's char budget, so moderator intent is never silently dropped.

The override MERGES into the AI's plan — it never replaces it. Anything you don't specify still comes from the AI plan and the authored archetype strategy.

The whole override object is in the render-input hash, so ANY edit (including admin-only fields) flips render-scenario tiles stale.

**Examples**

- **Scenario:** The AI's plan is 90% right but keeps adding a second adult subject next to the baby version.
  - **Input:** Enable the override; Forbidden Visual Details: ["a separate adult version of the subject"].
  - **Outcome:** "Do not add a separate adult version of the subject." lands in STRICT CONSTRAINTS; everything else in the AI plan is untouched.
- **Scenario:** You disable the toggle after a one-off experiment.
  - **Input:** enabled: false (fields left populated)
  - **Outcome:** The compiler ignores the entire override — renders behave as if it didn't exist, but your authored fields are preserved for later.
- **Scenario:** You write a detail with a hardcoded name.
  - **Input:** Required Visual Details: ["David's face on the statue"]
  - **Outcome:** Wrong — use "{NAME}'s face on the statue". Tokens resolve per render; a real name would leak into every other user's render.

**Sources**

- `lib/api-zod/src/visualStrategyOverride.ts` `visualPromptStrategyOverrideSchema` — The override's schema: field shapes, list caps, token canonicalization/validation on save, and the admin-only fields excluded from rendering.
- `artifacts/api-server/src/lib/imagePrompt/compilers/nanoBanana2.ts` `compile` — The deterministic Nano Banana 2 compiler — where each override sub-field is merged into a labeled prompt section.
- `artifacts/api-server/src/lib/imagePrompt/generator.ts` `buildImagePromptUserMessage` — The planner-side RENDER POLICY block — 'the ONLY layer that may suppress; do not self-censor beyond it'.
- `artifacts/api-server/src/lib/factRenderScenarios.ts` `renderAffectingEnrichment` — The render-input hash projection — it includes visualPromptStrategyOverride WHOLESALE, so editing any part of the override flips render-scenario tiles stale.

### Visual Concept (Core Scene)

*Describe the picture you want in plain language — it becomes the authoritative CORE SCENE, winning over the AI plan's scene.*

- **Effect:** Render-affecting — feeds the prompt pipeline
- **Staleness:** Editing re-flags render scenarios as stale.
- **Editor surface:** field-label

**What it is**

The moderator-authored scene: 2–4 plain-language sentences describing exactly what the image shows (subject, action, setting, objects, composition). When non-empty, it is AUTHORITATIVE — the planner LLM is directed to realize exactly this scene (not invent its own), and the compiler emits it as the CORE SCENE section at required priority, never compressed under the char budget.

Token-capable: use {NAME}, {NAME_POSSESSIVE}, and pronoun tokens — never a real name. Capped at 1500 characters: it is a scene brief, not a full prompt.

Also surfaced as the prominent 'Visual concept — describe the picture' card in moderation visual review; both surfaces edit this same field. Typing a non-empty concept auto-enables the override.

**How the AI sets it**

Authored by moderators only — the AI never writes it. Preserved verbatim across re-classification like the rest of the override.

**How it affects the render**

Replaces the AI plan's coreScene as the CORE SCENE section (required, non-compressible, marked MODERATOR in the prompt breakdown).

The compiler still owns identity/reference/text-policy language: engine instructions written here ('preserve the face', 'no readable text') are stripped, with a visible warning in the prompt diagnostics. A concept that consists ONLY of such instructions falls back to the AI scene with a loud warning — never a silently empty scene.

The planner LLM also receives it as a hard directive, so subjectDetails/environment/lighting are planned to support THIS scene.

**Examples**

- **Scenario:** The AI keeps missing the scale gag in a participation-trophy fact.
  - **Input:** Visual concept: "{NAME} triumphantly holds a participation trophy the size of a grain of rice, photographed like a championship victory."
  - **Outcome:** CORE SCENE is exactly that sentence (token-rendered per render), the planner fleshes out supporting detail around it, and it survives the char budget uncompressed.
- **Scenario:** You write engine instructions instead of a scene.
  - **Input:** Visual concept: "Preserve the uploaded face and do not show readable text."
  - **Outcome:** Both clauses are compiler-owned and stripped; the diagnostics warn that the concept emptied out and the AI scene was used instead. Rewrite as visible scene description.

**Sources**

- `lib/api-zod/src/visualStrategyOverride.ts` `visualPromptStrategyOverrideSchema` — The override's schema: field shapes, list caps, token canonicalization/validation on save, and the admin-only fields excluded from rendering.
- `artifacts/api-server/src/lib/imagePrompt/compilers/nanoBanana2.ts` `compile` — The deterministic Nano Banana 2 compiler — where each override sub-field is merged into a labeled prompt section.
- `artifacts/api-server/src/lib/factRenderScenarios.ts` `renderAffectingEnrichment` — The render-input hash projection — it includes visualPromptStrategyOverride WHOLESALE, so editing any part of the override flips render-scenario tiles stale.

### Moderator Intent (admin-only, not rendered)

*WHY you overrode — a note for humans; never compiled into any prompt.*

- **Effect:** Human-only — never leaves the admin UI
- **Staleness:** Editing re-flags render scenarios as stale.
- **Editor surface:** field-label

**What it is**

Free text explaining the intent behind the override, for yourself and other admins. It is explicitly excluded from the rendered text fields — the compiler never emits it, and it is not a token-insert target (tokens in it are neither needed nor validated).

**How the AI sets it**

Written by moderators; the AI never touches it.

**How it affects the render**

None on the compiled prompt — it never leaves the admin UI.

HONEST CAVEAT: the render-input hash includes the override object WHOLESALE, so editing this field DOES flip render-scenario tiles stale even though no compiled prompt changes because of it. Re-running the flagged scenarios will produce byte-identical prompts.

**Examples**

- **Scenario:** You pinned an unusual subject realization.
  - **Input:** Moderator Intent: "AI kept rendering a realistic baby — pinning adult-head composite per David's note 6/30."
  - **Outcome:** The next admin understands the override; the engine prompt is unaffected (but tiles flag stale due to the wholesale hash).

**Sources**

- `lib/api-zod/src/visualStrategyOverride.ts` `visualPromptStrategyOverrideSchema` — The override's schema: field shapes, list caps, token canonicalization/validation on save, and the admin-only fields excluded from rendering.
- `artifacts/api-server/src/lib/factRenderScenarios.ts` `renderAffectingEnrichment` — The render-input hash projection — it includes visualPromptStrategyOverride WHOLESALE, so editing any part of the override flips render-scenario tiles stale.

### Subject Depiction Mode

*Pin HOW the subject is physically realized in the image — human, transformed, object, symbolic — when the AI keeps getting it wrong.*

- **Effect:** Render-affecting — feeds the prompt pipeline
- **Staleness:** Editing re-flags render scenarios as stale.
- **Editor surface:** field-label

**What it is**

A mode dropdown that pins the subject's physical realization. The default use_ai_plan keeps the AI's own subject treatment; any other mode requires a description (the editor warns when it's empty) — because only the DESCRIPTION is compiled, never the mode name itself.

**How the AI sets it**

Moderator-chosen after reviewing test renders. Pick the mode that names your intent, then write the description as a complete instruction (see the per-value docs).

**How it affects the render**

When a mode other than use_ai_plan is set with a non-empty description, the description is emitted as the required-priority "SUBJECT REALIZATION" section, placed right after SUBJECT BINDING so it leads the visual prose.

It ADDS to (never replaces) the compiler-owned SUBJECT BINDING / anti-split guards; if your realization conflicts with a default guard (e.g. you WANT a realistic full de-age), express the conflict via Forbidden Visual Details.

**Values (8)**

- `use_ai_plan` — The default — keep the AI plan's subject realization untouched. The rest of the override (details, roles, policies) still applies.
  - *Render:* No SUBJECT REALIZATION section is emitted at all; the AI's own subject treatment (plus the compiler's SUBJECT BINDING) stands.
  - *Example:* The AI already renders the subject correctly; you only need to forbid one stray detail — leave this on use_ai_plan.
- `normal_human` *(authored — verify)* — Pin the subject as an ordinary human at their normal age and form — no transformation, object-ification, or symbolism.
  - *Render:* Your description (e.g. "{NAME} as a normal adult human, unchanged") is compiled verbatim into the required SUBJECT REALIZATION section, overriding an AI plan that kept transforming the subject.
  - *Example:* The AI keeps turning the subject into a giant for a strength fact — pin normal_human with "{NAME} at normal human scale".
- `age_transformed_human` *(authored — verify)* — The subject rendered as the SAME recognizable person at a different life stage (baby, child, elderly).
  - *Render:* Your description states the target life stage; it ADDS to (never replaces) the compiler's own SUBJECT BINDING / anti-split guards, which already fuse identity with the transformed age.
  - *Example:* "{NAME} de-aged into a toddler, same recognizable face" for a "{NAME} as a baby…" fact.
- `adult_head_on_transformed_body` *(authored — verify)* — The deliberately absurd composite: the subject's recognizable adult head/face kept on a transformed (e.g. baby) body.
  - *Render:* Your description spells out the composite so the engine doesn't 'fix' it into either a full adult or a full baby. Pair with forbiddenVisualDetails to block a realistic full de-age if the AI keeps producing one.
  - *Example:* "{NAME}'s adult head, unchanged, on a newborn-sized swaddled body" — the classic meme-composite realization.
- `subject_as_object` *(authored — verify)* — The subject realized as a THING — a statue, a mountain, a constellation, a product — rather than a figure in the scene.
  - *Render:* Your description defines the object and how it still reads as the subject (engraving, silhouette, likeness). Compiled into the required SUBJECT REALIZATION section.
  - *Example:* "{NAME} rendered as a colossal marble statue in the town square, face clearly recognizable" for a legacy/monument fact.
- `nonhuman_transformation` *(authored — verify)* — The subject transformed into a non-human being — an animal, a mythical creature, a force of nature.
  - *Render:* Your description states the creature and which identity cues survive the transformation; it is compiled into the required SUBJECT REALIZATION section.
  - *Example:* "{NAME} as a lion with {NAME_POSSESSIVE} distinctive hair color in the mane" for an apex-predator fact.
- `symbolic_or_implied` *(authored — verify)* — The subject is not literally shown — their presence is implied by evidence, symbols, or the scene's reaction to them.
  - *Render:* Your description defines the implication (empty throne, awed crowd looking off-frame, aftermath). Compiled into the required SUBJECT REALIZATION section.
  - *Example:* "{NAME} is off-frame; show only the crowd shielding their eyes from a blinding glow at the doorway" for an ineffable-presence fact.
- `custom` *(authored — verify)* — None of the named modes fit — the description carries the entire realization spec.
  - *Render:* Exactly like the other non-default modes: only the description text is compiled (the mode name itself never reaches the engine), so write the description as a complete, self-contained instruction.
  - *Example:* A half-photo/half-blueprint split-render of the subject that no named mode covers — describe it fully under custom.

**Examples**

- **Scenario:** "{NAME} as a baby ran the boardroom" — the AI renders a realistic baby, losing the recognizable face.
  - **Input:** mode: adult_head_on_transformed_body, description: "{NAME}'s recognizable adult head on a baby's body in a tiny suit"
  - **Outcome:** The prompt gains "SUBJECT REALIZATION: {NAME}'s recognizable adult head on a baby's body in a tiny suit." (token resolved per render) at required priority.
- **Scenario:** You set a mode but leave the description blank.
  - **Input:** mode: subject_as_object, description: ""
  - **Outcome:** Nothing is emitted (the section needs a description) and the editor warns 'Subject realization mode is set but its description is empty.'

**Sources**

- `lib/api-zod/src/visualStrategyOverride.ts` `visualPromptStrategyOverrideSchema` — The override's schema: field shapes, list caps, token canonicalization/validation on save, and the admin-only fields excluded from rendering.
- `artifacts/api-server/src/lib/imagePrompt/compilers/nanoBanana2.ts` `compile` — The deterministic Nano Banana 2 compiler — where each override sub-field is merged into a labeled prompt section.
- `artifacts/api-server/src/lib/factRenderScenarios.ts` `renderAffectingEnrichment` — The render-input hash projection — it includes visualPromptStrategyOverride WHOLESALE, so editing any part of the override flips render-scenario tiles stale.

### Subject Depiction Description

*The actual compiled text of the SUBJECT REALIZATION section — write it as a complete instruction.*

- **Effect:** Render-affecting — feeds the prompt pipeline
- **Staleness:** Editing re-flags render scenarios as stale.
- **Editor surface:** field-label

**What it is**

The token-aware text that IS the SUBJECT REALIZATION section. The mode dropdown categorizes your intent, but this description is the only part the engine ever sees — so it must fully state the realization on its own.

**How the AI sets it**

Moderator-authored. Token chips insert {NAME}/{NAME_POSSESSIVE}/pronoun tokens at the caret; name-token variants are canonicalized on save and unknown tokens rejected.

**How it affects the render**

Emitted verbatim (tokens resolved, terminal punctuation normalized) as the required "SUBJECT REALIZATION" section — required priority means it survives the char budget.

Skipped entirely when the mode is use_ai_plan or the description is blank.

**Examples**

- **Scenario:** Pinning a symbolic realization.
  - **Input:** "{NAME} is off-frame; the crowd stares upward at a silhouette blotting out the sun"
  - **Outcome:** That sentence leads the prompt's realization, steering the whole scene composition.

**Sources**

- `lib/api-zod/src/visualStrategyOverride.ts` `visualPromptStrategyOverrideSchema` — The override's schema: field shapes, list caps, token canonicalization/validation on save, and the admin-only fields excluded from rendering.
- `artifacts/api-server/src/lib/imagePrompt/compilers/nanoBanana2.ts` `compile` — The deterministic Nano Banana 2 compiler — where each override sub-field is merged into a labeled prompt section.
- `artifacts/api-server/src/lib/factRenderScenarios.ts` `renderAffectingEnrichment` — The render-input hash projection — it includes visualPromptStrategyOverride WHOLESALE, so editing any part of the override flips render-scenario tiles stale.

### Required Visual Details

*Concrete things that MUST be visible — each entry becomes part of a required prompt section.*

- **Effect:** Render-affecting — feeds the prompt pipeline
- **Staleness:** Editing re-flags render scenarios as stale.
- **Editor surface:** field-label

**What it is**

A list (max 40 entries) of concrete, visible details the render must include. Token-aware. Write each entry as a noun-y visual ('{NAME}'s recognizable face on a newborn body'), not intent commentary.

**How the AI sets it**

Moderator-authored, typically after a test render omitted something load-bearing for the joke.

**How it affects the render**

Entries are joined into the required-priority "REQUIRED VISUAL DETAILS" section (each entry a clause, "; "-separated), placed right after SUBJECT DETAILS. Required priority means the engine char budget can never drop them.

They also seed the compiler's de-dupe haystack, so later sections don't repeat them.

**Examples**

- **Scenario:** The joke needs the trophy shelf visible but renders keep cropping it.
  - **Input:** Required Visual Details: ["a shelf crowded with gold trophies behind {NAME}"]
  - **Outcome:** "REQUIRED VISUAL DETAILS: a shelf crowded with gold trophies behind {NAME}." (token resolved) — guaranteed to survive budgeting.

**Sources**

- `lib/api-zod/src/visualStrategyOverride.ts` `visualPromptStrategyOverrideSchema` — The override's schema: field shapes, list caps, token canonicalization/validation on save, and the admin-only fields excluded from rendering.
- `artifacts/api-server/src/lib/imagePrompt/compilers/nanoBanana2.ts` `compile` — The deterministic Nano Banana 2 compiler — where each override sub-field is merged into a labeled prompt section.
- `artifacts/api-server/src/lib/factRenderScenarios.ts` `renderAffectingEnrichment` — The render-input hash projection — it includes visualPromptStrategyOverride WHOLESALE, so editing any part of the override flips render-scenario tiles stale.

### Forbidden Visual Details

*Things that must NOT appear — each entry becomes a "Do not …" line in STRICT CONSTRAINTS.*

- **Effect:** Render-affecting — feeds the prompt pipeline
- **Staleness:** Editing re-flags render scenarios as stale.
- **Editor surface:** field-label

**What it is**

A list (max 40 entries) of visuals to ban. Each entry is normalized into a negative constraint: an entry not already phrased negatively gets a 'Do not ' prefix (entries starting with Do not/Don't/Avoid/Never/No are kept as-is, never double-prefixed).

**How the AI sets it**

Moderator-authored — the standard fix for a recurring wrong element in test renders, and the sanctioned way to override a default compiler guard you disagree with.

**How it affects the render**

Normalized entries join the required-priority STRICT CONSTRAINTS section (after the compiler's own supporting-text, violence, and anti-split constraints), so they always survive the char budget.

**Examples**

- **Scenario:** Renders keep adding a second adult next to the de-aged subject.
  - **Input:** Forbidden Visual Details: ["a separate adult version of the subject"]
  - **Outcome:** "Do not a separate adult version of the subject." — better: write it verb-first ("show a separate adult version of the subject") so the prefixed line reads "Do not show a separate adult version of the subject."
- **Scenario:** An entry already phrased as a negative.
  - **Input:** ["Never show the subject's back to camera"]
  - **Outcome:** Kept as-is: "Never show the subject's back to camera." — no double "Do not" prefix.

**Sources**

- `lib/api-zod/src/visualStrategyOverride.ts` `visualPromptStrategyOverrideSchema` — The override's schema: field shapes, list caps, token canonicalization/validation on save, and the admin-only fields excluded from rendering.
- `artifacts/api-server/src/lib/imagePrompt/compilers/nanoBanana2.ts` `compile` — The deterministic Nano Banana 2 compiler — where each override sub-field is merged into a labeled prompt section.
- `artifacts/api-server/src/lib/factRenderScenarios.ts` `renderAffectingEnrichment` — The render-input hash projection — it includes visualPromptStrategyOverride WHOLESALE, so editing any part of the override flips render-scenario tiles stale.

### Scene Role Assignments

*Who is who in the scene — your bindings REPLACE the AI's secondary-character casting.*

- **Effect:** Render-affecting — feeds the prompt pipeline
- **Staleness:** Editing re-flags render scenarios as stale.
- **Editor surface:** field-label

**What it is**

A list (max 20) of entity → visual-role pairs. The entity is 'subject' or a relationship/name/type label ('mother', 'crowd/victims'); the visual role is what that entity concretely is/does in the frame. Both sides are token-aware.

**How the AI sets it**

Moderator-authored when the AI casts roles wrongly — the classic failure being a secondary character drifting into the subject's central action.

**How it affects the render**

When ANY binding is present, your bindings take precedence over the AI plan's secondaryCharacters wholesale: the 'subject' entity's role becomes the subject's role-in-scene, and every other entity becomes a secondary character.

They are compiled into the ROLE DETAILS section as ADDITIVE clauses — but the Visual Concept (CORE SCENE) now LEADS the prompt and carries the scene, so ROLE DETAILS only surfaces a role the Concept did not already state (redundant ones are dropped). A role that already names the subject is emitted as-is (never doubled to "<Name> is <Name> …"); a bare role gets a "<subject> is <role>" clause. Negatives belong in Forbidden Visual Details, not here.

Rows with an empty entity or role are skipped (the editor warns).

**Examples**

- **Scenario:** "A baby drove {NAME}'s mother home." — renders keep putting the subject behind the wheel.
  - **Input:** Role Bindings: subject → "the astonished passenger", "baby" → "the tiny driver gripping the wheel"
  - **Outcome:** "ROLE DETAILS: {NAME} is the astonished passenger. baby is the tiny driver gripping the wheel." (emitted only if the Visual Concept did not already cast these roles) — replacing the AI's own casting.

**Sources**

- `lib/api-zod/src/visualStrategyOverride.ts` `visualPromptStrategyOverrideSchema` — The override's schema: field shapes, list caps, token canonicalization/validation on save, and the admin-only fields excluded from rendering.
- `artifacts/api-server/src/lib/imagePrompt/compilers/nanoBanana2.ts` `compile` — The deterministic Nano Banana 2 compiler — where each override sub-field is merged into a labeled prompt section.
- `artifacts/api-server/src/lib/factRenderScenarios.ts` `renderAffectingEnrichment` — The render-input hash projection — it includes visualPromptStrategyOverride WHOLESALE, so editing any part of the override flips render-scenario tiles stale.

### Composition Guidance

*Framing/camera/layout directives folded into the COMPOSITION section.*

- **Effect:** Render-affecting — feeds the prompt pipeline
- **Staleness:** Editing re-flags render scenarios as stale.
- **Editor surface:** field-label

**What it is**

A list (max 20) of composition directives — framing, camera angle, subject placement, negative space. Token-aware.

**How the AI sets it**

Moderator-authored, layered after the AI plan's own framing + camera + caption-negative-space directives.

**How it affects the render**

Entries are appended to the COMPOSITION section (high priority — included while the char budget allows, after all required sections are safe).

**Examples**

- **Scenario:** Renders keep centering the subject when the joke needs scale contrast.
  - **Input:** Composition Guidance: ["low-angle wide shot; {NAME} tiny in the lower third against the colossal object"]
  - **Outcome:** The directive joins the COMPOSITION section after the AI plan's framing/camera lines.

**Sources**

- `lib/api-zod/src/visualStrategyOverride.ts` `visualPromptStrategyOverrideSchema` — The override's schema: field shapes, list caps, token canonicalization/validation on save, and the admin-only fields excluded from rendering.
- `artifacts/api-server/src/lib/imagePrompt/compilers/nanoBanana2.ts` `compile` — The deterministic Nano Banana 2 compiler — where each override sub-field is merged into a labeled prompt section.
- `artifacts/api-server/src/lib/factRenderScenarios.ts` `renderAffectingEnrichment` — The render-input hash projection — it includes visualPromptStrategyOverride WHOLESALE, so editing any part of the override flips render-scenario tiles stale.

### Extra Prompt Details (any style)

*Extra scene text that must work under EVERY visual style — compiled as ADDITIONAL DETAILS.*

- **Effect:** Render-affecting — feeds the prompt pipeline
- **Staleness:** Editing re-flags render scenarios as stale.
- **Editor surface:** field-label

**What it is**

A list (max 20) of free-form prompt additions that hold under any look/style the render is later given (photoreal, cartoon, painterly). Don't put style words here — style comes from the separate style system. Token-aware.

**How the AI sets it**

Moderator-authored for content that doesn't fit the more specific fields (details, roles, composition).

**How it affects the render**

Compiled into the "ADDITIONAL DETAILS" section, placed after ENVIRONMENT at high priority and compressible — under extreme budget pressure it is trimmed sentence-by-sentence before being dropped (unlike the required override sections). Prefer Required Visual Details for anything that must survive unconditionally.

**Examples**

- **Scenario:** The scene needs weather that isn't a required element.
  - **Input:** Style-Agnostic Prompt Additions: ["a light drizzle glossing every surface"]
  - **Outcome:** "ADDITIONAL DETAILS: a light drizzle glossing every surface." — included while budget allows, style-neutral.

**Sources**

- `lib/api-zod/src/visualStrategyOverride.ts` `visualPromptStrategyOverrideSchema` — The override's schema: field shapes, list caps, token canonicalization/validation on save, and the admin-only fields excluded from rendering.
- `artifacts/api-server/src/lib/imagePrompt/compilers/nanoBanana2.ts` `compile` — The deterministic Nano Banana 2 compiler — where each override sub-field is merged into a labeled prompt section.
- `artifacts/api-server/src/lib/factRenderScenarios.ts` `renderAffectingEnrichment` — The render-input hash projection — it includes visualPromptStrategyOverride WHOLESALE, so editing any part of the override flips render-scenario tiles stale.

### Do-Not-Render Additions

*Exclusions — but Nano Banana 2 has NO negative-prompt parameter, so these become prose "Do not …" constraints.*

- **Effect:** Render-affecting — feeds the prompt pipeline
- **Staleness:** Editing re-flags render scenarios as stale.
- **Editor surface:** field-label

**What it is**

A list (max 20) of exclusion entries. Despite the name, the target engine has no negative-prompt API parameter (the plan validator forces compiledPrompt.negativePrompt empty) — so every entry is turned into a prose constraint inside the positive prompt.

**How the AI sets it**

Moderator-authored. Functionally these merge with Forbidden Visual Details; use whichever framing reads clearer for the exclusion.

**How it affects the render**

Each entry is normalized into a "Do not …" line (same no-double-prefix rule as Forbidden Visual Details) and appended to the required-priority STRICT CONSTRAINTS section — guaranteed to survive the char budget. Nothing is ever sent through a negative-prompt channel, because none exists.

**Examples**

- **Scenario:** Renders keep adding lens flare.
  - **Input:** Negative Prompt Additions: ["add lens flare or bloom effects"]
  - **Outcome:** "Do not add lens flare or bloom effects." appears in STRICT CONSTRAINTS as prose — the engine has no negative-prompt parameter to receive it any other way.

**Sources**

- `lib/api-zod/src/visualStrategyOverride.ts` `visualPromptStrategyOverrideSchema` — The override's schema: field shapes, list caps, token canonicalization/validation on save, and the admin-only fields excluded from rendering.
- `artifacts/api-server/src/lib/imagePrompt/compilers/nanoBanana2.ts` `compile` — The deterministic Nano Banana 2 compiler — where each override sub-field is merged into a labeled prompt section.
- `lib/api-zod/src/imagePromptGeneration.ts` `validateImagePromptPlan` — Rule 16: compiledPrompt.negativePrompt must be empty for nano_banana_2 — exclusions must be positive prose.
- `artifacts/api-server/src/lib/factRenderScenarios.ts` `renderAffectingEnrichment` — The render-input hash projection — it includes visualPromptStrategyOverride WHOLESALE, so editing any part of the override flips render-scenario tiles stale.

### Override supporting-text policy

*Governs IN-WORLD readable text (signs, titles, scoreboards) — overlay/caption text is always excluded regardless.*

- **Effect:** Render-affecting — feeds the prompt pipeline
- **Staleness:** Editing re-flags render scenarios as stale.
- **Editor surface:** field-label

**What it is**

An optional policy override (checkbox + mode + guidance) for in-world readable text. Two distinct text layers exist: the meme caption/fact text is composited OUTSIDE the image and is ALWAYS excluded from the render (the compiler unconditionally emits the overlay-text exclusion — no captions, watermarks, logos, brand marks baked in); this policy governs only text living inside the scene.

When the checkbox is off, the default policy (allow) applies. Guidance is token-aware.

**How the AI sets it**

Moderator-set. The editor warns when mode=require has no guidance — required text must be described.

**How it affects the render**

Compiled into the required-priority STRICT CONSTRAINTS section per mode (see the per-value docs). Independently, an always-on incidental-text guard keeps background signage non-readable while yielding to any intentional in-scene text, so you only need mode=forbid to fully suppress text the scene would otherwise want. If the AI planner picked concrete supportingTextElements, those render regardless of mode — the planner's scene content is the strongest signal.

**Values (3)**

- `allow` — In-world readable text (signs, TV titles, scoreboards, documents) is permitted but not requested.
  - *Render:* The compiler adds no in-world-text directive of its own unless the planner picked explicit supportingTextElements or your guidance is set — unnecessary text is not encouraged. Two lines are always emitted regardless: the narrow overlay-text exclusion (no captions/watermarks/logos baked in) and an always-on incidental-text guard that steers background signage non-readable while YIELDING to any intentional in-scene text.
  - *Example:* allow + guidance 'a TV title reading "{NAME} Week"' → the guidance line is emitted so the title card appears; the incidental-text guard yields to it.
- `forbid` — In-world readable text should be avoided in this scene.
  - *Render:* Emits the literal line: "Avoid readable in-scene text unless required by a higher-priority instruction." into STRICT CONSTRAINTS (alongside the always-on incidental-text guard). This is the way to fully suppress in-scene text — it replaces the retired no_readable_text modifier. Exception: if the planner selected concrete supportingTextElements, those still render (the planner's scene content is the strongest signal).
  - *Example:* A scene should have NO readable text at all → forbid emits the avoid line and cleans the scene of readable text.
- `require` — The joke NEEDS readable in-world text (a title card, a scoreboard, a headline) — make the engine show it.
  - *Render:* Emits: "SUPPORTING TEXT: Readable in-scene text is required in this scene. Show it clearly: {your guidance}." (or the guidance-less variant). The editor warns when require is set without guidance — the engine can't require unspecified text.
  - *Example:* "Sharks have a {NAME} Week" → require + guidance 'a TV title card reading "{NAME} Week"'.

**Examples**

- **Scenario:** "Sharks have a {NAME} Week" — the joke needs the title card readable.
  - **Input:** mode: require, guidance: 'a TV title card reading "{NAME} Week"'
  - **Outcome:** "SUPPORTING TEXT: Readable in-scene text is required in this scene. Show it clearly: a TV title card reading "{NAME} Week"." (token resolved per render).
- **Scenario:** Gibberish signage keeps appearing.
  - **Input:** mode: forbid
  - **Outcome:** "Avoid readable in-scene text unless required by a higher-priority instruction." joins STRICT CONSTRAINTS.

**Sources**

- `lib/api-zod/src/visualStrategyOverride.ts` `visualPromptStrategyOverrideSchema` — The override's schema: field shapes, list caps, token canonicalization/validation on save, and the admin-only fields excluded from rendering.
- `artifacts/api-server/src/lib/imagePrompt/compilers/nanoBanana2.ts` `compile` — The deterministic Nano Banana 2 compiler — where each override sub-field is merged into a labeled prompt section.
- `artifacts/api-server/src/lib/factRenderScenarios.ts` `renderAffectingEnrichment` — The render-input hash projection — it includes visualPromptStrategyOverride WHOLESALE, so editing any part of the override flips render-scenario tiles stale.

### Override violence policy

*The ONLY control that can suppress violent depiction — default is allow at strong intensity.*

- **Effect:** Render-affecting — feeds the prompt pipeline
- **Staleness:** Editing re-flags render scenarios as stale.
- **Editor surface:** field-label

**What it is**

An optional policy override (checkbox + mode + intensity + guidance) for how much of the fact's violence/consequences the scene depicts. The checkbox scaffold defaults to allow + strong — the platform default that depicts what the fact requires, including bodies/casualties, without gratuitous gore.

This override is the ONLY violence suppressor in the pipeline: the auto-sanitizing modifiers were retired, and the planner is explicitly told the render policy 'is the ONLY layer that may suppress; do not self-censor beyond it'.

**How the AI sets it**

Moderator-set, typically to soften/suppress a fact whose default renders are too grisly for its context. Guidance (token-aware) refines or, under allow, replaces the default directive line.

**How it affects the render**

suppress emits the literal compiler line: "Do not depict violence, injury, or death directly; represent consequences symbolically or through environmental damage."

soften emits: "Soften violent consequences; avoid graphic injury and visible death unless explicitly required by a higher-priority instruction."

allow emits the permission line only when the fact is violence-relevant (a violence modifier — cinematic_aftermath, projectile_impact_power, action_comedy — or violent lexicon in the fact/plan): "When the fact explicitly requires violence, death, weapons, or destruction, depict the action and consequences clearly without gratuitous gore." Your guidance text replaces it when set.

All of it lands in the required-priority STRICT CONSTRAINTS section; the planner separately receives a matching RENDER POLICY block so scene planning and compilation agree. Intensity is planner-side context under allow (see the per-value docs) — the compiler never emits "graphic"-flavored language.

**Values (8)**

- `allow` — The platform default — depict the violence/consequences the fact requires, without gratuitous gore.
  - *Render:* When the fact is violence-relevant (violence modifiers or violent lexicon), the compiler emits the permission line: "When the fact explicitly requires violence, death, weapons, or destruction, depict the action and consequences clearly without gratuitous gore." Your guidance text, if set, replaces that line. The planner separately receives violence=ALLOW with the intensity and "Do NOT add your own sanitizing or content-suppression language."
  - *Example:* "{NAME} threw a grenade and killed 50 people…" → the aftermath (bodies included) is depicted, not sanitized away.
- `soften` — Deliberately reduce explicit violent consequences while keeping the action.
  - *Render:* Emits the literal line: "Soften violent consequences; avoid graphic injury and visible death unless explicitly required by a higher-priority instruction." The planner receives violence=SOFTEN with matching language.
  - *Example:* An action fact whose test renders came out too grisly for the meme tone → soften keeps the explosion, loses the gore.
- `suppress` — Deliberately avoid depicting violence at all — consequences become symbolic/environmental.
  - *Render:* Emits the literal line: "Do not depict violence, injury, or death directly; represent consequences symbolically or through environmental damage." This moderator override is the ONLY thing that suppresses violent depiction — the retired auto-softening modifiers no longer exist.
  - *Example:* A combat fact rendered for a context where no injury should be visible → suppress swaps casualties for cratered ground and dust.
- `nonviolent` *(authored — verify)* — No violent content at all — the scene should carry zero violence even under an allow mode.
  - *Render:* Planner context only: the intensity is echoed in the planner's violence=ALLOW line to calibrate how much consequence the scene stages. For a hard guarantee of no violence, use mode=suppress instead — intensity alone emits no compiler directive.
  - *Example:* A gentle fact that trips the violence lexicon incidentally — nonviolent tells the planner to keep the scene entirely peaceful.
- `mild` *(authored — verify)* — Cartoon-level, consequence-light action — impacts and tumbles without injury.
  - *Render:* Planner context only (echoed in the violence=ALLOW line); no deterministic compiler directive branches on it.
  - *Example:* A slapstick fact → mild keeps the punch visible but nobody visibly hurt.
- `moderate` *(authored — verify)* — Real action-movie consequences implied — destruction and danger, but no explicit casualties.
  - *Render:* Planner context only (echoed in the violence=ALLOW line); no deterministic compiler directive branches on it.
  - *Example:* A building-toppling fact → moderate shows wreckage and fleeing crowds, not bodies.
- `strong` — The platform default. Per the code comment: the platform default is "strong" (visible death, bodies, explosions, weapons, action aftermath, without gratuitous gore).
  - *Render:* The default intensity in every render policy and in the override's checkbox scaffold. The planner's default line is violence=ALLOW (strong), which explicitly permits the bodies/casualties the fact calls for.
  - *Example:* "{NAME} killed 50 people with a grenade throw" → strong depicts the casualties the fact describes, non-gratuitously.
- `graphic` — Per the code comment: "graphic" is FUTURE-COMPATIBLE only (a future adult/NSFW mode may use it). It is never selected or encouraged by default.
  - *Render:* No current pipeline behavior selects or amplifies it — the compiler never emits "graphic"-flavored language. It exists so a future adult/NSFW mode has a schema slot; do not use it today.
  - *Example:* None today — selecting it renders like strong; the value is reserved for a future mode.

**Examples**

- **Scenario:** "{NAME} once threw a grenade and killed 50 people, then it exploded." — a render context where no bodies should be visible.
  - **Input:** mode: suppress
  - **Outcome:** "Do not depict violence, injury, or death directly; represent consequences symbolically or through environmental damage." — cratered ground instead of casualties.
- **Scenario:** The same fact rendered normally.
  - **Input:** No override (default allow + strong)
  - **Outcome:** The fact is violence-relevant, so the allow permission line is emitted and the aftermath is depicted as the fact calls for.

**Sources**

- `lib/api-zod/src/visualStrategyOverride.ts` `visualPromptStrategyOverrideSchema` — The override's schema: field shapes, list caps, token canonicalization/validation on save, and the admin-only fields excluded from rendering.
- `artifacts/api-server/src/lib/imagePrompt/compilers/nanoBanana2.ts` `compile` — The deterministic Nano Banana 2 compiler — where each override sub-field is merged into a labeled prompt section.
- `artifacts/api-server/src/lib/imagePrompt/generator.ts` `buildImagePromptUserMessage` — The planner-side RENDER POLICY block — 'the ONLY layer that may suppress; do not self-censor beyond it'.
- `lib/api-zod/src/renderPolicyEnums.ts` `VIOLENCE_INTENSITY_VALUES` — The intensity ladder + the strong-is-default / graphic-is-future-only comment.
- `artifacts/api-server/src/lib/factRenderScenarios.ts` `renderAffectingEnrichment` — The render-input hash projection — it includes visualPromptStrategyOverride WHOLESALE, so editing any part of the override flips render-scenario tiles stale.

## References & Scene Entities

### Cultural / Inside References

*Outside-context dependencies the joke relies on — with a materiality gate deciding which ones the render MUST honor.*

- **Effect:** Render-affecting — feeds the prompt pipeline
- **Staleness:** Editing re-flags render scenarios as stale.
- **Editor surface:** section-level

**What it is**

The list of outside-context dependencies detected during enrichment: knowledge the joke relies on that isn't obvious from the literal words — a brand, a workplace/professional context, an idiom, wordplay, mechanism knowledge, or an inside reference. A fact with no such dependency has an empty list (there is deliberately no 'none' type).

Each row is fully editable, and the per-row 'Research Reference' tool can verify a reference and stamp research metadata (researchConfidence, sources, notes, ambiguity warnings) that both the admin and the planner see.

References inform HOW to render the joke; they never change the archetype/subtype — the taxonomy classifies the mechanism, references flesh out the rendering.

**How the AI sets it**

The classifier emits them under its cultural-reference rules, with the canonical worked examples: "Sharks have a {NAME} Week" → cultural_reference 'Shark Week' (visual implication: sharks are the audience watching the subject as spectacle); the Yardi demo fact → workplace/professional_domain_context; the magnifying-glass-at-night fact → mechanism_knowledge.

**How it affects the render**

Every reference (with research context when present) is injected into the planner's PER-FACT CULTURAL REFERENCES block, each marked material=true/false. The MATERIALITY GATE: a reference is material when researchConfidence is "high", OR confidence ≥ 0.8 AND it is not flagged for admin review. Ambiguous/review-flagged references are context only — never forced (they may be wrong).

FORCE-ECHO (validator rule 15): every material reference MUST be echoed back in visualPlan.culturalReferencesUsed (sourcePhrase verbatim + canonicalReferenceUsed + visualImplicationUsed + effectOnVisualPlan, all non-empty). A miss triggers one corrective retry re-asking the planner with the exact requirement.

The planner is instructed to "Bake the reference's visual implication into keyVisualElements + the compiledPrompt.prompt, but never draw a real logo or brand mark." The compiler then guarantees delivery: any echoed visualImplicationUsed the prose omitted is folded into "Ensure these elements are clearly visible: …". The canonical reference and explanation are NEVER compiled — re-emitting them would leak meta-instruction and brand names (e.g. "Discovery Channel") into the engine prompt.

The whole collection is in the render-input hash — editing any row flips render-scenario tiles stale.

Pipeline: classifier detects → planner is informed → validator force-echoes material items → compiler guarantees the concrete visual reaches the engine.

**Examples**

- **Scenario:** "Sharks have a {NAME} Week." — confidence 0.9, not flagged.
  - **Input:** cultural_reference, canonical "Shark Week", visualImplication "sharks are the audience watching the subject as spectacle"
  - **Outcome:** Material → the plan MUST echo it, and sharks-as-audience is guaranteed visible in the render; the words 'Shark Week'/'Discovery Channel' never reach the engine.
- **Scenario:** "{NAME} can set an ant on fire with a magnifying glass. At night." — mechanism_knowledge.
  - **Input:** visualImplication: "a magnifying glass focusing a beam under a starry night sky — the impossible part"
  - **Outcome:** The night-beam visual is echoed and gap-filled into the prompt so the mechanism-defiance reads.
- **Scenario:** A brand reference at confidence 0.6 with requiresAdminReview=true.
  - **Input:** (unchanged, unresearched)
  - **Outcome:** NOT material: the planner sees it as context but is never forced to honor it. Running Research Reference to high confidence makes it material.

**Sources**

- `artifacts/api-server/src/lib/factEnrichmentConfig.ts` `FACT_ENRICHMENT_SYSTEM_DEFAULT` — The classifier system prompt — the cultural-reference and semantic-entity/capitalization rules plus their worked examples.
- `lib/api-zod/src/taxonomy.ts` `culturalReferenceSchema` — The reference/entity schemas: field shapes, max lengths, and the research-metadata fields.
- `artifacts/api-server/src/lib/imagePrompt/generator.ts` `buildImagePromptUserMessage` — Where references/entities are injected into the planner message, including the materiality gate and the never-draw-a-real-logo instruction.
- `artifacts/api-server/src/lib/imagePrompt/generator.ts` `isMaterialCulturalReference` — A reference is material when researchConfidence === "high", OR confidence >= 0.8 and it is not flagged for admin review.
- `lib/api-zod/src/imagePromptGeneration.ts` `validateImagePromptPlan` — Rules 14/15: material entities/references MUST be echoed back in the visual plan; a violation triggers one corrective retry.
- `artifacts/api-server/src/lib/imagePrompt/compilers/nanoBanana2.ts` `composeKeyElementsDirective` — The compiler-side guarantee: resolved visualImplicationUsed / visualReferentUsed values the prose omitted are folded into "Ensure these elements are clearly visible: …".
- `artifacts/api-server/src/lib/factRenderScenarios.ts` `renderAffectingEnrichment` — The render-input hash includes culturalReferences and semanticEntities wholesale — editing any row field flips render-scenario tiles stale.

### Source phrase

*The literal phrase in the fact that triggers the reference — also the echo-match key.*

- **Effect:** Render-affecting — feeds the prompt pipeline
- **Staleness:** Editing re-flags render scenarios as stale.
- **Editor surface:** reserved

**What it is**

The verbatim word/phrase in the fact text that carries the reference (max 300 chars). It doubles as the reference's identity: the validator matches the plan's echo-back against it case-insensitively (falling back to the canonical reference when empty).

**How the AI sets it**

The classifier quotes it from the fact; editable for manual-fill workflows.

**How it affects the render**

Shown to the planner in the reference block; for material references, the plan must echo this exact sourcePhrase in culturalReferencesUsed or the corrective retry fires.

**Examples**

- **Scenario:** "Sharks have a {NAME} Week."
  - **Input:** sourcePhrase: "{NAME} Week"
  - **Outcome:** The plan's culturalReferencesUsed entry must carry this sourcePhrase verbatim (case-insensitive match).

**Sources**

- `lib/api-zod/src/taxonomy.ts` `culturalReferenceSchema` — The reference/entity schemas: field shapes, max lengths, and the research-metadata fields.
- `lib/api-zod/src/imagePromptGeneration.ts` `validateImagePromptPlan` — Rules 14/15: material entities/references MUST be echoed back in the visual plan; a violation triggers one corrective retry.
- `artifacts/api-server/src/lib/factRenderScenarios.ts` `renderAffectingEnrichment` — The render-input hash includes culturalReferences and semanticEntities wholesale — editing any row field flips render-scenario tiles stale.

### Reference type

*What KIND of outside-context dependency this is.*

- **Effect:** Render-affecting — feeds the prompt pipeline
- **Staleness:** Editing re-flags render scenarios as stale.
- **Editor surface:** repeater-enum

**What it is**

An eight-way categorization of the dependency (see the per-value docs). There is intentionally no 'none' value — a fact without references has an empty list instead.

**How the AI sets it**

Chosen by the classifier per its rules; the canonical examples map Shark Week → cultural_reference, Yardi → workplace/professional_domain_context, the night magnifying glass → mechanism_knowledge.

**How it affects the render**

Planner context only — it labels the dependency in the reference block. The materiality gate and echo rules don't branch on type, though brand/workplace types usually arrive with requiresAdminReview=true (which does affect materiality).

**Values (8)**

- `cultural_reference` — The joke leans on a shared cultural artifact or phenomenon — a TV show, event, meme, tradition — that isn't named literally.
  - *Render:* The reference (with its visual implication) is injected into the planner's PER-FACT CULTURAL REFERENCES block; if material, the planner must bake the implication into the scene.
  - *Example:* "Sharks have a {NAME} Week" → cultural_reference, canonical "Shark Week" — sharks become the audience watching the subject as spectacle.
- `brand_reference` — The joke depends on a real brand or company ("Victoria's Secret", "Apple") — typically also flagged requiresAdminReview.
  - *Render:* Informs the planner's interpretation, but the canonical brand name is NEVER compiled into the engine prompt, and the planner is told to never draw a real logo or brand mark — only the brand's visual implication reaches the scene.
  - *Example:* A "{NAME}'s secret" wordplay on Victoria's Secret → the scene gets the runway-glamour implication, no logo.
- `workplace_context` — The joke needs knowledge of a specific workplace or company context the audience shares.
  - *Render:* Planner context: the scene is staged inside the implied workplace world; usually requiresAdminReview (real workplace).
  - *Example:* "{NAME} doesn't prepare for demos, demos prepare for {NAME}. #Yardi" → the Yardi/SaaS-presales demo context.
- `professional_domain_context` — The joke needs domain-professional knowledge (how presales demos, courtrooms, or trading floors work) rather than a specific employer.
  - *Render:* Planner context: the scene borrows the domain's recognizable staging (demo screens, gavels, tickers) so the joke reads.
  - *Example:* The same Yardi demo fact classified for its presales-demo domain rather than the employer per se.
- `idiom_or_phrase` — The joke reuses a familiar phrase, idiom, or saying whose recognition is the hook.
  - *Render:* Planner context: the visual implication usually literalizes the idiom; there may be no canonicalReference (empty is allowed).
  - *Example:* "{NAME}'s handshake seals deals" riffing on "seal the deal" → a literal wax seal in the scene.
- `wordplay` — The joke's hook is a pun or double meaning in the words themselves.
  - *Render:* Planner context: the scene typically needs BOTH meanings visible for the pun to land — the visual implication should say how.
  - *Example:* A "{NAME} raised the bar" fact → a literal bar being physically raised in a gym.
- `mechanism_knowledge` — The joke depends on knowing how something normally works, so the impossibility registers.
  - *Render:* Planner context: the scene must show the mechanism being defied clearly enough that a viewer who knows it gets the joke.
  - *Example:* "{NAME} can set an ant on fire with a magnifying glass. At night." → magnifying glasses focus SUNlight; nighttime breaks the mechanism.
- `inside_reference` — The joke references something only a specific in-group (a friend circle, a team, a community) will recognize.
  - *Render:* Planner context: often low-confidence and requiresAdminReview — the AI can't verify an inside joke, so a human should confirm the implication.
  - *Example:* A fact riffing on a submitter's group chat catchphrase — flagged for review because the AI is guessing at the referent.

**Examples**

- **Scenario:** The Yardi demo fact.
  - **Input:** referenceType: professional_domain_context
  - **Outcome:** The planner reads the joke through the SaaS-presales-demo lens when staging the scene.

**Sources**

- `artifacts/api-server/src/lib/factEnrichmentConfig.ts` `FACT_ENRICHMENT_SYSTEM_DEFAULT` — The classifier system prompt — the cultural-reference and semantic-entity/capitalization rules plus their worked examples.
- `lib/api-zod/src/taxonomy.ts` `culturalReferenceSchema` — The reference/entity schemas: field shapes, max lengths, and the research-metadata fields.
- `artifacts/api-server/src/lib/factRenderScenarios.ts` `renderAffectingEnrichment` — The render-input hash includes culturalReferences and semanticEntities wholesale — editing any row field flips render-scenario tiles stale.

### Canonical reference

*The reference's canonical name — planner context that NEVER reaches the engine prompt.*

- **Effect:** Render-affecting — feeds the prompt pipeline
- **Staleness:** Editing re-flags render scenarios as stale.
- **Editor surface:** reserved

**What it is**

The canonical name/source of the reference (e.g. "Shark Week", "Victoria's Secret"; max 300 chars). May be empty when no single canonical name exists (common for idioms). Also the echo-match fallback when sourcePhrase is empty.

**How the AI sets it**

Named by the classifier; the Research Reference tool corrects/confirms it.

**How it affects the render**

Planner context only — and deliberately NEVER compiled into the engine prompt: emitting it would leak brand names into the render. Only the reference's concrete visual implication travels; the planner is told never to draw a real logo or brand mark.

**Examples**

- **Scenario:** Shark Week reference on a live render.
  - **Input:** canonicalReference: "Shark Week"
  - **Outcome:** The planner knows exactly which phenomenon is meant; the engine prompt contains sharks-as-audience visuals but never the words 'Shark Week'.

**Sources**

- `lib/api-zod/src/taxonomy.ts` `culturalReferenceSchema` — The reference/entity schemas: field shapes, max lengths, and the research-metadata fields.
- `artifacts/api-server/src/lib/imagePrompt/generator.ts` `buildImagePromptUserMessage` — Where references/entities are injected into the planner message, including the materiality gate and the never-draw-a-real-logo instruction.
- `artifacts/api-server/src/lib/factRenderScenarios.ts` `renderAffectingEnrichment` — The render-input hash includes culturalReferences and semanticEntities wholesale — editing any row field flips render-scenario tiles stale.

### Explanation

*The plain-language joke mechanism the reference enables — planner context, never compiled.*

- **Effect:** Render-affecting — feeds the prompt pipeline
- **Staleness:** Editing re-flags render scenarios as stale.
- **Editor surface:** reserved

**What it is**

A plain-language explanation of how the reference makes the joke work (max 800 chars).

**How the AI sets it**

Written by the classifier; directly editable per the admin workflow.

**How it affects the render**

Read by the planner when interpreting the fact, but never compiled into the engine prompt — an 'explaining the joke' line is meta-instruction the image engine can't use.

**Examples**

- **Scenario:** The magnifying-glass fact.
  - **Input:** explanation: "Magnifying glasses need sunlight to burn; doing it at night is the impossibility."
  - **Outcome:** The planner stages the mechanism-defiance; the sentence itself never reaches the engine.

**Sources**

- `lib/api-zod/src/taxonomy.ts` `culturalReferenceSchema` — The reference/entity schemas: field shapes, max lengths, and the research-metadata fields.
- `artifacts/api-server/src/lib/imagePrompt/generator.ts` `buildImagePromptUserMessage` — Where references/entities are injected into the planner message, including the materiality gate and the never-draw-a-real-logo instruction.
- `artifacts/api-server/src/lib/factRenderScenarios.ts` `renderAffectingEnrichment` — The render-input hash includes culturalReferences and semanticEntities wholesale — editing any row field flips render-scenario tiles stale.

### Visual implication

*THE load-bearing field: how the reference should change the rendered scene — this is what actually reaches the engine.*

- **Effect:** Render-affecting — feeds the prompt pipeline
- **Staleness:** Editing re-flags render scenarios as stale.
- **Editor surface:** reserved

**What it is**

How the reference should change the visual interpretation of the scene (max 800 chars). Write it as a CONCRETE visual ('sharks are the audience watching the subject as spectacle'), not analysis — for a material reference this text, as echoed by the planner, is what the render is guaranteed to contain.

**How the AI sets it**

Written by the classifier and refined by admins/research — the single most render-worthy edit in a reference row.

**How it affects the render**

For material references the planner must echo it as visualImplicationUsed and bake it into keyVisualElements + the prompt. If the prose still omitted it, the compiler gap-fills it into "Ensure these elements are clearly visible: …" — so the implication reaches the engine while brand names never do.

**Examples**

- **Scenario:** Shark Week reference.
  - **Input:** visualImplication: "sharks are the audience watching the subject as spectacle"
  - **Outcome:** Sharks-on-couches-watching-TV staging is forced into the plan and guaranteed visible in the compiled prompt.
- **Scenario:** A vague implication.
  - **Input:** visualImplication: "make it feel like the TV event"
  - **Outcome:** Weak — nothing concrete to gap-fill. Rewrite it as a visible thing the scene must contain.

**Sources**

- `lib/api-zod/src/taxonomy.ts` `culturalReferenceSchema` — The reference/entity schemas: field shapes, max lengths, and the research-metadata fields.
- `artifacts/api-server/src/lib/imagePrompt/generator.ts` `buildImagePromptUserMessage` — Where references/entities are injected into the planner message, including the materiality gate and the never-draw-a-real-logo instruction.
- `lib/api-zod/src/imagePromptGeneration.ts` `validateImagePromptPlan` — Rules 14/15: material entities/references MUST be echoed back in the visual plan; a violation triggers one corrective retry.
- `artifacts/api-server/src/lib/imagePrompt/compilers/nanoBanana2.ts` `composeKeyElementsDirective` — The compiler-side guarantee: resolved visualImplicationUsed / visualReferentUsed values the prose omitted are folded into "Ensure these elements are clearly visible: …".
- `artifacts/api-server/src/lib/factRenderScenarios.ts` `renderAffectingEnrichment` — The render-input hash includes culturalReferences and semanticEntities wholesale — editing any row field flips render-scenario tiles stale.

### Confidence

*0–1: how confident the AI is that this reference is the joke's actual hook — half of the materiality gate.*

- **Effect:** Render-affecting — feeds the prompt pipeline
- **Staleness:** Editing re-flags render scenarios as stale.
- **Editor surface:** reserved

**What it is**

The classifier's 0–1 confidence that the reference is the joke's real hook. Editable — raising or lowering it directly moves the reference across the materiality threshold.

**How the AI sets it**

Emitted by the classifier per reference; admins adjust it when they know better.

**How it affects the render**

Materiality gate input: confidence ≥ 0.8 (with requiresAdminReview false) makes the reference material — force-echoed into the plan and guaranteed in the render. Below the bar (unless researchConfidence is high) it is planner context only.

**Examples**

- **Scenario:** A correct reference sitting at 0.7.
  - **Input:** You raise confidence to 0.9 (review unchecked).
  - **Outcome:** It crosses the gate: the next plan MUST echo it, and its visual implication is guaranteed in the prompt.

**Sources**

- `lib/api-zod/src/taxonomy.ts` `culturalReferenceSchema` — The reference/entity schemas: field shapes, max lengths, and the research-metadata fields.
- `artifacts/api-server/src/lib/imagePrompt/generator.ts` `isMaterialCulturalReference` — A reference is material when researchConfidence === "high", OR confidence >= 0.8 and it is not flagged for admin review.
- `artifacts/api-server/src/lib/factRenderScenarios.ts` `renderAffectingEnrichment` — The render-input hash includes culturalReferences and semanticEntities wholesale — editing any row field flips render-scenario tiles stale.

### Requires admin review

*Human sanity-check flag — while set, the reference can't be forced into renders (unless research verified it).*

- **Effect:** Render-affecting — feeds the prompt pipeline
- **Staleness:** Editing re-flags render scenarios as stale.
- **Editor surface:** reserved

**What it is**

Set true by the classifier when the reference touches a real brand, workplace, or professional context, or is otherwise ambiguous and worth a human check.

**How the AI sets it**

Classifier-set per its rules; you uncheck it once you've confirmed the reference.

**How it affects the render**

It blocks materiality: a flagged reference is never force-echoed regardless of confidence — EXCEPT when researchConfidence is "high" (verified research overrides the flag). Unchecking it (with confidence ≥ 0.8) makes the reference material.

**Examples**

- **Scenario:** A Yardi workplace reference, confidence 0.85, flagged for review.
  - **Input:** You confirm it and uncheck the box.
  - **Outcome:** The reference becomes material — future plans must honor it.

**Sources**

- `artifacts/api-server/src/lib/factEnrichmentConfig.ts` `FACT_ENRICHMENT_SYSTEM_DEFAULT` — The classifier system prompt — the cultural-reference and semantic-entity/capitalization rules plus their worked examples.
- `artifacts/api-server/src/lib/imagePrompt/generator.ts` `isMaterialCulturalReference` — A reference is material when researchConfidence === "high", OR confidence >= 0.8 and it is not flagged for admin review.
- `artifacts/api-server/src/lib/factRenderScenarios.ts` `renderAffectingEnrichment` — The render-input hash includes culturalReferences and semanticEntities wholesale — editing any row field flips render-scenario tiles stale.

### Semantic Entities / Visual Referents

*Capitalization-aware term disambiguations the planner must treat as the LOCKED meaning of the fact's words.*

- **Effect:** Render-affecting — feeds the prompt pipeline
- **Staleness:** Editing re-flags render scenarios as stale.
- **Editor surface:** section-level

**What it is**

The list of surface terms whose interpretation materially matters for the image — 'Earth' the planet vs 'earth' the soil being the flagship case. Casing is preserved verbatim (never normalized before interpretation; the classifier reads factTextExact), and only terms whose reading changes the image are listed — never every noun, and NEVER the fact's subject.

Subject-name defense: the subject (the canonical placeholder 'Alex') is categorically not a semantic entity — the classifier is forbidden from listing it, and a deterministic strip removes it from older enrichments defensively, so it is never force-echoed or baked in. The subject's identity is owned by the personalization/rendering layer.

**How the AI sets it**

The classifier applies the capitalization examples: earth/Earth (soil vs planet), apple/Apple (fruit vs company), sun/Sun (sunlight vs the named body or a personification), law/Law (legal rules vs a title/institution). Capitalization is a strong signal but never the sole basis; sentence-initial capitalization yields capitalizationSignal=sentence_initial_ambiguous + requiresAdminReview=true with the referent inferred from context.

**How it affects the render**

Entities are injected into the planner's SEMANTIC ENTITY INTERPRETATION block, labeled "hard visual context — DO NOT override; treat as the locked meaning of the surface term in this fact".

FORCE-ECHO (validator rule 14): every entity with materiallyAffectsVisualPrompt=true MUST be echoed in visualPlan.semanticEntitiesUsed (surfaceText verbatim, non-empty visualReferentUsed + effectOnVisualPlan). A miss triggers one corrective retry.

The engine never sees an "Interpret X means Y" meta line — the planner resolves the ambiguity into the concrete scene, and the compiler gap-fills any omitted visualReferentUsed into "Ensure these elements are clearly visible: …" so the resolved referent (e.g. "the planet Earth seen from orbit") is guaranteed visible.

Entities never change the archetype/subtype — they are render context, not taxonomy. The whole collection is in the render-input hash, so edits flip render-scenario tiles stale.

Pipeline: classifier detects → planner is informed → validator force-echoes material items → compiler guarantees the concrete visual reaches the engine.

**Examples**

- **Scenario:** "{NAME} bench-presses the Earth."
  - **Input:** surfaceText "Earth", entityKind celestial_body, visualReferent "the planet Earth", materiallyAffects ✓
  - **Outcome:** The plan must echo it; the render is guaranteed to show the planet, not a pile of soil.
- **Scenario:** "{NAME} moved the earth with one hand."
  - **Input:** surfaceText "earth", entityKind common_noun, capitalizationSignal lowercase_common_noun, visualReferent "ground, dirt, soil, or terrain"
  - **Outcome:** The mundane reading is locked — no planet appears.
- **Scenario:** An old enrichment stored "Alex" as an entity.
  - **Input:** (nothing to do)
  - **Outcome:** The defensive strip removes it before planning — the subject is never a semantic entity, so it can't be force-echoed or baked in.

**Sources**

- `artifacts/api-server/src/lib/factEnrichmentConfig.ts` `FACT_ENRICHMENT_SYSTEM_DEFAULT` — The classifier system prompt — the cultural-reference and semantic-entity/capitalization rules plus their worked examples.
- `lib/api-zod/src/taxonomy.ts` `culturalReferenceSchema` — The reference/entity schemas: field shapes, max lengths, and the research-metadata fields.
- `artifacts/api-server/src/lib/imagePrompt/generator.ts` `buildImagePromptUserMessage` — Where references/entities are injected into the planner message, including the materiality gate and the never-draw-a-real-logo instruction.
- `lib/api-zod/src/imagePromptGeneration.ts` `validateImagePromptPlan` — Rules 14/15: material entities/references MUST be echoed back in the visual plan; a violation triggers one corrective retry.
- `artifacts/api-server/src/lib/imagePrompt/compilers/nanoBanana2.ts` `composeKeyElementsDirective` — The compiler-side guarantee: resolved visualImplicationUsed / visualReferentUsed values the prose omitted are folded into "Ensure these elements are clearly visible: …".
- `artifacts/api-server/src/lib/renderCanonical.ts` `stripSubjectNameSemanticEntities` — The subject-name defense: the personalized subject is never a semantic entity, even if an older enrichment stored it as one.
- `artifacts/api-server/src/lib/factRenderScenarios.ts` `renderAffectingEnrichment` — The render-input hash includes culturalReferences and semanticEntities wholesale — editing any row field flips render-scenario tiles stale.

### Surface text (verbatim case)

*The term exactly as it appears in the fact — casing preserved; also the echo-match key.*

- **Effect:** Render-affecting — feeds the prompt pipeline
- **Staleness:** Editing re-flags render scenarios as stale.
- **Editor surface:** reserved

**What it is**

The term verbatim from the fact, casing intact (max 120 chars) — 'Earth' and 'earth' are different surface texts, and that difference is the point. Do not normalize it; normalizedText holds the lowercase form.

**How the AI sets it**

Quoted by the classifier from factTextExact.

**How it affects the render**

For material entities, the plan's semanticEntitiesUsed must contain this surfaceText (case-insensitive match) or the corrective retry fires. Entities whose surfaceText is a raw template token (e.g. literally "{NAME}") are filtered from the required echo list — the planner sees the rendered fact and can't echo a token.

**Examples**

- **Scenario:** The Earth bench-press fact.
  - **Input:** surfaceText: "Earth"
  - **Outcome:** The echo entry must carry "Earth"; the preserved capital is what justified the celestial reading.

**Sources**

- `artifacts/api-server/src/lib/factEnrichmentConfig.ts` `FACT_ENRICHMENT_SYSTEM_DEFAULT` — The classifier system prompt — the cultural-reference and semantic-entity/capitalization rules plus their worked examples.
- `lib/api-zod/src/taxonomy.ts` `culturalReferenceSchema` — The reference/entity schemas: field shapes, max lengths, and the research-metadata fields.
- `lib/api-zod/src/imagePromptGeneration.ts` `validateImagePromptPlan` — Rules 14/15: material entities/references MUST be echoed back in the visual plan; a violation triggers one corrective retry.
- `artifacts/api-server/src/lib/factRenderScenarios.ts` `renderAffectingEnrichment` — The render-input hash includes culturalReferences and semanticEntities wholesale — editing any row field flips render-scenario tiles stale.

### Normalized text

*The lowercase comparable form of the surface text.*

- **Effect:** Render-affecting — feeds the prompt pipeline
- **Staleness:** Editing re-flags render scenarios as stale.
- **Editor surface:** reserved

**What it is**

The lowercase form used for comparisons (max 120 chars) — 'earth' for both 'Earth' and 'EARTH'.

**How the AI sets it**

Emitted by the classifier alongside the surface text.

**How it affects the render**

Bookkeeping only — the planner block and the echo-match key both use surfaceText; this field exists as the case-insensitive comparable form.

**Examples**

- **Scenario:** surfaceText "Earth".
  - **Input:** normalizedText: "earth"
  - **Outcome:** The pair records both the meaningful casing and the comparable form.

**Sources**

- `lib/api-zod/src/taxonomy.ts` `culturalReferenceSchema` — The reference/entity schemas: field shapes, max lengths, and the research-metadata fields.
- `artifacts/api-server/src/lib/factRenderScenarios.ts` `renderAffectingEnrichment` — The render-input hash includes culturalReferences and semanticEntities wholesale — editing any row field flips render-scenario tiles stale.

### Entity kind

*WHAT the term refers to in this fact — planet, brand, personified concept, plain object…*

- **Effect:** Render-affecting — feeds the prompt pipeline
- **Staleness:** Editing re-flags render scenarios as stale.
- **Editor surface:** repeater-enum

**What it is**

An eleven-way classification of the referent's kind (see the per-value docs). It is render context, not taxonomy — resolving 'Earth' to the planet never changes the archetype/subtype.

**How the AI sets it**

Chosen by the classifier per its capitalization/context rules; 'ambiguous' pairs with requiresAdminReview.

**How it affects the render**

Shown in the planner's locked-interpretation block; the concrete steering comes from visualReferent, with the kind labeling why the reading holds.

**Values (11)**

- `proper_noun` *(authored — verify)* — A capitalized proper noun naming a specific thing that isn't better covered by a more specific kind.
  - *Render:* The visual referent pins WHICH specific thing the scene shows, treated by the planner as the locked meaning of the term.
  - *Example:* "Everest" in a climbing fact → the specific mountain, not a generic peak.
- `common_noun` — A lowercase common noun whose everyday meaning is the right reading — recorded when it could be confused with a capitalized referent.
  - *Render:* Locks the mundane interpretation so the planner doesn't upgrade it to the named entity.
  - *Example:* "earth" → dirt, soil, ground, or terrain — NOT the planet.
- `named_entity` *(authored — verify)* — A specific named person, character, work, or event (other than the fact's subject — the subject is never listed).
  - *Render:* The planner renders the specific entity's recognizable characteristics per the visual referent.
  - *Example:* "Godzilla" in a size fact → the famous kaiju silhouette, per its visualReferent.
- `brand_or_cultural_reference` — The term is a brand or cultural reference ('Apple' the company, not the fruit) — usually paired with a culturalReferences entry.
  - *Render:* Locks the brand/cultural reading for the planner; as always, no real logo or brand mark is ever drawn — only the visual implication.
  - *Example:* "Apple" capitalized mid-sentence → the technology company, rendered as sleek-device context, never the logo.
- `abstract_concept` *(authored — verify)* — An abstraction (infinity, probability, time) that has no direct physical form.
  - *Render:* The visual referent must translate the abstraction into something showable; expect symbolic staging.
  - *Example:* "infinity" in a counting fact → an endless receding number-scape as the referent.
- `personified_concept` — A concept treated as a character in this fact — capitalization often signals it ('Law', 'Death', 'Gravity').
  - *Render:* The planner renders the concept as a figure per the visual referent, rather than as its abstract meaning.
  - *Example:* "Law" capitalized as an actor in the sentence → a personified authority figure, per the classifier's Law/law example.
- `physical_object` *(authored — verify)* — A concrete object whose specific reading matters to the joke (which kind of 'bar', which 'mouse').
  - *Render:* Pins the object's interpretation so the scene shows the right thing.
  - *Example:* "mouse" in a tech fact → the computer peripheral, not the animal.
- `place` *(authored — verify)* — A location whose identity matters — a named place or a specific kind of setting.
  - *Render:* The scene is staged in the pinned location per the visual referent.
  - *Example:* "Paris" → the city with recognizable landmarks, not the mythological figure.
- `celestial_body` — A named astronomical object — the classifier's flagship capitalization case.
  - *Render:* Locks the astronomical reading; the resolved referent (e.g. 'the planet Earth seen from orbit') is guaranteed to reach the engine prompt.
  - *Example:* "Earth" → the planet Earth; "Sun" → the named celestial body (or a personified entity, depending on context).
- `institution_or_system` — An institution or a system of rules ('the Law' as the legal system, 'the Church', 'the Market').
  - *Render:* The planner stages the institution's recognizable trappings (courtrooms, trading floors) per the visual referent.
  - *Example:* "law" lowercase → legal rules generally; "Law" may indicate a title or an institution, per the classifier examples.
- `ambiguous` — The AI could not confidently resolve the referent — the interpretation is a guess that a human should settle.
  - *Render:* The classifier sets requiresAdminReview for ambiguous kinds; the tentative referent still informs the planner until you correct it.
  - *Example:* A sentence-initial capitalized term with two plausible readings — the AI picks one and flags the row for review.

**Examples**

- **Scenario:** "Apple" capitalized mid-sentence in a tech fact.
  - **Input:** entityKind: brand_or_cultural_reference
  - **Outcome:** The company reading is locked — with the standard never-draw-a-real-logo rule downstream.

**Sources**

- `artifacts/api-server/src/lib/factEnrichmentConfig.ts` `FACT_ENRICHMENT_SYSTEM_DEFAULT` — The classifier system prompt — the cultural-reference and semantic-entity/capitalization rules plus their worked examples.
- `lib/api-zod/src/taxonomy.ts` `culturalReferenceSchema` — The reference/entity schemas: field shapes, max lengths, and the research-metadata fields.
- `artifacts/api-server/src/lib/factRenderScenarios.ts` `renderAffectingEnrichment` — The render-input hash includes culturalReferences and semanticEntities wholesale — editing any row field flips render-scenario tiles stale.

### Capitalization signal

*What the term's casing contributed to this interpretation — sentence-initial ambiguity is the classic review trigger.*

- **Effect:** Render-affecting — feeds the prompt pipeline
- **Staleness:** Editing re-flags render scenarios as stale.
- **Editor surface:** repeater-enum

**What it is**

A six-way record of what signal the surface casing carried (see the per-value docs). Sentence-initial ambiguity is the common reason an otherwise-confident entry needs admin review.

**How the AI sets it**

The classifier uses capitalization as a strong signal but never alone; when a word is capitalized only because it begins the sentence, it sets sentence_initial_ambiguous + requiresAdminReview=true and infers the referent from context.

**How it affects the render**

Documents the reasoning shown to the planner; the scene itself follows visualReferent. Its main operational effect is flagging the sentence-initial case for your review.

**Values (6)**

- `capitalized_named_entity` — The term is capitalized mid-sentence, signaling a named entity ('Earth', 'Apple', 'Shark Week').
  - *Render:* Supports the named-entity reading of the visual referent — capitalization is a strong signal, but never the sole basis.
  - *Example:* "…lifted Earth…" → capitalized mid-sentence → the planet.
- `lowercase_common_noun` — The term is lowercase, signaling the everyday common-noun reading.
  - *Render:* Supports the mundane referent (soil, fruit, sunlight) over the named entity.
  - *Example:* "…moved the earth beneath them…" → lowercase → soil/ground.
- `sentence_initial_ambiguous` — The term is capitalized only because it starts the sentence — casing carries NO signal, so the referent was inferred from context alone.
  - *Render:* The classifier's rule: set this signal, set requiresAdminReview to true, and infer the referent from context. Your review decides whether the inference was right.
  - *Example:* "Earth trembled when {NAME} stepped." → sentence-initial: planet or ground? Flagged for a human call.
- `all_caps_presentation_ignored` *(authored — verify)* — The term appears in ALL CAPS for emphasis/styling — the shouting is presentation, not a semantic signal, and was ignored.
  - *Render:* The referent was resolved as if the term were normally cased; the caps carry no interpretation weight.
  - *Example:* "{NAME} BENCH-PRESSED THE EARTH" → styling caps ignored; context decides planet vs ground.
- `mixed_case_brand_or_title` *(authored — verify)* — The term's distinctive mixed casing marks a brand or title (iPhone, YouTube, eBay).
  - *Render:* Supports the brand/title reading of the referent — with the usual no-logo rule downstream.
  - *Example:* "iPhone" → the branded device category, casing itself being the tell.
- `not_relevant` *(authored — verify)* — Capitalization played no role in this interpretation — the entry exists for a non-casing reason (pure ambiguity, cultural reference).
  - *Render:* The visual referent stands on context alone; the casing axis is simply not part of the reasoning.
  - *Example:* An entity recorded because its wordplay reading matters, where either casing would read the same.

**Examples**

- **Scenario:** "Earth trembled when {NAME} stepped."
  - **Input:** capitalizationSignal: sentence_initial_ambiguous (requiresAdminReview auto-true)
  - **Outcome:** You decide planet vs ground; the AI's context-based guess stands until you do.

**Sources**

- `artifacts/api-server/src/lib/factEnrichmentConfig.ts` `FACT_ENRICHMENT_SYSTEM_DEFAULT` — The classifier system prompt — the cultural-reference and semantic-entity/capitalization rules plus their worked examples.
- `lib/api-zod/src/taxonomy.ts` `culturalReferenceSchema` — The reference/entity schemas: field shapes, max lengths, and the research-metadata fields.
- `artifacts/api-server/src/lib/factRenderScenarios.ts` `renderAffectingEnrichment` — The render-input hash includes culturalReferences and semanticEntities wholesale — editing any row field flips render-scenario tiles stale.

### Visual referent

*The concrete interpretation that actually steers the scene — for material entities, guaranteed to reach the engine.*

- **Effect:** Render-affecting — feeds the prompt pipeline
- **Staleness:** Editing re-flags render scenarios as stale.
- **Editor surface:** reserved

**What it is**

The concrete resolved interpretation (max 400 chars) — e.g. 'the planet Earth' or 'ground, dirt, soil, or terrain beneath the subject'. Write it as a visible thing, not an essay: it is the payload the rest of the pipeline delivers.

**How the AI sets it**

Resolved by the classifier from casing + context; the most render-worthy edit in an entity row.

**How it affects the render**

The planner treats it as the locked meaning and stages the scene accordingly, echoing the resolved form as visualReferentUsed. The compiler gap-fills any omitted referent into "Ensure these elements are clearly visible: …" — the referent reaches the engine as a concrete element, never as an "interpret X as Y" meta line.

**Examples**

- **Scenario:** The Earth bench-press fact.
  - **Input:** visualReferent: "the planet Earth"
  - **Outcome:** If the prose somehow omitted the planet, the compiled prompt still gains "Ensure these elements are clearly visible: the planet Earth…".

**Sources**

- `lib/api-zod/src/taxonomy.ts` `culturalReferenceSchema` — The reference/entity schemas: field shapes, max lengths, and the research-metadata fields.
- `artifacts/api-server/src/lib/imagePrompt/generator.ts` `buildImagePromptUserMessage` — Where references/entities are injected into the planner message, including the materiality gate and the never-draw-a-real-logo instruction.
- `artifacts/api-server/src/lib/imagePrompt/compilers/nanoBanana2.ts` `composeKeyElementsDirective` — The compiler-side guarantee: resolved visualImplicationUsed / visualReferentUsed values the prose omitted are folded into "Ensure these elements are clearly visible: …".
- `artifacts/api-server/src/lib/factRenderScenarios.ts` `renderAffectingEnrichment` — The render-input hash includes culturalReferences and semanticEntities wholesale — editing any row field flips render-scenario tiles stale.

### Notes

*The AI's reasoning for this interpretation — planner-visible context.*

- **Effect:** Render-affecting — feeds the prompt pipeline
- **Staleness:** Editing re-flags render scenarios as stale.
- **Editor surface:** reserved

**What it is**

Free-text reasoning behind the interpretation (max 800 chars; empty when there's nothing to say).

**How the AI sets it**

Written by the classifier; editable when you want to leave interpretation context for the planner and other admins.

**How it affects the render**

Included in the planner's entity block when non-empty (as context), but never compiled into the engine prompt.

**Examples**

- **Scenario:** A sentence-initial 'Sun'.
  - **Input:** notes: "Sentence-initial; context (orbits, gravity) supports the celestial reading."
  - **Outcome:** You (and the planner) see why the celestial referent was chosen.

**Sources**

- `lib/api-zod/src/taxonomy.ts` `culturalReferenceSchema` — The reference/entity schemas: field shapes, max lengths, and the research-metadata fields.
- `artifacts/api-server/src/lib/imagePrompt/generator.ts` `buildImagePromptUserMessage` — Where references/entities are injected into the planner message, including the materiality gate and the never-draw-a-real-logo instruction.
- `artifacts/api-server/src/lib/factRenderScenarios.ts` `renderAffectingEnrichment` — The render-input hash includes culturalReferences and semanticEntities wholesale — editing any row field flips render-scenario tiles stale.

### Materially affects visual prompt

*The entity's materiality switch — checked entities are FORCED into the plan (validator rule 14).*

- **Effect:** Render-affecting — feeds the prompt pipeline
- **Staleness:** Editing re-flags render scenarios as stale.
- **Editor surface:** reserved

**What it is**

True when changing this interpretation would materially change the rendered image. This checkbox is the entity-side materiality gate (entities have no confidence threshold — this flag alone decides).

**How the AI sets it**

Set by the classifier per its 'materially changes the rendered image' rule; toggle it to control enforcement.

**How it affects the render**

Checked: the plan MUST echo the entity in semanticEntitiesUsed with a concrete visualReferentUsed + effectOnVisualPlan (one corrective retry on a miss), and the referent is guaranteed to reach the engine via the gap-fill. Unchecked: the entity remains locked planner context but is never forced.

**Examples**

- **Scenario:** The planet reading is essential to the joke.
  - **Input:** materiallyAffectsVisualPrompt: true
  - **Outcome:** Every future plan must account for the planet Earth or fail validation and retry.

**Sources**

- `lib/api-zod/src/taxonomy.ts` `culturalReferenceSchema` — The reference/entity schemas: field shapes, max lengths, and the research-metadata fields.
- `lib/api-zod/src/imagePromptGeneration.ts` `validateImagePromptPlan` — Rules 14/15: material entities/references MUST be echoed back in the visual plan; a violation triggers one corrective retry.
- `artifacts/api-server/src/lib/imagePrompt/compilers/nanoBanana2.ts` `composeKeyElementsDirective` — The compiler-side guarantee: resolved visualImplicationUsed / visualReferentUsed values the prose omitted are folded into "Ensure these elements are clearly visible: …".
- `artifacts/api-server/src/lib/factRenderScenarios.ts` `renderAffectingEnrichment` — The render-input hash includes culturalReferences and semanticEntities wholesale — editing any row field flips render-scenario tiles stale.

### Requires admin review

*Human sanity-check flag for this interpretation — auto-set for sentence-initial ambiguity and brand/ambiguous kinds.*

- **Effect:** Render-affecting — feeds the prompt pipeline
- **Staleness:** Editing re-flags render scenarios as stale.
- **Editor surface:** reserved

**What it is**

True when a human should confirm the interpretation: sentence-initial ambiguity, brand/cultural references, an ambiguous kind, or any case worth a sanity check.

**How the AI sets it**

Classifier-set per its rules (sentence-initial capitalization always sets it); uncheck once you've confirmed the reading.

**How it affects the render**

Unlike the cultural-reference flag, it does NOT gate materiality — a flagged entity with materiallyAffectsVisualPrompt=true is still force-echoed. It is a review signal for you, carried into the planner block as context.

**Examples**

- **Scenario:** Sentence-initial 'Earth' resolved to the planet.
  - **Input:** requiresAdminReview: true (auto)
  - **Outcome:** You confirm or correct the referent; the enforcement behavior is unchanged either way.

**Sources**

- `artifacts/api-server/src/lib/factEnrichmentConfig.ts` `FACT_ENRICHMENT_SYSTEM_DEFAULT` — The classifier system prompt — the cultural-reference and semantic-entity/capitalization rules plus their worked examples.
- `lib/api-zod/src/taxonomy.ts` `culturalReferenceSchema` — The reference/entity schemas: field shapes, max lengths, and the research-metadata fields.
- `artifacts/api-server/src/lib/factRenderScenarios.ts` `renderAffectingEnrichment` — The render-input hash includes culturalReferences and semanticEntities wholesale — editing any row field flips render-scenario tiles stale.

### Confidence

*0–1: the AI's confidence in this interpretation — informational for entities (no threshold gates on it).*

- **Effect:** Render-affecting — feeds the prompt pipeline
- **Staleness:** Editing re-flags render scenarios as stale.
- **Editor surface:** reserved

**What it is**

The classifier's 0–1 confidence in the interpretation. Unlike cultural references (where 0.8 is half the materiality gate), no entity-side threshold branches on it — materiality is the checkbox alone.

**How the AI sets it**

Emitted by the classifier per entry.

**How it affects the render**

Shown to the planner in the entity block and to you in the row; use a low value as your cue to review, but it does not change enforcement.

**Examples**

- **Scenario:** A coin-flip interpretation.
  - **Input:** confidence: 0.55
  - **Outcome:** Your cue to settle the reading yourself — the pipeline treats the entity the same either way.

**Sources**

- `lib/api-zod/src/taxonomy.ts` `culturalReferenceSchema` — The reference/entity schemas: field shapes, max lengths, and the research-metadata fields.
- `artifacts/api-server/src/lib/imagePrompt/generator.ts` `buildImagePromptUserMessage` — Where references/entities are injected into the planner message, including the materiality gate and the never-draw-a-real-logo instruction.
- `artifacts/api-server/src/lib/factRenderScenarios.ts` `renderAffectingEnrichment` — The render-input hash includes culturalReferences and semanticEntities wholesale — editing any row field flips render-scenario tiles stale.
