# Plan — retire Variants: every fact stands alone

```plan-oracle

Direction served
Launch simplification (the cut-and-prune line of `docs/ai-context/launch-definition.md`; ledger `docs/retired/README.md`). David, 2026-11-15, on being asked whether variants earn their keep: "Option 1. Let's just retire the entire concept. There's no production data we need to worry about. Delete all existing variants and remove all mention from documentation."

Background, measured at commit a15be27:
- Glossary: a variant "owns its own memes, taxonomy/enrichment, Visual Concept, and AI images, and it inherits **no** metadata from its root" — so every alternate wording costs a full moderation pass, paid prep and its own gags (`docs/plans/PLAN_THREE_GAGS.md:228`: "Variants are their own facts with their own gags.").
- Variants are hidden from browse (`artifacts/api-server/src/routes/facts.ts:116-120`) and shown only as "Alternate Phrasings" on the root fact's page (`artifacts/overhype-me/src/pages/FactDetail.tsx:526-535`).
- Variants also reach two other surfaces: related facts can return another root's variants, and a root's meme gallery includes its variants' memes (`artifacts/api-server/src/routes/facts.ts:275`, `artifacts/api-server/src/routes/memes.ts:313`).
- Measured through the Replit connector, 2026-11-15 (one read-only SELECT per database): development holds 54 facts, 4 with a `parent_id` (all active), 1 meme on those, 0 reviews with a `parent_fact_id`; production holds 0 facts, 0 memes, 0 reviews with a `parent_fact_id`. The scrubbed legacy fixture (`artifacts/api-server/fixtures/legacy/`, committed 2026-11-14) holds 53 facts, 4 with a `parent_id`.

Product intent (this increment)
After this increment there is no such thing as a variant anywhere in the product.
1. Every fact stands alone: no fact points at a parent, and nothing in the system can create such a link.
2. At triage a near-duplicate submission has two outcomes only: rejected as a duplicate, or accepted as its own fact. The "Prep as Variant of #N" action is gone.
3. The public fact page has no "Alternate Phrasings" section and no "Variant of" banner.
4. The admin Facts editor has no Parent ID field, no use-case label, and no add-variant or delete-variant action; the admin variant routes are gone.
5. Every existing variant fact (a fact with a parent) is permanently deleted in every database, development and production, together with what hangs off it (its memes, votes, comments, gags, reviews) — David: "Delete all existing variants."
6. The parent link, the variant-only use-case label and the review's parent-fact field are removed from the database schema, the API contract and the generated clients.
7. Living documentation describes no variant concept: the glossary, the subsystem docs, the Manual, the in-app admin help, the admin field reference and the testing guide.

Must not change
- Duplicate detection at submission and triage: the similarity match, the submitter-facing warning, and rejection as a duplicate.
- Facts that are not variants: their text, votes, comments, memes, gags, enrichment and active state are untouched by the deletion.
- Related facts, browse, top facts, hero, search: same results as today for non-variant facts.
- Comment threading (comments have their own parent field) is unrelated and untouched.
- Other meanings of the word "variant" (UI component variants, render variants at production review, image-engine variants, tokenizer helper variants) are untouched.
- The three-gags behaviour and the wording lock, except where their text or code mentions variants.
- Activation rules for a fact (the approved-gag requirement) other than the removed "a variant's parent must be an active root" clause.

Settled decisions
- Retire, not rework (David, 2026-11-15, Q1: option 1). An "alternate wordings on one fact" entity is **never** in this plan; it is recorded as the revisit condition if users ask for a wording choice after launch.
- Hard delete, not deactivate (David, 2026-11-15: "There's no production data we need to worry about. Delete all existing variants"). Consequence accepted with it: memes made from a variant fact are deleted with the fact (`lib/db/src/schema/memes.ts`: `factId ... onDelete: "cascade"`).
- Documentation (David, 2026-11-15, Q2: option 1): every living document is purged of the concept; historical records stay as written (approved plans whose digests pin their text, plan-review transcripts, past UAT and test-run records, applied migrations); the 2026-07-24 decision is marked superseded in the decisions log and the retirement is entered in `docs/retired/README.md`.
- A submission created as a variant that has not yet become a fact is kept as an ordinary submission awaiting triage, never auto-accepted (taken on recommendation, reported to David 2026-11-15; none exists in either database today).
- This supersedes the 2026-07-24 decision "Variants are independent facts" in `docs/ai-context/decisions.md`.

Now / next / never
- Now: code, schema, data deletion and living docs, as above.
- Never: alternate wordings sharing one fact's gags (see settled decisions).


Ceremony tier
Production-phase product code with a destructive migration: tier `sensitive`, with the migration specialist review.
```

