# Plan — up to three approved gags per fact, all first-class

```plan-oracle
Direction served
docs/ai-context/product-strategy.md, "Gags and examples" (approved 2026-11-11): "A fact can have up to three approved gags. One is required; the second and third are optional, added at a moderator's discretion. Where a fact has more than one, the user picks. Built before launch at David's direction." and "Examples are stored per gag and per look ... Only one unstyled example per approved gag is required; styled examples are optional."

Product intent (this plan)
A fact's wording is fixed from the moment it is accepted at triage. A fact has one to three gags, and every gag is the same kind of thing: stored the same way, approved the same way, rendered the same way. A gag is approved when a moderator approves one of its test renders, and that render becomes the gag's example. A new gag, or a change to an existing gag, changes nothing users get until its example is approved. Additional gags are optional; a fact with one gag is complete, and having more only widens the choice a user gets when making an AI picture. Anything that draws a fact's picture without a picker uses the fact's default gag. (No user AI-picture route exists today; launch Phase 7 rebuilds it, and must offer a picker wherever more than one gag is available.)

Must not change
- What any existing fact renders: for a fact with one gag, the scene, bubbles and compiled prompt are identical before and after.
- A live fact always has at least one approved gag, enforced by the database as well as the code.
- The moderator-authored scene stays authoritative and verbatim at render time; one source of truth per gag.
- Blind moderation, the legal-safety rules, the humor note (one per fact, moderator-written only), the gag writer's locked prompt.
- No paid render fires without a moderator's action; no catalogue-wide re-render.
- The refresh (send-back) cycle for a live fact still works and still never touches what users get until promoted.

Settled decisions
1. Up to three approved gags per fact; one required, two optional, at a moderator's discretion (strategy, 2026-11-11).
2. A gag added to a live fact stays hidden until its example is approved (David, 2026-11-14, Issue #943).
3. Users see the first gag until the picker exists (David, 2026-11-14, Issue #943).
4. Built before launch (David, 2026-11-11).
5. Examples are not re-rendered across the catalogue and are not meme backgrounds (strategy).
6. Scope agreed by David, 2026-11-14 ("Option 1"), Issue #949: storage for up to three gags in a fixed order; each gag owns its whole scene-specific setup; "its example is approved" means a moderator approved an unstyled test render of that gag and the fact records which render, with no waiver; moderators can add, approve and remove gags on a fact in moderation and on a live fact without sending the whole live fact back through review; an approved example stays approved when engine or prompt settings change later.
7. All gags are first-class (David, 2026-11-14): "I strongly feel that additional gags should be first class citizens in the code. All gags are gags. Doesn't matter if it's the first one or the third one. They all use the same rules, same systems, same approvals, etc. Don't treat them differently." And: "Nobody is using the system currently so shouldn't we just do it right the first time?"
8. The example (David, 2026-11-14): "When the admin approves a test render for a gag, that test render becomes the 'example' image of that gag."
9. The candidate flow (David, 2026-11-14): "There should be a way to say 'Use this instead of the current default gag' vs. 'Use this as an additional gag'. Any existing gag should be able to be updated/overwritten by a new gag if the admin asks for more examples and wants to update multiple gags."
10. During a refresh, gags cannot be changed outside the refresh's own review (David, 2026-11-14): "No. Gags get written as the last step of a refresh. If the taxonomy isn't done, you shouldn't be able to add gag info."
11. After a refresh changes a fact's classification, its approved gags stay available (David, 2026-11-14: "Yes").
12. A fact's wording does not change (David, 2026-11-14: "A facts wording can never change"), so gag approval is not tied to wording.
13. The picker (David, 2026-11-14): "Be sure that if there are multiple gags available that there is a picker for the user to choose which one they want to use."
14. Existing live facts, which have no example on record, stay live (David, 2026-11-14, Q3: "Stay live"), marked "no example yet" until a moderator approves a render for each.
15. The picker's screen waits for launch Phase 7, when user AI pictures return; this plan builds the list it reads (David, 2026-11-14, Q4: "Yes").
16. A fact's wording cannot be edited (David, 2026-11-14, Q5): "Remove the ability to change a fact's text. If there's an issue with the fact it should be removed and a new one created." The replacement is a new fact: it starts with no votes, comments or shares, memes already made stay with the old fact, and the old fact's variants go down with it (confirmed by David, 2026-11-14).
17. The one editing window is triage (David, 2026-11-14, Q6): "Live facts only. If it's a new fact and it's in moderation, an admin should be able to edit it before any enrichment happens. Once it's locked, that's it. Locking should be the very first thing that happens as part of step 1." So an admin can edit a submission's wording at triage; accepting it at triage locks the wording before anything else runs; after that it never changes, in moderation or live.

Next (not in this plan)
The picker's screen and the user AI-picture flow it belongs to (launch Phase 7, which this plan hands the list of available gags and their examples); showing example pictures on public fact pages; styled examples per look and the site-wide style samples; reordering gags.

Never
Re-rendering examples across the catalogue; examples as meme backgrounds; a fourth gag.
```

