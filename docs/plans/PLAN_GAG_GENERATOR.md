# Plan: the gag generator on Astra with the locked prompt, a joke read and a per-fact humor note

```plan-oracle
# Oracle: the gag generator on Astra with the locked prompt and a per-fact humor note

Agreed with David on 2026-11-13 ("1. Go. 2. Option 2."), after he locked the prompt ("Locked").

## Direction served

The gag generator understands each fact's joke: it runs on OpenAI's strongest model with the locked prompt, and David's taste is captured once per fact as a humor note. Product strategy, *Gags and examples*: a fact can have up to three approved gags.

## Product intent (David, verbatim)

- "we'll use that, in conjunction with Astra 6 as the model that generates the gags in the app. Once you and Astra have agreed on the prompt, I'll review it and lock it in. Then we can update the code with the new prompt."
- "I feel like we might want to have an extra piece of human-written metadata about each fact which is an explanation of 'why is this funny and how can that humor be interpreted visually?' That seems to be what the AI has struggled with most in the past because understanding the nuance of visual humor is a big challenge." He chose: the AI drafts it, a human corrects it ("I like Option 1").
- "Should we rely on the prompt to teach the LLM how to handle the tokenization? I feel like that's redundant and will break. Rather, we should have it use a generic name that we then tokenize using the function we already have, no?"
- "The purpose of this prompt is to build just the visual gag, not the whole rendered prompt, right?"
- On how a joke read becomes a humor note, he chose option 2: it is saved when a moderator edits it, and also when a moderator presses a one-press confirm on a correct read.

## In this build

1. The gag generator runs on `gpt-6-astra`, on its own engine setting; the render planner's engine is untouched.
2. The locked prompt (file `gag-prompt-LOCKED.md`, sha256 838fce3ae26e9ed0b09bdd581f09fb814f4d111b246c279fabd23c35921bff6f) replaces the current system prompt, verbatim.
3. The request is rebuilt to send only what a gag writer needs: the fact with the stand-in name "Alex"; the approved humor note when there is one; what any references mean, in plain language; the joke type in one line; the violence and text limits; the gags the fact already has; the moderator's working draft.
4. The generator returns a "joke read" with its three gags, and moderators see it above them.
5. A moderator can correct the joke read, or confirm it with one press, and it is saved as the fact's humor note. A saved note is used for every later generation on that fact and is never overwritten by the AI.
6. Scenes and bubble lines pass through the existing tokenizer (`tokenizePlainTextToTemplate`); the checks that already run after generation stay.

## Checked in this build, fixed later if needed

Whether the image side can draw the hero at another age with their own face and features (David: "must put a de-aged baby version of the adult head on the newborn body"; "If the picture of the person has facial hair, it should remain in baby form"). Report the finding; a fix is its own item.

## Later, not in this build

- A sound-effect overlay type beside speech and thought.
- A "mean or cruel" filter that hides such facts by default.

## Must not change

- Gags already approved stay exactly as they are; nothing is regenerated in bulk.
- A moderator's chosen scene is still used word for word.
- Blind moderation and the legal-safety rules.
- The image wording and the picture engines.
- A moderator's corrections survive any AI re-run.

## Decisions David made on the plan's three items (2026-11-13)

His words: "1. Agreed. This is an admin function so doesn't need high availability. 2. Agreed. 3. No worries."

1. No fallback model: if Astra is unavailable, gag generation fails and says so.
2. A humor note survives edits to its fact's wording; it stays and is shown for re-reading.
3. The cost of generating on Astra for facts entering moderation is accepted.

## Ceremony tier

Product code, production phase: plan reviewed by Astra, David's approval, Codex code review, a UAT section. Migration review if it needs a schema change.
```

Workstream: issue #935. One increment, one pull request.

## Problem

The candidate visual-concept generator ("gag generator") drafts three scene ideas per fact during moderation prep. It runs on `gpt-5.5`, on a prompt that never says what makes a gag good, and nothing records, per fact, why the fact is funny. David's diagnosis: understanding the nuance of visual humor is what the AI has struggled with most.

## Direction, product intent, must not change

As the oracle above. The prompt text is settled: `gag-prompt-LOCKED.md`, sha256 `838fce3ae26e9ed0b09bdd581f09fb814f4d111b246c279fabd23c35921bff6f`, locked by David on 2026-11-13. This plan does not reopen its wording.

