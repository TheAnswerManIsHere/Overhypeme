# Plan — fact lifecycle rebuild: moderation, taxonomy, fact administration

```plan-oracle
# Oracle — fact lifecycle rebuild: moderation, taxonomy, fact administration

Agreed with David in conversation, 2026-11-17 (grilling Q1–Q18; scope approved in words: "Approved"). One plan, three phases, built in order.

## Direction

A human approves every gag, so the machinery built for taxonomy-driven prompts is removed. Moderation becomes four clear steps for new submissions only; a live fact changes only for a stated reason, through one editor, with nothing unreviewed reaching members. (David: "There needs to be a reason to update facts, not just the idea that we've got a new version of the LLM"; "What I don't want to do is to rebuild another whole UI for updating things"; "Deprecated means removed", decisions.md 2026-11-17.)

## Product intent

### Phase 1 — submission and moderation
1. The submission form is the only way a fact enters. The admin paste/JSON import, the CSV import, the API-key import and `docs/llm-import-prompt.md` are removed (Q6).
2. When the server's duplicate verdict says a submission is a duplicate, the form says so in a funny, on-brand message and shows the matching fact; the user may back out or submit anyway, and it arrives at Triage flagged. Identical text is refused. The verdict itself (server-computed, no percentage) is Issue #1003's and is not rebuilt here (Q7, reconciled with #1003's approved plan).
3. The form keeps the helpers it has today — the personalization preview, the grammar check and the hashtag suggestions (David: "A user submits a fact using the fact submission form we have today. The fact submission form is good except…" the duplicate warning). Once a fact is submitted, nothing automated runs on it except the duplicate check: no enrichment starts (David: "there's no enrichment that should start just because a fact has been submitted"). No automated screening of fact text; Triage is the screen (Q8).
4. The moderation queue shows new submissions only. Refresh reviews and every "Send back to review" entry point are removed.
5. Steps: Triage (unchanged) → How the fact was read → Gags → Test Renders. "Provisional approval – start prep" starts the background work; there is no separate enrichment screen (Q1: 2).
6. Step 2 shows the Humor Note, which David approves there, and beneath it, read-only, the reference research it was written from. The rest of the classification is not on moderation (Q12: 1; PLAN_GAG_DIRECT_RENDER Q2: 1). A background failure shows on the step that waits for it, with a retry.
7. The Humor Note is its own AI step, separate from writing gags, written from automatic reference research (web lookup), and stays editable on the Gags step; rewriting it there produces fresh gag ideas, replaces untouched pre-filled gags and keeps hand-edited ones (Q5: 1 and David's grenade example).
8. The gag writer receives the fact and the approved Humor Note only — not the classification — provided a blind with/without comparison David judges shows the ideas are no worse (Q15: 1). It gains a checklist: setting always stated; subject's action, pose and expression; props, outfit and viewpoint only when the joke needs them; lighting and style left to the look. A gag stays one scene paragraph plus bubbles (Q13: 1). The locked prompt is revised and relocked once, and the same revision carries Issue #969 (David, 2026-11-17: "Fold issue 969 into this work with the addition"): the world keeps its real properties and only the hero breaks the rule. The hero stays at human scale; the benchmark is never weakened (it stays at full real strength, or is escalated to mythical strength and still loses); and everything the fact mentions stays at its original scale unless the fact itself says it is larger or smaller (David: "pretty much everything should stay at its original scale unless explicitly told not to… something small doing a lot of damage for example"; the grenade fact, where the writer made the grenade a bowling ball and then a giant object).
9. Gags step: gag 1 exists on arrival, pre-filled from the first idea; "Gag ideas" and "Visual gag" are the names; the explanatory messages David listed are gone. A gag has no approved/hidden state of its own; any gag can be deleted (David: "It's stupid to have a concept of a gag that is halfway there").
10. Each gag's cast stays as built in PLAN_GAG_DIRECT_RENDER: derived from the scene at save, read-only, feeding the speaker list. The fact-level Characters section leaves moderation.
11. Test Renders: three render windows per gag and nothing else from the gag setup; male runs automatically, female and pet on request; "Back to gags". Final hashtags and "Approve for production" are on this step.
12. A fact goes live only when every one of its gags has three approved renders (male, female, pet). This one rule guards going live from moderation, from "Publish changes" and from "Reactivate".
13. "Reject" is on every step, with a required reason, an optional note and the email to the submitter; "Withdraw" is removed; a reason for "couldn't make it work visually" is added (Q2: 1).
14. A live fact's gags and examples change through a working copy members never see, swapped in by one "Publish changes" under rule 12 (Q3: 1). Phase 1 builds the storage; Phase 3 builds the screen.

### Phase 2 — taxonomy
15. The Taxonomy Health page and its machinery are removed: the stale-signature idea, engine revision and "Mark major update", candidate/promote versions, projection repair, the character-fill job, the old Utilities backfill, and the manual-override system (Q9: 1, Q16: 1).
16. The AI taxonomy and the reference research are still produced and stored on every fact (David overrode the recommendation to delete: "I still want to keep the derived metadata… future value"; "I like the cultural reference research and that should remain as stored metadata"). Produced in the background at provisional approval; read-only; each run kept as history; "Re-run" on demand; never blocks moderation; never re-run automatically on a live fact.
17. The checks behind "needs attention": taxonomy missing; an example drawn by an older engine (marked stale, shown until an approved replacement takes over — Q11); duplicate fingerprint missing; a live fact's pictures often failing or refused.

### Phase 3 — fact administration
18. The Facts page lists approved facts only (live or deactivated). The "needs attention" counts act as filters; bulk selection runs the mechanical fixes (cost stated before any paid run); next/previous steps through a filtered set. There is no separate health page.
19. A fact opens in a modal (full-screen on a phone) reusing the moderation screens as tabs: Overview (collapsible groups: identity and origin, scoring, usage, pictures, hashtags), Reading and taxonomy (with run history and "Re-run"), Gags, Renders, History.
20. Editable on a live fact: hashtags and the Humor Note (saved at once, logged); gags and examples (working copy, "Publish changes"). Counters, wording and taxonomy are read-only.
21. Deactivate is the normal removal. "Reactivate" is allowed when rule 12 holds; "Resubmit for moderation" is removed (Q18: 1). Permanent delete is offered only when no member's memes, AI pictures or comments are attached (Q17: 1).
22. Every admin action on a fact is recorded and shown on its History tab.
23. Removed: approved-text edit history, prompt diagnostics, the "evaluation golden" marker, legacy AI-meme columns, hand-editable counters.

## Must not change
- A fact's wording once approved.
- Submitter emails on approval and rejection; captcha, rate limit and pending cap on submission.
- Nothing is shown to members that a person has not approved.
- No admin action destroys a member's memes, AI pictures or comments.
- One editor for a fact's data: no second set of edit forms.
- The Comment Reviews tab.

## Settled decisions
- One plan, three phases, in the order above.
- Modifiers are removed and the gag's wording is the source of truth for appearance (Q10: 3, David over a stated picture-quality risk); the removal itself is PLAN_GAG_DIRECT_RENDER increment 3's (Issue #1016). This plan carries before/after renders of an age-change fact and a violence fact as evidence. **Struck by David, 2026-11-21 (Q35): "strike the promise"; the picture quality is revisited when the user-facing AI memes are tested.**
- The cast stays one separate derived step; the gag writer does not supply it.
- Built on top of the planner removal (Issue #1016) and the duplicate verdict (Issue #1003); neither is rebuilt here.
- Between phases some live-fact admin functions are unavailable; each phase leaves every remaining screen working.

## Now / next / never
- Now: the three phases.
- Next: an AI pre-read of submissions; any bulk import; a fast single-field review screen; the gag writer supplying the cast; comment moderation.
- Never in this plan: changing an approved fact's wording; refresh reviews; a second editing UI.

## Ceremony tier
Product, full feature process; migrations under migration ceremony; the gag-writer prompt change under the visual-pipeline rules.
```

