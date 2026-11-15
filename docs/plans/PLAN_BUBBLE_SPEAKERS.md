# Plan — a fact's characters, and a bubble's speaker picked from them

```plan-oracle
Direction served
Speech and thought bubbles (glossary, "Speech and thought bubbles"; visual-pipeline.md): a moderator marks that a character is speaking or thinking something, and the pipeline alone authors the engine instruction for it. A bubble's speaker is picked from the scene's characters, not typed (David, 2026-11-15, Issue #968).

Product intent (agreed by David, 2026-11-15)
- Enrichment lists every person or pet in the fact who could speak or think: always the subject, plus everyone else the fact names (for "When Alex was born, he drove his mom home from the hospital": Alex, and Alex's mom).
- Each listed character carries a short neutral label ("mom"), shown in the dropdown with the sample name ("Alex's mom").
- Moderators can correct the list (add, rename, remove); the correction is stored as an override like every other enrichment field, so re-enrichment never wipes it.
- The bubble speaker dropdown offers the fact's characters plus any extra characters that gag adds in its Scene Role Assignments.
- The image planner is given the list and told to use those exact labels, so the bubble's tail lands on the character picked.

Must not change
- An existing bubble's instruction stays word-for-word the same, and its speaker is now made sure to be drawn (Q1: 1, David, 2026-11-15); a typed speaker that is not on the list stays valid and is shown as-is.
- Bubble wording and limits.
- Gags stay separate from enrichment; moderators remain the authors of the scene.
- No re-renders.

Settled decisions
- A fact's wording never changes after triage (PLAN_THREE_GAGS.md, settled decisions 12, 16, 17; Issue #949).
- The pipeline is the only author of the engine-facing balloon instruction (glossary).
- AI-derived values and moderator overrides are always kept distinguishable (taxonomy-and-enrichment.md).

Now / Next / Never
- Now: the character list in enrichment with moderator overrides; the speaker dropdown; the planner using the list's labels; a one-off job filling the list for existing facts (text classifier only, no image model).
- Next: a "Someone else…" choice for talking objects (a car, a toaster).
- Never: a speaker that is a personalization token.

Ceremony
Full production loop; touches enrichment and the visual pipeline (sensitive subsystems); the backfill gets the migration review.
```

Workstream: #968

## Problem

A moderator writing a speech or thought bubble types its speaker into a free-text box (`BubbleEditor.tsx`, `bubble-entity` input). Nothing tells them which characters the fact contains, and nothing ties what they type to what the image model draws:

- The planner names every non-subject character itself, per render (`generator.ts:710`: *label = short relationship/name/type ("mother", …)*). A bubble typed as "mom" matches a planned "mother" by luck or not at all, and the compiler then warns `bubble_entity_unresolved` (`nanoBanana2.ts:606`) while the model places the tail wherever it likes.
- When a gag has any Scene Role Assignments, the compiler drops the planner's whole secondary-character list in favour of them (`nanoBanana2.ts:1329–1338`: `const secondaryCharacters = hasOverrideRoles ? overrideSecondary : aiSecondaryCharacters;`). A speaker who is in the fact but not in the gag's role list is then not in the scene at all.

## Direction

The glossary's *Speech and thought bubbles*: a moderator marks that a character is speaking or thinking; the pipeline writes the instruction. This plan gives the moderator the scene's cast to pick from, and makes the pipeline honour the pick.

## Product Intent, Must Not Change, Settled Decisions

As the oracle block above, verbatim.

## Vocabulary

- **Fact character list** — the new enrichment field `characters`: every person or pet the fact's locked wording names other than the subject. The subject is never stored in it; it is always implicit, as the bubble entity `subject` already is.
- **Character** — one entry: `label` (short, neutral, the value a bubble stores, e.g. `mom`), `kind` (`person` | `animal`), and `ofSubject` (true when the label is a relation of the subject, so the dropdown reads "Alex's mom"; false for "the referee").
- **Speaker** — the existing bubble `entity` string. Unchanged in shape: `subject`, or a plain label.

## Repo Context Inspected (at `fd51c72`)