## Problem
A variant is a second fact row linked to a "root" by `facts.parent_id`. Since 2026-07-24 it inherits nothing, so each alternate wording of one joke costs its own moderation pass, paid prep and gags, and splits votes. The reader sees it only as "Alternate Phrasings" on the root's page, in related facts, and through its memes in the root's gallery. The link also carries a body of invariants (an active variant's parent must be an active root for its lifetime; reparent guards; cascade deactivation) that exist only to keep the link consistent. David retired the concept on 2026-11-15.

## Direction, Product Intent, Must Not Change, Settled Decisions
As in the `plan-oracle` block above, verbatim.

## Repo Context Inspected
`docs/ai-context/`: glossary (Variant, Root), decisions (2026-07-24 entry and the lifecycle-closure entry), taxonomy-and-enrichment, moderation-workflow, launch-feature-inventory (C14 and the admin Facts row), overlay-declarations. `docs/engineering/migrations-and-backfills.md` (*Replit's publish changes production's schema before the runner does*). `docs/tests/TESTING.md` (legacy fixture refresh). Schema: `lib/db/src/schema/{facts,reviews,reactions,memes,imageProvenance,moderation,transientRenders,activity-feed}.ts`; migrations 0139 (live-fact gag triggers), 0141 (wording lock). Server: `routes/{facts,memes,admin,reviews}.ts`, `lib/{factActivation,moderationStaging,firstTimeStagingPrep,resubmitForModeration}.ts`, `testing/legacyFixture/{allowlist,load}.ts`, `scripts/upgrade-rehearsal.ts`. Client: `pages/FactDetail.tsx`, `components/facts/FactCard.tsx`, `pages/admin/{facts,moderation}.tsx`, the e2e stubs. Contract: `lib/api-spec/openapi.yaml` and the generated clients.

## Current Behavior
- `facts.parent_id` (no foreign key, indexed) and `facts.use_case`; `pending_reviews.parent_fact_id` (FK, set null).
- Creation: `POST /admin/facts/:id/variants`, triage `provisional-approve` with `parentFactId`, `POST /admin/reviews/:id/approve-variant`, and the admin fact PATCH's `parentId`.
- Guards: `activateFact` revalidates the parent; `assertReparentAllowed`; `cascadeDeactivateActiveChildren` on every deactivate or delete of a root; `resubmitForModeration` carries the parent.
- Readers: public feed and hero filter to roots (`includeVariants=true` lifts it for the admin engine workbench); fact detail returns `variants`, `parentId`, `useCase`; related facts excludes the source's own family; the meme gallery of a root merges its variants' memes; the admin Facts list paginates by root and nests variants.
- A raw `DELETE` of a fact cascades to comments, memes (and their share intents), gags, enrichment versions, override history, text-edit history, hashtag links, links, prompt attempts, comparison rows, user AI images and preferences. It does not remove reactions (polymorphic, no FK) or the reviews that staged or approved the fact (set null). Provenance records, moderation records and transient renders keep their rows by design (no FK or set null).

## Source-of-Truth Analysis
The only source of truth for "is a variant" is `facts.parent_id IS NOT NULL` (and, before a fact exists, `pending_reviews.parent_fact_id`). Both are removed; nothing replaces them. Duplicate detection's truth (`matching_fact_id`, `matching_similarity`) is untouched. No new source of truth is created.

## Proposed Design
One increment, one pull request: remove every writer and reader of the link, delete the variant rows, drop the three columns, regenerate the contract and clients, refresh the fixture, purge living docs.

### Data Model and Migration Impact
One forward migration (the next free number at build time), in one transaction that first takes an exclusive lock on `facts` and `pending_reviews`, so no parent-linked row can appear between selection and the column drop:

1. **Capture identities while the link exists, before changing anything.** V = every `facts` row with `parent_id IS NOT NULL`, active or not, whether or not the parent still exists; the ids of V's memes and comments; R = the `pending_reviews` rows whose `staging_fact_id` or `approved_fact_id` is in V.
2. **Delete what V owns that no cascade reaches, by the captured ids:** reactions whose target is a fact in V, a meme of a fact in V, or a comment on a fact in V; and activity-feed entries whose recorded fact is in V or whose recorded review is in R (they say "approved as a variant of fact #N" and link to a fact that will not exist). An activity entry or review belonging to a submission that only *matched* a variant is not owned and is kept.
3. **Delete V.** Cascades remove comments, memes and their share intents, gags, enrichment versions, override and text-edit history, hashtag links, links, prompt attempts, comparison rows, user AI images and preferences.
4. **Then delete R, by the captured ids.** After the facts, never before: a gag with a pending example or pending removal must keep its review pointer (`fact_gags_pending_ops_owned`), so deleting the review first aborts the migration; once the fact is gone its gags are gone.
5. **Assert that no fact with a parent remains, and abort if one does; then drop** `facts.parent_id` with its index, `facts.use_case`, and `pending_reviews.parent_fact_id` with its index. No fact's link is ever cleared to make it standalone. A review that carried a parent and has no fact yet loses the pointer with the column and stays in triage (settled decision).
6. **Report** the counts deleted per table in the migration's log line.

Kept under their existing retention contract: image provenance records, moderation records, transient renders, and stored image files. A matching-only review keeps its row; its `matching_fact_id` nulls by the existing FK.

Idempotency and the two paths (`migrations-and-backfills.md`): every step is guarded on the column still existing, so a re-run and a fresh baseline database are no-ops. Row states: variant fact (deleted with owned rows); non-variant fact (untouched); orphaned variant whose parent is gone (deleted); variant mid-refresh with a pending example or pending removal (deleted, no constraint failure); review owned by a variant (deleted); review matching a variant (kept, pointer null); review with a parent and no fact (kept, pointer dropped). Rollback: none for the data, by David's decision; the schema change is reversible by a new migration, the rows are not.

**The production path (concern C1).** Replit's publish applies its own structural diff before the runner, so on production the columns can be gone before step 1 runs and the guard then skips the deletion. Measured 2026-11-15, production holds 0 facts and 0 parent-linked reviews. That is *checked*, not *cannot*: the old code on production can create a variant until the next publish. So `docs/ai-context/replit-environment.md` (this product's own publish notes; `replit-platform.md` is overwritten by the fleet sync) gains a step for the first publish that carries this migration, removed once that publish has happened:
- Any admin request already in flight on production's moderation or Facts screens finishes before the count, and nobody uses those screens from the count until the new release has booted (David is the only admin; the publish is his).
- A read-only count of production `facts` rows with a parent must be zero before Replit's generated migration is approved.
- If it is not zero, the publish is cancelled (Cancel blocks it). While the identifying columns still exist, the checked-out release's pending migrations run on production through the migration-only command (`pnpm --filter @workspace/db run migrate`, which takes the target connection and runs the same runner with none of the boot-time updates), using the authorized production connection. The deletion counts the migration reports and the columns' absence are verified before publishing again; the original count cannot be repeated once the columns are gone. If production access cannot be established, publishing stays blocked and the structural diff is not approved. `unable to verify:` that authorized production credentials are available to that command from the Repl; settled during the build, and the blocked-publish rule holds either way.