## Settled decisions

1. **The approved humor note is a field on the fact row**, nullable, separate from the candidates blob (Astra, scope S1; the blob is "TRANSIENT, latest-only prep metadata (regenerate overwrites)", `lib/db/src/schema/facts.ts`). It records who approved it and when. A variant is its own fact row and owns its own note.
2. **Only a moderator's action writes the note.** Confirm and Save correction go through one admin write path. Generation, enrichment, refresh and migration never write it. The joke read lives in the candidates blob beside the three gags.
3. **The note is plain prose and is never shown to end users.** It may say "Alex"; it is not tokenized.
4. **The gag generator gets its own engine row** on `gpt-6-astra` at high reasoning effort, and `fact_visual_concepts_engine_id` is repointed to it by a data migration, whatever value it held before (seeding is `ON CONFLICT DO NOTHING`, so a code default alone would not switch an existing database; a previous custom value would otherwise keep generating on another model). The previous value is recorded for recovery. The render planner's setting and `openai-visual-planner` are not edited.
5. **No downgrade to a weaker model** (David, 2026-11-13: "Agreed. This is an admin function so doesn't need high availability."). Today an unusable configured engine falls back to the general utility model with a reason in provenance. For the gag generator that becomes a failed generation the moderator sees, with its cause and Regenerate. An unusable engine stops generation only: review details, saved notes and job status still load. A configuration fault fails the job at once through the queue's existing terminal outcome; a transient provider error keeps the existing retries.
6. **The request is built by its own function** from the review cycle's effective enrichment and `resolveRenderPolicy(enrichment)` (violence and supporting text), not from the render planner's context blocks. Strategy examples, taxonomy scores and render-mode strategy lines are not sent.
7. **"Gags the fact already has" means the saved gag** (`coreSceneOverride` and its bubbles) while the app stores one. The multiple-approved-gags model is its own plan (product strategy); this build does not start it. The moderator's unsaved draft is sent with its bubbles.
8. **Tokenization is the existing function**, `tokenizePlainTextToTemplate` with `purpose: "visual_strategy"` and `subjectNames: ["Alex"]`, applied to each scene and each bubble text. A conversion that leaves the stand-in name in the text, or leaves a scene without the subject token, is a failed conversion, never a pickable gag (Astra, scope S4: the tokenizer returns its input unchanged when its own response is malformed).
9. **A humor note survives edits to its fact's wording** (David, 2026-11-13: "Agreed."). It stays and is shown for re-reading.
10. **Affected-surface inventory, run on 2026-11-13.** `git grep -n CANDIDATE_CONTEXT_OPTS`: one consumer outside its definition, `visualConcepts/generator.ts`, plus a comment in `visualConcepts/inputHash.ts`. Readers of the wire and blob schemas (`git grep -ln "candidateConceptsWireSchema\|visualConceptCandidatesBlobSchema\|VisualConceptsResponse"`): `visualConceptJobs.ts`, `visualConcepts/generator.ts`, `routes/reviews.ts`, `testing/legacyFixture/{predicates,shapes}.ts`, `VisualConceptCandidates.tsx`, `pages/admin/moderation.tsx`, and `lib/api-zod/src/visualConcepts.ts`. Enqueue sites: `moderationStaging.ts:335` (automatic, first-time preparation, by a direct `enqueueJob`), `enrichmentJobs.ts:414` (automatic, refresh candidates) and `routes/reviews.ts:1792` (Regenerate). The engine resolver is also on a read path: review detail computes the candidates' freshness through it (`visualConceptJobs.ts`, `computeCurrentInputHash`). These are the surfaces the change is drawn from.

## Current behavior

- `generateVisualConcepts` makes one Structured Outputs call with `FACT_VISUAL_CONCEPTS_SYSTEM_DEFAULT` and a user message built from `buildImagePromptContextBlocks(…, CANDIDATE_CONTEXT_OPTS)`; one corrective retry on a validation failure.
- The job (`visualConceptJobs.ts`) passes `factText`, `enrichment` and the draft scene; it does not pass a render policy, so violence guidance falls back to defaults.
- The result is stored in `facts.visual_concept_candidates` with provenance and an input hash; the moderation screen hides candidates whose hash no longer matches.
- Generation is enqueued automatically after enrichment for every fact in moderation prep, and by Regenerate.

## Proposed design