Workstream: #1018. Built on Issue #1016 (the planner removal) and Issue #1003 (the duplicate verdict).

## Preflight

- **Increment test.** Three phases, each with its own completion David can evaluate (Definition of Done). Each phase is split into increments that leave every remaining screen working. The oracle uses "every" and "only" in bounded senses: every *step of the moderation review*, the *only* entry path, every *gag of one fact*.
- **Affected-surface inventory** (run at `9fa9a1c`; `git grep -l -e <pattern> -- artifacts lib`, migrations and generated code excluded; "all files (non-test)"). The scope of each removal is this hit list, re-run at build time, not a recalled one:
  - refresh send-back (`sendBackToReview|fact_send_back|bulk-send-back`): 20 (8)
  - refresh candidates (`candidateVersionId|candidate_version_id|promoteCandidateEnrichmentVersion|findInFlightRefreshCandidate`): 47 (27)
  - imports (`queueTextsForTriage|facts/import|import/facts`): 8 (4)
  - Taxonomy Health (`taxonomyHealth|taxonomy-health|TaxonomyHealth`): 38 (19)
  - override system (`enrichmentOverride|enrichment_overrides|EnrichmentOverride|enrichmentBaselineChanged`): 44 (26)
  - signature and engine revision (`lastProcessedSignature|last_processed_signature|rocessingSignature|engine_revision|engineRevision`): 39 (24)
  - fill, repair and backfill jobs (`fact_character_fill|factCharacterFill|projection_repair|projectionRepair|fact_enrichment_backfill|backfill-enrichment`): 18 (11)
  - resubmit (`resubmit-for-moderation|resubmitForModeration`): 7 (3)
  - withdraw (`ithdraw`): 29 (21)
  - per-gag approved/pending (`approvedVersion|pendingVersion|approved_version|pending_version|approvedExample|pendingExample`): 12 (5); the columns themselves are `approved_*` / `pending_*` on `fact_gags` and `stage` on `fact_gag_examples`
  - text-edit history and golden marker (`fact_text_edit_history|factTextEditHistory|evalGolden|eval_golden`): 12 (10)
  - A first run of these searches with the pathspec `'artifacts/*/src'` returned zero for every pattern, known examples included; the pathspec above is the one that finds them.