`lib/api-zod/src/taxonomy.ts` (enrichment schema, wire schema, `semanticEntities`), `lib/api-zod/src/enrichmentOverrides.ts` (`OVERRIDABLE_PATHS`), `lib/api-zod/src/visualStrategyOverride.ts` (bubble and role-binding schemas, entity rules), `artifacts/api-server/src/lib/factEnrichment.ts` (`enrichFact`, `materializeEnrichment`), `enrichmentJobs.ts`, `factEnrichmentBackfillJob.ts`, `enrichmentVersioning.ts`, `factRenderScenarios.ts` (`renderAffectingEnrichment`, `buildScenarioInputHash`), `imagePrompt/generator.ts` (`moderatorBubbleLines`, the `secondaryCharacters` instruction), `imagePrompt/compilers/nanoBanana2.ts` (`composeBubbleDirectives`, role precedence), `lib/api-zod/src/visualConcepts.ts` (`withCandidateConceptDraft`), `components/admin/BubbleEditor.tsx`, `EnrichmentEditor.tsx`, `gags/GagsPanel.tsx`; Astra's scope assessment (`.agents/reviews/bubble-speakers/round-0.md`).

## Current Behavior

1. The classifier is given the fact rendered with the stand-in name "Alex" (`enrichmentJobs.ts:99`, `enrichFact({ factText: renderedText })`) and returns no character list. `semanticEntities` lists only ambiguous referents that change the picture, and the subject's name is stripped from it (`generator.ts:211`).
2. The bubble editor has two placements editing one draft: the gag card (`GagsPanel.tsx:209`, `firstClass`) and the advanced panel (`EnrichmentEditor.tsx:1424`). Both take a typed speaker.
3. The planner already sees each bubble's speaker and text (`generator.ts:373–383`, `MODERATOR BUBBLE DIRECTIVES … [speech — mom: "…"]`) but is never told to draw that speaker under that label.
4. The compiler resolves `subject` to the subject's noun and uses any other speaker string verbatim, warning when no effective character carries it.

## Source-of-Truth Analysis

- **The character list is a fact-level classification of locked wording**, so it belongs in enrichment, beside `semanticEntities`, with the AI baseline and a moderator override kept apart like every other field. It is not gag content.
- **A gag's extra characters stay in its Scene Role Assignments**, which already exist per gag. The dropdown merges the two lists; it stores nothing new.
- **The bubble keeps storing a plain string.** The dropdown is a way of writing that string, not a new reference type. A saved bubble never changes because the list changed.
- **The character list reaches the planner as naming context, never as a cast list.** It tells the planner who exists and what each is called; the gag still decides who is in the picture. Because it now shapes the plan, it is part of the render input like every other enrichment field the planner reads.

## Proposed Design

### A. The field

- `characters: z.array(characterSchema).max(10).default([])` on `factEnrichmentBase`, plus `charactersExtraction: { promptVersion, extractedAt }`, optional, **written only after a character call's output validates** — a legitimate empty list included. Parsing an old blob, a default, a failed call and a promote of an old baseline never write it, so "this fact's list was really extracted" is never confused with "the field defaulted to empty".
- **Not** in `factEnrichmentWireSchema`: the main classifier's response contract is unchanged. The character call has its own strict wire schema.
- `characterSchema`: `label` follows the bubble-entity rules exactly (≤ `BUBBLE_ENTITY_MAX_CHARS`, no personalization tokens, same normalization), is not `subject` (case-insensitive), and labels are unique within the list (case-insensitive). `kind` ∈ `person | animal`. `ofSubject` boolean.
- Old enrichment blobs, archived versions and frozen render snapshots parse unchanged: the field defaults to `[]`.
- `/characters` joins `OVERRIDABLE_PATHS` as one list-valued override ("Characters"), so a correction is a whole-list override with the usual AI-vs-override decoration and baseline-changed detection.
- `renderAffectingEnrichment` includes `characters` (not the extraction marker), so a changed list marks that fact's test renders out of date, as any planner input does. Reporting stays separate from rendering: nothing re-renders.

### B. Who produces it

- One producer: a dedicated, versioned character-list call (`CHARACTER_LIST_PROMPT_VERSION = "v1"`) made inside `enrichFact` after classification, on the same engine settings. It reads the locked wording rendered with the stand-in name, and returns every person or animal named besides the subject. "Alex" (the canonical stand-in, `renderCanonical.CANONICAL_SUBJECT_NAMES`) is stripped if returned, as `semanticEntities` already strips it.
- Because it sits inside `enrichFact`, every writer that classifies — the first enrichment, sticky re-enrich, a refresh candidate, the queued backfill — gets it, and the main classification prompt and `CLASSIFICATION_PROMPT_VERSION` are untouched, so no fact reads as stale-for-classification because of this work.
- A failure of the character call does not fail enrichment. If no successful extraction exists yet, the field stays `[]` with no marker, so the fact counts as *missing a character list* (G), which Taxonomy Health shows and the fill job retries. If a prior successful list and marker exist, both are kept: the wording is locked, so that list is still the fact's, and the fact stays complete.