**A. Engine.** A code-defined engine row for the gag writer (`gpt-6-astra`, reasoning effort high, not eligible as a default LLM), synced like the other engine definitions. The completion ceiling leaves room for Astra's reasoning at that effort, so a normal answer is not cut off; a cut-off answer fails validation and takes the existing corrective retry.

**B. Prompt.** The system prompt constant becomes the locked text, byte for byte; a test pins its sha256 so a later edit is a deliberate one. `VISUAL_CONCEPTS_PROMPT_VERSION` moves to 3. The admin screen keeps showing it read-only.

**C. Request.** One function builds the per-request message, with absent blocks omitted and no second copy of the output rules:

- the caption: the fact template rendered through the existing renderer with the name Alex and they/them;
- the approved humor note, when the fact has one;
- meanings that matter: each material cultural reference and semantic entity as one plain line, with a tentative annotation marked tentative;
- the joke mechanism: archetype and subtype in plain words with the subtype's one-line principle;
- the limits: violence and supporting text, from the resolved render policy;
- the saved gag and its bubbles, rendered with Alex: during a refresh this is the live fact's approved gag, not the refresh candidate's;
- the moderator's working draft and its bubbles, from the review editor.

Meanings, joke mechanism and limits come from the review cycle's effective enrichment.

**D. Output and conversion.** The wire schema gains `jokeRead`. Each scene and bubble text is converted by the tokenizer (decision 8), then runs through the validation, sanitizing and budget preflight that exist today, after conversion. A response in which no gag converts and validates takes the corrective retry; a second failure fails the job as today. The stored blob gains `jokeRead` and the note text the gags were generated under (null when there was none).

**E. Humor note.** On the moderation screen, above the three gags:

- the current generation's joke read is always shown above its gags, labelled as the AI's read. With no saved note it carries **That's right** and **Edit**: That's right saves it as the note; Edit opens it for correction and Save stores the corrected text.
- a saved note is shown as the approved humor note, with who and when, and **Edit**. The latest joke read still shows beside it, since under an approved note it can flag an ambiguity or conflict. Generated text never replaces the note.
- a fact with no candidates yet can still have a note written directly.

Saving shows a saving state and then the saved state; a failed save says so and keeps the text. A correction being typed is kept when polling delivers a new generation.

The panel's failure message is corrected: it suggests writing a scene by hand, but approving a gag requires a successful idea generation (`routes/reviews.ts:1096`). That gate stays. With no fallback model, a fact's gag cannot be approved while Astra is unavailable; the message says so and offers Regenerate.

**F. Freshness.** The existing checks stay (same review, same candidate version, same input hash), and one is added: the stored gags are current only when the fact has no saved note, or the saved note equals the note they were generated under or their own joke read. The note is kept out of the input hash so that confirming does not invalidate the gags it was confirmed beside. So confirming a correct read leaves the three gags usable, and a correction marks them out of date and offers Regenerate, which then runs under the corrected note. A generation that finishes after a note was saved or changed does not touch the note; its gags are judged against the saved note by the same rule.

## Data model and migration impact

One expand-only migration (0137):

- `facts.humor_note text null`, `facts.humor_note_approved_by` (user id, set null on user deletion), `facts.humor_note_approved_at timestamptz null`. Existing rows stay null. No backfill.
- Data change: set `admin_config.value` for `fact_visual_concepts_engine_id` to the new engine id, recording the previous value. Idempotent; reports what it changed. After it runs, the resolved model for gag generation is checked to be `gpt-6-astra`, not merely that the engine row exists.

Row states: old facts have a null note and an old-shape blob with no `jokeRead`. Old blobs still parse, and their cards read as out of date, because the input hash covers the prompt version, prompt text and engine, all of which change; that is the ordinary staleness behavior, and nothing regenerates automatically. Saved, approved scenes and bubbles are untouched. No rewrite of stored blobs. Rollback is a code rollback plus restoring the recorded config value; the three nullable columns stay, so no human note is destroyed.

`humor_note` is outside `enrichment`, so enrichment refresh, candidate promotion and human-override preservation do not reach it. Account deletion and data-lifecycle code are checked for the new user reference.

## Runtime behavior