- **Claim-oracle rule.** Every "cannot" below names a construct (a database constraint or trigger, or a server refusal). Properties backed only by tests are written as *checked*.
- **Specification test.** The plan states invariants and observable behaviour. Table, column, route and component names are the builder's unless a construct is named.

## Problem

Moderation, taxonomy upkeep and fact administration were built when the taxonomy drove picture prompts automatically. A human now approves every gag, and the planner is being removed (Issue #1016), so most of that machinery maintains data nothing reads, through three screens that share editors with different guards. An inventory of the code at session start found, among others: a bulk re-enrich that resets manual corrections (`isEnrichmentAdminEdited` keys on `enrichedBy === "admin"`, which nothing writes — read in code); a retry that appears to strand a failed refresh (inferred, untested); a hard delete that cascades members' memes (`memes.fact_id … onDelete: "cascade"`, read); imports that skip the similarity check (read); and a first-time submission that can only be rejected at Triage (read, `canReject`).

## Direction

As the oracle. `product-strategy.md` governs where documents disagree; `decisions.md` 2026-11-17 *Deprecated means removed* governs every removal here: no route answering 410, no column kept "as retired".

## Product Intent, Must Not Change, Settled Decisions

The oracle block above, verbatim.

## Repo Context Inspected (at `9fa9a1c`)

Read directly: `lib/db/src/schema/facts.ts`, `factGags.ts`, the list of tables referencing a fact; `lib/api-zod/src/taxonomy.ts`, `enrichmentOverrides.ts`, `processingSignature.ts`; `artifacts/api-server/src/lib/visualConcepts/generator.ts` (what the gag writer is sent, lines 205–232; one call returns the joke read and the ideas, line 263); `imagePrompt/generator.ts` and `compilers/nanoBanana2.ts` (what read the classification before #1016); `lib/referenceResearchConfig.ts` (web lookup); `docs/plans/PLAN_GAG_DIRECT_RENDER.md`; `docs/plans/gag-prompt-LOCKED.md`; the diff of `pages/admin/moderation.tsx` in PR #1002; Issues #1003, #1016, #969, #979.

Taken from a delegated inventory and not re-read by me (each item tagged read or inferred in that report): the route-level detail of `routes/reviews.ts`, `routes/admin.ts`, `routes/adminTaxonomyHealth.ts`, the job list, the notification paths, and the admin pages' controls. Anything a step below rests on is re-read at build time.

## Current Behavior

- **Entry:** the form (`POST /facts/submit-review`), two admin imports, one API-key import, resubmit of an inactive fact, and send-back of a live fact. All create a `pending_reviews` row.
- **Stages:** `triage_pending → prep_pending → (prep_failed) → concept_review → production_review → production_approved`, with `triage_rejected` and `production_rejected`. A refresh of a live fact is an ordinary review row carrying a candidate enrichment version.
- **Gags:** `fact_gags` holds an approved version and a pending change per gag, plus `pending_remove`; `fact_gag_examples` holds male/female/pet examples at stage `approved` or `pending`. A gag reaches users when a moderator approves one of its renders (decisions.md 2026-11-14). Database triggers hold "a live fact keeps an approved gag".
- **The gag writer** is sent the fact, the approved humor note when there is one, reference and term meanings from the classification, and a mechanism line; it returns a joke read and three ideas in one call.
- **Taxonomy:** `facts.enrichment` with an AI baseline, a path-keyed override layer and four projection columns; `fact_enrichment_versions`; a processing signature and engine revision that mark facts stale; Taxonomy Health with twelve checks and bulk repair, re-enrich, character-fill and send-back actions.
- **Fact administration:** a list with the detail panel beside or below it; hand-editable counters; soft and hard delete; live gag edits applied outside any review.

## Source-of-Truth Analysis

- **What a picture shows:** the gag's content (scene, bubbles, cast), per PLAN_GAG_DIRECT_RENDER. Unchanged by this plan.
- **How a fact is read:** the approved Humor Note. It becomes the one input, beside the fact itself, that gag ideas are written from. The reference research is its evidence, stored with it, and never a second authority: where they differ the note wins.
- **Which gags a fact offers members:** its *published set*. The fact is the unit of publication: approving a render records a selection and publishes nothing; removing a gag from a live fact changes only the draft; today's behaviour, where approving a gag's third example applies its pending change at once (`gagStore.ts:396`) and removal is immediate, ends. A fact in moderation has only a *draft set*; a live fact has a published set and, when someone is editing, a draft set. The draft becomes the published set in one step, never gag by gag. The existing `approved_*` / `pending_*` columns already hold two versions per gag; whether they are reused as published/draft or replaced is the builder's choice under the migration review, provided no third state exists.
- **Whether a fact may go live:** one predicate, evaluated server-side on the draft set at "Approve for production" and "Publish changes", and on the published set at "Reactivate": between one and three gags, and every gag has an approved male, female and pet render of its current content. Today's gate (`routes/reviews.ts:639`) asks only for one approved gag and lets unfinished ones stay hidden; it is replaced.
- **Whether a fact was ever approved:** recorded on the fact at "Approve for production" (who and when), separate from `is_active`, which today is false for staging facts and deactivated facts alike. The Facts list and "Reactivate" read that record, so a rejected or unfinished submission can never be listed or reactivated.
- **The taxonomy:** stored AI output with one remaining reader: cast preparation reads the fact-level character labels as naming hints and tolerates their absence (`gags/castPreparation.ts:31`). That contract is kept when the storage changes. It is never an input to a render or to the gag writer once the blind check passes.
- **What happened to a fact:** one admin-action record per fact (new), the source for the History tab.

## Proposed Design

### Phase 1 — submission and moderation

**1A. The blind check (first, evidence only).** The gag writer is run twice on facts David picks (at least six, including one with a cultural reference and one with an ambiguous term): once as today, once with the fact and the approved note only, the note carrying the reference meanings. David sees the idea sets unlabelled and picks per fact. Text only; no render.
- *Passes* (no fact judged worse without the classification): design 1B stands.
- *Fails* (David judges the reduced-input ideas worse on any fact): the input removal stays unshipped. The results are used to revise the research, the note or the gag-writing approach, and a revised comparison is brought back to him. No fallback makes the taxonomy a moderation dependency. Work that does not depend on the outcome (stages, Reject, the published and draft sets, removals) continues.

- *Outcome (2026-11-17):* **pass, by David's decision (Q27).** Run on the candidate prompt with Issue #969's scale rules: without the classification preferred 3, with it 2, 1 tie, all close; David: *"a pass. Unless the extra cost and complexity are creating a significantly better outcome, they must go."* The acceptance rule "no fact judged worse" is replaced by "no meaningful difference" (`decisions.md`, 2026-11-17). 1B stands.

**1B. The reading.** At provisional approval one background AI step produces the draft Humor Note and the reference research (each reference found, what it means, its implication for a picture, its sources), with web lookup available. The order is research from the fact, then the note written from that research, then approval, then gag ideas. It does not depend on the taxonomy run, and the taxonomy run can no longer advance a review or start idea writing (today enrichment completion does both, `moderationStaging.ts:301`). Its output is stored on the fact with who approved the note and when; each run is kept. The research shown with a note is the research that note was written from: a later re-run of research or taxonomy adds a new history entry and never replaces an approved note or its basis. This is new orchestration on the existing durable jobs — the current research endpoint only researches a reference someone has already identified and saves nothing — and no general workflow engine is added.
- Step 2 shows the note, editable, with the research beneath it, read-only. "Approve" records the approval and opens Gags.
- Gag ideas are written in the background from the draft note as soon as it exists. If the approved note differs from the draft, the ideas are written again before Gags opens.
- On the Gags step the note stays editable. Saving a changed note discards unused ideas, writes new ones, replaces any gag whose content is still exactly the idea it was pre-filled from, and discards that gag's renders. A gag edited by hand is kept, including one edited while new ideas were being written: the replacement compares against the gag as it is when the ideas arrive.
- A failed research or note run leaves the Reading step failed and retryable ("Try again"); the review does not move on without a note. A successful run may find no references, which is a result, not a failure. A failure of idea writing shows on Gags with "Try again". Both follow `async-ui-status.md`.
- The taxonomy is outside this path end to end: today's production approval requires valid enrichment (`routes/reviews.ts:633`), and that gate is removed. A new submission reaches live with the taxonomy absent or failed.

**1C. The gag writer.** The locked prompt is revised once and relocked by David: inputs reduced per 1A's outcome; the joke read removed from its output (the note is written before it runs); the checklist added; and Issue #969's revision with David's 2026-11-17 addition (oracle item 8): the hero at human scale, the benchmark never weakened, everything the fact mentions at its original scale unless the fact says otherwise. The revision keeps what #969 says must stay: the other party as a character with a face showing the emotion the joke needs, and room for absurd, personified feats at human scale. It is drafted with Astra, and before David relocks it he judges the revised writer's ideas on the facts that exposed the problems (pushups, the Mount Rushmore chin, the grenade) beside the benchmark facts. `gag-prompt-LOCKED.md` and its benchmark are updated in the same change. The blind check (1A) runs on today's wording in both arms so it measures the inputs alone; the wording revision is judged separately.

**1D. Stages and the four steps.** A review is at exactly one of: Triage, Reading, Gags, Test Renders, Approved, Rejected. There is no stage for "enrichment running" or "enrichment failed": background work has its own status on the step that needs it. A review can move back from Test Renders to Gags. "Reject" from any step takes a required reason (the four existing plus "couldn't make it work visually"), an optional note, sends the rejection email, and discards the submission's gags and renders; nothing of a rejected submission appears on the Facts page. Reject takes the same row lock the other transitions take.

**1E. Gags and Test Renders.** As the oracle, items 9–12. On arrival at Gags, gag 1 exists, pre-filled from the first idea. Removing a gag is allowed at any time, including the last one (approval then refuses, saying a fact needs a gag). Test Renders shows, per gag, three windows; male starts on arrival for any gag without a current male render; female and pet start on request. "Approve for production" evaluates the go-live predicate server-side and names what is missing when it refuses.

**1F. The published and draft sets.** Storage and server rules for a live fact's draft set are built here: edits to a live fact's gags or examples never change what members are offered until "Publish changes"; publishing is one transaction that evaluates the predicate and swaps the set. The current Facts page's live gag editing is removed in this phase (its replacement is Phase 3), so between phases a live fact's gags cannot be edited. The existing hard-delete action and its API are removed in this phase too, since they cascade members' memes, AI pictures and comments (`routes/admin.ts:882`); the guarded replacement arrives in Phase 3, and until then a fact can only be deactivated.

**1I. Admin actions are recorded from the start.** The admin-action record (3C) is created in this phase, and every mutation this plan introduces writes to it as it is built. The existing activity feed is a best-effort, submitter-facing feed and is not used for this. Phase 3 adds the History tab over records that already exist.

**1G. Entry and duplicates.** The three imports and their document are removed. On the form, when Issue #1003's verdict is "duplicate", the message is funny and on-brand and shows the matching fact's text; "Submit anyway" remains; a submission whose text is identical to an existing fact's is refused by the server. The copy is written in the brand voice and judged by David in UAT.

**1H. Refresh and resubmission reviews removed, at the stage cutover.** Every route, job, button and review-side branch that creates or handles a refresh is removed (inventory: send-back and candidate patterns), and so are "Resubmit for moderation" and its route: a resubmission is a review against an existing fact with no candidate version (`resubmitForModeration.ts:94`), so it is not a new submission either. Both go in the same increment that changes the stages, so the queue is never left holding a kind of review the new stages do not describe. Any refresh or resubmission review open at migration time is closed, its candidate or working changes discarded, and its fact left exactly as it was: active or deactivated state, published content and member attachments unchanged. A deactivated fact has no route back until Phase 3's "Reactivate". `fact_enrichment_versions` rows are kept for Phase 2.

### Phase 2 — taxonomy

**2A. Removal.** The Taxonomy Health page, its routes and jobs, the processing signature, engine revision and "Mark major update", projection repair, character fill, the Utilities backfill, and the override system (layers, history, baseline-changed flag, the override editor) are removed. The gag-fold report, which sits on that page, moves with its job to wherever Issue #982's workstream needs it, or is removed if the fold is complete; this is confirmed with that workstream before the page is deleted.

**2B. Stored taxonomy.** One taxonomy run per fact at provisional approval, in the background, and on "Re-run". A run never changes anything members see and never blocks a moderation step. Each run's output is kept as history (existing version rows become history rows). The four projection columns stop being a second copy: either derived by the database or removed, so they cannot drift (construct, not a repair job). The fact-level character list stays inside the stored taxonomy output and is no longer edited.

**2C. The checks.** One server predicate per reason, used by both the counts and the filters: taxonomy missing; example stale (judged from the render's own recorded provenance: drawn by an engine other than the one routed today for its mode or that engine's recorded fallback, or by an older prompt-generation version; no global revision marker is reintroduced); example missing (a live fact's gag without a full set — the facts carried over before example sets); duplicate fingerprint missing; pictures often failing (over a live fact's most recent member and admin renders; the window and threshold are chosen at build time from real data and stated to David). Missing fingerprints are filled automatically; nothing else runs on its own.

### Phase 3 — fact administration

**3A. List and sheet.** As the oracle, items 18–19. The sheet's Gags and Renders tabs are the moderation step components, not copies. Overview groups are read-only except hashtags.

**3B. Controlled change.** "Publish changes" (1F's rule), a visible "unpublished changes" state on the sheet and in the list, and "Discard changes". Deactivate, Reactivate (predicate on the published set), and permanent delete, which the server refuses while any member meme, AI picture or comment references the fact, naming the counts. The refusal holds against a member attaching content at the same moment: the check and the delete are one protected operation, since the foreign keys cascade and a count followed by a delete would not keep the promise. The server refuses writes to counters and to wording.

**3C. History.** Every admin action on a fact from moderation onward (provisional approval, note approval, approval for production, reject, hashtag and note edits, publish, discard, deactivate, reactivate, re-run, delete) writes one record: who, what, when, and enough detail to read what changed. Gag saves, gag removals and render approvals are included, in moderation as well as on a live fact. Triage actions happen before a fact exists, so a record carries the review's identity until a fact does. Discarding a draft does not erase the record of what was done to it. Shown newest first on the History tab.

**3D. Needs attention.** Counts across the top of the list, each a filter; bulk selection; bulk actions limited to the mechanical ones (re-run taxonomy, re-draw stale or missing examples into draft sets), each a tracked job with queued, running, done, failed and skipped counts and a stated cost before any paid run; a bulk re-draw only prepares replacement pictures in draft sets and can neither approve nor publish them; next and previous through the filtered set inside the sheet.

### Alternatives considered

- **Keep a per-gag approval and add a fact-level gate on top.** Rejected by David: two meanings of "approved".
- **Take a live fact offline to edit its gags.** Rejected (Q3): shared links would break while it is reworked.
- **Delete the taxonomy.** Recommended by me, rejected by David (Q14).
- **A separate health page.** Rejected (Q9): a second place for rules to grow.
- **Have the gag writer supply the cast.** Rejected: two producers of one datum.

## Data Model and Migration Impact

Under migration ceremony (`overhype-migration-review`), each migration idempotent, with counts logged per state.

- **Reviews:** stage values change. Existing rows map: triage stages unchanged; `prep_pending`, `prep_failed`, `concept_review` → Reading or Gags by whether a note is approved; `production_review` → Test Renders; `production_approved` → Approved; `triage_rejected` and first-time `production_rejected` (withdrawn) → Rejected, reason kept; refresh rows → closed (1H). Rows already terminal are otherwise untouched (no-op count reported).
- **Facts first, then gags.** The conversion partitions by each fact's lifecycle, never by the old column names, because today a gag's `approved_*` content can exist on an unfinished staging fact (the third render approval applies pending content during first-time moderation, `gagStore.ts:413`) and `pending_review_id` marks refresh ownership only.
  1. *Establish which facts were ever approved*, from existing approval records (a review at `production_approved` for the fact) and established live status. Approval taken from legacy evidence is recorded as legacy, distinct from an approval a person records from now on; no approver is invented. A fact whose history cannot be established is reported by id and left unlisted, not guessed.
  2. *A never-approved submission* has no published set: all its working gags and valid example selections, including content now under `approved_*`, become its draft.
  3. *A previously approved fact*, active or deactivated, keeps its published content as its published set; legitimate unpublished edits outside any review become its draft and stay private.
  4. *Open refresh and resubmission reviews* are closed (1H); refresh-owned pending operations are discarded with their review. Queued refresh, send-back, fill, repair and backfill jobs are cancelled and their queues removed. Under *Deprecated means removed*, obsolete workflow records (refresh reviews, candidate versions, override rows, signature values) are deleted or converted, never kept as inert rows; conversion keeps published content and member attachments and never promotes unfinished work. Example rows follow their gag. The two "approved before examples" markers are replaced by the "example missing" check.
- **Facts:** the humor note gains run history and stored research; override columns, the signature, the legacy AI-meme columns, the golden marker and (2B) the projection columns are dropped after their readers are removed, in that order. `fact_text_edit_history` and `enrichment_override_history` are dropped.
- **New:** the admin-action record (3C).
- **Row states:** old shape, new shape, partially migrated (migration re-run safe), failed (migration aborts and reports the row), skipped and no-op are each counted. There is no production member data in these tables yet; the migrations are still written as if there were.
- **Rollback:** additive steps are a code revert; each destructive drop is its own migration after the code that stops reading it has merged, and carries a `pre-cut/<feature>` tag and a ledger row in `docs/retired/README.md`.

## Runtime Behavior and Edge Cases

- Two moderators on one review: every transition takes the review lock and is a compare-and-set on the stage; the loser is told the review moved.
- A note edit while ideas are being written: the newer note wins; ideas written from an older note are discarded on arrival (compared by the note they were written from).
- Background work and server restarts follow Issue #1000's resume rules; this plan adds no new job runner.
- A member reading a fact's gags during a publish gets the complete previous published set or the complete replacement, example selections included, never a mixture. The member-facing resolver reads content and examples in separate queries today (`gags/resolver.ts:135`), so it is changed to one consistent read; how is the builder's choice.
- Publish while a bulk re-draw is writing into the same draft set: publish evaluates the predicate inside its transaction and refuses if a gag's current content lacks an approved render.
- A fact deactivated with unpublished changes keeps them.
- Reject during a running render: the render's result is discarded; no orphan picture is offered anywhere.

## Admin and User UX Impact

- Submitter: the duplicate message; otherwise unchanged.
- Moderator: four steps with a visible step indicator; a status on each step for its background work; "Reject" in the same place on every step.
- Admin: the Facts page as described; nothing else in the admin console changes except the removal of Taxonomy Health and the Utilities tab.
- Brand and layout follow `overhype-design`.

## Security, Permissions and Validation

All routes stay behind the existing admin permission checks; new routes are added to the permission grid and its test. The go-live predicate, the delete guard, the counter and wording refusals and the identical-text refusal are enforced on the server. Removing the API-key import removes one externally reachable write path; the API-key mechanism itself is removed only if the inventory at build time shows no remaining user.

## Testing Plan

- **Unit and integration:** the go-live predicate over the draft and published sets; stage transitions including reject from each step and concurrent transitions; note-change effects on ideas and pre-filled gags; publish as one transaction; the delete guard; each needs-attention predicate, with counts equal to filter results; migrations over fixtures for the states that separate publication from preparation: an unfinished submission holding approved gag content; a deactivated approved fact; an open refresh; an open resubmission; a live fact with unpublished edits; a fact with no establishable approval.
- **Acceptance journeys** (the existing recorder): submit → four steps → live with the taxonomy run made to fail; reject at step 3 with the email; edit a live fact's gag → unpublished → publish.
- **Browser:** the admin screens suite updated for the four steps and the sheet; phone-width run of the sheet.
- **Evidence David judges:** the blind check (1A); the revised gag writer's ideas on the pushups, Rushmore and grenade facts before the relock (1C); ~~before and after renders of an age-change fact and a violence fact once modifiers are gone (settled decision)~~ (struck, Q35, 2026-11-21); the duplicate message copy.
- **UAT:** judgement steps only — whether the four steps feel right in use, whether the sheet's grouping reads well. Screen facts are assertions in the PRs.

## Implementation Steps

Each increment is one PR; a phase is done when its increments are merged and its Definition of Done holds.

1. **1.1** the blind check harness and David's judgement (no product change).
2. **1.2** the stage cutover: the four stages and steps, the reading step with the note's storage and history, Reject on every step, the admin-action record, the ever-approved record, and the removal of refresh reviews, resubmission and hard delete (1H, 1F). The gag-writer relock ships here if 1.1 passed, and separately when it does. Requires Issue #1016 merged.
3. **1.3** published and draft sets, the fact-level predicate, the simplified Gags and Test Renders steps, removal of live gag editing from the old Facts page.
4. **1.4** removal of imports; the duplicate message and the identical-text refusal. Requires Issue #1003 merged.
5. **2.1** removal of Taxonomy Health and the override system; stored taxonomy with history and "Re-run".
6. **2.2** the needs-attention predicates and their API.
7. **3.1** the list and the fact sheet with its tabs.
8. **3.2** Publish, Discard, Deactivate, Reactivate, guarded delete, History.
9. **3.3** the needs-attention strip, bulk actions and step-through.

## Risks and Mitigations

- **Ideas get worse without the classification.** 1A decides before anything is removed; if it fails, the removal stays unshipped and a revised comparison goes back to David.
- **Other sessions are changing the same files** (Issues #1016, #1003, #1000). Each increment starts from fresh `main`; 1.2 and 1.4 wait for their named dependency.
- **A removal takes something still read.** Each removal re-runs its inventory search and removes readers before columns.
- **Between phases a live fact's gags cannot be edited.** Accepted in the scope; the catalogue is pre-launch.
- **Web lookup adds cost and delay to the reading.** It runs in the background before the moderator arrives; a failure is visible on the step and retryable.

## Open uncertainty

- Whether Issue #1016 changes any gag-writer input this plan names; re-read at 1.2.
- The exact fail-rate threshold for "pictures often failing"; set from data at 2.2.
- Whether the gag-fold report is still needed when 2.1 starts.

## Questions for David

None open. Astra asked whether the form's personalization preview and hashtag suggestions survive "nothing automated on submission" (concern C4); David's own words settle it (oracle item 3, clarified), so it is not asked. Items reported for the approval readout, not asked: facts made live before example sets stay live and appear under "example missing".

## Next (taken from this plan, not in it)

An AI pre-read of submissions; any bulk import; a fast single-field review screen; the gag writer supplying the cast; comment moderation; deleting taxonomy fields nothing reads.

## Definition of Done

- **Phase 1:** a new submission can be taken from the form to live through the four steps with no other screen, with the taxonomy absent or failed; the queue holds no refresh and no resubmission; it can be rejected from any step with the email sent; no import route exists; a fact cannot go live with a gag lacking any of its three approved renders (server refusal, tested); a live fact's offered gags do not change until a publish.
- **Phase 2:** no Taxonomy Health page, override, signature or repair job exists in the code; a taxonomy run failing or being absent blocks nothing; each needs-attention count equals its filter's result.
- **Phase 3:** every action in oracle items 18–22 is available from the Facts page and nowhere else; every such action appears in History; permanent delete is refused while member content is attached; the sheet is usable at phone width.