I am not splitting the work into two publishes: publishing is deferred to near launch, so the column drop would sit open for weeks holding dead columns and dead guards for a table that is empty.

### Runtime Behavior
- No route, job or script reads or writes a parent link; the three variant routes and the PATCH field are gone and return the router's ordinary 404 or ignore the field per the existing validation style.
- Public feed, hero, top facts and search return what they return today for non-variant facts; the `includeVariants` parameter is removed and the admin engine workbench lists every fact.
- Fact detail returns no `variants`, `parentId` or `useCase`. Related facts excludes only the source fact. A fact's meme gallery shows that fact's memes.
- Activation requires what it requires today minus the parent clause. Deactivating or deleting a fact touches only that fact.
- Triage: a submission with a duplicate match can be rejected as a duplicate or accepted as its own fact; acceptance takes no parent.
- The approval activity message has one wording.

### Admin/User UX Impact
- Fact page: no "Variant of" banner, no "Alternate Phrasings" section.
- Admin Facts: a flat list; no nested variants, no Parent ID field, no use-case field, no add or delete variant.
- Moderation: no "Prep as Variant of #N"; the duplicate match and its similarity still show.
- In-app admin help regenerates from the Manual with the variant sections removed.
No async surface changes.

### Security, Permissions, and Validation
Only removals. The remaining admin routes keep `requireAdmin`. Request schemas stop accepting `parentFactId` / `parentId`; the OpenAPI contract and both generated clients are regenerated from the spec, never hand-edited.