- Generation is still one job per review cycle, enqueued where it is today, with the same cost guard (only while the review is unresolved).
- Cost per generation rises from about $0.13 to about $0.25. That figure is provisional: an estimate from published prices ($10 and $50 per million input and output tokens), to be replaced by measured usage including corrective retries and tokenizer calls. It applies to each fact entering paid preparation after triage, each refresh, and each Regenerate (accepted by David, 2026-11-13).
- A generation takes longer on Astra at high effort; the existing three-minute timeout and "still running" state apply. If real runs approach the timeout, the timeout is raised, not the effort lowered.

## Admin UX impact

The joke read and humor note card (E), in the existing candidates panel; statuses per the async-status rule (pending, ok, failed, out of date). No end-user surface changes.

## Security, permissions and validation

- Note save: the same server-side admin permission as saving the visual concept; length-capped; plain text; rejected for a fact the moderator cannot act on.
- The note and the joke read are model or moderator text placed into a later prompt: they are sent as data inside a labelled block, as the saved gag already is.
- No new external vendor; the OpenAI key and call path are the existing ones.

## Testing plan

What each establishes:

- the request contains each block when its source is present and omits it when absent; it contains no curly-brace token, no strategy example and no taxonomy score; the caption reads with Alex;
- the render policy reaches the request (violence and supporting text), including a moderator's soften or suppress;
- conversion: a scene and a bubble line come back with the subject token; another character's pronoun is left alone ("Dad nods; he takes it seriously"); a tokenizer that returns its input unchanged yields an unpickable gag, not a stored "Alex";
- an unusable engine fails the generation at once with no call to another model, and the review detail still loads with a previously stored blob, the saved note, and the failure and its recovery action;
- after the migration the gag generator resolves to `gpt-6-astra`, from the old default and from a custom previous value, and the render planner's engine is unchanged;
- the note: Confirm and Save write it with the moderator and time; a generation finishing afterwards leaves it unchanged; enrichment refresh leaves it unchanged; a variant's note is its own;
- freshness: confirm keeps the gags current; a correction marks them out of date; regenerating under the note makes the new ones current; a changed fact, policy or review still marks them out of date whatever the note says;
- a refresh with approved gag A, saved refresh candidate B and unsaved draft C sends A as the saved gag and C as the working draft, bubbles included;
- all three enqueue paths (first-time, refresh, Regenerate) produce a request with the render policy and the note;
- old-shape blobs parse and show as out of date;
- the prompt constant's sha256 equals the locked digest;
- the moderation panel: read, confirm, edit, save, failed save, reload, a regeneration under an approved note whose read differs, and a typed correction surviving a poll (component tests; one browser test of the journey against the stubbed generator).

The first implementation step is one real call with the locked prompt and the real response schema, through tokenization, recording token usage, completion status and elapsed time. After merge, on dev, with real calls (paid, within the per-run budget, recorded on the ledger): generate gags for five facts and confirm the engine in provenance is the new one. And the age check: generate and render the "drove mom home" fact once, with an adult reference photo that has visible facial hair, and report three things separately: the newborn body, the de-aged likeness, and whether the facial hair was kept. A failure there is its own item.

## Risks

- **Astra may not be reachable from this account through the call path the app uses.** OpenAI's documentation lists Chat Completions and Structured Outputs for it; the first step of implementation is one real call. If it is refused, that is a blocker brought to David, not a fallback.
- **The tokenizer may mis-assign a pronoun.** The prompt's "prefer the name, use they for Alex" keeps this rare; a wrong token is visible to the moderator in the scene text before any picture is made, and editable there.
- **A fact's text can change after its note is saved.** The note is kept and shown (decision 9).
- **Nobody has run the locked prompt.** The UAT is where its gags are first judged.

## Items for David at approval

None open. The three items raised with the draft were answered on 2026-11-13 and are decisions 5 and 9 and the cost line under Runtime behavior. One consequence of decision 5 is named for him: while Astra is unavailable a fact's gag cannot be approved, because approval already requires a successful idea generation.

## Documentation

`visual-pipeline.md` (the candidate generator, the request, the joke read and note, freshness), the moderation subsystem doc, the glossary (joke read, humor note), `decisions.md` (the engine choice and no-fallback; the note's ownership), and the Manual chapter at the next harvest.

## Definition of done

A moderator opens a fact in moderation and sees a joke read and three gags written by Astra under the locked prompt; confirms or corrects the read; regenerates under the saved note; picks a gag whose scene and bubbles carry tokens; and none of this changed the render planner, an approved gag, or a saved note. David's UAT judges the reads and the gags. The age check is reported.