## Problem

A fact stores exactly one gag, inside its enrichment record (`enrichment.visualPromptStrategyOverride`). The gag writer drafts three candidates, but picking one overwrites the single saved gag. The strategy calls for up to three approved gags per fact, and David's direction is that they are all the same kind of thing.

## Direction

`product-strategy.md`, *Gags and examples*. This plan makes true: gags are their own records, one to three per fact, each approved by its example; every render says which gag it drew; and the list a picker needs exists. It does not build the user AI-picture flow or public example pages.

## Product Intent, Must Not Change, Settled Decisions

As in the `plan-oracle` block above, verbatim.

## What changed from the plan David read on 2026-11-14

- The first gag is no longer left in the enrichment record with additional gags beside it. Every gag moves to one table (decision 7).
- Two lines he had agreed are replaced by decision 7's "same rules, same approvals", and are named here so they are read rather than inferred:
  1. *"Existing direct editing of a live fact's first gag keeps working as it does today."* Today an edit to a live fact's gag reaches users at once with no render. Now an edit to any gag on a live fact is a pending change, and users keep the approved version until the change's example is approved.
  2. *The no-waiver example gate for the first gag was Phase 7's.* It arrives now: a fact goes live only when at least one gag has an approved example.
- Wording hashes are dropped (decision 12), and the wording itself is locked (decisions 16 and 17), so an example can never sit under wording it was not approved for.

## Vocabulary

- **Gag**: one way of making a fact's joke visible, with its whole visual setup. A fact has one to three.
- **Approved version**: the content users get, with its example. **Pending change**: content a moderator has saved that is not approved yet. A gag can have both.
- **Available**: a gag with an approved version on a live fact.
- **Default gag**: the available gag in the lowest slot. Derived, never stored.

## Repo Context Inspected (at `1e00bd2`)

- Docs: `product-strategy.md`, `visual-pipeline.md`, `moderation-workflow.md`, `launch-definition.md`, `glossary.md`, `overlay-declarations.md`, `meme-and-video-studio.md` (*AI image memes*: "There are none."), `PLAN_GAG_GENERATOR.md`.
- Schema: `facts.ts`, `reviews.ts`, `imagePromptAttempts.ts`, `factEnrichmentVersions.ts`, `imageProvenance.ts`; latest migration `0138_ai_settings_in_code`; eleven trigger statements already exist in `lib/db/migrations`.
- API contracts: `lib/api-zod/src/visualStrategyOverride.ts`, `visualConcepts.ts`, `renderScenarios.ts`, `taxonomy.ts`, `enrichmentOverrides.ts`.
- Server: `routes/reviews.ts`, `routes/admin.ts`, `lib/reviewRenderScenarios.ts`, `factRenderScenarios.ts`, `imagePromptAttempts.ts`, `imagePromptJobs.ts`, `enrichmentVersioning.ts`, `sendBackToReview.ts`, `moderationStaging.ts`, `factActivation.ts`, `factEnrichment.ts` (`materializeEnrichment`), `confirmedFactTextEdit.ts`, `visualConceptJobs.ts`, `visualConcepts/inputHash.ts`, `imagePrompt/generator.ts`, `compilers/nanoBanana2.ts`, `promptBudget.ts`, `comparison/runs.ts`.
- Admin UI: `pages/admin/moderation.tsx`, `pages/admin/facts.tsx`, `VisualConceptCard.tsx`, `VisualConceptCandidates.tsx`, `EnrichmentEditor.tsx`, `FactVisualReviewGrid.tsx`, `useFactEnrichmentEditing.ts`.