### C. The dropdown

- `BubbleEditor` takes a `characters` prop and both placements pass the fact's **effective** list (Facts editor, Moderation, and a refresh candidate's editor, each from the enrichment it is editing).
- Options, in order: **"Alex (the subject)"** → `subject`; each fact character → its label, shown as "Alex's mom" when `ofSubject`, else "the referee"; each label in this gag's Scene Role Assignments not already listed → that label, marked "added in this gag".
- A saved speaker matching none of those is shown as itself, marked "not in this fact's character list", selected, and saved unchanged — never rewritten. Renaming or removing a character never touches saved bubbles; they show this way.
- New bubbles default to `subject`, as today.
- The free-text box goes; typing a new speaker is the *Next* "Someone else…" option. A moderator who needs a speaker today adds them to the character list or to the gag's Scene Role Assignments, both of which then appear in the dropdown.
- The existing soft warnings stay, now reading the merged list.

### D. The character-list editor

A **Characters** section in the enrichment editor beside *Semantic Entities*: one row per character (label, person/pet, "relation of the subject"), add and remove, the AI-value/override decoration every overridable field has, and the same validation as the schema with field-specific errors.

### E. Corrections survive every writer

The oracle promises that re-enrichment never wipes a moderator's character correction. Today two paths can:

- **The sticky re-enrich** (`enrichmentJobs.ts:193`) rematerializes with the overrides it read *before* its classifier call; its final locked read fetches only id and text. It will re-read the overrides inside that locked transaction and merge against them, so a correction saved during classification survives. This is the same fix for every field, since it is one read.
- **The two bulk backfills** (`factEnrichmentBackfillJob.ts:75`, `admin.ts:2138`) materialize with `overrides: {}`, and their "admin-edited" guard (`taxonomyHealth/index.ts:349`, `enrichedBy === "admin"` or non-empty review notes) does not see a field override at all — so even without force they can clear one. They will keep a `/characters` override (re-read under their write lock) while resetting the rest exactly as today. Widening that to every field is a separate behaviour change (*Next*).
- The existing explicit "reset this override" action still resets it; that is a moderator's choice, not re-enrichment.

### F. The pipeline honours the pick

- **Planner** (context block beside semantic entities): the effective fact character list is given as **naming context** — "these are the people and animals the fact names, with their labels; if you include any of them, use exactly this label; you need not include any of them." Plus, in `moderatorBubbleLines`, one instruction: every bubble speaker other than `subject` must appear in `visualPlan.secondaryCharacters` with `label` exactly the speaker string. With no characters and no bubbles nothing changes.
- **Compiler** (role precedence): after choosing role assignments or the planner's list as today, any non-subject speaker still missing is taken from the planner's characters with that exact label, if present, and added. Where a speaker is in both, the gag's Scene Role Assignment wins — moderator staging stays authoritative. A fact character who speaks in no bubble and is not in the gag's roles is not forced into the scene.
- **The speaker's identity survives into the final prompt.** Today `composeAdditiveRoleDetails` drops a character's whole entry when its visual role is already described in the scene (`nanoBanana2.ts:703–706`), even if its label appears nowhere — so "mom" can reach the engine only inside the balloon instruction, with no warning (Astra reproduced this with a mom and a nurse both described in the scene). For an **active speaker** — a non-subject label some bubble names — the entry is kept as a short binding (`mom: the older woman in the red coat`) even when its role is covered, and it is exempt from the additive budget trim, as bubble directives already are. The binding is kept short whatever the planner wrote (planner role text is unbounded, `imagePromptGeneration.ts:513`), so it fits beside the 1,000-character role-section cap (`nanoBanana2.ts:1367`) and final assembly without lowering any bubble limit or adding a new way for a render to fail. Other characters dedupe as today.
- `bubble_entity_unresolved` / `bubble_entity_ambiguous` are read against **the bindings actually emitted**, not the planner's array, so a speaker that reaches the engine only inside its balloon now warns.
- `IMAGE_PROMPT_GENERATION_VERSION` v8 → v9, with the changelog line (Q1 says what that marks out of date).
- The bubble directive itself (`composeBubbleDirective`, its `who` and text) is unchanged.

### G. The fill job for existing facts

