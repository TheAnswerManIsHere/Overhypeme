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
  - [Speech & Thought Bubbles](#speech-thought-bubbles)
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
  - [Characters](#characters)
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

- **Effect:** Advisory only — read by the gag writer, never by the picture prompt
- **Staleness:** Editing does not re-flag render scenarios.
- **Editor surface:** field-label

**What it is**

The primary archetype classifies HOW the fact's joke works (its mechanism), not what it is superficially about. The classifier's own rule: "Classify by the joke mechanism, not by superficial topic" — a moon fact caused by a sneeze is a superhuman physical feat with an astronomical-consequence modifier, not a cosmic category.

There are 11 archetypes. The gag writer is told the archetype and subtype as the JOKE MECHANISM when it drafts gag ideas, so getting this wrong skews the ideas it proposes. It does not reach the picture itself: a picture is drawn from the approved gag.

**How the AI sets it**

The enrichment classifier reads the fact rendered to the canonical subject ("Alex", they/them) and picks exactly one archetype using per-archetype "use when…" rules, plus explicit disambiguation guidance (e.g. the redundant-mechanism rule: "threw a grenade and killed 50 people, then it exploded" is a superhuman physical feat, NOT temporal inversion — the explosion is a redundant normal mechanism).

A deterministic repair guard also runs after classification: a low-confidence temporal_causality_inversion on a thrown-weapon/redundant-mechanism pattern is auto-repaired to superhuman_physical_feat with the normal_function_rendered_unnecessary modifier.

**How it affects the render**

Read by the gag writer when it drafts gag ideas: it is the first half of the JOKE MECHANISM block in the writer's message. It does not reach the picture prompt, which is drawn only from the approved gag. The render-time planner that used to inject the archetype's strategy template was removed when pictures started being drawn straight from the gag (plan docs/plans/PLAN_GAG_DIRECT_RENDER.md).

Editing it marks the stored gag ideas out of date (the writer's freshness check) so they can be redrafted. It never marks a render out of date.

**Values (11)**

- `superhuman_physical_feat` — Use when a real physical action is exaggerated to impossible force, scale, speed, endurance, precision, sensory ability, or consequence. This is also where redundant-mechanism jokes belong: when a tool or weapon's normal mechanism (an explosion, a gunshot) happens AFTER the subject's power already achieved the result, classify here (with the normal_function_rendered_unnecessary modifier), NOT as temporal inversion.
  - *Render:* No longer applied to a picture directly — the gag writer is told the archetype as the joke mechanism, and the render planner that read the authored strategy was removed. The strategy this archetype used to select: a grounded cinematic scene showing the recognizable action AND its impossible consequence in the same image, with concrete visual proof (cracked ground, shockwaves, motion trails, scale contrast). Locked rule: "Show a real physical action and its impossible physical consequence in the same image whenever possible. Preserve the face, exaggerate the legend." The only archetype with its own authored t2i fallback; its six visualization examples are fully authored (including the canonical grenade redundant-mechanism example).
  - *Example:* "{NAME} once threw a grenade and killed 50 people, then it exploded." → the throw is the impossible force; the grenade is staged intact and unexploded in flight.
- `object_logic_impossibility` — Use when the object, tool, material, medium, or semantic object logic makes the action impossible — the joke is that the thing itself cannot logically support what the subject did with it (slamming a revolving door, strangling with a cordless phone).
  - *Render:* No longer applied to a picture directly — the gag writer is told the archetype as the joke mechanism, and the render planner that read the authored strategy was removed. The strategy this archetype used to select: make the contradiction visually legible — show what the object is and why the result should be impossible, with the subject confident and in control. Uniquely has frame-selection guidance (direct_action / implied_aftermath / object_transformation / target_reaction). Locked rule: when the action is less funny to show directly, show the impossible aftermath and let the viewer infer the cause. Its five visualization examples are fully authored.
  - *Example:* "{NAME} can slam a revolving door." → the rotating mechanism is clearly visible, yet impossibly slammed shut; {NAME} stands beside it, casual and powerful.
- `environmental_obedience_immunity` — Use when nature, weather, darkness, water, fire, gravity, or another natural/environmental force avoids, obeys, yields to, personifies itself around, or fails to affect the subject. Per the mechanism-not-topic rule, a sun-blinking fact lands here (personified natural force), not in any cosmic category.
  - *Render:* No longer applied to a picture directly — the gag writer is told the archetype as the joke mechanism, and the render planner that read the authored strategy was removed. The strategy this archetype used to select: make the force visually obvious (enough rain/darkness/fire/wind that the viewer knows what is being defied) and show it reacting to the subject. Locked rule: "Show the environment reacting to the subject, not the subject reacting to the environment." Its visualization examples are marked authoring-pending in the strategy file (fact stubs without prose).
  - *Example:* "Rain avoids {NAME}." → a downpour drenches the whole street while the rain visibly parts around a dry, unbothered {NAME}.
- `authority_threat_reversal` — Use when a normal power, danger, authority, role, predator, institution, or responsibility relationship is inverted — the subject is normally the subordinate one, but the authority/threat now responds to them. The prompt's canonical example: a baby driving their mother home is this archetype (social role reversal), not a physics joke.
  - *Render:* No longer applied to a picture directly — the gag writer is told the archetype as the joke mechanism, and the render planner that read the authored strategy was removed. The strategy this archetype used to select: show who normally has power and make the inversion legible through body language, deference, ceremony, or fear. Per-subtype treatments diverge: social reversals stage grounded human comedy, institutional ones use official settings/procedure, predator ones show the threat recoiling or submitting. Locked rule: show the normal power relationship, then make the reversal visually obvious. Examples are marked authoring-pending (stubs, though the "Sharks have a {NAME} Week" stub carries an authored Shark Week cultural-reference annotation).
  - *Example:* "A baby drove {NAME}'s mother home." → a realistic car interior where the impossibility is who holds the driver's role, not the physics.
- `temporal_causality_inversion` — Use ONLY when the humor depends on impossible event order, time reversal, retrocausality, or an effect clearly occurring before its cause — broken time, sequence, process order, history, age, or reversibility. Critical disambiguation: "then" does NOT automatically mean temporal inversion. If a normal mechanism (grenade exploding, gun firing) happens after the result but the joke is that the subject's power made it unnecessary, that is a redundant mechanism → classify as superhuman_physical_feat (or the relevant power archetype) with normal_function_rendered_unnecessary instead. Before choosing this, ask: is the joke primarily about impossible time order, or did the subject's power simply beat the normal mechanism?
  - *Render:* No longer applied to a picture directly — the gag writer is told the archetype as the joke mechanism, and the render planner that read the authored strategy was removed. The strategy this archetype used to select: show the broken sequence so the viewer understands what should have happened first — before/after contrast, frozen action, reversed motion cues, impossible age relationships. The strategy block itself repeats the warning to never stage redundant-mechanism facts (e.g. the grenade) as an explosion before the throw. Locked rule: "Show the broken sequence." Examples are marked authoring-pending (fact stubs only).
  - *Example:* "{NAME} finished the race before it started." → {NAME} calmly crossing the finish line while the starting gun is still being raised behind them.
- `presence_induced_reaction_aura` — Use when the subject does little or nothing, but people, objects, opportunities, conflicts, crowds, or situations react because of their presence, reputation, aura, or tiny gesture. The prompt's disambiguation example: a bar fight ending because the subject raises an eyebrow is this archetype, not temporal inversion.
  - *Render:* No longer applied to a picture directly — the gag writer is told the archetype as the joke mechanism, and the render planner that read the authored strategy was removed. The strategy this archetype used to select: contrast the subject's minimal, composed action against an exaggerated reaction around them — and the subject must look like this is normal, never confused by it. Locked rule: "The subject barely acts. The world reacts." Examples are marked authoring-pending (fact stubs only).
  - *Example:* "A bar fight ends when {NAME} raises an eyebrow." → brawlers frozen mid-swing, all eyes on {NAME}'s single raised eyebrow.
- `logic_formal_impossibility` — Use when the fact violates formal logic, math, infinity, probability, rules, games, paradox, or formal language. Per the mechanism-not-topic rule, counting to infinity is a logic/formal impossibility, not physical scale.
  - *Render:* No longer applied to a picture directly — the gag writer is told the archetype as the joke mechanism, and the render planner that read the authored strategy was removed. The strategy this archetype used to select: a symbolic scene where the broken rule feels physically real (impossible geometry, paradoxical objects, infinite loops, collapsing probability), with concise supporting numbers/symbols/equations explicitly permitted when they make the rule funnier to read. Locked rule: turn the formal impossibility into a physical visual metaphor. Examples are marked authoring-pending (though the pi-PIN stub carries partial authored guidance: show four crisp digits, never long streams of pi).
  - *Example:* "{NAME} counted to infinity. Twice." → an endless symbolic number-scape resolving around a calm {NAME}, rather than someone mouthing numbers.
- `intellectual_omniscience` — Use when the subject knows, predicts, solves, remembers, understands, or deduces something impossible — knowledge that should be hidden, unavailable, unwritten, or unknowable.
  - *Render:* No longer applied to a picture directly — the gag writer is told the archetype as the joke mechanism, and the render planner that read the authored strategy was removed. The strategy this archetype used to select: show the knowledge barrier AND the subject's effortless access to it (sealed vaults, future reflections, overwhelmed experts) — never ordinary studying or hacking. Locked rule: "The subject knows what cannot be known, and the image must show why that knowledge should have been impossible." Examples are marked authoring-pending (though the "knows Victoria's secret" stub carries an authored brand cultural-reference annotation).
  - *Example:* "{NAME} knows what the Magic 8 Ball will say before it's shaken." → the answer already visible to {NAME} while the ball sits untouched.
- `technology_system_reaction` — Use when machines, apps, computers, passwords, AI, digital systems, networks, devices, or software react to, obey, defer to, or fail against the subject.
  - *Render:* No longer applied to a picture directly — the gag writer is told the archetype as the joke mechanism, and the render planner that read the authored strategy was removed. The strategy this archetype used to select: the system must visibly change behavior because the subject is present (gates opening, screens changing state, robots pausing, AI deferring) — never a passive background prop or ordinary computer use. Concise supporting UI text/status messages are permitted when they help the reaction read. Locked rule: "The system reacts to the subject. Technology becomes the subordinate user." Examples are marked authoring-pending (fact stubs only).
  - *Example:* "{NAME}'s chess computer resigns while unplugged." → a dead, unplugged machine displaying its resignation to a calm {NAME}.
- `intrinsic_legendary_attribute` — Use when the subject has an impossible built-in trait, aura, body feature, biological property, personal field, possession, or metaphorical property made physical — the impossibility is part of who they are, not something they did.
  - *Render:* No longer applied to a picture directly — the gag writer is told the archetype as the joke mechanism, and the render planner that read the authored strategy was removed. The strategy this archetype used to select: make the impossible property feel intrinsic to the subject (body detail, aura, shadow, personal objects, the world's reaction), enhancing their mythic status rather than reading as a random external event; metaphorical facts get converted into a concrete visual form. Locked rule: "The subject is not just legendary because of what they do. Something about them is inherently impossible." Examples are marked authoring-pending (fact stubs only).
  - *Example:* "Under {NAME}'s beard is another fist." → the body feature itself is the impossible legend.
- `mundane_act_made_legendary` — Use when an ordinary everyday action, task, habit, errand, work activity, food/drink activity, or social behavior is treated as absurdly epic, mythic, dominant, or legendary.
  - *Render:* No longer applied to a picture directly — the gag writer is told the archetype as the joke mechanism, and the render planner that read the authored strategy was removed. The strategy this archetype used to select: keep the ordinary act clearly visible and specific (the comedy dies if it becomes generic hero imagery), then elevate it through staging, lighting, reactions, and ceremony. Locked rule: "Make the ordinary act visible, then stage it like a legendary event." Examples are marked authoring-pending (fact stubs only).
  - *Example:* "{NAME} doesn't prepare for demos. Demos prepare for {NAME}." → an ordinary work task staged like a world-changing ceremony.

**Examples**

- **Scenario:** "{NAME} once threw a grenade and killed 50 people, then it exploded."
  - **Input:** primaryArchetype: superhuman_physical_feat (NOT temporal_causality_inversion)
  - **Outcome:** The gag writer is told the mechanism is a superhuman physical feat, so its ideas stage the throw as the overwhelming force with the explosion redundant — the canonical redundant-mechanism example from the classifier prompt.
- **Scenario:** "{NAME} sneezed and the moon left orbit."
  - **Input:** primaryArchetype: superhuman_physical_feat + modifier astronomical_consequence
  - **Outcome:** Classified by mechanism (a physical act at impossible scale), not topic (space) — no cosmic archetype exists.
- **Scenario:** "A baby drove {NAME}'s mother home."
  - **Input:** primaryArchetype: authority_threat_reversal, subtype social_role_reversal
  - **Outcome:** The gag writer is told the mechanism is a social role reversal, so its ideas stage grounded human comedy — the wrong person holding the role — rather than physics.

**Sources**

- `artifacts/api-server/src/lib/factEnrichmentConfig.ts` `FACT_ENRICHMENT_SYSTEM_DEFAULT` — The classifier system prompt — the authoritative definition of what the AI is told this field means.
- `artifacts/api-server/src/lib/visualConcepts/generator.ts` `buildVisualConceptsUserMessage` — Where the gag writer's message gets the archetype and subtype (the JOKE MECHANISM block) and the reference/entity meanings. Modifiers, literalness and complexity are not put in the message.
- `artifacts/api-server/src/lib/visualConcepts/inputHash.ts` `writerAffectingEnrichment` — The gag writer's freshness projection: editing a field listed here marks the stored gag ideas out of date. It is not a render hash.
- `artifacts/api-server/src/lib/factRenderScenarios.ts` `renderAffectingEnrichment` — The render-input hash projection: it hashes only the gag's scene, bubbles and cast entries, so no classification field flips a render stale.

### Mechanism Subtype

*The archetype's refinement — picks the one-sentence visual principle the gag writer is shown.*

- **Effect:** Advisory only — read by the gag writer, never by the picture prompt
- **Staleness:** Editing does not re-flag render scenarios.
- **Editor surface:** field-label

**What it is**

Each archetype has 3–7 subtypes that pin down the joke's specific flavor (e.g. superhuman_physical_feat splits into force/strength/speed/endurance/precision/sensory scaling and ordinary-action-extreme-consequence). The subtype dropdown only offers subtypes valid for the selected archetype, and validation rejects a mismatched pair.

**How the AI sets it**

The classifier picks the subtype from the allowed list for its chosen archetype, using the per-archetype subtype rules in its system prompt. If it emits an invalid pair, one corrective retry re-asks with the allowed list.

**How it affects the render**

Read by the gag writer: the subtype's authored one-sentence visual principle (from getSubtypeGuidance) follows the archetype in the JOKE MECHANISM block of its message — e.g. strength_scaled_action → "Show the subject physically controlling an impossibly massive object while looking confident and in control." It does not reach the picture prompt, which is drawn only from the approved gag.

Editing it marks the stored gag ideas out of date. It never marks a render out of date.

**Values (60)**

- `force_scaled_action` — A physical action (a throw, punch, kick, impact) whose FORCE is exaggerated to impossible scale — the environment takes the hit. Also the home of redundant-mechanism weapon facts (with the normal_function_rendered_unnecessary modifier).
  - *Render:* The gag writer receives the principle: "Show force radiating outward from the action into the environment."
  - *Example:* "When {NAME} does pushups, they don't push themselves up — they push the Earth down." → the ground visibly compresses beneath their hands.
- `strength_scaled_action` — Lifting, carrying, holding, or manipulating something impossibly massive — raw strength is the exaggerated dimension.
  - *Render:* The gag writer receives the principle: "Show the subject physically controlling an impossibly massive object while looking confident and in control."
  - *Example:* "{NAME} can bench press a house." → a real-scale house lifted like a barbell, {NAME} calm, never crushed or struggling.
- `speed_scaled_action` — Movement or action performed at impossible speed.
  - *Render:* The gag writer receives the principle: "Show motion trails, displaced air, afterimages, or environmental blur while keeping the subject visually recognizable."
  - *Example:* "{NAME} once ran a marathon in a single stride." → motion trails and displaced air across the whole course, {NAME} crisp and recognizable at the center.
- `endurance_scaled_action` — The subject outlasts anything — effort, exhaustion, or wear simply never reaches them; the world gives out first.
  - *Render:* The gag writer receives the principle: "Show the world, equipment, or environment exhausted while the subject remains composed and powerful."
  - *Example:* "{NAME} doesn't get tired on the treadmill. The treadmill gets tired of {NAME}." → a smoking, slumped treadmill; {NAME} composed and barely sweating.
- `precision_scaled_action` — Impossible accuracy, trajectory, or perfection of a physical action.
  - *Render:* The gag writer receives the principle: "Show the impossible trajectory or perfect result clearly enough that the precision is obvious."
  - *Example:* "{NAME} threw a baseball around the world and caught it from behind." → a glowing curved motion trail wrapping the horizon back into {NAME}'s glove.
- `sensory_scaled_action` — A sense (sight, hearing, smell, touch, taste) operating at impossible range or resolution.
  - *Render:* The gag writer receives the principle: "Represent sensory power as a physical cinematic effect while keeping the subject central."
  - *Example:* "{NAME} can hear WiFi." → visible signal waves bending toward {NAME}'s ear as a physical cinematic effect.
- `ordinary_action_extreme_consequence` — A completely normal action (a sneeze, a step, a clap) produces a wildly disproportionate physical consequence — the moon-sneeze fact is the canonical case (classified by mechanism, not by its space topic).
  - *Render:* The gag writer receives the principle: "Make the ordinary action clear, then show the consequence at a wildly exaggerated scale."
  - *Example:* "When {NAME} sneezes, the moon changes orbit." → a casual sneeze in the foreground, a shockwave into the night sky, the moon subtly displaced.
- `mechanical_contradiction` — The object's mechanism physically cannot do what the fact claims (you cannot slam a door that revolves).
  - *Render:* The gag writer receives the principle: "Make the object's normal mechanism visible, then show it behaving in the impossible way."
  - *Example:* "{NAME} can slam a revolving door." → the rotating mechanism still visible, but bent into a hard-stopped, slammed position.
- `semantic_instrument_contradiction` — The tool's defining property (its NAME says what it can't do) contradicts the action — a cordless phone used for something that requires a cord.
  - *Render:* The gag writer receives the principle: "Show the impossible tool clearly and show the result or aftermath that should be impossible for that tool."
  - *Example:* "{NAME} can strangle someone with a cordless phone." → {NAME} holds a clearly cordless handset; the impossible aftermath is visible nearby, cause left to inference.
- `material_state_contradiction` — A material behaves in a state it cannot hold — vapor stacked like bricks, liquid folded like cloth.
  - *Render:* The gag writer receives the principle: "Turn the impossible material property into a clear physical visual."
  - *Example:* "{NAME} can stack fog." → translucent slabs of fog held in a neat stack, still misty at the edges so the impossibility reads.
- `medium_contradiction` — The surrounding medium (water, vacuum, fire) should make the action impossible, yet it succeeds inside that medium.
  - *Render:* The gag writer receives the principle: "Make the hostile medium obvious, then show the impossible action succeeding inside that medium."
  - *Example:* "{NAME} can start a fire underwater." → a bright flame burning fully submerged, bubbles and refracted light proving the water is real.
- `target_nature_contradiction` — The TARGET's own nature makes the result impossible — drowning a fish, sunburning a shadow.
  - *Render:* The gag writer receives the principle: "Show the target reacting in a way that contradicts what it naturally is."
  - *Example:* "{NAME} can drown a fish." → the fish visibly overwhelmed by the very water it should thrive in, {NAME} standing confidently by.
- `object_agency_inversion` — The object becomes the actor — it does the work, takes the initiative, or acts on its own because of the subject.
  - *Render:* The gag writer receives the principle: "Show the object taking the active role while the subject remains calm and in control."
  - *Example:* "The punching bag hits itself so {NAME} doesn't have to." → the bag mid-swing against itself while {NAME} watches, arms crossed.
- `environmental_immunity` — An environmental condition affects everything and everyone — except the subject, who is untouched.
  - *Render:* The gag writer receives the principle: "Show the environmental condition affecting the surrounding world while the subject remains untouched."
  - *Example:* "{NAME} walks through blizzards in a t-shirt." → the whole street buried and frozen while {NAME} strolls through untouched.
- `environmental_agency_inversion` — The natural force and the subject swap roles — the force becomes the affected party, victim, or subordinate ("Water gets {NAME}" instead of {NAME} getting wet).
  - *Render:* The gag writer receives the principle: "Show the environmental force behaving like it is the affected party, victim, or subordinate."
  - *Example:* "Water gets {NAME}." → water recoiling, cowering, or drenched-looking around a dominant, dry {NAME}.
- `environmental_control_interface` — The subject operates a natural force like a device — switching darkness off, adjusting gravity, dialing the wind.
  - *Render:* The gag writer receives the principle: "Make the abstract force feel physically controllable."
  - *Example:* "{NAME} turns the dark off." → {NAME}'s hand on a physical switch as darkness visibly drains out of the scene.
- `environmental_retreat_obedience` — The force actively avoids, parts around, or clears a path for the subject, as if obeying them.
  - *Render:* The gag writer receives the principle: "Show the force parting, bending, clearing, or retreating around the subject."
  - *Example:* "Rain avoids {NAME}." → a heavy downpour with a visible dry corridor bending around {NAME}.
- `personified_natural_force` — A natural force behaves like a person around the subject — the sun blinking is the classifier prompt's canonical case (this, not a cosmic category).
  - *Render:* The gag writer receives the principle: "Give the natural force a readable reaction while keeping it cinematic and not overly cartoonish unless style calls for it."
  - *Example:* "The sun blinked when it saw {NAME}." → the sun given a readable, cinematic reaction — dimming mid-blink — over an unbothered {NAME}.
- `social_role_reversal` — An everyday social role or responsibility is held by the wrong person — the baby driving {NAME}'s mother home is the canonical example.
  - *Render:* The gag writer receives the principle: "Stage realistically so the humor comes from the wrong person holding authority or responsibility."
  - *Example:* "Baby {NAME} drives their mom home from the hospital." → grounded, realistic car interior; the joke is entirely who is behind the wheel.
- `institutional_authority_reversal` — An institution (school, court, security, the law) submits to or reverses its normal role toward the subject.
  - *Render:* The gag writer receives the principle: "Use official environments and procedural symbols to show the institution submitting or reversing its normal role."
  - *Example:* "{NAME}'s teachers raised their hands when they had questions." → a classroom where the adult teacher raises a hand toward school-age {NAME}.
- `predator_danger_reversal` — Something normally dangerous (a predator, Death, a threat) treats the subject as the real threat, authority, or spectacle.
  - *Render:* The gag writer receives the principle: "Show the normally dangerous thing reacting as if the subject is the real threat, authority, or spectacle."
  - *Example:* "Sharks have a {NAME} Week." → sharks gathered as the rapt audience around a screen showing {NAME} — the Shark Week framing reversed, no real network logos.
- `pure_timeline_inversion` — The timeline itself is impossible — ages, birth order, or event order contradict history. Only for genuine time-order jokes, never redundant-mechanism facts.
  - *Render:* The gag writer receives the principle: "Show one clear contradiction in timeline, age, sequence, or event order."
  - *Example:* "{NAME} was born before their parents." → one clear, readable age/timeline contradiction staged in a single frame.
- `pre_cause_consequence` — The effect exists before its cause has happened. Careful: if the cause still happens later but is merely redundant (the grenade that explodes after the kill), that is superhuman_physical_feat with normal_function_rendered_unnecessary, NOT this.
  - *Render:* The gag writer receives the principle: "Show the cause still pending while the effect is already visible."
  - *Example:* "The punching bag was bruised before {NAME} hit it." → the bruise already there while {NAME}'s first punch is still mid-air.
- `reverse_process_entropy_reversal` — A normally irreversible process runs backward for the subject — unscrambling eggs, un-squeezing toothpaste.
  - *Render:* The gag writer receives the principle: "Show the completed mess or changed state reassembling into its earlier form."
  - *Example:* "{NAME} can unscramble an egg." → the scrambled egg visibly reassembling into a pristine whole egg in {NAME}'s hand.
- `surrender` — Conflict, opposition, or enemies simply give up because the subject is present.
  - *Render:* The gag writer receives the principle: "Show the subject calm and still while others visibly give up or submit."
  - *Example:* "Battlefield conflict stops when {NAME} arrives." → both sides lowering weapons the moment {NAME} steps into frame, calm and still.
- `awe_deference` — People or the environment treat the subject as naturally, unquestionably important — reverence without any threat.
  - *Render:* The gag writer receives the principle: "Show people or environment treating the subject as naturally important."
  - *Example:* "Rooms stand up when {NAME} walks in." → an entire room rising in spontaneous deference while {NAME} strolls through as if it's normal.
- `prestige_transfer` — Mere contact with or acknowledgment from the subject confers status on someone or something else.
  - *Render:* The gag writer receives the principle: "Show brief contact with the subject transferring status."
  - *Example:* "A pat on the back from {NAME} is resume-worthy." → someone proudly framing the moment of the pat like a diploma.
- `world_waits_for_subject` — Events, opportunities, or the world itself pause and wait for the subject rather than proceeding without them.
  - *Render:* The gag writer receives the principle: "Show the world paused, prepared, or expectant around the subject."
  - *Example:* "Opportunity waits for {NAME}." → opportunity personified standing patiently at {NAME}'s door, hand raised but not knocking, while {NAME} finishes their coffee.
- `object_obsession` — An object is emotionally or socially fixated on the subject — devotion inverted from user-to-thing into thing-to-subject.
  - *Render:* The gag writer receives the principle: "Show an object emotionally or socially fixated on the subject."
  - *Example:* "{NAME}'s phone is addicted to them." → the phone straining toward {NAME}, screen lighting up with longing notifications.
- `respectful_refusal` — A nuisance, pest, or obstacle voluntarily declines to bother the subject, out of respect.
  - *Render:* The gag writer receives the principle: "Show a nuisance or obstacle voluntarily holding back."
  - *Example:* "Mosquitoes refuse to bite {NAME}." → a swarm hovering at a respectful distance, one almost bowing, while {NAME} lounges unbitten.
- `tiny_gesture_massive_reaction` — A minimal gesture (a raised eyebrow, a nod) triggers a massive response — the eyebrow-ends-the-bar-fight fact is the classifier prompt's canonical case.
  - *Render:* The gag writer receives the principle: "Make the tiny gesture visible and the reaction huge."
  - *Example:* "A bar fight ends when {NAME} raises an eyebrow." → the eyebrow clearly readable in the frame; the entire brawl frozen because of it.
- `infinity_impossibility` — The fact completes, exceeds, or manipulates infinity — the canonical "counted to infinity, twice" territory.
  - *Render:* The gag writer receives the principle: "Visualize completed infinity, infinite loops, or impossible scale through cinematic metaphor."
  - *Example:* "{NAME} counted to infinity. Twice." → a cinematic infinite number-scape visibly completed — twice — around a calm {NAME}.
- `probability_impossibility` — An outcome that probability makes impossible, not just unlikely — a seven on a six-sided die.
  - *Render:* The gag writer receives the principle: "Show the impossible outcome with enough context that the probability rule is obvious (e.g. a seven on a six-sided die)."
  - *Example:* "{NAME} rolled a seven on a six-sided die." → the die large and legible with seven pips, its six-sidedness clearly readable.
- `rule_system_impossibility` — A game or defined rule system is beaten in a way its own rules make impossible.
  - *Render:* The gag writer receives the principle: "Show the impossible game/system state in a way that makes the rule legible."
  - *Example:* "{NAME} can win Connect Four in three moves." → the board state itself shows the impossible win, legible to anyone who knows the game.
- `paradox_or_undefined_impossibility` — A logical paradox or mathematically undefined operation — divide-by-zero and square-circle facts land here.
  - *Render:* The gag writer receives the principle: "Use paradoxical objects or impossible geometry; covers divide-by-zero and undefined-state cases."
  - *Example:* "{NAME} can divide by zero." → reality rendered as impossible geometry gracefully resolving around {NAME} instead of erroring.
- `formal_language_impossibility` — A formal-language, notation, or symbol-system rule is broken — like knowing the LAST four digits of pi, which has no last digits.
  - *Render:* The gag writer receives the principle: "Visualize the broken language/syntax rule through a symbolic concrete scene." (The authored pi-PIN example adds: showing four crisp digits is encouraged; never render long streams of pi.)
  - *Example:* "{NAME}'s PIN is the last four digits of pi." → a keypad showing four crisp digits, the joke concrete without walls of pi.
- `hidden_knowledge` — The subject knows secrets, mysteries, confidential truths, or inaccessible information.
  - *Render:* The gag writer receives the principle: "Secrets, mysteries, confidential truths, inaccessible information." — stage the barrier and the subject's effortless access.
  - *Example:* "{NAME} knows Victoria's secret." → elegant fashion-boutique secret-keeping visual language (the brand is the joke), no real logos.
- `future_prediction` — The subject knows future answers, outcomes, or random results before they happen.
  - *Render:* The gag writer receives the principle: "Future answers, outcomes, or random results known early."
  - *Example:* "{NAME} knows what the Magic 8 Ball will say before it's shaken." → the ball untouched, its answer already reflected in {NAME}'s knowing look.
- `impossible_problem_solving` — The subject solves problems before they are available, posed, or solvable.
  - *Render:* The gag writer receives the principle: "Problems solved before available or solvable."
  - *Example:* "{NAME} solves the crossword before the clues are printed." → a completed grid beside a printing press still producing the blank puzzle.
- `memory_omniscience` — Impossible memory — remembering the future, the unwitnessed, or the forgotten.
  - *Render:* The gag writer receives the principle: "Impossible memories, future memories, forgotten or unwitnessed events."
  - *Example:* "{NAME} remembers tomorrow." → tomorrow rendered as a crisp photograph already in {NAME}'s album.
- `strategic_omniscience` — The subject knows entire strategies, opponents' moves, or plans before they unfold.
  - *Render:* The gag writer receives the principle: "Entire strategies, opponent moves, or plans known ahead."
  - *Example:* "{NAME} knows your next move before you do." → the opponent's undecided move already marked and countered on {NAME}'s side of the board.
- `secret_mastery` — The subject has mastered hidden systems, elite knowledge, forbidden techniques, or secret skills.
  - *Render:* The gag writer receives the principle: "Hidden systems, elite knowledge, forbidden techniques, secret skills."
  - *Example:* "{NAME} knows the secret menu before the restaurant opens." → staff stunned as {NAME} orders from a menu no one has written yet.
- `security_system_submission` — Access-control systems (passwords, locks, checkpoints, logins) unlock, grant access, or submit to the subject.
  - *Render:* The gag writer receives the principle: "Access systems unlock, grant access, or submit."
  - *Example:* "The system logs itself in for {NAME}." → a login screen visibly completing itself as {NAME} approaches, no keys touched.
- `device_obedience` — Hardware anticipates, obeys, or serves the subject like a loyal attendant.
  - *Render:* The gag writer receives the principle: "Hardware anticipates, obeys, or serves."
  - *Example:* "The printer apologizes to {NAME} first." → a printer displaying a contrite status message before {NAME} even reaches it.
- `software_permission_inversion` — The normal permission flow is inverted — the software asks the subject for permission instead of the reverse.
  - *Render:* The gag writer receives the principle: "App or software asks the subject for permission."
  - *Example:* "Apps ask {NAME} for permission." → a phone screen with a permission dialog politely addressed to {NAME}, Allow/Deny buttons awaiting their verdict.
- `ai_deference` — AI or robots treat the subject as the higher intelligence, deferring to their judgment.
  - *Render:* The gag writer receives the principle: "AI or robots treat the subject as higher intelligence."
  - *Example:* "AI asks {NAME} for permission to think." → a glowing AI interface in a visibly deferential waiting state, cursor paused for {NAME}'s nod.
- `machine_intimidation` — A machine reacts to the subject with defeat, hesitation, or submission — beaten without a contest.
  - *Render:* The gag writer receives the principle: "Machine reacts with defeat, hesitation, or submission."
  - *Example:* "{NAME}'s chess computer resigns while unplugged." → the machine dark and unplugged, yet its resignation unmistakably displayed.
- `network_system_reaction` — Large-scale digital infrastructure — networks, servers, the internet itself — responds to the subject.
  - *Render:* The gag writer receives the principle: "Large-scale networks, servers, or infrastructure respond."
  - *Example:* "The servers stand at attention when {NAME} walks in." → whole server racks lighting up in synchronized salute as {NAME} enters the data center.
- `body_feature_impossibility` — A body feature (beard, fist, jawline, eyes, hands) has an impossible legendary property.
  - *Render:* The gag writer receives the principle: "Beard, fist, jawline, eyes, hands, or other body feature with an impossible legendary property."
  - *Example:* "Under {NAME}'s beard is another fist." → the impossible feature staged as a natural, mythic part of {NAME}'s body.
- `aura_property` — An invisible personal quality (confidence, charisma, presence) manifests as a visible aura, field, or atmosphere.
  - *Render:* The gag writer receives the principle: "Invisible quality represented as aura, field, atmosphere, or distortion."
  - *Example:* "{NAME}'s confidence has its own gravitational pull." → a visible field around {NAME} that bends light and pulls loose objects inward.
- `biological_impossibility` — A biological property, bodily output, or life-sign (tears, blood, breath, heartbeat, fingerprints, DNA, voice) has an impossible legendary effect.
  - *Render:* The gag writer receives the principle: "Biological property, bodily output, biometric marker, or life-sign with an impossible legendary effect (tears, blood, breath, heartbeat, fingerprints, DNA, voice)."
  - *Example:* "{NAME}'s tears cure disease. They have never cried." → the miraculous property implied and mythic, the composure intact.
- `metaphor_made_physical` — A common phrase or figure of speech is literally, physically true of the subject.
  - *Render:* The gag writer receives the principle: "Common phrase becomes physically true."
  - *Example:* "When {NAME} speaks, their words carry weight." → spoken words rendered as heavy physical objects visibly bowing the table they land on.
- `personal_effect_field` — The immediate space around the subject behaves differently from the rest of the world.
  - *Render:* The gag writer receives the principle: "Immediate space around the subject behaves differently."
  - *Example:* "WiFi is stronger within ten feet of {NAME}." → full signal bars blooming on every device inside a visible radius around {NAME}.
- `legendary_possession` — An ordinary possession has impossible properties purely because it belongs to the subject.
  - *Render:* The gag writer receives the principle: "Ordinary possession has impossible properties because it belongs to the subject."
  - *Example:* "{NAME}'s sunglasses block the sun from seeing them." → ordinary sunglasses, but it is the sun squinting and failing to make {NAME} out.
- `domestic_task_mythologized` — A household chore is treated as a legendary act.
  - *Render:* The gag writer receives the principle: "Household chore becomes legendary."
  - *Example:* "Dust surrenders before {NAME} even starts vacuuming." → the chore staged like a decisive victory, vacuum readable, dust in visible retreat.
- `ordinary_errand_mythologized` — A normal errand (shopping, mail, returns) becomes ceremonial or mythic.
  - *Render:* The gag writer receives the principle: "Normal errand becomes ceremonial or mythic."
  - *Example:* "Grocery carts steer perfectly straight for {NAME}." → a supermarket aisle staged like a ceremonial procession, the everyday errand still clearly readable.
- `food_drink_ritualized` — Food, drink, or cooking becomes a ritual, interrogation, or act of command.
  - *Render:* The gag writer receives the principle: "Food, drink, or cooking becomes a ritual, interrogation, or act of command."
  - *Example:* "Coffee beans confess to {NAME}." → a morning brew staged like an interrogation scene, beans under the lamp, {NAME} calmly in command.
- `commute_travel_mythologized` — Driving, parking, commuting, flying, or travel is treated as legendary.
  - *Render:* The gag writer receives the principle: "Driving, parking, commuting, flying, or travel is treated as legendary."
  - *Example:* "The curb moves over for {NAME} when they parallel park." → the curb itself visibly shifting to make room, the ordinary parking maneuver staged like an event.
- `social_habit_mythologized` — A normal greeting or social habit becomes a ceremony.
  - *Render:* The gag writer receives the principle: "Normal greeting or social habit becomes a ceremony."
  - *Example:* "Hands apply for the privilege of being shaken by {NAME}." → a formal application line of outstretched hands, the humble handshake turned ceremonial.
- `work_task_mythologized` — An ordinary professional task is treated as absurdly overhyped.
  - *Render:* The gag writer receives the principle: "Ordinary professional task becomes overhyped."
  - *Example:* "{NAME} doesn't prepare for demos. Demos prepare for {NAME}." → the demo setup arranging and rehearsing itself while {NAME} arrives, composed and worthy of it.

**Examples**

- **Scenario:** "{NAME} bench-presses the Earth." (superhuman_physical_feat)
  - **Input:** subtype: strength_scaled_action
  - **Outcome:** The gag writer's JOKE MECHANISM block carries: "Show the subject physically controlling an impossibly massive object while looking confident and in control."
- **Scenario:** "{NAME} rolled a seven on a six-sided die." (logic_formal_impossibility)
  - **Input:** subtype: probability_impossibility
  - **Outcome:** The gag writer is told to show the impossible outcome with enough context that the broken probability rule is obvious.

**Sources**

- `artifacts/api-server/src/lib/factEnrichmentConfig.ts` `FACT_ENRICHMENT_SYSTEM_DEFAULT` — The classifier system prompt — the authoritative definition of what the AI is told this field means.
- `lib/api-zod/src/visualPromptStrategies.ts` `getSubtypeGuidance` — The per-subtype principle sentences the gag writer is shown.
- `artifacts/api-server/src/lib/visualConcepts/generator.ts` `buildVisualConceptsUserMessage` — Where the gag writer's message gets the archetype and subtype (the JOKE MECHANISM block) and the reference/entity meanings. Modifiers, literalness and complexity are not put in the message.
- `artifacts/api-server/src/lib/visualConcepts/inputHash.ts` `writerAffectingEnrichment` — The gag writer's freshness projection: editing a field listed here marks the stored gag ideas out of date. It is not a render hash.
- `artifacts/api-server/src/lib/factRenderScenarios.ts` `renderAffectingEnrichment` — The render-input hash projection: it hashes only the gag's scene, bubbles and cast entries, so no classification field flips a render stale.

### Depiction Style

*How literally vs. symbolically the fact should be depicted.*

- **Effect:** Advisory only — read by the gag writer, never by the picture prompt
- **Staleness:** Editing does not re-flag render scenarios.
- **Editor surface:** field-label

**What it is**

A five-way classification of the depiction approach: show the fact literally as an event, abstract it symbolically, turn it into a concrete metaphor, stage it as realistic social roleplay, or mix literal and symbolic elements.

**How the AI sets it**

The classifier judges whether the fact CAN be shown literally (most physical feats) or needs symbolic/metaphorical treatment (logic, infinity, wordplay), per the definitions in its system prompt.

**How it affects the render**

Not read by the picture, and not put in the gag writer's message — it is a recorded label. It is only part of the gag writer's freshness check, so editing it marks the stored gag ideas out of date. It never marks a render out of date.

**Values (5)**

- `literal_dramatization` — The fact should be depicted directly, as if it literally happened — the scene shows the impossible thing itself, dramatized cinematically.
  - *Render:* Not read by the gag writer or the picture; it is a label. In practice this is the rating most physical-feat and reversal facts get: the fact is staged as a real event.
  - *Example:* "{NAME} bench-presses a bus" → a scene of the subject actually lifting a bus, full cinematic staging.
- `symbolic_abstraction` — The fact is too conceptual to show literally and needs symbolic visual language — the image represents the idea, not the event.
  - *Render:* Not read by the gag writer or the picture; it is a label. Common for logic/infinity facts, which need symbols or scale metaphors rather than a literal event.
  - *Example:* "{NAME} counted to infinity. Twice." → an endless number-scape receding past the horizon rather than a person counting.
- `metaphorical_visualization` — The fact should become a concrete visual metaphor — a phrase or concept made physically true in the image.
  - *Render:* Not read by the gag writer or the picture; it is a label for facts that become one clear metaphor made physical.
  - *Example:* "{NAME}'s handshake seals deals" → a literal wax-seal stamp pressed by a handshake onto a giant contract.
- `grounded_roleplay` — The fact should be staged as a realistic human/social scene — the comedy comes from people behaving impossibly, not from physics.
  - *Render:* Not read by the gag writer or the picture; it is a label for facts whose impossibility lives in the social roles and reactions (e.g. authority reversals).
  - *Example:* "A baby drove {NAME}'s mother home" → a realistic car interior; the impossibility is who's driving, not the physics.
- `mixed` — The fact needs both literal and symbolic elements to land.
  - *Render:* Not read by the gag writer or the picture; it is a label for facts that need a literal core event plus symbolic supporting elements.
  - *Example:* "{NAME} argued with gravity and won" → a literal courtroom (roleplay) with gravity personified as a defeated force (symbolic).

**Examples**

- **Scenario:** "{NAME} counted to infinity. Twice."
  - **Input:** visualLiteralness: symbolic_abstraction
  - **Outcome:** Recorded as a label only; the gag the moderator approves decides whether the picture is symbolic (endless recursion imagery) or a person mouthing numbers.
- **Scenario:** "A baby drove {NAME}'s mother home."
  - **Input:** visualLiteralness: grounded_roleplay
  - **Outcome:** Recorded as a label only; the approved gag decides the staging.

**Sources**

- `artifacts/api-server/src/lib/factEnrichmentConfig.ts` `FACT_ENRICHMENT_SYSTEM_DEFAULT` — The classifier system prompt — the authoritative definition of what the AI is told this field means.
- `artifacts/api-server/src/lib/visualConcepts/inputHash.ts` `writerAffectingEnrichment` — The gag writer's freshness projection: editing a field listed here marks the stored gag ideas out of date. It is not a render hash.
- `artifacts/api-server/src/lib/factRenderScenarios.ts` `renderAffectingEnrichment` — The render-input hash projection: it hashes only the gag's scene, bubbles and cast entries, so no classification field flips a render stale.

### Visualization Difficulty

*The AI's rating of how hard this fact is to visualize.*

- **Effect:** Advisory only — read by the gag writer, never by the picture prompt
- **Staleness:** Editing does not re-flag render scenarios.
- **Editor surface:** field-label

**What it is**

A low/medium/high rating of visualization difficulty. High-complexity facts (abstract, wordplay-heavy, ambiguous) are where AI renders most often miss — the admin UI shows a "Hard to visualize" warning for them in the enrichment editor.

**How the AI sets it**

The classifier rates difficulty per its prompt definitions: low = straightforward, medium = needs interpretation but has clear anchors, high = abstract/wordplay/ambiguous.

**How it affects the render**

Not read by the picture, and not put in the gag writer's message. Treat 'high' as a cue to inspect the gag's test renders closely and tighten its scene when the picture misses.

Only part of the gag writer's freshness check: editing it marks the stored gag ideas out of date, never a render.

**Values (3)**

- `low` — Straightforward visual representation — the fact translates to an image with no interpretation needed.
  - *Render:* No effect on the picture or the gag writer's message; editing it only marks stored gag ideas out of date.
  - *Example:* "{NAME} lifts a car" → one subject, one car, one action.
- `medium` — Needs interpretation but has clear visual anchors — the AI has to make a staging choice, but the ingredients are obvious.
  - *Render:* No effect on the picture or the gag writer's message; editing it only marks stored gag ideas out of date. Worth a quick look at the gag's test renders.
  - *Example:* "Sharks have a {NAME} Week" → needs the 'sharks as audience' inversion, but sharks + TV are clear anchors.
- `high` — Abstract, wordplay-heavy, ambiguous, or hard to make visually clear. The admin UI surfaces a 'Hard to visualize' warning for these.
  - *Render:* No effect on the picture or the gag writer's message — but treat it as a signal to review the gag's test renders closely and to tighten the gag's scene if the picture misses.
  - *Example:* "{NAME} divided by zero and survived" → no natural image; expect symbolic staging and check it actually reads.

**Examples**

- **Scenario:** A fact the classifier rates hard to draw.
  - **Input:** visualComplexity: high
  - **Outcome:** Nothing blocks; expect a gag's male test render to need more iterations before it works, and judge it closely.

**Sources**

- `artifacts/api-server/src/lib/factEnrichmentConfig.ts` `FACT_ENRICHMENT_SYSTEM_DEFAULT` — The classifier system prompt — the authoritative definition of what the AI is told this field means.
- `artifacts/api-server/src/lib/visualConcepts/inputHash.ts` `writerAffectingEnrichment` — The gag writer's freshness projection: editing a field listed here marks the stored gag ideas out of date. It is not a render hash.
- `artifacts/api-server/src/lib/factRenderScenarios.ts` `renderAffectingEnrichment` — The render-input hash projection: it hashes only the gag's scene, bubbles and cast entries, so no classification field flips a render stale.

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

It is NOT in the render-input hash, so editing it does not flip test renders stale (the prompt doesn't depend on it).

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
- `artifacts/api-server/src/lib/taxonomyHealth/index.ts` `evaluateFactTaxonomyHealth` — The questionable/reject health flags and needs_admin_review gating.

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

None — human-only. Never enters the gag writer's message or the compiled prompt, and it is explicitly EXCLUDED from the render-input hash, so editing it does not flip test renders stale.

**Examples**

- **Scenario:** adultSuitability came back requires_review.
  - **Input:** adultSuitabilityNotes: "Workplace demo context — compatible only if framed outside the office."
  - **Outcome:** You read the note, decide, and adjust the rating; renders are untouched.

**Sources**

- `artifacts/api-server/src/lib/factEnrichmentConfig.ts` `FACT_ENRICHMENT_SYSTEM_DEFAULT` — The classifier system prompt — the authoritative definition of what the AI is told this field means.
- `artifacts/api-server/src/lib/factRenderScenarios.ts` `renderAffectingEnrichment` — The render-input hash projection: it hashes only the gag's scene, bubbles and cast entries, so no classification field flips a render stale.

### Render Modifiers

*Flags the classifier records about the fact. They do not steer the picture: it is drawn from the approved gag.*

- **Effect:** Advisory only — read by the gag writer, never by the picture prompt
- **Staleness:** Editing does not re-flag render scenarios.
- **Editor surface:** field-label

**What it is**

A list of flags from a known catalog (custom values allowed) that mark rendering, identity, setting, and safety constraints. They are a record of what the classifier saw. They do not reach any picture prompt: until pictures started being drawn straight from the gag (plan docs/plans/PLAN_GAG_DIRECT_RENDER.md) a few of them acted as structural compiler signals (subject binding, no-clones, violence relevance, failure-mode guards); that effect was removed.

Unknown (custom) modifiers render as amber chips. Like the known ones they carry no directive anywhere.

**How the AI sets it**

The classifier prefers known modifiers from its catalog and may add a custom one only when no known modifier captures an important rendering, discovery, identity, setting, or safety constraint. Admins freely add/remove them here.

**How it affects the render**

None on the picture. A picture's prompt is built only from the approved gag's scene, bubbles and cast plus fixed wording that is the same for every fact, so no modifier changes it. Age changes and "one subject, no clones" are now the gag writer's job, stated in the gag's scene.

The gag writer's message does not list modifiers either. They are part of its freshness check only: editing them marks the stored gag ideas out of date (the inert legacy text/logo names are filtered out of that check). They never mark a render out of date.

**Values (49)**

- `single_subject_focus` *(authored — verify)* — Composition flag: the image should center on the subject alone, with no competing characters sharing the spotlight.
  - *Render:* No effect on the picture: the compiler does not read it and the gag writer's message does not list it. It is recorded on the fact and is part of the gag writer's freshness check only (editing it marks stored gag ideas out of date). If the picture should show it, say it in the gag's scene.
  - *Example:* "{NAME} is the gym's entire membership" → a label only; the picture follows the gag's scene, so say it there if it should show.
- `identity_strict` *(authored — verify)* — Identity-policy flag: the subject's recognizable likeness should be preserved strictly — the joke fails if the rendered person doesn't clearly read as the reference photo's person.
  - *Render:* No effect on the picture: no compiler directive or identity policy keys off this flag, and the gag writer's message does not list it. Likeness preservation is owned by the subject render mode and the fixed identity wording every picture carries.
  - *Example:* "{NAME} was recognized from space" → a label only; the picture follows the gag's scene, so say it there if it should show.
- `identity_essence_only` *(authored — verify)* — Identity-policy flag: strict likeness may be relaxed — the render only needs to carry the subject's essence (build, hair, vibe), e.g. through a heavy transformation or symbolic treatment.
  - *Render:* No effect on the picture: like identity_strict, nothing in the compiler or the gag writer's message reads it. It is recorded on the fact and takes part only in the gag writer's freshness check.
  - *Example:* "{NAME} turned into pure motivation" → a label only; the picture follows the gag's scene, so say it there if it should show.
- `face_prominent` *(authored — verify)* — Framing flag: the joke depends on the subject's face and expression reading clearly, so the face must be framed large and unobstructed.
  - *Render:* No effect on the picture: the compiler does not read it and the gag writer's message does not list it. It is recorded on the fact and is part of the gag writer's freshness check only (editing it marks stored gag ideas out of date). If the picture should show it, say it in the gag's scene.
  - *Example:* "{NAME}'s wink restarted the power grid" → a label only; the picture follows the gag's scene, so say it there if it should show.
- `full_body_needed` *(authored — verify)* — Framing flag: the joke needs the whole body visible (a pose, a feat, a stance) — a chest-up crop would lose it.
  - *Render:* No effect on the picture: the compiler does not read it and the gag writer's message does not list it. It is recorded on the fact and is part of the gag writer's freshness check only (editing it marks stored gag ideas out of date). If the picture should show it, say it in the gag's scene.
  - *Example:* "{NAME} deadlifts a city bus" → a label only; the picture follows the gag's scene, so say it there if it should show.
- `age_transform` — The fact requires the subject rendered at a different age or life stage than the reference photo — the generic form of the baby/older variants below.
  - *Render:* No effect on the picture any more. Age transforms used to drive a SUBJECT BINDING section (the subject IS the transformed person, never a second generic baby/elder) plus anti-split constraints; that code was removed when pictures started being drawn straight from the gag (plan docs/plans/PLAN_GAG_DIRECT_RENDER.md). The gag writer owns age handling now: the de-aging or aging has to be written into the gag's scene.
  - *Example:* "{NAME} was born flexing" → a label only; the picture follows the gag's scene, so say it there if it should show.
- `baby_child_version` — The fact describes the subject as a baby or young child — the reference person must be de-aged, not accompanied by a random infant.
  - *Render:* No effect on the picture any more. Age transforms used to drive a SUBJECT BINDING section (the subject IS the transformed person, never a second generic baby/elder) plus anti-split constraints; that code was removed when pictures started being drawn straight from the gag (plan docs/plans/PLAN_GAG_DIRECT_RENDER.md). The gag writer owns age handling now: the de-aging or aging has to be written into the gag's scene.
  - *Example:* "{NAME} as a baby negotiated their own bedtime" → a label only; the picture follows the gag's scene, so say it there if it should show.
- `infant_version` — A finer-grained age stage than baby_child_version: the fact needs the subject rendered specifically as a newborn/infant. The compiler used to render it distinctly (that effect was removed); the classifier's suggestion catalog doesn't list it, so it's typically moderator-added.
  - *Render:* No effect on the picture any more. Age transforms used to drive a SUBJECT BINDING section (the subject IS the transformed person, never a second generic baby/elder) plus anti-split constraints; that code was removed when pictures started being drawn straight from the gag (plan docs/plans/PLAN_GAG_DIRECT_RENDER.md). The gag writer owns age handling now: the de-aging or aging has to be written into the gag's scene.
  - *Example:* "{NAME} filed taxes from the womb" → a label only; the picture follows the gag's scene, so say it there if it should show.
- `child_version` — A finer-grained age stage than baby_child_version: the fact needs the subject rendered specifically as a young child (past infancy). The compiler used to render it distinctly (that effect was removed); the classifier's suggestion catalog doesn't list it, so it's typically moderator-added.
  - *Render:* No effect on the picture any more. Age transforms used to drive a SUBJECT BINDING section (the subject IS the transformed person, never a second generic baby/elder) plus anti-split constraints; that code was removed when pictures started being drawn straight from the gag (plan docs/plans/PLAN_GAG_DIRECT_RENDER.md). The gag writer owns age handling now: the de-aging or aging has to be written into the gag's scene.
  - *Example:* "{NAME} won a Nobel Prize in third grade" → a label only; the picture follows the gag's scene, so say it there if it should show.
- `older_self_version` — The fact describes the subject as a much older version of themselves — the same person aged, not an unrelated elderly extra.
  - *Render:* No effect on the picture any more. Age transforms used to drive a SUBJECT BINDING section (the subject IS the transformed person, never a second generic baby/elder) plus anti-split constraints; that code was removed when pictures started being drawn straight from the gag (plan docs/plans/PLAN_GAG_DIRECT_RENDER.md). The gag writer owns age handling now: the de-aging or aging has to be written into the gag's scene.
  - *Example:* "At 90, {NAME} still outruns ambulances" → a label only; the picture follows the gag's scene, so say it there if it should show.
- `grounded_realism` *(authored — verify)* — Staging flag: keep physics and rendering realistic — the impossibility should live in what's happening (roles, outcomes), not in cartoon physics or surreal style.
  - *Render:* No effect on the picture: the compiler does not read it and the gag writer's message does not list it. It is recorded on the fact and is part of the gag writer's freshness check only (editing it marks stored gag ideas out of date). If the picture should show it, say it in the gag's scene.
  - *Example:* "A baby drove {NAME}'s mother home" → a label only; the picture follows the gag's scene, so say it there if it should show.
- `mock_heroic` *(authored — verify)* — The comedy comes from treating something trivial with epic gravitas — the subject should be staged like a monument to a mundane act.
  - *Render:* No effect on the picture: the compiler does not read it and the gag writer's message does not list it. It is recorded on the fact and is part of the gag writer's freshness check only (editing it marks stored gag ideas out of date). If the picture should show it, say it in the gag's scene.
  - *Example:* "{NAME} plugged in a USB right on the first try" → a label only; the picture follows the gag's scene, so say it there if it should show.
- `action_comedy` — The fact is an action joke — energetic, slapstick, physical comedy staging suits it better than solemn cinematics.
  - *Render:* No effect on the picture any more. It used to mark the fact violence-relevant for the compiler; that check was removed when pictures started being drawn straight from the gag (plan docs/plans/PLAN_GAG_DIRECT_RENDER.md). Every picture now carries the one fixed violence sentence (comedic violence and its consequences shown clearly, without intense gore), whatever the modifiers say.
  - *Example:* "{NAME} fought the office printer and won" → a label only; the picture follows the gag's scene, so say it there if it should show.
- `cinematic_aftermath` — The funniest frame is AFTER the action — the crater, the dust, the stunned onlookers — rather than the action itself.
  - *Render:* No effect on the picture any more. It used to mark the fact violence-relevant for the compiler; that check was removed when pictures started being drawn straight from the gag (plan docs/plans/PLAN_GAG_DIRECT_RENDER.md). Every picture now carries the one fixed violence sentence (comedic violence and its consequences shown clearly, without intense gore), whatever the modifiers say.
  - *Example:* "{NAME} high-fived a mountain" → a label only; the picture follows the gag's scene, so say it there if it should show.
- `symbolic_abstraction_required` *(authored — verify)* — The fact cannot be shown literally at all — it demands symbolic visual language (the modifier-flag counterpart of the symbolic_abstraction literalness rating).
  - *Render:* No effect on the picture: the compiler does not read it and the gag writer's message does not list it. It is recorded on the fact and is part of the gag writer's freshness check only (editing it marks stored gag ideas out of date). If the picture should show it, say it in the gag's scene.
  - *Example:* "{NAME} counted to infinity. Twice." → a label only; the picture follows the gag's scene, so say it there if it should show.
- `metaphorical_visualization` *(authored — verify)* — The joke should land as one concrete visual metaphor — a phrase made physically true in the image (the modifier-flag counterpart of the same-named literalness rating).
  - *Render:* No effect on the picture: the compiler does not read it and the gag writer's message does not list it. It is recorded on the fact and is part of the gag writer's freshness check only (editing it marks stored gag ideas out of date). If the picture should show it, say it in the gag's scene.
  - *Example:* "{NAME}'s handshake seals deals" → a label only; the picture follows the gag's scene, so say it there if it should show.
- `clear_causal_relationship` — The joke is a cause→effect gag, and it only lands if the viewer instantly sees which action caused which consequence.
  - *Render:* No effect on the picture any more. It used to add a failure-mode guard ("show the cause and its effect together") to the strict constraints; that guard was removed when pictures started being drawn straight from the gag (plan docs/plans/PLAN_GAG_DIRECT_RENDER.md). Make the cause and effect legible in the gag's scene.
  - *Example:* "{NAME} clapped and the thunder answered" → a label only; the picture follows the gag's scene, so say it there if it should show.
- `crowd_reaction` — Witnesses are part of the joke — the scene needs a visible crowd whose reaction sells how impressive the subject is.
  - *Render:* No effect on the picture any more. It used to add a crowd focus/relationship guard to the strict constraints; that guard was removed when pictures started being drawn straight from the gag (plan docs/plans/PLAN_GAG_DIRECT_RENDER.md). Describe the crowd, and who it reacts to, in the gag's scene.
  - *Example:* "{NAME} parallel-parked on the first attempt" → a label only; the picture follows the gag's scene, so say it there if it should show.
- `environmental_reaction` *(authored — verify)* — The environment itself should visibly respond to the subject — nature, buildings, or weather reacting is the punchline's proof.
  - *Render:* No effect on the picture: the compiler does not read it and the gag writer's message does not list it. It is recorded on the fact and is part of the gag writer's freshness check only (editing it marks stored gag ideas out of date). If the picture should show it, say it in the gag's scene.
  - *Example:* "{NAME} whispered and the forest leaned in" → a label only; the picture follows the gag's scene, so say it there if it should show.
- `object_transformation` *(authored — verify)* — An object changes state because of the subject, and the change itself must be legible — best shown mid-transformation.
  - *Render:* No effect on the picture: the compiler does not read it and the gag writer's message does not list it. It is recorded on the fact and is part of the gag writer's freshness check only (editing it marks stored gag ideas out of date). If the picture should show it, say it in the gag's scene.
  - *Example:* "{NAME} stared at coal until it became a diamond" → a label only; the picture follows the gag's scene, so say it there if it should show.
- `technology_reaction` *(authored — verify)* — Devices and machines visibly respond to the subject — screens, routers, robots reacting is the gag's evidence.
  - *Render:* No effect on the picture: the compiler does not read it and the gag writer's message does not list it. It is recorded on the fact and is part of the gag writer's freshness check only (editing it marks stored gag ideas out of date). If the picture should show it, say it in the gag's scene.
  - *Example:* "WiFi gets stronger when {NAME} walks by" → a label only; the picture follows the gag's scene, so say it there if it should show.
- `official_setting` *(authored — verify)* — "{NAME} was sworn in as everyone's emergency contact" → a label only; the picture follows the gag's scene, so say it there if it should show.
  - *Render:* No effect on the picture: setting/location flags are not read by the compiler or put in the gag writer's message. The gag's scene decides the environment, so say the formal/ceremonial setting there if the picture needs it.
  - *Example:* "{NAME} was sworn in as everyone's emergency contact" → a label only; the picture follows the gag's scene, so say it there if it should show.
- `professional_context` *(authored — verify)* — Context flag: the fact lives in a professional/expert domain (consultants, doctors, engineers at work). Also an adult-suitability signal — professional contexts are on the classifier's adult-incompatible list.
  - *Render:* No effect on the picture: nothing compiles it and the gag writer's message does not list it. Its firmer role is taxonomy/safety context (adult-suitability review). It also takes part in the gag writer's freshness check.
  - *Example:* "{NAME} closed the deal by nodding" → a label only; the picture follows the gag's scene, so say it there if it should show.
- `domestic_setting` *(authored — verify)* — "{NAME}'s houseplants water themselves out of respect" → a label only; the picture follows the gag's scene, so say it there if it should show.
  - *Render:* No effect on the picture: setting/location flags are not read by the compiler or put in the gag writer's message. The gag's scene decides the environment, so say the home/domestic setting there if the picture needs it.
  - *Example:* "{NAME}'s houseplants water themselves out of respect" → a label only; the picture follows the gag's scene, so say it there if it should show.
- `office_setting` *(authored — verify)* — "The office printer works only for {NAME}" → a label only; the picture follows the gag's scene, so say it there if it should show.
  - *Render:* No effect on the picture: setting/location flags are not read by the compiler or put in the gag writer's message. The gag's scene decides the environment, so say the office setting there if the picture needs it.
  - *Example:* "The office printer works only for {NAME}" → a label only; the picture follows the gag's scene, so say it there if it should show.
- `school_setting` *(authored — verify)* — "Teachers ask {NAME} for hall passes" → a label only; the picture follows the gag's scene, so say it there if it should show.
  - *Render:* No effect on the picture: setting/location flags are not read by the compiler or put in the gag writer's message. The gag's scene decides the environment, so say the school setting there if the picture needs it.
  - *Example:* "Teachers ask {NAME} for hall passes" → a label only; the picture follows the gag's scene, so say it there if it should show.
- `hospital_setting` *(authored — verify)* — "Doctors check {NAME}'s pulse to calibrate their watches" → a label only; the picture follows the gag's scene, so say it there if it should show.
  - *Render:* No effect on the picture: setting/location flags are not read by the compiler or put in the gag writer's message. The gag's scene decides the environment, so say the hospital/medical setting there if the picture needs it.
  - *Example:* "Doctors check {NAME}'s pulse to calibrate their watches" → a label only; the picture follows the gag's scene, so say it there if it should show.
- `courtroom_setting` *(authored — verify)* — "{NAME} was called as an expert witness on being impressive" → a label only; the picture follows the gag's scene, so say it there if it should show.
  - *Render:* No effect on the picture: setting/location flags are not read by the compiler or put in the gag writer's message. The gag's scene decides the environment, so say the courtroom setting there if the picture needs it.
  - *Example:* "{NAME} was called as an expert witness on being impressive" → a label only; the picture follows the gag's scene, so say it there if it should show.
- `airport_setting` *(authored — verify)* — "TSA waves {NAME} through with applause" → a label only; the picture follows the gag's scene, so say it there if it should show.
  - *Render:* No effect on the picture: setting/location flags are not read by the compiler or put in the gag writer's message. The gag's scene decides the environment, so say the airport setting there if the picture needs it.
  - *Example:* "TSA waves {NAME} through with applause" → a label only; the picture follows the gag's scene, so say it there if it should show.
- `gym_setting` *(authored — verify)* — "The gym renamed leg day after {NAME}" → a label only; the picture follows the gag's scene, so say it there if it should show.
  - *Render:* No effect on the picture: setting/location flags are not read by the compiler or put in the gag writer's message. The gag's scene decides the environment, so say the gym setting there if the picture needs it.
  - *Example:* "The gym renamed leg day after {NAME}" → a label only; the picture follows the gag's scene, so say it there if it should show.
- `bar_setting` *(authored — verify)* — "Bartenders tip {NAME}" → a label only; the picture follows the gag's scene, so say it there if it should show.
  - *Render:* No effect on the picture: setting/location flags are not read by the compiler or put in the gag writer's message. The gag's scene decides the environment, so say the bar setting there if the picture needs it.
  - *Example:* "Bartenders tip {NAME}" → a label only; the picture follows the gag's scene, so say it there if it should show.
- `battlefield_setting` *(authored — verify)* — "{NAME} won the battle by showing up" → a label only; the picture follows the gag's scene, so say it there if it should show.
  - *Render:* No effect on the picture: setting/location flags are not read by the compiler or put in the gag writer's message. The gag's scene decides the environment, so say the battlefield setting there if the picture needs it.
  - *Example:* "{NAME} won the battle by showing up" → a label only; the picture follows the gag's scene, so say it there if it should show.
- `technology_setting` *(authored — verify)* — "Servers cool down when {NAME} logs on" → a label only; the picture follows the gag's scene, so say it there if it should show.
  - *Render:* No effect on the picture: setting/location flags are not read by the compiler or put in the gag writer's message. The gag's scene decides the environment, so say the tech/data-center setting there if the picture needs it.
  - *Example:* "Servers cool down when {NAME} logs on" → a label only; the picture follows the gag's scene, so say it there if it should show.
- `underwater_setting` *(authored — verify)* — "Sharks have a {NAME} Week" → a label only; the picture follows the gag's scene, so say it there if it should show.
  - *Render:* No effect on the picture: setting/location flags are not read by the compiler or put in the gag writer's message. The gag's scene decides the environment, so say the underwater setting there if the picture needs it.
  - *Example:* "Sharks have a {NAME} Week" → a label only; the picture follows the gag's scene, so say it there if it should show.
- `space_setting` *(authored — verify)* — "{NAME} waved at the ISS and it waved back" → a label only; the picture follows the gag's scene, so say it there if it should show.
  - *Render:* No effect on the picture: setting/location flags are not read by the compiler or put in the gag writer's message. The gag's scene decides the environment, so say the outer-space setting there if the picture needs it.
  - *Example:* "{NAME} waved at the ISS and it waved back" → a label only; the picture follows the gag's scene, so say it there if it should show.
- `outdoor_nature_setting` *(authored — verify)* — "Mountains adjust their height for {NAME}'s photos" → a label only; the picture follows the gag's scene, so say it there if it should show.
  - *Render:* No effect on the picture: setting/location flags are not read by the compiler or put in the gag writer's message. The gag's scene decides the environment, so say the outdoor/nature setting there if the picture needs it.
  - *Example:* "Mountains adjust their height for {NAME}'s photos" → a label only; the picture follows the gag's scene, so say it there if it should show.
- `city_setting` *(authored — verify)* — "Traffic lights turn green when {NAME} approaches" → a label only; the picture follows the gag's scene, so say it there if it should show.
  - *Render:* No effect on the picture: setting/location flags are not read by the compiler or put in the gag writer's message. The gag's scene decides the environment, so say the urban/city setting there if the picture needs it.
  - *Example:* "Traffic lights turn green when {NAME} approaches" → a label only; the picture follows the gag's scene, so say it there if it should show.
- `avoid_weapons_focus` *(authored — verify)* — Presentation constraint (not moderation): a weapon may appear if the fact requires it, but it must not be the visual centerpiece of the scene.
  - *Render:* No effect on the picture: the compiler does not read it and the gag writer's message does not list it. It is recorded on the fact and is part of the gag writer's freshness check only (editing it marks stored gag ideas out of date). If the picture should show it, say it in the gag's scene.
  - *Example:* "{NAME} caught the arrow mid-flight" → a label only; the picture follows the gag's scene, so say it there if it should show.
- `avoid_gross_literalization` *(authored — verify)* — Taste constraint: a literal rendering of the fact would be gross or off-putting — the idea should be staged tastefully instead.
  - *Render:* No effect on the picture: the compiler does not read it and the gag writer's message does not list it. It is recorded on the fact and is part of the gag writer's freshness check only (editing it marks stored gag ideas out of date). If the picture should show it, say it in the gag's scene.
  - *Example:* "{NAME} sweats pure espresso" → a label only; the picture follows the gag's scene, so say it there if it should show.
- `avoid_extra_faces` *(authored — verify)* — Focus constraint: background faces dilute the subject and risk identity confusion — keep other faces minimal so the subject stays the one clear face.
  - *Render:* No effect on the picture: the compiler does not read it and the gag writer's message does not list it. It is recorded on the fact and is part of the gag writer's freshness check only (editing it marks stored gag ideas out of date). If the picture should show it, say it in the gag's scene.
  - *Example:* "{NAME} won the marathon running backwards" → a label only; the picture follows the gag's scene, so say it there if it should show.
- `avoid_duplicate_subject` — Anti-clone constraint: image models love to render the reference person twice — this flag pins the subject to exactly one instance.
  - *Render:* No effect on the picture any more. It used to trigger the single-instance SUBJECT BINDING and the no-clone strict constraint; both were removed when pictures started being drawn straight from the gag (plan docs/plans/PLAN_GAG_DIRECT_RENDER.md). Keep the subject to one copy by saying so in the gag's scene.
  - *Example:* "{NAME} raced their own shadow" → a label only; the picture follows the gag's scene, so say it there if it should show.
- `astronomical_consequence` *(authored — verify)* — The fact's consequence is planetary/cosmic scale — the image must stage that scale, not shrink it to a local effect.
  - *Render:* No effect on the picture: the compiler does not read it and the gag writer's message does not list it. It is recorded on the fact and is part of the gag writer's freshness check only (editing it marks stored gag ideas out of date). If the picture should show it, say it in the gag's scene.
  - *Example:* "{NAME} sneezed and the moon left orbit" → a label only; the picture follows the gag's scene, so say it there if it should show.
- `celestial_object` *(authored — verify)* — A specific celestial body (planet, moon, star) is a load-bearing prop in the joke and must be clearly rendered in frame.
  - *Render:* No effect on the picture: the compiler does not read it and the gag writer's message does not list it. It is recorded on the fact and is part of the gag writer's freshness check only (editing it marks stored gag ideas out of date). If the picture should show it, say it in the gag's scene.
  - *Example:* "The moon waves back at {NAME}" → a label only; the picture follows the gag's scene, so say it there if it should show.
- `subject_object_reversal` — The joke inverts the normal actor/acted-on relationship — the object does to the subject what the subject would normally do to it.
  - *Render:* No effect on the picture any more. It used to add a failure-mode guard keeping the reversed roles legible; that guard was removed when pictures started being drawn straight from the gag (plan docs/plans/PLAN_GAG_DIRECT_RENDER.md). Make the object's action on the subject clear in the gag's scene.
  - *Example:* "The dumbbells ask {NAME} for a lighter set" → a label only; the picture follows the gag's scene, so say it there if it should show.
- `normal_function_rendered_unnecessary` — Redundant-mechanism jokes: the subject's impossible power accomplishes the result BEFORE an object/tool/weapon's normal mechanism is needed — the mechanism may still fire afterward, but comically redundantly. Explicitly NOT a temporal/causality inversion (the canonical example: "threw a grenade and killed 50 people, then it exploded").
  - *Render:* No effect on the picture: the compiler does not read it and the gag writer's message does not list it. It is recorded on the fact and is part of the gag writer's freshness check only (editing it marks stored gag ideas out of date). If the picture should show it, say it in the gag's scene. (This modifier's main job is taxonomy: it marks the redundant-mechanism pattern so the fact is not misclassified as a temporal/causality inversion.)
  - *Example:* "{NAME} threw a grenade and killed 50 people, then it exploded" → a label only; the picture follows the gag's scene, so say it there if it should show.
- `projectile_impact_power` — A thrown/launched object carries impossible force — the image needs visual evidence of that power (shockwave, trail, impact path).
  - *Render:* No effect on the picture any more. It used to mark the fact violence-relevant for the compiler; that check was removed when pictures started being drawn straight from the gag (plan docs/plans/PLAN_GAG_DIRECT_RENDER.md). Every picture now carries the one fixed violence sentence (comedic violence and its consequences shown clearly, without intense gore), whatever the modifiers say.
  - *Example:* "{NAME}'s paper airplane broke the sound barrier" → a label only; the picture follows the gag's scene, so say it there if it should show.
- `brand_context` *(authored — verify)* — Context flag: the joke depends on a brand or company reference. Pairs with the culturalReferences brand_reference entries; brands are also on the adult-suitability incompatible list.
  - *Render:* No effect on the picture: nothing compiles it. It tells reviewers the joke leans on a brand. Real brand MARKS never render regardless: the always-on overlay-text exclusion bans logos and brand marks on every image.
  - *Example:* "A rental company sends {NAME} thank-you flowers" → a label only; the picture follows the gag's scene, so say it there if it should show.
- `workplace_context` *(authored — verify)* — Context flag: the fact assumes workplace framing — bosses, HR, coworkers, office politics. Workplace context is also on the classifier's adult-incompatible list, so this doubles as a safety signal.
  - *Render:* No effect on the picture: nothing compiles it and the gag writer's message does not list it. Its more concrete role is taxonomy/adult-suitability context.
  - *Example:* "HR studies {NAME}'s emails as literature" → a label only; the picture follows the gag's scene, so say it there if it should show.
- `audience_inside_reference` *(authored — verify)* — Context flag: the joke's audience exists INSIDE the reference — the in-scene watchers/consumers belong to the referenced format or world (e.g. the sharks watching "{NAME} Week"), and the joke collapses if who-is-watching-whom gets lost.
  - *Render:* No effect on the picture: the compiler does not read it and the gag writer's message does not list it. It is recorded on the fact and is part of the gag writer's freshness check only (editing it marks stored gag ideas out of date). If the picture should show it, say it in the gag's scene.
  - *Example:* "Sharks have a {NAME} Week" → a label only; the picture follows the gag's scene, so say it there if it should show.

**Examples**

- **Scenario:** "{NAME} as a baby negotiated their own bedtime." — render shows an adult plus a random baby.
  - **Input:** Add modifier: "baby_child_version"
  - **Outcome:** Nothing in the picture changes: the modifier is not read by the compiler any more. Fix the render by writing the de-aging into the gag's scene ("{NAME}, de-aged into a baby — the same person, not a second one"); the scene reaches the prompt verbatim.
- **Scenario:** A render keeps drawing readable gibberish signage, but the scene has NO text that should appear.
  - **Input:** Say in the gag's scene that there are no signs or lettering.
  - **Outcome:** Every picture already carries fixed wording excluding overlay text and steering incidental background text non-readable; anything stronger goes in the scene. (The supporting-text override and the old no_readable_text modifier are both retired.)
- **Scenario:** You add a custom modifier "sepia_flashback".
  - **Input:** modifiers: [..., "sepia_flashback"] (amber chip)
  - **Outcome:** Nothing reads it for the picture; it is recorded on the fact and takes part in the gag writer's freshness check only.

**Sources**

- `artifacts/api-server/src/lib/factEnrichmentConfig.ts` `FACT_ENRICHMENT_SYSTEM_DEFAULT` — The classifier system prompt — the authoritative definition of what the AI is told this field means.
- `artifacts/api-server/src/lib/visualConcepts/inputHash.ts` `writerAffectingEnrichment` — The gag writer's freshness projection: editing a field listed here marks the stored gag ideas out of date. It is not a render hash.
- `artifacts/api-server/src/lib/factRenderScenarios.ts` `renderAffectingEnrichment` — The render-input hash projection: it hashes only the gag's scene, bubbles and cast entries, so no classification field flips a render stale.

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
- `artifacts/api-server/src/lib/factRenderScenarios.ts` `renderAffectingEnrichment` — The render-input hash projection: it hashes only the gag's scene, bubbles and cast entries, so no classification field flips a render stale.

### AI Classification Confidence

*The classifier's 0–1 confidence in its own archetype/subtype call. Read-only.*

- **Effect:** Advisory only — read by the gag writer, never by the picture prompt
- **Editor surface:** field-label

**What it is**

The model's self-reported confidence (0–1) in the taxonomy classification. Below 0.75, Taxonomy Health raises a low-confidence flag and marks the fact needs_admin_review — your cue to sanity-check the archetype/subtype yourself.

Read-only here: it describes the AI's classification event and is not meaningfully hand-editable.

**How the AI sets it**

Emitted by the classifier with each classification; the deterministic redundant-mechanism repair caps it at 0.49 when it rewrites a misclassification, keeping the fact flagged for review.

**How it affects the render**

Advisory only: a record of the classifier's own confidence; it reaches no prompt, and it is excluded from the render-input hash.

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

None — human-only. Never enters the gag writer's message or the compiled prompt; excluded from the render-input hash, so editing it never flips renders stale.

**Examples**

- **Scenario:** You approved despite a questionable fit.
  - **Input:** adminReviewNotes: "Fit is borderline but the visual is great — approved 7/2."
  - **Outcome:** Context preserved for the next admin; nothing else in the system changes.

**Sources**

- `artifacts/api-server/src/lib/factRenderScenarios.ts` `renderAffectingEnrichment` — The render-input hash projection: it hashes only the gag's scene, bubbles and cast entries, so no classification field flips a render stale.

## Visual Strategy Override

### Visual Strategy Override

*The gag's content: its scene and its speech/thought bubbles are what a picture is drawn from. The old "More art direction" controls are retired.*

- **Effect:** Render-affecting — reaches the picture prompt (the gag's scene and bubbles)
- **Staleness:** Editing re-flags render scenarios as stale.
- **Editor surface:** panel-level

**What it is**

The per-gag content object a moderator edits: the scene (Visual Concept) and the speech/thought bubbles. It is stored with the gag, and a picture's prompt is built only from it (plus the gag's cast, read from the scene by an AI step when the gag is saved) and fixed wording that is the same for every fact.

Write plain English — don't hand-type tokens. Each rendered-text field just needs the subject's name written naturally ("David laughs", not "{NAME} laughs"); on Save the system auto-tokenizes every changed field through the same tokenizer fact submission uses, and shows you the tokenized result right there so you can verify it and correct it before it persists. Chips ({NAME}, {NAME_POSSESSIVE}, {SUBJ}, and the other pronoun tokens) remain in the toolbar as an expert escape hatch, but authoring no longer requires them. Name ONLY the main subject in your prose; refer to every other character by role ("the mother", "a bystander") — the tokenizer only replaces the subject's name and pronouns, so a second named character would be left literal.

The eleven "More art direction" fields (moderator intent, subject depiction, required/forbidden details, role assignments, composition guidance, extra prompt details, do-not-render additions, the supporting-text and violence overrides, notes for the moderator) are retired: no longer accepted on save and never read. Any live value was folded into the gag's scene text first.

**How the AI sets it**

Authored by moderators, or picked from the gag writer's candidate ideas (the AI never writes it straight into a picture). The save path stamps server-owned provenance (updatedBy/updatedAt).

**How it affects the render**

The scene is the CORE SCENE section of the prompt, verbatim; the bubbles become the SPEECH & THOUGHT BUBBLES section, with speaker bindings written from the gag's cast. Everything else in the prompt is fixed wording: identity, a filler line for details the scene leaves unstated, style, and one fixed violence sentence.

Nothing about the fact's AI classification (archetype, modifiers, literalness, references, characters) is added to the picture. There is no render-time AI planner and no other modifier- or classification-driven compiler wording; both were removed when pictures started being drawn straight from the gag (plan docs/plans/PLAN_GAG_DIRECT_RENDER.md).

Editing the scene or a bubble flips render-scenario tiles stale; the render-input hash covers only the gag's scene, bubbles and cast entries.

**Examples**

- **Scenario:** A render keeps missing a detail the gag depends on.
  - **Input:** Add the detail to the Visual Concept (scene) text.
  - **Outcome:** The scene reaches the prompt verbatim, so the detail is drawn; there is no separate required-details field to fill any more.
- **Scenario:** You write a scene naming the subject in plain English.
  - **Input:** Visual Concept: "David's face on the statue"
  - **Outcome:** Click Save — the system tokenizes it to "{NAME_POSSESSIVE} face on the statue" and shows you the result. Tokens resolve per render; a plain name persisted as-is would leak into every other user's render, which is exactly what auto-tokenize prevents.

**Sources**

- `lib/api-zod/src/visualStrategyOverride.ts` `visualPromptStrategyOverrideSchema` — The gag content's schema: field shapes, list caps and token canonicalization/validation on save.
- `artifacts/api-server/src/lib/imagePrompt/compilers/nanoBanana2.ts` `compileDirect` — The one compile entry point: a picture's prompt is the gag's scene, its bubbles and its cast plus fixed wording that is the same for every fact.
- `artifacts/api-server/src/lib/factRenderScenarios.ts` `renderAffectingEnrichment` — The render-input hash projection: it hashes only the gag's scene, bubbles and cast entries, so editing either flips render-scenario tiles stale.

### Visual Concept (Core Scene)

*Describe the picture in plain English, naming only the subject — on Save the system tokenizes it and shows you the result.*

- **Effect:** Render-affecting — reaches the picture prompt (the gag's scene and bubbles)
- **Staleness:** Editing re-flags render scenarios as stale.
- **Editor surface:** field-label

**What it is**

The moderator-authored scene: 2–4 plain-language sentences describing exactly what the image shows (subject, action, setting, objects, composition). It is the whole of what the picture shows: the compiler emits it as the CORE SCENE section at required priority, never compressed under the char budget, and nothing about the fact's classification is added to it.

Write it in plain English, naming the subject naturally ("David leans against the bar"). On Save the system tokenizes it (the same tokenizer fact submission uses) and shows the tokenized result in the field so you can verify it before it persists — the field is still editable afterward. Name ONLY the main subject; refer to any other character by role ("the bartender", "a passerby"), never by name, since the tokenizer won't recognize a second name as personalizable. Capped at 1500 characters: it is a scene brief, not a full prompt.

Also surfaced as the prominent 'Visual concept — describe the picture' card in moderation visual review; both surfaces edit this same field.

**How the AI sets it**

Authored by moderators, or picked from the gag writer's candidate ideas. Preserved verbatim across re-classification.

**How it affects the render**

Is the CORE SCENE section, verbatim (required, non-compressible, marked MODERATOR in the prompt breakdown). The prompt's other sections are fixed wording, including a line telling the engine to choose plausible details for whatever the scene leaves unstated.

The compiler still owns identity/reference/text-policy language: engine instructions written here ('preserve the face', 'no readable text') are rendered as written but raise a warning in the prompt diagnostics, since they duplicate wording the compiler already supplies. A scene is required: the picture cannot be drawn without one.

**Examples**

- **Scenario:** The AI keeps missing the scale gag in a participation-trophy fact.
  - **Input:** Visual concept: "David triumphantly holds a participation trophy the size of a grain of rice, photographed like a championship victory."
  - **Outcome:** Click Save — the field shows "{NAME} triumphantly holds a participation trophy the size of a grain of rice, photographed like a championship victory." CORE SCENE is exactly that sentence (token-resolved per render), the engine fills in unstated detail around it, and it survives the char budget uncompressed.
- **Scenario:** You write engine instructions instead of a scene.
  - **Input:** Visual concept: "Preserve the uploaded face and do not show readable text."
  - **Outcome:** Both clauses are compiler-owned wording; the diagnostics warn about them. Rewrite as visible scene description.
- **Scenario:** Your prose names a second character ("David and Alex raced go-karts").
  - **Input:** Visual concept: "David and Alex raced go-karts around the office."
  - **Outcome:** Tokenizes to "{NAME} and Alex raced go-karts around the office." — only David becomes {NAME}; Alex stays a literal name in the compiled prompt. Rewrite as "David raced a coworker around go-karts in the office" to avoid a hardcoded second name.

**Sources**

- `lib/api-zod/src/visualStrategyOverride.ts` `visualPromptStrategyOverrideSchema` — The gag content's schema: field shapes, list caps and token canonicalization/validation on save.
- `artifacts/api-server/src/lib/imagePrompt/compilers/nanoBanana2.ts` `compileDirect` — The one compile entry point: a picture's prompt is the gag's scene, its bubbles and its cast plus fixed wording that is the same for every fact.
- `artifacts/api-server/src/lib/factRenderScenarios.ts` `renderAffectingEnrichment` — The render-input hash projection: it hashes only the gag's scene, bubbles and cast entries, so editing either flips render-scenario tiles stale.

### Speech & Thought Bubbles

*Make a character in the scene speak or think an exact line — a balloon rendered into the image with the text lettered verbatim. Pick who says it from the dropdown — the subject or a character from this gag's cast; shorter text renders more reliably.*

- **Effect:** Render-affecting — reaches the picture prompt (the gag's scene and bubbles)
- **Staleness:** Editing re-flags render scenarios as stale.
- **Editor surface:** field-label

**What it is**

A list (max 4; 1–2 works best) of bubbles: a type (Speech = tailed balloon; Thought = cloud with a trail of circles), WHO it belongs to (picked from a dropdown of the subject, the characters in this gag's cast, which an AI step reads from the scene when the gag is saved, shown read-only; the bubble stores the plain label, e.g. "mom", and a speaker saved earlier that is on none of those lists is kept as it is), and the exact text to letter (max 80 characters, soft warning at 60 — legibility drops with length). Text is token-capable ({NAME} etc.) and is whitespace-normalized on Save; what you see saved is exactly what the engine is asked to letter.

**How the AI sets it**

Moderator-authored, or proposed by the gag writer when the fact contains a literal quote — picking an idea fills these rows (draft-only; Save still applies).

**How it affects the render**

Each bubble compiles to one deterministic directive in the required SPEECH & THOUGHT BUBBLES section (stored order preserved, never de-duplicated or compressed). Bubbles always render; overlay/caption text stays excluded as ever.

Bubbles have their own prompt-budget pool: if the combined directives exceed it, Save fails with a bubble-specific error — shorten the text or remove a bubble. Nothing is silently dropped.

For a speaker other than the subject, the compiler opens the section with a short line tying the label to who they are in the picture, written from the gag's stored cast ("mom: the woman in the passenger seat.") — so the balloon has someone to point at even when the scene describes her without naming her.

A speaker with no cast entry renders its directive anyway, but the model may add, ignore, or misattribute that character — the preview shows a warning; confirm the render.

**Examples**

- **Scenario:** "When David left for college, he told his dad, 'You're the man of the house now.'"
  - **Input:** Speech bubble — entity "subject", text "You're the man of the house now."
  - **Outcome:** The render shows a clean comic-style balloon whose tail points to David, lettered with exactly that line — in every render mode and style.

**Sources**

- `lib/api-zod/src/visualStrategyOverride.ts` `visualPromptStrategyOverrideSchema` — The gag content's schema: field shapes, list caps and token canonicalization/validation on save.
- `artifacts/api-server/src/lib/imagePrompt/compilers/nanoBanana2.ts` `compileDirect` — The one compile entry point: a picture's prompt is the gag's scene, its bubbles and its cast plus fixed wording that is the same for every fact.
- `artifacts/api-server/src/lib/factRenderScenarios.ts` `renderAffectingEnrichment` — The render-input hash projection: it hashes only the gag's scene, bubbles and cast entries, so editing either flips render-scenario tiles stale.

### Moderator Intent (admin-only, not rendered)

*Retired. A note for humans about why you overrode; it never reached a prompt.*

- **Effect:** Human-only — never leaves the admin UI
- **Staleness:** Editing does not re-flag render scenarios.
- **Editor surface:** field-label

**What it is**

Retired. A note for humans about why you overrode; it never reached a prompt. It was one of the eleven "More art direction" controls that left the moderation screen and the pipeline when pictures started being drawn straight from the approved gag (plan docs/plans/PLAN_GAG_DIRECT_RENDER.md).

**How the AI sets it**

No longer accepted on save: a save carrying a value here is refused. Stored content keeps parsing, and any live value was folded into the gag's scene text first. Nothing reads it.

**How it affects the render**

None. A picture's prompt is built only from the approved gag's scene, its bubbles and its cast, plus fixed wording that is the same for every fact. This field is never read, and editing it never marks a render out of date.

**Examples**

- **Scenario:** You want what this field used to do for one gag.
  - **Input:** Say it in the gag's scene text.
  - **Outcome:** The scene reaches the prompt verbatim, so a detail written there is drawn; this retired field would have been ignored.

**Sources**

- `lib/api-zod/src/visualStrategyOverride.ts` `visualPromptStrategyOverrideSchema` — The gag content's schema: field shapes, list caps and token canonicalization/validation on save.
- `lib/api-zod/src/visualStrategyOverride.ts` `retiredArtDirectionFields` — Names the retired "More art direction" fields: a save carrying a value in any of them is refused, and stored values are never read.

### Subject Depiction Mode

*Retired. It used to pin how the subject was physically realized (human, transformed, object, symbolic).*

- **Effect:** Human-only — never leaves the admin UI
- **Staleness:** Editing does not re-flag render scenarios.
- **Editor surface:** field-label

**What it is**

Retired. It used to pin how the subject was physically realized (human, transformed, object, symbolic). It was one of the eleven "More art direction" controls that left the moderation screen and the pipeline when pictures started being drawn straight from the approved gag (plan docs/plans/PLAN_GAG_DIRECT_RENDER.md).

**How the AI sets it**

No longer accepted on save: a save carrying a value here is refused. Stored content keeps parsing, and any live value was folded into the gag's scene text first. Nothing reads it.

**How it affects the render**

None. A picture's prompt is built only from the approved gag's scene, its bubbles and its cast, plus fixed wording that is the same for every fact. This field is never read, and editing it never marks a render out of date.

**Values (8)**

- `use_ai_plan` — The old default — leave the subject's realization to the AI plan. There is no AI plan any more, so this is simply the state of every gag.
  - *Render:* Retired: no longer accepted on save and never read. Pictures are drawn only from the approved gag's scene, bubbles and cast, so this value changes nothing in the prompt. (Removed when pictures started being drawn straight from the gag; plan docs/plans/PLAN_GAG_DIRECT_RENDER.md.)
  - *Example:* Retired: say it in the gag's scene text instead.
- `normal_human` *(authored — verify)* — Pin the subject as an ordinary human at their normal age and form — no transformation, object-ification, or symbolism.
  - *Render:* Retired: no longer accepted on save and never read. Pictures are drawn only from the approved gag's scene, bubbles and cast, so this value changes nothing in the prompt. (Removed when pictures started being drawn straight from the gag; plan docs/plans/PLAN_GAG_DIRECT_RENDER.md.)
  - *Example:* Retired: say it in the gag's scene text instead.
- `age_transformed_human` *(authored — verify)* — The subject rendered as the SAME recognizable person at a different life stage (baby, child, elderly).
  - *Render:* Retired: no longer accepted on save and never read. Pictures are drawn only from the approved gag's scene, bubbles and cast, so this value changes nothing in the prompt. (Removed when pictures started being drawn straight from the gag; plan docs/plans/PLAN_GAG_DIRECT_RENDER.md.)
  - *Example:* Retired: say it in the gag's scene text instead.
- `adult_head_on_transformed_body` *(authored — verify)* — The deliberately absurd composite: the subject's recognizable adult head/face kept on a transformed (e.g. baby) body.
  - *Render:* Retired: no longer accepted on save and never read. Pictures are drawn only from the approved gag's scene, bubbles and cast, so this value changes nothing in the prompt. (Removed when pictures started being drawn straight from the gag; plan docs/plans/PLAN_GAG_DIRECT_RENDER.md.)
  - *Example:* Retired: say it in the gag's scene text instead.
- `subject_as_object` *(authored — verify)* — The subject realized as a THING — a statue, a mountain, a constellation, a product — rather than a figure in the scene.
  - *Render:* Retired: no longer accepted on save and never read. Pictures are drawn only from the approved gag's scene, bubbles and cast, so this value changes nothing in the prompt. (Removed when pictures started being drawn straight from the gag; plan docs/plans/PLAN_GAG_DIRECT_RENDER.md.)
  - *Example:* Retired: say it in the gag's scene text instead.
- `nonhuman_transformation` *(authored — verify)* — The subject transformed into a non-human being — an animal, a mythical creature, a force of nature.
  - *Render:* Retired: no longer accepted on save and never read. Pictures are drawn only from the approved gag's scene, bubbles and cast, so this value changes nothing in the prompt. (Removed when pictures started being drawn straight from the gag; plan docs/plans/PLAN_GAG_DIRECT_RENDER.md.)
  - *Example:* Retired: say it in the gag's scene text instead.
- `symbolic_or_implied` *(authored — verify)* — The subject is not literally shown — their presence is implied by evidence, symbols, or the scene's reaction to them.
  - *Render:* Retired: no longer accepted on save and never read. Pictures are drawn only from the approved gag's scene, bubbles and cast, so this value changes nothing in the prompt. (Removed when pictures started being drawn straight from the gag; plan docs/plans/PLAN_GAG_DIRECT_RENDER.md.)
  - *Example:* Retired: say it in the gag's scene text instead.
- `custom` *(authored — verify)* — None of the named modes fit — the description carries the entire realization spec.
  - *Render:* Retired: no longer accepted on save and never read. Pictures are drawn only from the approved gag's scene, bubbles and cast, so this value changes nothing in the prompt. (Removed when pictures started being drawn straight from the gag; plan docs/plans/PLAN_GAG_DIRECT_RENDER.md.)
  - *Example:* Retired: say it in the gag's scene text instead.

**Examples**

- **Scenario:** You want what this field used to do for one gag.
  - **Input:** Say it in the gag's scene text.
  - **Outcome:** The scene reaches the prompt verbatim, so a detail written there is drawn; this retired field would have been ignored.

**Sources**

- `lib/api-zod/src/visualStrategyOverride.ts` `visualPromptStrategyOverrideSchema` — The gag content's schema: field shapes, list caps and token canonicalization/validation on save.
- `lib/api-zod/src/visualStrategyOverride.ts` `retiredArtDirectionFields` — Names the retired "More art direction" fields: a save carrying a value in any of them is refused, and stored values are never read.

### Subject Depiction Description

*Retired. It used to be the text of the SUBJECT REALIZATION prompt section.*

- **Effect:** Human-only — never leaves the admin UI
- **Staleness:** Editing does not re-flag render scenarios.
- **Editor surface:** field-label

**What it is**

Retired. It used to be the text of the SUBJECT REALIZATION prompt section. It was one of the eleven "More art direction" controls that left the moderation screen and the pipeline when pictures started being drawn straight from the approved gag (plan docs/plans/PLAN_GAG_DIRECT_RENDER.md).

**How the AI sets it**

No longer accepted on save: a save carrying a value here is refused. Stored content keeps parsing, and any live value was folded into the gag's scene text first. Nothing reads it.

**How it affects the render**

None. A picture's prompt is built only from the approved gag's scene, its bubbles and its cast, plus fixed wording that is the same for every fact. This field is never read, and editing it never marks a render out of date.

**Examples**

- **Scenario:** You want what this field used to do for one gag.
  - **Input:** Say it in the gag's scene text.
  - **Outcome:** The scene reaches the prompt verbatim, so a detail written there is drawn; this retired field would have been ignored.

**Sources**

- `lib/api-zod/src/visualStrategyOverride.ts` `visualPromptStrategyOverrideSchema` — The gag content's schema: field shapes, list caps and token canonicalization/validation on save.
- `lib/api-zod/src/visualStrategyOverride.ts` `retiredArtDirectionFields` — Names the retired "More art direction" fields: a save carrying a value in any of them is refused, and stored values are never read.

### Required Visual Details

*Retired. It used to list details every render had to show.*

- **Effect:** Human-only — never leaves the admin UI
- **Staleness:** Editing does not re-flag render scenarios.
- **Editor surface:** field-label

**What it is**

Retired. It used to list details every render had to show. It was one of the eleven "More art direction" controls that left the moderation screen and the pipeline when pictures started being drawn straight from the approved gag (plan docs/plans/PLAN_GAG_DIRECT_RENDER.md).

**How the AI sets it**

No longer accepted on save: a save carrying a value here is refused. Stored content keeps parsing, and any live value was folded into the gag's scene text first. Nothing reads it.

**How it affects the render**

None. A picture's prompt is built only from the approved gag's scene, its bubbles and its cast, plus fixed wording that is the same for every fact. This field is never read, and editing it never marks a render out of date.

**Examples**

- **Scenario:** You want what this field used to do for one gag.
  - **Input:** Say it in the gag's scene text.
  - **Outcome:** The scene reaches the prompt verbatim, so a detail written there is drawn; this retired field would have been ignored.

**Sources**

- `lib/api-zod/src/visualStrategyOverride.ts` `visualPromptStrategyOverrideSchema` — The gag content's schema: field shapes, list caps and token canonicalization/validation on save.
- `lib/api-zod/src/visualStrategyOverride.ts` `retiredArtDirectionFields` — Names the retired "More art direction" fields: a save carrying a value in any of them is refused, and stored values are never read.

### Forbidden Visual Details

*Retired. It used to list details every render had to avoid.*

- **Effect:** Human-only — never leaves the admin UI
- **Staleness:** Editing does not re-flag render scenarios.
- **Editor surface:** field-label

**What it is**

Retired. It used to list details every render had to avoid. It was one of the eleven "More art direction" controls that left the moderation screen and the pipeline when pictures started being drawn straight from the approved gag (plan docs/plans/PLAN_GAG_DIRECT_RENDER.md).

**How the AI sets it**

No longer accepted on save: a save carrying a value here is refused. Stored content keeps parsing, and any live value was folded into the gag's scene text first. Nothing reads it.

**How it affects the render**

None. A picture's prompt is built only from the approved gag's scene, its bubbles and its cast, plus fixed wording that is the same for every fact. This field is never read, and editing it never marks a render out of date.

**Examples**

- **Scenario:** You want what this field used to do for one gag.
  - **Input:** Say it in the gag's scene text.
  - **Outcome:** The scene reaches the prompt verbatim, so a detail written there is drawn; this retired field would have been ignored.

**Sources**

- `lib/api-zod/src/visualStrategyOverride.ts` `visualPromptStrategyOverrideSchema` — The gag content's schema: field shapes, list caps and token canonicalization/validation on save.
- `lib/api-zod/src/visualStrategyOverride.ts` `retiredArtDirectionFields` — Names the retired "More art direction" fields: a save carrying a value in any of them is refused, and stored values are never read.

### Scene Role Assignments

*Retired. It used to say who was who among the secondary characters; the gag's cast now does this job, read from the scene when the gag is saved.*

- **Effect:** Human-only — never leaves the admin UI
- **Staleness:** Editing does not re-flag render scenarios.
- **Editor surface:** field-label

**What it is**

Retired. It used to say who was who among the secondary characters; the gag's cast now does this job, read from the scene when the gag is saved. It was one of the eleven "More art direction" controls that left the moderation screen and the pipeline when pictures started being drawn straight from the approved gag (plan docs/plans/PLAN_GAG_DIRECT_RENDER.md).

**How the AI sets it**

No longer accepted on save: a save carrying a value here is refused. Stored content keeps parsing, and any live value was folded into the gag's scene text first. Nothing reads it.

**How it affects the render**

None. A picture's prompt is built only from the approved gag's scene, its bubbles and its cast, plus fixed wording that is the same for every fact. This field is never read, and editing it never marks a render out of date.

**Examples**

- **Scenario:** You want what this field used to do for one gag.
  - **Input:** Say it in the gag's scene text.
  - **Outcome:** The scene reaches the prompt verbatim, so a detail written there is drawn; this retired field would have been ignored.

**Sources**

- `lib/api-zod/src/visualStrategyOverride.ts` `visualPromptStrategyOverrideSchema` — The gag content's schema: field shapes, list caps and token canonicalization/validation on save.
- `lib/api-zod/src/visualStrategyOverride.ts` `retiredArtDirectionFields` — Names the retired "More art direction" fields: a save carrying a value in any of them is refused, and stored values are never read.

### Composition Guidance

*Retired. It used to add framing and camera advice to the COMPOSITION section.*

- **Effect:** Human-only — never leaves the admin UI
- **Staleness:** Editing does not re-flag render scenarios.
- **Editor surface:** field-label

**What it is**

Retired. It used to add framing and camera advice to the COMPOSITION section. It was one of the eleven "More art direction" controls that left the moderation screen and the pipeline when pictures started being drawn straight from the approved gag (plan docs/plans/PLAN_GAG_DIRECT_RENDER.md).

**How the AI sets it**

No longer accepted on save: a save carrying a value here is refused. Stored content keeps parsing, and any live value was folded into the gag's scene text first. Nothing reads it.

**How it affects the render**

None. A picture's prompt is built only from the approved gag's scene, its bubbles and its cast, plus fixed wording that is the same for every fact. This field is never read, and editing it never marks a render out of date.

**Examples**

- **Scenario:** You want what this field used to do for one gag.
  - **Input:** Say it in the gag's scene text.
  - **Outcome:** The scene reaches the prompt verbatim, so a detail written there is drawn; this retired field would have been ignored.

**Sources**

- `lib/api-zod/src/visualStrategyOverride.ts` `visualPromptStrategyOverrideSchema` — The gag content's schema: field shapes, list caps and token canonicalization/validation on save.
- `lib/api-zod/src/visualStrategyOverride.ts` `retiredArtDirectionFields` — Names the retired "More art direction" fields: a save carrying a value in any of them is refused, and stored values are never read.

### Extra Prompt Details (any style)

*Retired. It used to add extra detail lines to the prompt.*

- **Effect:** Human-only — never leaves the admin UI
- **Staleness:** Editing does not re-flag render scenarios.
- **Editor surface:** field-label

**What it is**

Retired. It used to add extra detail lines to the prompt. It was one of the eleven "More art direction" controls that left the moderation screen and the pipeline when pictures started being drawn straight from the approved gag (plan docs/plans/PLAN_GAG_DIRECT_RENDER.md).

**How the AI sets it**

No longer accepted on save: a save carrying a value here is refused. Stored content keeps parsing, and any live value was folded into the gag's scene text first. Nothing reads it.

**How it affects the render**

None. A picture's prompt is built only from the approved gag's scene, its bubbles and its cast, plus fixed wording that is the same for every fact. This field is never read, and editing it never marks a render out of date.

**Examples**

- **Scenario:** You want what this field used to do for one gag.
  - **Input:** Say it in the gag's scene text.
  - **Outcome:** The scene reaches the prompt verbatim, so a detail written there is drawn; this retired field would have been ignored.

**Sources**

- `lib/api-zod/src/visualStrategyOverride.ts` `visualPromptStrategyOverrideSchema` — The gag content's schema: field shapes, list caps and token canonicalization/validation on save.
- `lib/api-zod/src/visualStrategyOverride.ts` `retiredArtDirectionFields` — Names the retired "More art direction" fields: a save carrying a value in any of them is refused, and stored values are never read.

### Do-Not-Render Additions

*Retired. It used to add 'do not draw' lines to the strict constraints.*

- **Effect:** Human-only — never leaves the admin UI
- **Staleness:** Editing does not re-flag render scenarios.
- **Editor surface:** field-label

**What it is**

Retired. It used to add 'do not draw' lines to the strict constraints. It was one of the eleven "More art direction" controls that left the moderation screen and the pipeline when pictures started being drawn straight from the approved gag (plan docs/plans/PLAN_GAG_DIRECT_RENDER.md).

**How the AI sets it**

No longer accepted on save: a save carrying a value here is refused. Stored content keeps parsing, and any live value was folded into the gag's scene text first. Nothing reads it.

**How it affects the render**

None. A picture's prompt is built only from the approved gag's scene, its bubbles and its cast, plus fixed wording that is the same for every fact. This field is never read, and editing it never marks a render out of date.

**Examples**

- **Scenario:** You want what this field used to do for one gag.
  - **Input:** Say it in the gag's scene text.
  - **Outcome:** The scene reaches the prompt verbatim, so a detail written there is drawn; this retired field would have been ignored.

**Sources**

- `lib/api-zod/src/visualStrategyOverride.ts` `visualPromptStrategyOverrideSchema` — The gag content's schema: field shapes, list caps and token canonicalization/validation on save.
- `lib/api-zod/src/visualStrategyOverride.ts` `retiredArtDirectionFields` — Names the retired "More art direction" fields: a save carrying a value in any of them is refused, and stored values are never read.

### Override supporting-text policy

*Retired. It used to override the policy for readable in-scene text; the prompt now carries fixed text rules for every picture.*

- **Effect:** Human-only — never leaves the admin UI
- **Staleness:** Editing does not re-flag render scenarios.
- **Editor surface:** field-label

**What it is**

Retired. It used to override the policy for readable in-scene text; the prompt now carries fixed text rules for every picture. It was one of the eleven "More art direction" controls that left the moderation screen and the pipeline when pictures started being drawn straight from the approved gag (plan docs/plans/PLAN_GAG_DIRECT_RENDER.md).

**How the AI sets it**

No longer accepted on save: a save carrying a value here is refused. Stored content keeps parsing, and any live value was folded into the gag's scene text first. Nothing reads it.

**How it affects the render**

None. A picture's prompt is built only from the approved gag's scene, its bubbles and its cast, plus fixed wording that is the same for every fact. This field is never read, and editing it never marks a render out of date.

**Values (3)**

- `allow` — In-world readable text (signs, TV titles, scoreboards, documents) is permitted but not requested.
  - *Render:* Retired: no longer accepted on save and never read. Pictures are drawn only from the approved gag's scene, bubbles and cast, so this value changes nothing in the prompt. (Removed when pictures started being drawn straight from the gag; plan docs/plans/PLAN_GAG_DIRECT_RENDER.md.)
  - *Example:* Retired: say it in the gag's scene text instead.
- `forbid` — In-world readable text should be avoided in this scene.
  - *Render:* Retired: no longer accepted on save and never read. Pictures are drawn only from the approved gag's scene, bubbles and cast, so this value changes nothing in the prompt. (Removed when pictures started being drawn straight from the gag; plan docs/plans/PLAN_GAG_DIRECT_RENDER.md.)
  - *Example:* Retired: say it in the gag's scene text instead.
- `require` — The joke NEEDS readable in-world text (a title card, a scoreboard, a headline) — make the engine show it.
  - *Render:* Retired: no longer accepted on save and never read. Pictures are drawn only from the approved gag's scene, bubbles and cast, so this value changes nothing in the prompt. (Removed when pictures started being drawn straight from the gag; plan docs/plans/PLAN_GAG_DIRECT_RENDER.md.)
  - *Example:* Retired: say it in the gag's scene text instead.

**Examples**

- **Scenario:** You want what this field used to do for one gag.
  - **Input:** Say it in the gag's scene text.
  - **Outcome:** The scene reaches the prompt verbatim, so a detail written there is drawn; this retired field would have been ignored.

**Sources**

- `lib/api-zod/src/visualStrategyOverride.ts` `visualPromptStrategyOverrideSchema` — The gag content's schema: field shapes, list caps and token canonicalization/validation on save.
- `lib/api-zod/src/visualStrategyOverride.ts` `retiredArtDirectionFields` — Names the retired "More art direction" fields: a save carrying a value in any of them is refused, and stored values are never read.

### Override violence policy

*Retired. It used to soften or suppress violence per fact; every picture now carries the one fixed violence sentence.*

- **Effect:** Human-only — never leaves the admin UI
- **Staleness:** Editing does not re-flag render scenarios.
- **Editor surface:** field-label

**What it is**

Retired. It used to soften or suppress violence per fact; every picture now carries the one fixed violence sentence. It was one of the eleven "More art direction" controls that left the moderation screen and the pipeline when pictures started being drawn straight from the approved gag (plan docs/plans/PLAN_GAG_DIRECT_RENDER.md).

**How the AI sets it**

No longer accepted on save: a save carrying a value here is refused. Stored content keeps parsing, and any live value was folded into the gag's scene text first. Nothing reads it.

**How it affects the render**

None. A picture's prompt is built only from the approved gag's scene, its bubbles and its cast, plus fixed wording that is the same for every fact. This field is never read, and editing it never marks a render out of date.

**Values (8)**

- `allow` — The old default — depict the violence/consequences the fact requires, without gratuitous gore. Every picture now carries one fixed sentence saying much the same.
  - *Render:* Retired: no longer accepted on save and never read. Pictures are drawn only from the approved gag's scene, bubbles and cast, so this value changes nothing in the prompt. (Removed when pictures started being drawn straight from the gag; plan docs/plans/PLAN_GAG_DIRECT_RENDER.md.)
  - *Example:* Retired: say it in the gag's scene text instead.
- `soften` — Deliberately reduce explicit violent consequences while keeping the action.
  - *Render:* Retired: no longer accepted on save and never read. Pictures are drawn only from the approved gag's scene, bubbles and cast, so this value changes nothing in the prompt. (Removed when pictures started being drawn straight from the gag; plan docs/plans/PLAN_GAG_DIRECT_RENDER.md.)
  - *Example:* Retired: say it in the gag's scene text instead.
- `suppress` — Deliberately avoid depicting violence at all — consequences become symbolic/environmental.
  - *Render:* Retired: no longer accepted on save and never read. Pictures are drawn only from the approved gag's scene, bubbles and cast, so this value changes nothing in the prompt. (Removed when pictures started being drawn straight from the gag; plan docs/plans/PLAN_GAG_DIRECT_RENDER.md.)
  - *Example:* Retired: say it in the gag's scene text instead.
- `nonviolent` *(authored — verify)* — No violent content at all — the scene should carry zero violence even under an allow mode.
  - *Render:* Retired: no longer accepted on save and never read. Pictures are drawn only from the approved gag's scene, bubbles and cast, so this value changes nothing in the prompt. (Removed when pictures started being drawn straight from the gag; plan docs/plans/PLAN_GAG_DIRECT_RENDER.md.)
  - *Example:* Retired: say it in the gag's scene text instead.
- `mild` *(authored — verify)* — Cartoon-level, consequence-light action — impacts and tumbles without injury.
  - *Render:* Retired: no longer accepted on save and never read. Pictures are drawn only from the approved gag's scene, bubbles and cast, so this value changes nothing in the prompt. (Removed when pictures started being drawn straight from the gag; plan docs/plans/PLAN_GAG_DIRECT_RENDER.md.)
  - *Example:* Retired: say it in the gag's scene text instead.
- `moderate` *(authored — verify)* — Real action-movie consequences implied — destruction and danger, but no explicit casualties.
  - *Render:* Retired: no longer accepted on save and never read. Pictures are drawn only from the approved gag's scene, bubbles and cast, so this value changes nothing in the prompt. (Removed when pictures started being drawn straight from the gag; plan docs/plans/PLAN_GAG_DIRECT_RENDER.md.)
  - *Example:* Retired: say it in the gag's scene text instead.
- `strong` — The old default. Per the code comment: the default was "strong" (visible death, bodies, explosions, weapons, action aftermath, without gratuitous gore).
  - *Render:* Retired: no longer accepted on save and never read. Pictures are drawn only from the approved gag's scene, bubbles and cast, so this value changes nothing in the prompt. (Removed when pictures started being drawn straight from the gag; plan docs/plans/PLAN_GAG_DIRECT_RENDER.md.)
  - *Example:* Retired: say it in the gag's scene text instead.
- `graphic` — Per the code comment: "graphic" is FUTURE-COMPATIBLE only (a future adult/NSFW mode may use it). It is never selected or encouraged by default.
  - *Render:* Retired: no longer accepted on save and never read. Pictures are drawn only from the approved gag's scene, bubbles and cast, so this value changes nothing in the prompt. (Removed when pictures started being drawn straight from the gag; plan docs/plans/PLAN_GAG_DIRECT_RENDER.md.)
  - *Example:* Retired: say it in the gag's scene text instead.

**Examples**

- **Scenario:** You want what this field used to do for one gag.
  - **Input:** Say it in the gag's scene text.
  - **Outcome:** The scene reaches the prompt verbatim, so a detail written there is drawn; this retired field would have been ignored.

**Sources**

- `lib/api-zod/src/visualStrategyOverride.ts` `visualPromptStrategyOverrideSchema` — The gag content's schema: field shapes, list caps and token canonicalization/validation on save.
- `lib/api-zod/src/visualStrategyOverride.ts` `retiredArtDirectionFields` — Names the retired "More art direction" fields: a save carrying a value in any of them is refused, and stored values are never read.
- `artifacts/api-server/src/lib/imagePrompt/violenceRule.ts` `VIOLENCE_RULE` — The one fixed violence sentence every picture's prompt carries; no setting changes it.

## References & Scene Entities

### Cultural / Inside References

*Outside-context dependencies the joke relies on — told to the gag writer as WHAT THE REFERENCES MEAN, with a materiality gate deciding which it states as settled.*

- **Effect:** Advisory only — read by the gag writer, never by the picture prompt
- **Staleness:** Editing does not re-flag render scenarios.
- **Editor surface:** section-level

**What it is**

The list of outside-context dependencies detected during enrichment: knowledge the joke relies on that isn't obvious from the literal words — a brand, a workplace/professional context, an idiom, wordplay, mechanism knowledge, or an inside reference. A fact with no such dependency has an empty list (there is deliberately no 'none' type).

Each row is fully editable, and the per-row 'Research Reference' tool can verify a reference and stamp research metadata (researchConfidence, sources, notes, ambiguity warnings) that both the admin and the gag writer's materiality check see.

References inform the gag writer how the joke works; they never change the archetype/subtype — the taxonomy classifies the mechanism, references flesh out the meaning. They do not reach the picture prompt directly.

**How the AI sets it**

The classifier emits them under its cultural-reference rules, with the canonical worked examples: "Sharks have a {NAME} Week" → cultural_reference 'Shark Week' (visual implication: sharks are the audience watching the subject as spectacle); the Yardi demo fact → workplace/professional_domain_context; the magnifying-glass-at-night fact → mechanism_knowledge.

**How it affects the render**

Every reference is listed in the gag writer's message under WHAT THE REFERENCES MEAN as `"sourcePhrase" refers to canonicalReference: explanation Visually: visualImplication`. The MATERIALITY GATE (isMaterialCulturalReference): a reference is material when researchConfidence is "high", OR confidence ≥ 0.8 AND it is not flagged for admin review. A non-material reference is still listed, marked "(tentative)" — it may be wrong.

Nothing is forced into a picture. The render-time planner that force-echoed material references into the visual plan, and the compiler gap-fill that guaranteed their visual implication reached the prompt, were removed when pictures started being drawn straight from the gag (plan docs/plans/PLAN_GAG_DIRECT_RENDER.md). The moderator-approved gag decides what is drawn.

Reference text never goes into a picture prompt: the prompt is built only from the approved gag, plus fixed wording that excludes logos and brand marks. Only the gag writer reads these rows.

The whole collection is in the gag writer's freshness check, so editing any row marks the stored gag ideas out of date. It is not in the render-input hash and never marks a render out of date.

Pipeline: the classifier detects → the gag writer is told the meanings when it drafts gag ideas → a moderator approves a gag → the picture is drawn from that gag alone (no classification field reaches the picture prompt).

**Examples**

- **Scenario:** "Sharks have a {NAME} Week." — confidence 0.9, not flagged.
  - **Input:** cultural_reference, canonical "Shark Week", visualImplication "sharks are the audience watching the subject as spectacle"
  - **Outcome:** Material → the gag writer states it as settled, so its ideas can use sharks-as-audience; the words 'Shark Week'/'Discovery Channel' reach a picture only if the approved gag's scene contains them.
- **Scenario:** "{NAME} can set an ant on fire with a magnifying glass. At night." — mechanism_knowledge.
  - **Input:** visualImplication: "a magnifying glass focusing a beam under a starry night sky — the impossible part"
  - **Outcome:** The gag writer is told the night-beam visual, so its ideas can make the mechanism-defiance read.
- **Scenario:** A brand reference at confidence 0.6 with requiresAdminReview=true.
  - **Input:** (unchanged, unresearched)
  - **Outcome:** NOT material: the gag writer still sees it, marked (tentative). Running Research Reference to high confidence makes it material.

**Sources**

- `artifacts/api-server/src/lib/factEnrichmentConfig.ts` `FACT_ENRICHMENT_SYSTEM_DEFAULT` — The classifier system prompt — the cultural-reference and semantic-entity/capitalization rules plus their worked examples.
- `lib/api-zod/src/taxonomy.ts` `culturalReferenceSchema` — The reference/entity schemas: field shapes, max lengths, and the research-metadata fields.
- `artifacts/api-server/src/lib/visualConcepts/generator.ts` `buildVisualConceptsUserMessage` — Where references and material entities reach anything: the WHAT THE REFERENCES MEAN block of the gag writer's message. No picture prompt reads them.
- `artifacts/api-server/src/lib/visualConcepts/generator.ts` `isMaterialCulturalReference` — A reference is material when researchConfidence === "high", OR confidence >= 0.8 and it is not flagged for admin review; a non-material one is shown to the gag writer as "(tentative)".
- `artifacts/api-server/src/lib/visualConcepts/inputHash.ts` `writerAffectingEnrichment` — The gag writer's freshness projection: it includes culturalReferences and semanticEntities wholesale, so editing a row marks stored gag ideas out of date. It is not a render hash.

### Source phrase

*The literal phrase in the fact that triggers the reference.*

- **Effect:** Advisory only — read by the gag writer, never by the picture prompt
- **Staleness:** Editing does not re-flag render scenarios.
- **Editor surface:** reserved

**What it is**

The verbatim word/phrase in the fact text that carries the reference (max 300 chars). It is the quoted phrase at the start of the reference's line in the gag writer's message.

**How the AI sets it**

The classifier quotes it from the fact; editable for manual-fill workflows.

**How it affects the render**

Shown to the gag writer as the quoted phrase its reference line starts with.

**Examples**

- **Scenario:** "Sharks have a {NAME} Week."
  - **Input:** sourcePhrase: "{NAME} Week"
  - **Outcome:** The gag writer's line reads: "{NAME} Week" refers to … — so it knows which words carry the reference.

**Sources**

- `lib/api-zod/src/taxonomy.ts` `culturalReferenceSchema` — The reference/entity schemas: field shapes, max lengths, and the research-metadata fields.
- `artifacts/api-server/src/lib/visualConcepts/inputHash.ts` `writerAffectingEnrichment` — The gag writer's freshness projection: it includes culturalReferences and semanticEntities wholesale, so editing a row marks stored gag ideas out of date. It is not a render hash.

### Reference type

*What KIND of outside-context dependency this is.*

- **Effect:** Advisory only — read by the gag writer, never by the picture prompt
- **Staleness:** Editing does not re-flag render scenarios.
- **Editor surface:** repeater-enum

**What it is**

An eight-way categorization of the dependency (see the per-value docs). There is intentionally no 'none' value — a fact without references has an empty list instead.

**How the AI sets it**

Chosen by the classifier per its rules; the canonical examples map Shark Week → cultural_reference, Yardi → workplace/professional_domain_context, the night magnifying glass → mechanism_knowledge.

**How it affects the render**

Not shown to the gag writer and not read by the picture — it labels the dependency for admins. The materiality gate doesn't branch on type, though brand/workplace types usually arrive with requiresAdminReview=true (which does affect materiality).

**Values (8)**

- `cultural_reference` — The joke leans on a shared cultural artifact or phenomenon — a TV show, event, meme, tradition — that isn't named literally.
  - *Render:* The gag writer is shown the reference and its visual implication under WHAT THE REFERENCES MEAN, so its ideas can use it. The type itself is not shown, and nothing reaches the picture except through the approved gag.
  - *Example:* "Sharks have a {NAME} Week" → cultural_reference, canonical "Shark Week" — sharks become the audience watching the subject as spectacle.
- `brand_reference` — The joke depends on a real brand or company ("Victoria's Secret", "Apple") — typically also flagged requiresAdminReview.
  - *Render:* The gag writer is shown the brand and its visual implication. The picture prompt never receives the brand: it is drawn only from the approved gag, and every prompt excludes logos and brand marks.
  - *Example:* A "{NAME}'s secret" wordplay on Victoria's Secret → the scene gets the runway-glamour implication, no logo.
- `workplace_context` — The joke needs knowledge of a specific workplace or company context the audience shares.
  - *Render:* Gag writer context: its ideas can be staged inside the implied workplace world; usually requiresAdminReview (real workplace), which makes the reference tentative for the writer.
  - *Example:* "{NAME} doesn't prepare for demos, demos prepare for {NAME}. #Yardi" → the Yardi/SaaS-presales demo context.
- `professional_domain_context` — The joke needs domain-professional knowledge (how presales demos, courtrooms, or trading floors work) rather than a specific employer.
  - *Render:* Gag writer context: its ideas can borrow the domain's recognizable staging (demo screens, gavels, tickers) so the joke reads.
  - *Example:* The same Yardi demo fact classified for its presales-demo domain rather than the employer per se.
- `idiom_or_phrase` — The joke reuses a familiar phrase, idiom, or saying whose recognition is the hook.
  - *Render:* Gag writer context: the visual implication usually literalizes the idiom; there may be no canonicalReference (empty is allowed).
  - *Example:* "{NAME}'s handshake seals deals" riffing on "seal the deal" → a literal wax seal in the scene.
- `wordplay` — The joke's hook is a pun or double meaning in the words themselves.
  - *Render:* Gag writer context: a good gag typically needs BOTH meanings visible for the pun to land — the visual implication should say how.
  - *Example:* A "{NAME} raised the bar" fact → a literal bar being physically raised in a gym.
- `mechanism_knowledge` — The joke depends on knowing how something normally works, so the impossibility registers.
  - *Render:* Gag writer context: a good gag shows the mechanism being defied clearly enough that a viewer who knows it gets the joke.
  - *Example:* "{NAME} can set an ant on fire with a magnifying glass. At night." → magnifying glasses focus SUNlight; nighttime breaks the mechanism.
- `inside_reference` — The joke references something only a specific in-group (a friend circle, a team, a community) will recognize.
  - *Render:* Gag writer context: often low-confidence and requiresAdminReview — the AI can't verify an inside joke, so the writer is told it is tentative and a human should confirm the implication.
  - *Example:* A fact riffing on a submitter's group chat catchphrase — flagged for review because the AI is guessing at the referent.

**Examples**

- **Scenario:** The Yardi demo fact.
  - **Input:** referenceType: professional_domain_context
  - **Outcome:** Recorded as a label only; the gag writer sees the reference's explanation and visual implication, not the type.

**Sources**

- `artifacts/api-server/src/lib/factEnrichmentConfig.ts` `FACT_ENRICHMENT_SYSTEM_DEFAULT` — The classifier system prompt — the cultural-reference and semantic-entity/capitalization rules plus their worked examples.
- `lib/api-zod/src/taxonomy.ts` `culturalReferenceSchema` — The reference/entity schemas: field shapes, max lengths, and the research-metadata fields.
- `artifacts/api-server/src/lib/visualConcepts/inputHash.ts` `writerAffectingEnrichment` — The gag writer's freshness projection: it includes culturalReferences and semanticEntities wholesale, so editing a row marks stored gag ideas out of date. It is not a render hash.

### Canonical reference

*The reference's canonical name — read by the gag writer; never part of a picture prompt.*

- **Effect:** Advisory only — read by the gag writer, never by the picture prompt
- **Staleness:** Editing does not re-flag render scenarios.
- **Editor surface:** reserved

**What it is**

May be empty when no single canonical name exists (common for idioms). It appears in the gag writer's reference line as what the phrase refers to.

**How the AI sets it**

Named by the classifier; the Research Reference tool corrects/confirms it.

**How it affects the render**

Read by the gag writer ("… refers to canonicalReference …"), and deliberately never part of a picture prompt, which is built only from the approved gag. Brand names reach a picture only if the gag's scene says them, and logos and brand marks are always excluded.

**Examples**

- **Scenario:** Shark Week reference on a live render.
  - **Input:** canonicalReference: "Shark Week"
  - **Outcome:** The gag writer knows exactly which phenomenon is meant; the picture prompt contains sharks-as-audience visuals only if the approved gag's scene does.

**Sources**

- `lib/api-zod/src/taxonomy.ts` `culturalReferenceSchema` — The reference/entity schemas: field shapes, max lengths, and the research-metadata fields.
- `artifacts/api-server/src/lib/visualConcepts/generator.ts` `buildVisualConceptsUserMessage` — Where references and material entities reach anything: the WHAT THE REFERENCES MEAN block of the gag writer's message. No picture prompt reads them.
- `artifacts/api-server/src/lib/visualConcepts/inputHash.ts` `writerAffectingEnrichment` — The gag writer's freshness projection: it includes culturalReferences and semanticEntities wholesale, so editing a row marks stored gag ideas out of date. It is not a render hash.

### Explanation

*The plain-language joke mechanism the reference enables — read by the gag writer, never part of a picture prompt.*

- **Effect:** Advisory only — read by the gag writer, never by the picture prompt
- **Staleness:** Editing does not re-flag render scenarios.
- **Editor surface:** reserved

**What it is**

A plain-language explanation of how the reference makes the joke work (max 800 chars).

**How the AI sets it**

Written by the classifier; directly editable per the admin workflow.

**How it affects the render**

Read by the gag writer (it follows the reference in the writer's message), but never part of a picture prompt — an 'explaining the joke' line is meta-instruction the image engine can't use.

**Examples**

- **Scenario:** The magnifying-glass fact.
  - **Input:** explanation: "Magnifying glasses need sunlight to burn; doing it at night is the impossibility."
  - **Outcome:** The gag writer sees why the mechanism-defiance is funny; the sentence itself never reaches the picture prompt.

**Sources**

- `lib/api-zod/src/taxonomy.ts` `culturalReferenceSchema` — The reference/entity schemas: field shapes, max lengths, and the research-metadata fields.
- `artifacts/api-server/src/lib/visualConcepts/generator.ts` `buildVisualConceptsUserMessage` — Where references and material entities reach anything: the WHAT THE REFERENCES MEAN block of the gag writer's message. No picture prompt reads them.
- `artifacts/api-server/src/lib/visualConcepts/inputHash.ts` `writerAffectingEnrichment` — The gag writer's freshness projection: it includes culturalReferences and semanticEntities wholesale, so editing a row marks stored gag ideas out of date. It is not a render hash.

### Visual implication

*THE load-bearing field: how the reference should change the scene — shown to the gag writer after "Visually:".*

- **Effect:** Advisory only — read by the gag writer, never by the picture prompt
- **Staleness:** Editing does not re-flag render scenarios.
- **Editor surface:** reserved

**What it is**

the gag writer reads it as the visual consequence of the reference. It reaches a picture only if the approved gag's scene carries it.

**How the AI sets it**

Written by the classifier and refined by admins/research — the single most render-worthy edit in a reference row.

**How it affects the render**

Shown to the gag writer after "Visually:" in its reference line. It is not put into any picture prompt and nothing gap-fills it: the render-time planner and the compiler's gap-fill were removed when pictures started being drawn straight from the gag.

**Examples**

- **Scenario:** Shark Week reference.
  - **Input:** visualImplication: "sharks are the audience watching the subject as spectacle"
  - **Outcome:** The gag writer's ideas can stage sharks on couches watching TV; whether the picture shows it depends on the approved gag.
- **Scenario:** A vague implication.
  - **Input:** visualImplication: "make it feel like the TV event"
  - **Outcome:** Weak — nothing concrete for the gag writer to stage. Rewrite it as a visible thing a gag can contain.

**Sources**

- `lib/api-zod/src/taxonomy.ts` `culturalReferenceSchema` — The reference/entity schemas: field shapes, max lengths, and the research-metadata fields.
- `artifacts/api-server/src/lib/visualConcepts/generator.ts` `buildVisualConceptsUserMessage` — Where references and material entities reach anything: the WHAT THE REFERENCES MEAN block of the gag writer's message. No picture prompt reads them.
- `artifacts/api-server/src/lib/visualConcepts/inputHash.ts` `writerAffectingEnrichment` — The gag writer's freshness projection: it includes culturalReferences and semanticEntities wholesale, so editing a row marks stored gag ideas out of date. It is not a render hash.

### Confidence

*0–1: how confident the AI is that this reference is the joke's actual hook — half of the materiality gate.*

- **Effect:** Advisory only — read by the gag writer, never by the picture prompt
- **Staleness:** Editing does not re-flag render scenarios.
- **Editor surface:** reserved

**What it is**

The classifier's 0–1 confidence that the reference is the joke's real hook. Editable — raising or lowering it directly moves the reference across the materiality threshold.

**How the AI sets it**

Emitted by the classifier per reference; admins adjust it when they know better.

**How it affects the render**

Materiality gate input: confidence ≥ 0.8 (with requiresAdminReview false) makes the reference material — the gag writer states it as settled. Below the bar (unless researchConfidence is high) it is listed as (tentative).

**Examples**

- **Scenario:** A correct reference sitting at 0.7.
  - **Input:** You raise confidence to 0.9 (review unchecked).
  - **Outcome:** It crosses the gate: the gag writer now states it as settled instead of marking it tentative.

**Sources**

- `lib/api-zod/src/taxonomy.ts` `culturalReferenceSchema` — The reference/entity schemas: field shapes, max lengths, and the research-metadata fields.
- `artifacts/api-server/src/lib/visualConcepts/generator.ts` `isMaterialCulturalReference` — A reference is material when researchConfidence === "high", OR confidence >= 0.8 and it is not flagged for admin review; a non-material one is shown to the gag writer as "(tentative)".
- `artifacts/api-server/src/lib/visualConcepts/inputHash.ts` `writerAffectingEnrichment` — The gag writer's freshness projection: it includes culturalReferences and semanticEntities wholesale, so editing a row marks stored gag ideas out of date. It is not a render hash.

### Requires admin review

*Human sanity-check flag — while set, the gag writer is told the reference is tentative (unless research verified it).*

- **Effect:** Advisory only — read by the gag writer, never by the picture prompt
- **Staleness:** Editing does not re-flag render scenarios.
- **Editor surface:** reserved

**What it is**

Set true by the classifier when the reference touches a real brand, workplace, or professional context, or is otherwise ambiguous and worth a human check.

**How the AI sets it**

Classifier-set per its rules; you uncheck it once you've confirmed the reference.

**How it affects the render**

It blocks materiality: a flagged reference is listed as (tentative) regardless of confidence — EXCEPT when researchConfidence is "high" (verified research overrides the flag). Unchecking it (with confidence ≥ 0.8) makes the reference material.

**Examples**

- **Scenario:** A Yardi workplace reference, confidence 0.85, flagged for review.
  - **Input:** You confirm it and uncheck the box.
  - **Outcome:** The reference becomes material — the gag writer states it as settled.

**Sources**

- `artifacts/api-server/src/lib/factEnrichmentConfig.ts` `FACT_ENRICHMENT_SYSTEM_DEFAULT` — The classifier system prompt — the cultural-reference and semantic-entity/capitalization rules plus their worked examples.
- `artifacts/api-server/src/lib/visualConcepts/generator.ts` `isMaterialCulturalReference` — A reference is material when researchConfidence === "high", OR confidence >= 0.8 and it is not flagged for admin review; a non-material one is shown to the gag writer as "(tentative)".
- `artifacts/api-server/src/lib/visualConcepts/inputHash.ts` `writerAffectingEnrichment` — The gag writer's freshness projection: it includes culturalReferences and semanticEntities wholesale, so editing a row marks stored gag ideas out of date. It is not a render hash.

### Semantic Entities / Visual Referents

*Capitalization-aware term disambiguations the gag writer is told as the meaning of the fact's words.*

- **Effect:** Advisory only — read by the gag writer, never by the picture prompt
- **Staleness:** Editing does not re-flag render scenarios.
- **Editor surface:** section-level

**What it is**

The list of surface terms whose interpretation materially matters for the image — 'Earth' the planet vs 'earth' the soil being the flagship case. Casing is preserved verbatim (never normalized before interpretation; the classifier reads factTextExact), and only terms whose reading changes the image are listed — never every noun, and NEVER the fact's subject.

Subject-name defense: the subject (the canonical placeholder 'Alex') is categorically not a semantic entity — the classifier is forbidden from listing it, and a deterministic strip removes it from older enrichments defensively, so it is never told to the gag writer as a referent. The subject's identity is owned by the personalization/rendering layer.

**How the AI sets it**

The classifier applies the capitalization examples: earth/Earth (soil vs planet), apple/Apple (fruit vs company), sun/Sun (sunlight vs the named body or a personification), law/Law (legal rules vs a title/institution). Capitalization is a strong signal but never the sole basis; sentence-initial capitalization yields capitalizationSignal=sentence_initial_ambiguous + requiresAdminReview=true with the referent inferred from context.

**How it affects the render**

Entities flagged materiallyAffectsVisualPrompt are listed in the gag writer's message under WHAT THE REFERENCES MEAN as `"surfaceText" means visualReferent`, marked "(tentative)" when requiresAdminReview is set. They do not reach the picture prompt.

Nothing is forced into a picture: the render-time planner's echo-back validation and the compiler's gap-fill were removed when pictures started being drawn straight from the gag (plan docs/plans/PLAN_GAG_DIRECT_RENDER.md).

The engine never sees an "Interpret X means Y" meta line either: it gets only the approved gag's scene, so the resolved referent is drawn only if the gag's scene says it.

Entities never change the archetype/subtype — they are writer context, not taxonomy. The whole collection is in the gag writer's freshness check, so edits mark stored gag ideas out of date; it is not in the render-input hash and never marks a render out of date.

Pipeline: the classifier detects → the gag writer is told the meanings when it drafts gag ideas → a moderator approves a gag → the picture is drawn from that gag alone (no classification field reaches the picture prompt).

**Examples**

- **Scenario:** "{NAME} bench-presses the Earth."
  - **Input:** surfaceText "Earth", entityKind celestial_body, visualReferent "the planet Earth", materiallyAffects ✓
  - **Outcome:** The gag writer is told the referent is the planet, so its ideas use the planet, not a pile of soil.
- **Scenario:** "{NAME} moved the earth with one hand."
  - **Input:** surfaceText "earth", entityKind common_noun, capitalizationSignal lowercase_common_noun, visualReferent "ground, dirt, soil, or terrain"
  - **Outcome:** The mundane reading is locked for the gag writer — its ideas use soil, not the planet.
- **Scenario:** An old enrichment stored "Alex" as an entity.
  - **Input:** (nothing to do)
  - **Outcome:** The defensive strip removes it before the gag writer sees it — the subject is never a semantic entity.

**Sources**

- `artifacts/api-server/src/lib/factEnrichmentConfig.ts` `FACT_ENRICHMENT_SYSTEM_DEFAULT` — The classifier system prompt — the cultural-reference and semantic-entity/capitalization rules plus their worked examples.
- `lib/api-zod/src/taxonomy.ts` `culturalReferenceSchema` — The reference/entity schemas: field shapes, max lengths, and the research-metadata fields.
- `artifacts/api-server/src/lib/visualConcepts/generator.ts` `buildVisualConceptsUserMessage` — Where references and material entities reach anything: the WHAT THE REFERENCES MEAN block of the gag writer's message. No picture prompt reads them.
- `artifacts/api-server/src/lib/renderCanonical.ts` `stripSubjectNameSemanticEntities` — The subject-name defense: the personalized subject is never a semantic entity, even if an older enrichment stored it as one.
- `artifacts/api-server/src/lib/visualConcepts/inputHash.ts` `writerAffectingEnrichment` — The gag writer's freshness projection: it includes culturalReferences and semanticEntities wholesale, so editing a row marks stored gag ideas out of date. It is not a render hash.

### Characters

*Every person or animal the fact names besides the subject — a naming hint for the cast read from a gag's scene.*

- **Effect:** Advisory only — read by the gag writer, never by the picture prompt
- **Staleness:** Editing does not re-flag render scenarios.
- **Editor surface:** section-level

**What it is**

The fact's cast, minus the subject: for "When Alex was born, he drove his mom home from the hospital" it is one character, label "mom", a person, a relation of the subject. The subject is never listed — it is always available as "Alex (the subject)".

The subject is never listed. A label follows the bubble-speaker rules (plain text, no personalization token, never the word "subject", and unique within the list) so it can be matched to a bubble's speaker.

"Relation of the subject" decides how the character is named: "Alex's mom" when ticked, "the referee" when not.

**How the AI sets it**

A dedicated, versioned call made right after classification (its own prompt and response schema, so the main classification is untouched) reads the fact as rendered with the stand-in name and lists every person or animal it names besides the subject. The stand-in name is stripped if returned.

A successful call stamps an extraction marker, even for an empty list. A failed call leaves no marker on a fact that has never had a list — Taxonomy Health counts it as missing and "Fill character lists" retries it — and keeps the previous list on a fact that already had one.

A moderator correction replaces the whole list and survives re-enrichment, refreshes and both bulk re-enrich jobs; only the field's own reset clears it.

**How it affects the render**

Read only by cast extraction: when a gag is saved, the AI step that reads the gag's scene for who else is in it is given these labels as naming hints (never as characters to add). The gag writer's message and the picture prompt do not receive the list.

It never forces a character into a gag. Who appears is the gag's choice; the gag's cast, read from its scene and bubbles, is what the speaker dropdown offers and what the compiler binds speakers to.

Not in the render-input hash or the gag writer's freshness check, so editing the list never marks a render or a stored gag idea out of date.

**Examples**

- **Scenario:** "When {NAME} was born, {SUBJ} drove {POSS} mom home from the hospital."
  - **Input:** label "mom", kind person, relation of the subject ✓
  - **Outcome:** Cast extraction names the character "mom" when it reads the scene, so the speaker dropdown offers "mom" from the gag's cast.
- **Scenario:** The AI missed a character, or named one awkwardly.
  - **Input:** Add or rename the row (e.g. "mother" → "mom")
  - **Outcome:** Saved as a correction that re-enrichment keeps. Cast extraction uses the corrected label as its naming hint the next time a gag is saved.

**Sources**

- `lib/api-zod/src/taxonomy.ts` `culturalReferenceSchema` — The reference/entity schemas: field shapes, max lengths, and the research-metadata fields.
- `artifacts/api-server/src/lib/gags/castExtraction.ts` `buildCastUserMessage` — Where the fact's character labels are used: as naming hints for the cast read from a gag's scene.

### Surface text (verbatim case)

*The term exactly as it appears in the fact — casing preserved.*

- **Effect:** Advisory only — read by the gag writer, never by the picture prompt
- **Staleness:** Editing does not re-flag render scenarios.
- **Editor surface:** reserved

**What it is**

The term verbatim from the fact, casing intact (max 120 chars) — 'Earth' and 'earth' are different surface texts, and that difference is the point. Do not normalize it; normalizedText holds the lowercase form.

**How the AI sets it**

Quoted by the classifier from factTextExact.

**How it affects the render**

Shown to the gag writer as the quoted term at the start of the entity's line (`"surfaceText" means …`), only for entities flagged materiallyAffectsVisualPrompt. Entities whose surfaceText is a raw template token (e.g. literally "{NAME}") are dropped by the subject-name strip before the writer sees them.

**Examples**

- **Scenario:** The Earth bench-press fact.
  - **Input:** surfaceText: "Earth"
  - **Outcome:** The gag writer's line starts with "Earth"; the preserved capital is what justified the celestial reading.

**Sources**

- `artifacts/api-server/src/lib/factEnrichmentConfig.ts` `FACT_ENRICHMENT_SYSTEM_DEFAULT` — The classifier system prompt — the cultural-reference and semantic-entity/capitalization rules plus their worked examples.
- `lib/api-zod/src/taxonomy.ts` `culturalReferenceSchema` — The reference/entity schemas: field shapes, max lengths, and the research-metadata fields.
- `artifacts/api-server/src/lib/visualConcepts/inputHash.ts` `writerAffectingEnrichment` — The gag writer's freshness projection: it includes culturalReferences and semanticEntities wholesale, so editing a row marks stored gag ideas out of date. It is not a render hash.

### Normalized text

*The lowercase comparable form of the surface text.*

- **Effect:** Advisory only — read by the gag writer, never by the picture prompt
- **Staleness:** Editing does not re-flag render scenarios.
- **Editor surface:** reserved

**What it is**

The lowercase form used for comparisons (max 120 chars) — 'earth' for both 'Earth' and 'EARTH'.

**How the AI sets it**

Emitted by the classifier alongside the surface text.

**How it affects the render**

Bookkeeping only — the gag writer's message uses surfaceText; this field exists as the case-insensitive comparable form.

**Examples**

- **Scenario:** surfaceText "Earth".
  - **Input:** normalizedText: "earth"
  - **Outcome:** The pair records both the meaningful casing and the comparable form.

**Sources**

- `lib/api-zod/src/taxonomy.ts` `culturalReferenceSchema` — The reference/entity schemas: field shapes, max lengths, and the research-metadata fields.
- `artifacts/api-server/src/lib/visualConcepts/inputHash.ts` `writerAffectingEnrichment` — The gag writer's freshness projection: it includes culturalReferences and semanticEntities wholesale, so editing a row marks stored gag ideas out of date. It is not a render hash.

### Entity kind

*WHAT the term refers to in this fact — planet, brand, personified concept, plain object…*

- **Effect:** Advisory only — read by the gag writer, never by the picture prompt
- **Staleness:** Editing does not re-flag render scenarios.
- **Editor surface:** repeater-enum

**What it is**

An eleven-way classification of the referent's kind (see the per-value docs). It is render context, not taxonomy — resolving 'Earth' to the planet never changes the archetype/subtype.

**How the AI sets it**

Chosen by the classifier per its capitalization/context rules; 'ambiguous' pairs with requiresAdminReview.

**How it affects the render**

Recorded only: not shown to the gag writer. The concrete steering comes from visualReferent; the kind labels why the reading holds.

**Values (11)**

- `proper_noun` *(authored — verify)* — A capitalized proper noun naming a specific thing that isn't better covered by a more specific kind.
  - *Render:* The visual referent pins WHICH specific thing is meant; the gag writer is told it as the meaning of the term (when the entity materially affects the picture).
  - *Example:* "Everest" in a climbing fact → the specific mountain, not a generic peak.
- `common_noun` — A lowercase common noun whose everyday meaning is the right reading — recorded when it could be confused with a capitalized referent.
  - *Render:* Locks the mundane interpretation so the gag writer doesn't upgrade it to the named entity.
  - *Example:* "earth" → dirt, soil, ground, or terrain — NOT the planet.
- `named_entity` *(authored — verify)* — A specific named person, character, work, or event (other than the fact's subject — the subject is never listed).
  - *Render:* The gag writer is told the specific entity via the visual referent, so its ideas can use its recognizable characteristics.
  - *Example:* "Godzilla" in a size fact → the famous kaiju silhouette, per its visualReferent.
- `brand_or_cultural_reference` — The term is a brand or cultural reference ('Apple' the company, not the fruit) — usually paired with a culturalReferences entry.
  - *Render:* Locks the brand/cultural reading for the gag writer; as always, no real logo or brand mark is ever drawn.
  - *Example:* "Apple" capitalized mid-sentence → the technology company, rendered as sleek-device context, never the logo.
- `abstract_concept` *(authored — verify)* — An abstraction (infinity, probability, time) that has no direct physical form.
  - *Render:* The visual referent translates the abstraction into something showable for the gag writer; expect symbolic gag ideas.
  - *Example:* "infinity" in a counting fact → an endless receding number-scape as the referent.
- `personified_concept` — A concept treated as a character in this fact — capitalization often signals it ('Law', 'Death', 'Gravity').
  - *Render:* The gag writer is told the concept is a figure per the visual referent, rather than its abstract meaning.
  - *Example:* "Law" capitalized as an actor in the sentence → a personified authority figure, per the classifier's Law/law example.
- `physical_object` *(authored — verify)* — A concrete object whose specific reading matters to the joke (which kind of 'bar', which 'mouse').
  - *Render:* Pins the object's interpretation so the gag writer's ideas show the right thing.
  - *Example:* "mouse" in a tech fact → the computer peripheral, not the animal.
- `place` *(authored — verify)* — A location whose identity matters — a named place or a specific kind of setting.
  - *Render:* The gag writer is told the pinned location via the visual referent.
  - *Example:* "Paris" → the city with recognizable landmarks, not the mythological figure.
- `celestial_body` — A named astronomical object — the classifier's flagship capitalization case.
  - *Render:* Locks the astronomical reading for the gag writer (e.g. 'the planet Earth seen from orbit').
  - *Example:* "Earth" → the planet Earth; "Sun" → the named celestial body (or a personified entity, depending on context).
- `institution_or_system` — An institution or a system of rules ('the Law' as the legal system, 'the Church', 'the Market').
  - *Render:* The gag writer is told the institution's identity via the visual referent, so its ideas can use the recognizable trappings (courtrooms, trading floors).
  - *Example:* "law" lowercase → legal rules generally; "Law" may indicate a title or an institution, per the classifier examples.
- `ambiguous` — The AI could not confidently resolve the referent — the interpretation is a guess that a human should settle.
  - *Render:* The classifier sets requiresAdminReview for ambiguous kinds; the gag writer is shown the referent marked (tentative) until you correct it.
  - *Example:* A sentence-initial capitalized term with two plausible readings — the AI picks one and flags the row for review.

**Examples**

- **Scenario:** "Apple" capitalized mid-sentence in a tech fact.
  - **Input:** entityKind: brand_or_cultural_reference
  - **Outcome:** The company reading is locked — with the standard never-draw-a-real-logo rule downstream.

**Sources**

- `artifacts/api-server/src/lib/factEnrichmentConfig.ts` `FACT_ENRICHMENT_SYSTEM_DEFAULT` — The classifier system prompt — the cultural-reference and semantic-entity/capitalization rules plus their worked examples.
- `lib/api-zod/src/taxonomy.ts` `culturalReferenceSchema` — The reference/entity schemas: field shapes, max lengths, and the research-metadata fields.
- `artifacts/api-server/src/lib/visualConcepts/inputHash.ts` `writerAffectingEnrichment` — The gag writer's freshness projection: it includes culturalReferences and semanticEntities wholesale, so editing a row marks stored gag ideas out of date. It is not a render hash.

### Capitalization signal

*What the term's casing contributed to this interpretation — sentence-initial ambiguity is the classic review trigger.*

- **Effect:** Advisory only — read by the gag writer, never by the picture prompt
- **Staleness:** Editing does not re-flag render scenarios.
- **Editor surface:** repeater-enum

**What it is**

A six-way record of what signal the surface casing carried (see the per-value docs). Sentence-initial ambiguity is the common reason an otherwise-confident entry needs admin review.

**How the AI sets it**

The classifier uses capitalization as a strong signal but never alone; when a word is capitalized only because it begins the sentence, it sets sentence_initial_ambiguous + requiresAdminReview=true and infers the referent from context.

**How it affects the render**

Recorded only: not shown to the gag writer; the meaning follows visualReferent. Its main operational effect is flagging the sentence-initial case for your review.

**Values (6)**

- `capitalized_named_entity` — The term is capitalized mid-sentence, signaling a named entity ('Earth', 'Apple', 'Shark Week').
  - *Render:* Recorded only (not shown to the gag writer): it supports the named-entity reading of the visual referent — capitalization is a strong signal, never the sole basis.
  - *Example:* "…lifted Earth…" → capitalized mid-sentence → the planet.
- `lowercase_common_noun` — The term is lowercase, signaling the everyday common-noun reading.
  - *Render:* Recorded only (not shown to the gag writer): it supports the mundane referent (soil, fruit, sunlight) over the named entity.
  - *Example:* "…moved the earth beneath them…" → lowercase → soil/ground.
- `sentence_initial_ambiguous` — The term is capitalized only because it starts the sentence — casing carries NO signal, so the referent was inferred from context alone.
  - *Render:* The classifier's rule: set this signal, set requiresAdminReview to true (so the gag writer sees the referent as tentative), and infer the referent from context. Your review decides whether the inference was right.
  - *Example:* "Earth trembled when {NAME} stepped." → sentence-initial: planet or ground? Flagged for a human call.
- `all_caps_presentation_ignored` *(authored — verify)* — The term appears in ALL CAPS for emphasis/styling — the shouting is presentation, not a semantic signal, and was ignored.
  - *Render:* The referent was resolved as if the term were normally cased; the caps carry no interpretation weight. Recorded only.
  - *Example:* "{NAME} BENCH-PRESSED THE EARTH" → styling caps ignored; context decides planet vs ground.
- `mixed_case_brand_or_title` *(authored — verify)* — The term's distinctive mixed casing marks a brand or title (iPhone, YouTube, eBay).
  - *Render:* Recorded only (not shown to the gag writer): it supports the brand/title reading of the referent; no real logo is ever drawn.
  - *Example:* "iPhone" → the branded device category, casing itself being the tell.
- `not_relevant` *(authored — verify)* — Capitalization played no role in this interpretation — the entry exists for a non-casing reason (pure ambiguity, cultural reference).
  - *Render:* The visual referent stands on context alone; the casing axis is simply not part of the reasoning. Recorded only.
  - *Example:* An entity recorded because its wordplay reading matters, where either casing would read the same.

**Examples**

- **Scenario:** "Earth trembled when {NAME} stepped."
  - **Input:** capitalizationSignal: sentence_initial_ambiguous (requiresAdminReview auto-true)
  - **Outcome:** You decide planet vs ground; the AI's context-based guess stands until you do.

**Sources**

- `artifacts/api-server/src/lib/factEnrichmentConfig.ts` `FACT_ENRICHMENT_SYSTEM_DEFAULT` — The classifier system prompt — the cultural-reference and semantic-entity/capitalization rules plus their worked examples.
- `lib/api-zod/src/taxonomy.ts` `culturalReferenceSchema` — The reference/entity schemas: field shapes, max lengths, and the research-metadata fields.
- `artifacts/api-server/src/lib/visualConcepts/inputHash.ts` `writerAffectingEnrichment` — The gag writer's freshness projection: it includes culturalReferences and semanticEntities wholesale, so editing a row marks stored gag ideas out of date. It is not a render hash.

### Visual referent

*The concrete interpretation — the part of an entity the gag writer is actually told (after "means"), for entities flagged as materially affecting the picture.*

- **Effect:** Advisory only — read by the gag writer, never by the picture prompt
- **Staleness:** Editing does not re-flag render scenarios.
- **Editor surface:** reserved

**What it is**

The concrete resolved interpretation (max 400 chars) — e.g. 'the planet Earth' or 'ground, dirt, soil, or terrain beneath the subject'. Write it as a visible thing, not an essay: it is the payload the rest of the pipeline delivers.

**How the AI sets it**

Resolved by the classifier from casing + context; the most render-worthy edit in an entity row.

**How it affects the render**

Shown to the gag writer as `"surfaceText" means visualReferent` for entities flagged materiallyAffectsVisualPrompt, so its ideas use the resolved meaning. It is not put into any picture prompt and nothing gap-fills it: the render-time planner and the compiler's gap-fill were removed when pictures started being drawn straight from the gag.

**Examples**

- **Scenario:** The Earth bench-press fact.
  - **Input:** visualReferent: "the planet Earth"
  - **Outcome:** The gag writer is told "Earth" means the planet, so its ideas show the planet; the picture shows it only if the approved gag's scene does.

**Sources**

- `lib/api-zod/src/taxonomy.ts` `culturalReferenceSchema` — The reference/entity schemas: field shapes, max lengths, and the research-metadata fields.
- `artifacts/api-server/src/lib/visualConcepts/generator.ts` `buildVisualConceptsUserMessage` — Where references and material entities reach anything: the WHAT THE REFERENCES MEAN block of the gag writer's message. No picture prompt reads them.
- `artifacts/api-server/src/lib/visualConcepts/inputHash.ts` `writerAffectingEnrichment` — The gag writer's freshness projection: it includes culturalReferences and semanticEntities wholesale, so editing a row marks stored gag ideas out of date. It is not a render hash.

### Notes

*The AI's reasoning for this interpretation — context for admins; not shown to the gag writer.*

- **Effect:** Advisory only — read by the gag writer, never by the picture prompt
- **Staleness:** Editing does not re-flag render scenarios.
- **Editor surface:** reserved

**What it is**

Free-text reasoning behind the interpretation (max 800 chars; empty when there's nothing to say).

**How the AI sets it**

Written by the classifier; editable when you want to leave interpretation context for other admins.

**How it affects the render**

Recorded only: not shown to the gag writer and never part of a picture prompt.

**Examples**

- **Scenario:** A sentence-initial 'Sun'.
  - **Input:** notes: "Sentence-initial; context (orbits, gravity) supports the celestial reading."
  - **Outcome:** You see why the celestial referent was chosen.

**Sources**

- `lib/api-zod/src/taxonomy.ts` `culturalReferenceSchema` — The reference/entity schemas: field shapes, max lengths, and the research-metadata fields.
- `artifacts/api-server/src/lib/visualConcepts/generator.ts` `buildVisualConceptsUserMessage` — Where references and material entities reach anything: the WHAT THE REFERENCES MEAN block of the gag writer's message. No picture prompt reads them.
- `artifacts/api-server/src/lib/visualConcepts/inputHash.ts` `writerAffectingEnrichment` — The gag writer's freshness projection: it includes culturalReferences and semanticEntities wholesale, so editing a row marks stored gag ideas out of date. It is not a render hash.

### Materially affects visual prompt

*The entity's materiality switch — only checked entities are told to the gag writer.*

- **Effect:** Advisory only — read by the gag writer, never by the picture prompt
- **Staleness:** Editing does not re-flag render scenarios.
- **Editor surface:** reserved

**What it is**

True when changing this interpretation would materially change the rendered image. This checkbox is the entity-side materiality gate (entities have no confidence threshold — this flag alone decides).

**How the AI sets it**

Set by the classifier per its 'materially changes the rendered image' rule; toggle it to control whether the gag writer is told the entity.

**How it affects the render**

Checked: the entity is listed in the gag writer's WHAT THE REFERENCES MEAN block (`"surfaceText" means visualReferent`). Unchecked: the writer is not told about it. Nothing is forced into a picture: the echo validation and gap-fill were removed when pictures started being drawn straight from the gag.

**Examples**

- **Scenario:** The planet reading is essential to the joke.
  - **Input:** materiallyAffectsVisualPrompt: true
  - **Outcome:** The gag writer is told what "Earth" means; an unchecked entity would not be mentioned to it at all.

**Sources**

- `lib/api-zod/src/taxonomy.ts` `culturalReferenceSchema` — The reference/entity schemas: field shapes, max lengths, and the research-metadata fields.
- `artifacts/api-server/src/lib/visualConcepts/inputHash.ts` `writerAffectingEnrichment` — The gag writer's freshness projection: it includes culturalReferences and semanticEntities wholesale, so editing a row marks stored gag ideas out of date. It is not a render hash.

### Requires admin review

*Human sanity-check flag for this interpretation — auto-set for sentence-initial ambiguity and brand/ambiguous kinds.*

- **Effect:** Advisory only — read by the gag writer, never by the picture prompt
- **Staleness:** Editing does not re-flag render scenarios.
- **Editor surface:** reserved

**What it is**

True when a human should confirm the interpretation: sentence-initial ambiguity, brand/cultural references, an ambiguous kind, or any case worth a sanity check.

**How the AI sets it**

Classifier-set per its rules (sentence-initial capitalization always sets it); uncheck once you've confirmed the reading.

**How it affects the render**

Unlike the cultural-reference flag, it does NOT decide whether the entity is listed: a flagged entity with materiallyAffectsVisualPrompt=true is still told to the gag writer, marked "(tentative)".

**Examples**

- **Scenario:** Sentence-initial 'Earth' resolved to the planet.
  - **Input:** requiresAdminReview: true (auto)
  - **Outcome:** You confirm or correct the referent; the gag writer stops seeing it as tentative once the flag is cleared.

**Sources**

- `artifacts/api-server/src/lib/factEnrichmentConfig.ts` `FACT_ENRICHMENT_SYSTEM_DEFAULT` — The classifier system prompt — the cultural-reference and semantic-entity/capitalization rules plus their worked examples.
- `lib/api-zod/src/taxonomy.ts` `culturalReferenceSchema` — The reference/entity schemas: field shapes, max lengths, and the research-metadata fields.
- `artifacts/api-server/src/lib/visualConcepts/inputHash.ts` `writerAffectingEnrichment` — The gag writer's freshness projection: it includes culturalReferences and semanticEntities wholesale, so editing a row marks stored gag ideas out of date. It is not a render hash.

### Confidence

*0–1: the AI's confidence in this interpretation — informational for entities (no threshold gates on it).*

- **Effect:** Advisory only — read by the gag writer, never by the picture prompt
- **Staleness:** Editing does not re-flag render scenarios.
- **Editor surface:** reserved

**What it is**

The classifier's 0–1 confidence in the interpretation. Unlike cultural references (where 0.8 is half the materiality gate), no entity-side threshold branches on it — materiality is the checkbox alone.

**How the AI sets it**

Emitted by the classifier per entry.

**How it affects the render**

Recorded only: not shown to the gag writer. Use a low value as your cue to review; it changes nothing downstream.

**Examples**

- **Scenario:** A coin-flip interpretation.
  - **Input:** confidence: 0.55
  - **Outcome:** Your cue to settle the reading yourself — nothing downstream treats the entity differently either way.

**Sources**

- `lib/api-zod/src/taxonomy.ts` `culturalReferenceSchema` — The reference/entity schemas: field shapes, max lengths, and the research-metadata fields.
- `artifacts/api-server/src/lib/visualConcepts/generator.ts` `buildVisualConceptsUserMessage` — Where references and material entities reach anything: the WHAT THE REFERENCES MEAN block of the gag writer's message. No picture prompt reads them.
- `artifacts/api-server/src/lib/visualConcepts/inputHash.ts` `writerAffectingEnrichment` — The gag writer's freshness projection: it includes culturalReferences and semanticEntities wholesale, so editing a row marks stored gag ideas out of date. It is not a render hash.