## Current Behavior

1. One gag per fact: the whole visual override object inside `facts.enrichment`. It holds the scene, bubbles, role bindings, required and forbidden details, subject realization, composition guidance, prompt additions, negative additions, and two settings (supporting text, violence) whose `guidance` text is scene-specific and is emitted into the picture instructions (`EnrichmentEditor.tsx:1444`, `nanoBanana2.ts:384`).
2. The override is also a layer of the enrichment machinery: `materializeEnrichment` (`factEnrichment.ts`) writes it into the effective blob; re-enrich and backfill preserve it; a refresh candidate carries its own copy (`fact_enrichment_versions.visual_override`), and promotion replaces `facts.enrichment` wholesale.
3. `facts_active_requires_concept`, a CHECK on `facts`, refuses an active fact whose enrichment has no scene. `activateFact` re-checks it in the activating transaction.
4. The planner and compiler read the override from each attempt's frozen enrichment snapshot (`imagePromptJobs.ts:117`). The freshness hash and the candidate-currency hash both include the whole override (`factRenderScenarios.ts:121`, `visualConcepts/inputHash.ts`).
5. Reference to the override or its scene appears in 41 non-test source files and 40 test files (`git grep -c "visualPromptStrategyOverride\|coreSceneOverride"`, 2026-11-14).
6. Three places insert render attempts, all admin-only. There is no user route.
7. Moderation test renders are keyed by review id and scenario key. Approving the visual gag detaches a review's earlier attempts and force-enqueues the default batch (`generic_t2i`, `i2i_male_default`, `i2i_female_default`), all unstyled. Production approval requires those three to be finished and fresh, or waived; no render is recorded as the fact's example.
8. A live fact's gag is edited through `PATCH /admin/facts/:id/enrichment` and reaches users at once. That route and its siblings are refused with 409 `REFRESH_IN_REVIEW` while a refresh is open.
9. A live fact's wording can be changed by a rare, warning-gated edit (`confirmedFactTextEdit.ts`: typed phrase, reason, audit row), which keeps the enrichment and the gag.
10. The three AI candidates are a latest-only blob on the fact, tied to a review; regeneration exists only at a review's Visual Concept step; a pick fills the single gag's draft.

## Source-of-Truth Analysis

| Concept | Today | After this plan |
| --- | --- | --- |
| A gag's content | inside `facts.enrichment` (and a copy on a refresh candidate) | its row in the gags table, and nowhere else |
| A fact's classification | `facts.enrichment` and its layers | unchanged, minus the gag |
| A gag's example | not recorded | on the gag's row |
| What users get for a gag | whatever is saved | the gag's approved version |
| Whether a live fact has a gag | CHECK on the enrichment blob | a database rule across the fact and its gags |
| Which gag a render drew | implicit | a column on the attempt |
| What the engine receives | render-time plan and compiler | unchanged |

Nothing is mirrored. The stored enrichment stops carrying a gag; the render input is assembled from the classification and one gag version at the moment a render is built, in the shape the planner and compiler already read.

## Proposed Design

### A. Storage

A gags table, one row per gag:

- an id that is the gag's identity for life;
- the fact, and a slot of 1, 2 or 3;
- an **approved version**: content (a complete visual override object with a non-empty scene), the example attempt, who approved and when. Empty until first approved;
- a **pending change**: content, and, where the change is waiting on a refresh's approval (section D), the render picked as its example or a pending removal, each with the review it belongs to. Empty when there is none;
- removed-at and removed-by; created-by; timestamps.