- A queued async job, `fact_character_fill`, started from a Taxonomy Health action with the progress display the async-status rule asks for.
- Targets, each where the AI baseline has **no extraction marker**: active facts; facts in first-time moderation that already have a valid baseline (at the Gags or Test Renders step — a submission still at triage or awaiting its first classification gets the list from normal prep); and open refresh candidates (`fact_enrichment_versions.status = 'candidate'`). Superseded and rejected versions and frozen render snapshots stay as they are.
- Per target: run the character call alone; in one transaction re-read the row, write the result and its extraction marker into the AI baseline only, rematerialize with the overrides as read in that transaction, and touch nothing else (no other enrichment field, signature, status, review cycle or gag).
- Idempotent and resumable: a target with the marker is counted *already complete*; a failed call is *failed*, leaves no marker and is picked up by the next run; a target whose row changed under it (a concurrent re-enrich) is *deferred*. The job reports processed, already complete, deferred and failed, and enqueues no render.
- Taxonomy Health shows a count of facts *missing a character list* (no marker), with the action beside it, so a character-call failure after the initial fill is visible and has its retry.
- Cost: one short text call per fact on the enrichment engine; no image model.

### Alternatives considered

- **Give the planner only the picked speakers** (plan v1). Withdrawn: the oracle says the planner is given the list, and as naming context rather than a cast it does not push anyone into a gag. Its cost — the fill marks the test renders of facts it fills out of date — lands in the same release as the version step that already does, so it adds no new flag for a moderator to clear.
- **Add characters to the main classification prompt.** Rejected: it bumps `CLASSIFICATION_PROMPT_VERSION`, marking every fact stale-for-classification, and the fill job would then be a second producer that could drift from the first.
- **Reuse the general enrichment backfill for the fill.** Rejected: it reclassifies every field and, by design, resets overrides (`factEnrichmentBackfillJob.ts:75`).
- **Treat "the key is present" as "extracted".** Rejected: the schema default and a failed call both produce an empty list, so a failure would read as done forever.

## Data Model and Migration Impact

- No column and no table: `characters` lives inside the existing JSONB enrichment layers and is defaulted on read. No schema migration.
- The fill job is the backfill and gets `overhype-migration-review`: idempotency, counts, the old/new/partial/failed/skipped/no-op row-state matrix, override preservation, and no destructive step (nothing is removed, so there is nothing to roll back beyond clearing the key).

## Runtime Behavior and Edge Cases

- **Subject-only fact** — the list is empty; the dropdown offers the subject and any gag roles.
- **A pet** ("Alex's dog refuses to fetch for anyone else") — `{label: "dog", kind: "animal", ofSubject: true}`, shown "Alex's dog".
- **Gag extra** — fact has mom; a gag's Scene Role Assignments add "doctor": the dropdown offers subject, Alex's mom, doctor (added in this gag). A bubble from mom renders with mom present even though the gag has explicit roles (F).
- **Scene already describes the speaker** — "Alex between an older woman in a red coat and a nurse in scrubs", bubble from mom: the final prompt binds `mom` to the older woman (F), rather than naming mom only inside the balloon.
- **Real people named in a fact** are listed like anyone else; bubble rules and the legal-safety rules are unchanged — a moderator could already type that speaker.
- **Concurrent edit** — a moderator override saved while the fill job processes the same fact survives: the job reads overrides inside its own write transaction.
- **A refresh promoted after the fill** carries the candidate's filled list, because the job fills open candidates too.
- **Visual Ideas** keep proposing their own speaker strings; applying one keeps them as-is and they show as off-list if they don't match (*Next*: tell the Visual Idea writer the labels).

## Security, Permissions and Validation

Admin-only surfaces and admin-only job route, behind the existing admin guard. The label rules are the bubble-entity rules, enforced in the shared schema on every write path (override save, AI output, fill job), so a token or the reserved word cannot enter through any of them.

## Testing Plan