## Testing Plan
Invariants, each with a negative case, run by the commands in `docs/tests/TESTING.md`:
1. **Deletion is exactly the owned population.** On a database built to the pre-retirement schema and loaded with the pre-retirement fixture (kept as a frozen test input), the migration removes the 4 variant facts, their memes, comments, gags, reactions, activity entries and owned reviews. Every surviving row is equal before and after on every surviving column, the only permitted difference being the named pointer nulling (`matching_fact_id` on a review that matched a variant, and the set-null pointers of the retained record tables). Planted cases: an inactive variant; an orphaned variant; a variant mid-refresh with a pending example, and one with a pending removal (the fixture has neither); a review that only matched a variant, with its activity entry (both kept); a parent-linked review with no fact (kept, in triage); a reaction on a non-variant fact with the same numeric id as a variant's meme (kept).
2. **Re-run and fresh build are no-ops** (the baseline test and a second run).
3. **The link cannot come back:** the three columns are absent from the built schema; no request schema accepts a parent; the removed routes do not exist.
4. **Non-variant behaviour is unchanged:** feed, hero, detail, related facts, gallery, triage accept/reject-duplicate, activation and deactivation, proven on existing suites with the variant cases removed and none weakened.
5. **Fixture (concern C3):** the committed legacy fixture is regenerated by the fixture tooling from a database the migration has run on, contains no row the migration deletes, and loads; no file in it is edited by hand. The upgrade rehearsal expects exactly the per-table drop computed from its snapshot's own variant population, and still fails on any other loss; the frozen snapshot is not replaced.
6. **Screens:** browser assertions that the fact page has no banner or section, the admin Facts editor has no parent or use-case control, and moderation has no variant action.
7. **Docs:** the `prose-sweep` skill over the living documents returns no description of the concept; a `git grep` for the retired identifiers over tracked code returns only historical records and unrelated senses.

UAT (judgement residue only): none expected; the screen facts above are assertions.

## Implementation Steps
1. Server: remove writers, guards and readers; delete the variant routes.
2. Migration, with its test against the frozen pre-retirement fixture.
3. Schema modules, OpenAPI, regenerate clients.
4. Client: fact page, fact card size, admin Facts, moderation, e2e stubs.
5. Fixture allowlist and regeneration; upgrade-rehearsal expectation.
6. Docs: glossary (Variant, Root), taxonomy-and-enrichment, moderation-workflow, token-rendering, roadmap, launch inventory, Manual chapters and regenerated help, admin field reference, TESTING.md; decisions entry (new decision, 2026-07-24 marked superseded, revisit condition); `docs/retired/README.md` entry; the first-publish step in `replit-environment.md`.
7. Post-merge: sync the Repl; read-only count on development showing zero parent-linked rows and the columns gone.

## Risks and Mitigations
- **Deleting too much.** Mitigated by test 1's equality over every surviving row and the planted id-collision case.
- **Production keeps a variant.** See *The production path*; checked at publish, not prevented.
- **Another branch takes the same migration number or still writes the columns.** The number is taken at build time from `main`; any open branch touching these files is merged against at the pull request.
- **Stored image files of deleted memes remain in storage.** Accepted: same as the existing admin hard delete; development data only.

## Questions for David
None. Q1 and Q2 are answered.

## Definition of Done
- No fact in development has a parent; the three columns do not exist; the fact page, admin Facts and moderation show no variant control.
- All tests above pass in CI; the legacy fixture loads; the upgrade rehearsal passes with its narrow expectation.
- Living docs carry no variant concept; decisions and the retired ledger record the retirement.
- The intended behaviour can be exercised in the product: submit a near-duplicate, see the match at triage, and accept it as its own fact or reject it as a duplicate.