Enforced by the database:

- slot is 1 to 3, with at most one non-removed gag per fact and slot, so a fourth cannot be stored;
- a non-removed gag has an approved version, a pending change, or both;
- an approved version has an example, except rows the migration marks as carried over (below);
- content has a non-empty scene;
- **a live fact has at least one non-removed gag with an approved version.** Because this spans two tables it is a constraint trigger on both, checked at commit, replacing `facts_active_requires_concept`. It refuses activating a fact with no approved gag, and removing or emptying the last approved gag of a live fact, including by raw SQL. Checking at commit does not by itself stop two transactions each removing a different gag, since each still sees the other's. So the rule first takes a lock on the fact's row and then validates, which serialises every change that can affect it for one fact. The fact is locked before its gags everywhere, matching the order activation and refresh promotion already use. Its tests must show that validation sees the preceding committed change and that raw-SQL changes get the same protection; showing a lock was taken is not enough.

`facts.enrichment`, the refresh candidate rows and `materializeEnrichment` no longer hold a gag. Render attempts gain one column naming the gag drawn; history keeps its frozen snapshots as they are.

### B. One resolver

One server module, used by every caller:

1. **Render input.** Given a classification and one gag version, return an enrichment in the existing shape with that version as its override. This is the only place the two are joined.
2. **Available gags.** For a live fact: its non-removed gags with an approved version, in slot order, each with its id and example. The first is the default gag. This is what Phase 7's AI-picture flow and picker call; a caller that names no gag gets the default, and a non-admin caller may only name an available gag.
3. **A gag's status for moderators**: new and hidden; approved and available; approved with a pending change; renders running; ready for an example.