- **Schema**: valid list; token in a label refused; `subject` refused; duplicate labels refused; old blob without the key parses to `[]`.
- **Override**: `/characters` set, reset-when-equal-to-AI, baseline-changed detection; survives a refresh promote; survives a sticky re-enrich when saved **before** the classifier call and when saved **during** it; survives both bulk backfills, with and without force, while their reset of other fields is unchanged.
- **Producer**: `enrichFact` stitches the call's result in with its marker; the main classifier's response schema is unchanged; the stand-in name is stripped; a successful subject-only result stamps the marker with `[]`; a failed call on a first enrichment leaves `[]` and no marker; a failed call on a re-enrichment keeps the prior list and marker; promoting an old baseline writes no marker.
- **Render hash**: changing `characters` changes `buildScenarioInputHash`; changing only the marker does not.
- **Planner**: the naming-context block appears exactly when the list is non-empty; the speaker instruction exactly when there is a non-subject speaker.
- **Compiler**, asserting on the **final assembled prompt**: hospital (subject + mom, no roles); a pet; subject-only; subject + mom with a gag role "doctor" and a bubble from mom — mom is bound under that label, the doctor keeps its authored role; the red-coat/scrubs scene with a bubble from mom — `mom` is bound to the older woman outside the balloon instruction; a speaker the planner left out — the warning fires; several active speakers under budget pressure, some supplemented beside moderator roles, with long planner role text and a promoted prompt recipe — every speaker's binding survives the role-section cap and final assembly and the prompt stays within its ceiling; the bubble directive text is byte-identical to v8's for the same inputs; a legacy off-list speaker still compiles the same directive.
- **Fill job**: fills an active fact, a first-time moderation fact at Gags, and an open candidate; skips a triage submission; leaves every other field, the signature, status and gags byte-identical; skips marked targets; a failure leaves no marker and the next run retries it; an interrupted run resumes; an override written mid-run survives; no render job is enqueued; a second run is a no-op; the Taxonomy Health count matches.
- **UI** (Vitest): option list and order; "Alex's mom" display; gag extras marked; an off-list saved speaker shown and saved unchanged; both placements receive the same options; character editor validation errors.
- **Browser** (local stack): on a seeded hospital fact, add two bubbles — subject "Buckle up, mom", mom "Will do" — save, reload, see them; the runtime prompt preview shows both directives and mom in ROLE DETAILS.

## Implementation Steps

1. Schema, extraction marker, override path, `renderAffectingEnrichment`; tests.
2. Character call (own wire schema) in `enrichFact`, with carry-forward on failure; tests.
3. Override survival in the sticky re-enrich and both backfills; tests.
4. Planner context and instruction, compiler precedence and speaker binding, diagnostics on emitted bindings, version bump; tests.
5. `BubbleEditor` dropdown and both placements; the Characters editor section; tests.
6. Fill job, Taxonomy Health count, action and progress display; migration review; tests.
7. Docs: glossary (*Fact character list*), `taxonomy-and-enrichment.md`, `visual-pipeline.md`, the admin field docs.
8. Browser check; PR with UAT section.

One increment, one PR: the dropdown is the testable surface and it is useless without the list behind it.

## Risks and Mitigations

- **The character call misses or invents someone** — the moderator corrects the list; the correction is durable.
- **The planner ignores the exact-label instruction** — the compiler warns `bubble_entity_unresolved`, now judged on what was actually emitted, and the moderator sees it in the runtime preview.
- **Tail placement is image output, not prompt text** — prompt assertions prove the label reaches the scene; only a test render proves the tail. That is the UAT's judgement step.

## Open uncertainty

None known that blocks building.

## Questions for David

- **Answered — Q1: 1** (David approved the plan with this recommendation, 2026-11-15).
- **Q1** — the oracle says existing bubbles render exactly as they do now. The bubble's own instruction (who says what) does stay word-for-word the same. But the fix that makes sure the speaker is actually drawn (F) changes the rest of the compiled prompt for any gag with bubbles, so the next picture made for an existing gag can be staged differently. Two side effects, from the version step either way: every existing test render shows as out of date, and every fact shows as *stale for reprocess* in Taxonomy Health (the version is part of the processing signature, `processingSignature.ts:49`), an info-level flag that only a refresh clears. Nothing re-renders, and approved examples stay approved (three-gags settled decision 6). Options: 1 — apply the fix to every bubble, old and new, amending the oracle line to "an existing bubble's instruction stays word-for-word the same; its speaker is now made sure to be drawn"; 2 — apply it only to speakers picked from the list, so older gags compile as they do now until a moderator re-picks. **Recommendation: 1** — a bubble whose speaker can vanish from the scene is the bug this fixes, and option 2 still needs the version step, so it avoids none of the out-of-date flags.

## Next (taken from this plan, not in it)

- A "Someone else…" speaker for talking objects (scope).
- Tell the Visual Idea writer the fact's character labels so its proposed bubbles use them.
- The bulk backfills' "admin-edited" guard does not see field overrides, so they can reset a moderator's correction to any field other than characters (`taxonomyHealth/index.ts:349`); a bugfix of its own.

## Definition of Done

Both bubble placements offer the subject, the fact's characters and the gag's extra roles; a saved off-list speaker is kept unchanged; moderators can correct the character list and the correction survives re-enrichment and promotion; every existing fact and open candidate has a list after the fill job, with nothing else changed and nothing rendered; a picked speaker appears in the compiled scene under that exact label, gag roles included; CI green; docs updated; UAT section in the PR.