Every existing reader of the override (comparison and eval tooling, the admin prompt preview, the gag writer's context, the legacy fixture export, the acceptance driver) goes through it and names the default gag where it named "the gag".

### C. One lifecycle for every gag

- **Save content** to a gag: becomes its pending change. Same validation and prompt-budget check as today's save (`validateVisualStrategyOverridePersistence`). A saved change never alters the approved version.
- **Run test renders** for a gag: a moderator's explicit action, the same default unstyled batch through the existing queue, attempt builder and compiler, drawing the pending change if there is one and the approved version otherwise. Attempts are looked up by gag and scenario, and keep the existing test-render controls, in particular `mirrorToLegacyStorage: false` (`imagePromptJobs.ts:82`), which selects preview sizing and keeps them out of the fact's shared images.
- **Approve a test render**: the moderator picks one finished render of that gag. It is accepted only if it belongs to this gag, finished with an image, used no look style, and its frozen snapshot holds exactly the content being approved. That render becomes the gag's example and the content becomes the approved version, in one compare-and-set. There is no waiver and no other way to approve a gag.
- **Discard a pending change**: the approved version is untouched.
- **Remove** a gag: allowed unless it is the last approved gag of a live fact.

Approval is stored and does not depend on the freshness hash, so a later engine, recipe or classification change revokes nothing (decisions 6 and 11). The panel shows "fact refreshed since approval" as a note for a moderator; it does not hide a gag.

### D. Where it happens

**First-time moderation.** The Visual Concept step becomes the Gags step: the moderator saves one to three gags from the candidates or by hand. Approving the step fires each gag's default batch, as it fires one batch today. At Test Renders the moderator approves a render for each gag they want. Approve for production requires at least one approved gag and activates the fact with whatever is approved; a gag still pending stays hidden and can be finished later. The waiver keeps its role for the other render scenarios and no longer exists for "no approved gag".

**A live fact, no review open.** From the Facts editor: add a gag, change any gag, run its test renders, approve a render, remove. Approval takes effect at once.

**A refresh.** Gags are frozen outside the refresh's own review (decision 10). Inside it, after the classification step, the moderator can leave the gags alone or change them, and renders are drawn against the candidate classification. Every gag operation performed inside a refresh belongs to that review: content changes, example picks and removals all stay pending until promotion. Promotion applies only that review's eligible changes, in the same transaction as the classification, and checks that an approved gag remains. So users never get a gag approved against a classification they do not have, and removing the default gag inside a refresh changes nothing until the refresh is approved. A decline keeps draft content but cancels that review's picks and removals; a later review cannot apply an earlier review's pick or removal without a new moderator decision. Editing content cancels any pick made for the content it replaces. A live edit racing the opening of a refresh keeps today's transaction boundaries: one wins, and the loser is refused. Approving a refresh does not require re-approving unchanged gags (decision 11).

**Deactivate, reactivate, delete.** Gags stay with the fact; resubmission runs the same Gags step with the existing gags in place; deleting the fact deletes them.

### E. Admin surface

One Gags panel, the same component on the moderation screen and in the Facts editor, replacing today's single Visual Concept card and render grid:

- one card per gag, slot 1 to 3, each showing its status in words, its approved example if it has one, and whether users could be offered it;
- the existing scene, bubble and advanced-options editors per gag;
- on every AI candidate card: **Use instead of the default gag**, **Use as an additional gag** (while fewer than three exist), and **Replace gag 2 / gag 3** where they exist, so one batch of candidates can update several gags (decision 9). Each fills that gag's pending change;
- **Run test renders** per gag, with per-render status and a per-gag summary, live, following the two-altitude async rule and reusing the existing grid and polling helpers;
- **Approve this render** on a finished render, which sets the example;
- **Discard change** and **Remove**, with confirmations;
- during a refresh, in the Facts editor: a notice that gags are edited in the refresh's review.

### F. The gag writer

- Its request lists every gag of the fact as existing gags. The locked system prompt already speaks of "existing gags" and is not edited. The request contract version is bumped.
- **Draft more gags** on a live fact: the gag writer can run outside a review, with the same engine, prompt, validation and latest-only store. Refused while a review is open.
- **One owner per generation**: each request carries its owner (a live-drafting request or a review cycle); success, failure and abandonment update the fact's candidate state only while that owner holds it, and opening a review takes ownership. The request and its currency hash use the same frozen list of gags.

### G. Wording locks at triage

- **At triage**, before a submission is accepted, an admin can edit its wording. The edited text passes the same checks a submission does (length, token grammar), the duplicate match is recomputed against it, and the review records who edited it and the wording as submitted.
- **Accepting at triage locks the wording first**, before the staging fact's classification or any other paid work is requested. From then on nothing changes it.
- **Both later edit paths are removed**: the edit of a staging fact's text during moderation, which today discards and re-runs the classification, and the confirmation-gated edit of a live fact's text (`confirmedFactTextEdit.ts`, the text half of `PATCH /admin/facts/:id`). The Facts editor and the moderation screen show the wording read-only after triage, with a line saying a wording problem means removing the fact and submitting a new one. Past entries in the wording-edit history stay readable.
- **Enforced by the database**: a fact's text cannot be updated once the row exists. Token or normalisation repairs that would rewrite stored text are no longer possible in place; one would need its own migration that lifts the rule, on David's say.
- **Replacing a live fact's wording**: deactivate the old fact using the existing soft-delete path, which also deactivates its active variants. The old fact and its memes are kept; hard deletion is not the route, because deleting a fact's row deletes its memes with it (`memes.ts:8`). Submit the corrected wording as a new fact, with no transferred votes, comments or shares.
- **Replacing a submission that is past triage**: today nothing can close it. A first-time submission cannot be rejected after triage (`reviews.ts:991`), a staging fact is already inactive, and deleting it leaves its review parked and still counted against the submitter's pending limit (`reviews.ts:185`). So a moderator gets one new action, **Withdraw: wording needs replacing**, available from acceptance until production approval. It makes the review terminal, keeps the fact inactive for good, and a prep result or stale action arriving afterwards cannot reopen or approve it. The corrected wording is then submitted and enters triage as a new fact. This is the only new way a submission ends after triage; the existing rule that a moderator fixes rather than rejects stays for everything else.
- **The triage edit and acceptance are serialised on the review**, so an edit that succeeds cannot be replaced by wording read earlier when acceptance creates the locked fact (`reviews.ts:889` reads the review before its transaction today).

### Alternatives considered

- **First gag stays in the enrichment, additional gags in a table** (the 2026-11-14 draft). Rejected by decision 7, and on the merits: it needed special cases for the first gag's approval, editing and render tracking, and Phase 7 would have had to unify later with real data.
- **Mirroring the default gag into the enrichment** so existing readers keep working. Rejected: two homes for one gag is the failure this repository has hit most.
- **A separate versions table per gag.** Rejected: one approved version and at most one pending change is all the behaviour needs; history lives in the attempts and the audit columns.

## Data Model and Migration Impact

One forward-only migration, shipped in the same release as the code that needs it, reviewed with `overhype-migration-review`. The repository's migration policy allows a contract in the same release before Seed (`docs/engineering/migrations-and-backfills.md`, *When it binds: from Seed*), and an expand-then-contract split does not work here: on a half-way release the old CHECK would reject every re-enrich and refresh promotion once writers stop storing the gag, an old instance could not activate a fact under the new rule, migrated staging gags could not be approved, and edits made by old instances after the copy would be lost.

In one transaction it:

1. Creates the gags table and the attempt column.
2. Records, per fact and per open refresh candidate, the override it is about to move, in `feature_permissions_migration_log` under this migration's name, as migration 0138 did for the settings it deleted.
3. For every fact whose enrichment holds a non-empty scene, inserts a slot-1 gag with that override as its content, then removes the override from `facts.enrichment`. Same for the copy on any open refresh candidate.
4. Replaces `facts_active_requires_concept` with the trigger rule.

| Row state before | After |
| --- | --- |
| Live fact with a gag | slot-1 gag, approved version, **no example, marked carried over** (decision 14) |
| Staging fact with a saved gag | slot-1 gag, pending change only |
| Fact with no gag (staging, never enriched) | no gag row |
| Open refresh whose candidate gag differs from the live one | live gag as approved version, candidate's as its pending change, owned by that review |
| Open refresh whose candidate gag is identical | no pending change |
| Enrichment that fails validation | gag still moved byte-for-byte; the enrichment is left otherwise as it was; counted |
| Existing attempts | gag column empty; snapshots unchanged |
| Re-run | no-op: a fact that already has a slot-1 gag is skipped |

The migration logs counts for each row of the table and fails if a live fact would end without an approved gag. The override's bytes are compared before and after for every moved gag.

**Carried-over gags.** Live facts today have no recorded example, because none was ever chosen. Per decision 14 they stay live with a "no example yet" note until a moderator approves a render for them. The marker is set only by the migration; nothing else can create an approved version without an example.

**Recovery.** Because the release is published as one unit, a brief window exists where an old instance reads a gag from the enrichment and finds none; before Seed that harms no user, and the publish is done when moderation is idle. Going back after publish is a reverse migration, written and tested with the forward one, that rebuilds every prior state from the log: live gags, staging gags held only as pending content, and an open refresh's differing candidate gag. It is valid until the first gag is added, changed or approved under the new model; after that, going back would lose moderators' work and the route is fix-forward. Running it is David's call.

## Runtime Behavior and Edge Cases

- A fact with one approved gag behaves as today on every path that draws a picture.
- Two moderators on one gag: approval is a compare-and-set on the content being approved; a change saved first makes the approval fail with a clear message.
- A render in flight when its gag changes finishes and is kept as history; it cannot be approved for the new content.
- A failed render shows its reason and is re-run by the moderator.
- Removing the default gag of a live fact that has another approved gag makes that one the default.
- A refresh promoted while a gag has a pending change with no picked render: the change stays pending.
- Variants are their own facts with their own gags.
- Re-enrich and backfill no longer need to preserve a gag, because it is not in what they write.
- A wording problem noticed after triage, during the Gags or Test Renders step: the moderator withdraws that submission (section G) and submits the corrected wording as a new one.

## Security, Permissions and Validation

- Every new route is `requireAdmin`, validated server-side with schemas in `lib/api-zod`; new exports go through the codegen allowlist in `lib/api-spec/patch-generated.mjs`.
- Content is token-canonicalized and validated on save by the functions used today.
- Platform safety checks that are not moderator settings (the legal-safety rules, the NSFW check) apply to every render as now.
- No public route returns gags in this plan; the available-gags function is server-side, for Phase 7.
- Approvals, removals and creations record the acting admin.

## Testing Plan

Invariants the automated tests must prove, with negative cases:

1. **Unchanged output.** For every existing compiler fixture and the acceptance facts, the compiled prompt from the migrated storage equals the prompt before, with a fixed planner result.
2. **Migration.** Each row state in the table above, from a fixture database built at the prior migration; byte equality of every moved gag; the counts; a second run changes nothing; the reverse migration restores every row state, including a staging gag and an open refresh's differing gag. On the migrated fixture, first-time moderation, a live edit and a refresh promotion each complete.
3. **One home.** After increment 1 no stored enrichment (fact or candidate) contains an override, and no code path writes one there. The sweep oracle is `git grep -n "visualPromptStrategyOverride\|coreSceneOverride"` over the tracked set, with the map's symbol query beside it; every remaining hit is the render-input shape, a frozen snapshot, or the resolver, and the list is recorded in the PR.
4. **Database rules, by raw SQL.** A fourth gag; a duplicate live slot; an approved version without an example outside the migration's marker; an empty scene; activating a fact with no approved gag; removing the last approved gag of a live fact. With two connections: two concurrent removals of a live fact's two approved gags, and an activation racing a removal, each leave the rule intact.
5. **Approval.** Refused for another gag's render, an unfinished or failed render, a styled render, and a render of other content. Accepted otherwise, and then that render is the example. No route approves a gag any other way.
6. **Hidden until approved.** A new gag and a pending change are absent from the available list and from every non-admin render; the approved version keeps being served while a change is pending. A caller naming no gag gets the default.
7. **Same rules for every slot.** The lifecycle, approval and render tests run identically against slots 1, 2 and 3.
8. **Permanence.** Engine, recipe and classification changes leave approvals in place.
9. **Refresh.** Gag changes are refused outside the refresh's review; renders inside it use the candidate classification; a content change, a pick and a removal each take effect only at promotion and atomically with it; removal followed by decline changes nothing users get; a pick or removal from a declined refresh is not applied by a later one; editing after picking cancels the pick; a live edit racing the opening of a refresh has one winner.
10. **No unprompted spend.** Saving, discarding and removing enqueue nothing.
11. **The gag writer.** The request lists every gag; Draft more gags is refused while a review is open; with a delayed generation double, in both completion orders, a live drafting job that ends after a review opened leaves the review's candidates and status untouched.
12. **First-time moderation.** Production approval is refused with no approved gag and succeeds with one, leaving a second pending gag hidden.

13. **Wording.** At triage an admin edit changes the wording, is validated, recomputes the duplicate match and is recorded. After acceptance every route that could change a fact's text refuses, for staging and live facts; a raw SQL update of a fact's text is refused; accepting at triage requests no paid work before the wording is locked. The sweep oracle for writers is `git grep -n` for writes to the facts table's text columns, recorded in the PR. A triage edit racing acceptance, in both completion orders, locks the edited wording or refuses the edit, never the stale wording. A withdrawn submission leaves the pending queue and the submitter's pending count, stays terminal through a delayed prep result, and cannot be activated; its replacement starts at triage. Replacing a live fact that has memes and active variants: the memes keep their association, the variants become inactive, and the replacement has a new identity and no engagement history.

Runners: `pnpm --filter @workspace/api-server test`, the frontend unit suite, `pnpm run check:codegen-drift`, and browser specs for the panel on AI doubles. The gag writer's acceptance recording is re-recorded once, a paid run of about the $1.47 the last one cost.

UAT, David's judgement only: fix a typo in a submission at triage, accept it, and see the wording read-only from then on; moderate a new fact with two gags and approve a render for each; on a live fact, change the default gag and see users would still get the old one until a new render is approved; add a third gag from a fresh batch of candidates; run a refresh and see gags frozen outside it. Each test-render batch is three preview-size pictures.

## Implementation Steps

**Increment 1 — every gag in one place, each approved by its example** (one publishable release)

1. The migration, its log and its reverse; the trigger rule.
2. The resolver; every reader and writer of the override moved to it; the enrichment machinery and the refresh layer stop carrying a gag.
3. Approved version and pending change; per-gag renders; approve a render; the production-approval rule; the refresh behaviour.
4. The Gags panel on the moderation screen and the Facts editor, with the candidate actions.
5. Docs: `glossary.md`, `visual-pipeline.md`, `moderation-workflow.md`, `admin-console.md`, `launch-definition.md`, `decisions.md`; the picker requirement recorded for Phase 7. Increment 3 updates `moderation-workflow.md`, `admin-console.md` and `decisions.md` for the wording lock.

The storage move is built and verified first inside the increment (identical prompts, clean sweep) before the lifecycle is layered on, but nothing is published between them.

**Increment 2 — the gag writer and the picker's list**

6. Every gag in the gag writer's request; Draft more gags on a live fact; generation ownership.
7. The available-gags function finalised for Phase 7, with its tests.

**Increment 3 — wording locks at triage**

8. The wording edit at triage; the lock on acceptance; removal of the two later edit paths; the database rule; the Withdraw action; the read-only wording in the Facts editor and moderation screen.

Increments 2 and 3 do not wait on David's UAT of increment 1, and increment 3 does not depend on the gag work. Until increment 3 ships, the old gated edit still exists; an edit made through it in that window leaves gags as they are.

## Risks and Mitigations

- **Increment 1 is large**: the storage move alone touches 41 source files and 40 test files, and the lifecycle and panel sit on top. It cannot be published in two parts (Data Model, above). Inside the increment the storage move is committed and proven first against its own oracle, identical prompts and a clean sweep, so a regression in it is found before the lifecycle exists.
- **A cross-table rule is harder to keep than a CHECK.** It is a constraint trigger, tested by raw SQL on both sides, and the post-publish structure check already planned before Seed (Issue #628) covers a publish that drops triggers.
- **Moderation spend per fact rises with gag count**: three pictures per gag per batch. Fired only by a moderator.
- **The moderation screen gets heavier.** One card per gag, collapsed when not being worked on.

## Open uncertainty

1. **How many live facts exist** in dev and production is not established here; the migration handles any number and reports it. Resolved at implementation by the migration's dry-run count.
2. **Whether any job deletes a moderation attempt's image.** Astra read `lib/dataLifecycle.ts` and `lib/mediaBackup/expiry.ts` and found neither does; a check for any other deleter stays bounded implementation work, and an example is exempted if one exists.

## Questions for David

None open. Q3, Q4, Q5 and Q6 are answered and are decisions 14 to 17.

## Definition of Done

- Every gag of every fact is a row in one table; no enrichment record holds one.
- A moderator can give a fact one to three gags, at first moderation and on a live fact, and each is approved by approving one of its test renders, which becomes its example.
- A new gag or a change to a gag is hidden until approved, for every slot.
- Candidate cards can replace the default gag, replace another gag, or add one.
- A fourth gag, and a live fact with no approved gag, are refused by the database.
- Facts with one gag compile to the same prompts as before.
- Gags are frozen outside a refresh's review while it is open; approvals inside it land at promotion.
- New candidates avoid every existing gag, and a moderator can draft candidates for a live fact.
- The available-gags list exists for Phase 7, with the default first.
- Existing live facts are still live after the migration, each marked "no example yet".
- A submission's wording can be edited at triage and nowhere else; after acceptance no screen, route or SQL update changes a fact's text.
- A moderator can withdraw a submission whose locked wording is wrong, and replace a live fact by deactivating it and submitting a new one.
- CI green, Codex review returned, UAT run.
