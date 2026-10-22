# Plan — Launch Phase 4: Cut and prune (#744; parent #628)

v4, 2026-10-21. Drafted on `main` at `8b42ee5`. v2 took Astra's scope exchange (`round-0.md`). v3 takes David's two answers (2026-10-21) and Astra's round 1 (`round-1.md`): saved memes classified by serving path, targeted assertions in place of an overclaimed smoke, job retirement by provenance, fixture row pruning, and the tag as a hard requirement. v4 takes Astra's rounds 2 and 3 (`round-2.md`, `round-3.md`): the stop-first cutover, delayed recovery of interrupted jobs, and a complete approval list.

```plan-oracle
# Oracle — Launch Phase 4, Cut and prune (#744; parent #628)

Agreed with David in the pre-plan conversation on #744, 2026-10-21. This is
the scope-of-work gate's text; the plan is measured against it.

## Direction served

`docs/ai-context/launch-definition.md`, *Cut, deleted or deferred*, and the
parent plan `docs/plans/PLAN_GET_TO_LAUNCH.md` v7, *Phase 4 — Cut and prune*.
Per-item decisions: `docs/ai-context/launch-feature-inventory.md`.

## Product intent

Every cut feature is gone from UI, routes, jobs, config, engines, schema,
docs and Manual, and nothing reachable promises deferred functionality. The
product surface every later phase builds, migrates, hardens and tests is
smaller by exactly the cut list, and nothing a launch user or an admin
relies on changes.

## Scope, in order (one PR per removal)

1. Legacy meme studio, legacy builders and the vestigial `VITE_MBFO_WIZARD`
   flag (D1, D4; decisions.md 2026-10-17). First because it is a leaf and
   the only consumer of the legacy video tab, the legacy builder and the
   routes only it calls.
2. Video: pipeline, legacy one-shot path, the wizard's video step, video
   engines, Video Styles (admin screen and config), video permalinks, the
   video-jobs schema (E, A17, K5). The generic async-job framework stays.
3. PuLID everywhere, by prose-sweep (D17, D18).
4. Merch and Zazzle: CTA, `/wear`, export, redirect, admin Affiliate screen,
   and the Zazzle config keys in the same PR (A21 teaser, A22, D28, K1).
5. Templates and gradient backgrounds (D2).
6. Stock photos, Pexels entirely, and the per-user image preferences (D3,
   K2, C12, C13).
7. Dead surfaces: standalone `/hashtags` page, dead admin files
   (`comments.tsx`, `ai.tsx`), dead profile Memes tab, Replit Auth remnant
   comments (A8, H, B15, B6).
8. Debug mode: the two `admin_config` columns and the five-file sweep
   (Journey I).
9. Route-visit counters (K8).
10. Dead leaderboard pills; all-time only (A14).
11. Orphan endpoints and dead tables, each deleted only after verification
    that nothing calls it (A27, Journey I code-only items, the legacy
    `ratings` table noted at C5).

## Retirement record (David, 2026-10-21, amending 2026-10-06)

- Every removal: a `pre-cut/<feature>` tag on the commit immediately before
  removal, and one row in the ledger `docs/retired/README.md` (feature,
  date, the decision it rests on, the tag, the deleting PR, and the paths of
  its Manual chapter, subsystem doc and UAT docs at the tag).
- A lessons page `docs/retired/<feature>.md` only where a rebuild would
  otherwise have to rediscover something the existing docs do not hold:
  written for an agent reader, facts and decisions and what failed, not a
  re-narration. On today's reading: video, Pexels and stock, Debug mode,
  PuLID.
- The Manual has no *Retired* section: the retired narrative lives at the
  tag, the ledger row points at it, and the live chapter is rewritten to
  describe what exists (the Manual ships into the in-app admin help).
- Locations derivable from the deleting diff or `scripts/map.mjs` at the tag
  are not hand-written.

## Must not change

- Anything the live image wizard, the public site or an admin screen
  reaches, unless it is on the cut list above.
- The dev-admin-login backdoor, its POST and GET routes and the wordmark
  triple-tap: all stay through Phase 4 (David, 2026-10-21: "I still want an
  easy way to get in and see admin screens without having to log in the
  standard way"). Phase 15 owns its redesign.
- `moderateComment` stays (Phase 9 wires it). Search-history recording
  stays. The eval dashboard stays admin-only. The generic async-job
  framework stays.
- E2E Smoke stays a required check on every PR with no numeric bound; `main`
  requires `Build`, `Test`, `Frontend Test` and `E2E Smoke`.
- No paid AI run above David's per-run and weekly budget without his
  go-ahead for that run. Removal PRs should need none.

## Settled — not re-opened

- Phase 4 before Phase 3 (David, 2026-10-21).
- One PR per removal, in the order above (David, 2026-10-21, approving the
  dependency order).
- Legacy meme studio first (David, 2026-10-21).
- The legacy studio is cut and work tied to it is killed, not deferred
  (decisions.md 2026-10-17). Stock photos and Pexels go entirely (David,
  2026-10-14).
- The backdoor stays through Phase 4 and moves to Phase 15 (David,
  2026-10-21; amends decisions.md 2026-10-14).
- The retirement-record shape above (David, 2026-10-21; amends decisions.md
  2026-10-06).

## Now / next / never

- **Now:** the eleven removals above, their records and tags, the doc and
  Manual sweep each needs, and the 41 UAT steps deferred to `#628 — Phase 4`:
  each removal retires or re-points its own steps; the six dev-admin-login
  steps are re-pointed to Phase 15, with the 2026-10-14 decision and the
  launch-definition cut line amended to match.
- **Next:** the backdoor's redesign as a safe easy admin entry, in Phase 15.
- **Never, here:** Phase 3 and every other launch phase; Phase 2 follow-ups
  (#693, #707, #711, #715, #691, #697); the #683 devops track; any change to
  the Phase 2 test infrastructure beyond what a removal itself requires.

## Ceremony tier

Feature-building, production phase. Tier internal, except Debug mode
(sensitive: it touches the payments path's config reads). Every removal that
drops schema runs migration review (`overhype-migration-review`). Codex
reviews every PR.

## Exit evidence

- A re-run of the route and page inventory shows no cut item, and each
  removal's structural and behavioural evidence (route and page inventory
  diff, caller tracing, inventory grep, typecheck, and assertions for its
  removed endpoints and controls and its retained paths) is green. Replaces
  `node scripts/map.mjs check`, which cannot run until #683 adopts the map
  (David, 2026-10-21).
- `git grep -n 'Deferred:\*\* #628 — Phase 4' -- docs/tests/UAT/` returns
  nothing.
- One ledger row and one `pre-cut/` tag per removal; a lessons page where the
  rule above calls for one.
- CI green on every PR; Manual, subsystem docs and in-app help swept.
```

## Problem

The launch definition cuts eleven features. Their code is still in the product: routes any signed-in account can call, a wizard that still offers stock photos and PuLID stylising, admin screens for merch and Video Styles, a parallel config universe behind Debug mode, and schema and boot-time seeds for all of it. Every later phase would otherwise migrate it (Phase 3), harden it (Phase 15), test it, and route around it. One instance is already on record: the user generate route that only the legacy studio calls has no budget gate on its no-photo path and stays deployed until this phase deletes it (`decisions.md`, 2026-10-17, *Acceptance journeys 5 and 6*, dissent and revisit-if).

## Direction

`launch-definition.md`, *Cut, deleted or deferred*, and `PLAN_GET_TO_LAUNCH.md` v7, Phase 4. This increment makes true that the cut list is gone from the running product and its documentation, and that what each cut taught survives where a rebuild will look.

## Product Intent, Must Not Change, Settled Decisions

Verbatim in the `plan-oracle` block above. Two Settled Decisions are added by the preflight below.

- **The affected-surface inventory, run at `8b42ee5`** (the oracle that each removal's scope is drawn from, re-run at that PR's base): `git grep -l -i -E '<pattern>' -- artifacts lib scripts .github cloudflare ':!*/node_modules/*' ':!lib/db/migrations/meta/*'` per removal. Results: legacy studio 13 files; routes only it calls 24; video 74; PuLID 94; merch and Zazzle 66; templates 70 (pattern too broad: `template_id` is a live discriminator, see *Templates*); Pexels and stock 120; image preferences 13; Debug mode 29; route stats 14. The class for each removal is "every reference to the feature's names, routes, tables, columns, config keys and env vars", and the per-PR sweep is that grep plus targeted caller tracing (imports, route strings, table and column names in SQL) on the deleted modules and tables. The map cannot serve here: every adoption file under `.agents/map/` reads `"adopted": false`, `map.mjs check` refuses unadopted configuration (`scripts/map.mjs:1355`), and `node scripts/map.mjs build` crashed in this container before writing an index. Adoption belongs to #683.
- **Boot-time seeds recreate cut schema.** `artifacts/api-server/src/lib/seed.ts` runs `CREATE TABLE IF NOT EXISTS video_jobs` (line 234) and `video_styles` (328), `ADD COLUMN IF NOT EXISTS debug_value` (303) and `debug_value_label` (270), and inserts the three Zazzle keys (503–509). A migration that drops these without the seed entry going in the same PR is undone at the next boot.

## Repo Context Inspected

`PLAN_GET_TO_LAUNCH.md` (Phases 3, 4, 6, 7, 15; dependency summary); `launch-definition.md`; `launch-feature-inventory.md` (journeys A–K); `decisions.md` (2026-10-06, 2026-10-14, 2026-10-17 ×2, 2026-08-28); `meme-and-video-studio.md`; `docs/manual/README.md` and the help generator `artifacts/overhype-me/scripts/generate-help-content.ts`; `docs/tests/TESTING.md` (*The legacy fixture*); the legacy fixture README and `memes.ndjson`; `scripts/map.mjs`; the wizard's `step2-image/` and `step2-video/`, `integration/sourceKinds.ts`, `types.ts`; `components/MemeStudio.tsx`; `pages/FactDetail.tsx`; `App.tsx`; `lib/memeComposite.ts`; `lib/adminConfig.ts`; `lib/membershipTiming.ts`; `lib/seed.ts`; `lib/firstTimeStagingPrep.ts`; `schema/userFactPreferences.ts`, `memes.ts`, `adminConfig.ts`, `engines.ts`, `facts.ts`; `testing/acceptance/inner.ts`, `coverage.ts`, `driver.ts`; the E2E specs; the 41 deferred UAT steps.

## Current Behavior

- **The live wizard offers three image sources** (`SourceSegmentedControl.tsx:3`): `ai-you` (PuLID stylising, Legendary), `self-upload`, and `stock` (Pexels). Step 1 offers an image card and a video card.
- **Memes are served by one of two paths** (`routes/memes.ts:612-640`). A meme with no `image_source` is a stored image read from object storage, whatever its `template_id` label says. A meme with an `image_source` recipe is composed on request; a stock recipe re-resolves its photo through the Pexels API on every view (`memeComposite.ts:171-185`).
- **The legacy fixture's 65 memes**, by `template_id` and background type: `photo_upload` 32, `photo_stock` 29 (13 with a stock `image_source`, 16 with none), gradient templates `night` 2 and `action` 2. Five upload memes carry `image_transform = 'pulid'`.
- **`user_fact_preferences` is not only an image preference.** Its `image_index` and `ai_meme_image_index` columns are the per-user image preference (C12, C13); its `last_seen_as_hero_at` drives the home-page hero rotator (`routes/facts.ts`, `routes.facts.hero.test.ts`), which ships.
- **Debug mode** makes every `admin_config` getter prefer `debug_value` while `debug_mode_active` is `"true"` (`adminConfig.ts:8-11`), and the membership timing route locks rows to keep both resolutions coherent (`membershipTiming.ts:249-330`).
- **The legacy fixture loads into a database at the current schema** (push, then migrate, then load; `TESTING.md`). A column the schema drops is a column the loader can no longer insert.
- **The acceptance run in live mode over the fixture reads one Pexels-only stock meme** (`inner.ts:130-145`; David, 2026-10-14, option 1), and its coverage list names a stock-photo keyword extractor call in journey 3 (`coverage.ts:122`).
- **The dev database, counted read-only through the Replit connector at 2026-10-21 ~23:42 UTC.** Memes not soft-deleted, by serving path: stored images (no recipe) 22 (12 labelled `photo_upload`, 10 labelled `photo_stock`); upload recipes 17 (5 PuLID-labelled); stock recipes 8; video 1; gradient templates 0 (all four already soft-deleted). `video_jobs` holds 39 rows. `debug_mode_active` is `false`; two keys carry a `debug_value` (`pexels_photos_per_gender`, which goes with Pexels, and `user_max_images`), and neither applies while the flag is off.
- **Engine reconciliation leaves rows behind** when a catalogue entry disappears (`lib/engines/reconcile.ts:17`), so deleting an engine from code does not delete its row.
- **`look_styles` has retained consumers**: the admin image bench (`routes/adminEngines.ts:866`; it fetches `/api/look-styles`, `pages/admin/engines.tsx:286`) and the runtime prompt preview (`RuntimePromptPreview.tsx:283`). That route is registered in the video route file (`routes/videos.ts:1045`), and the bench substitutes an empty list when the fetch fails. Source-image analysis also serves the bench.
- **Legacy-studio render jobs share queues with retained work.** The legacy generate routes enqueue `image_prompt_generation` through the same producer moderation and eval use (`imagePromptAttempts.ts:99`), handled on the retained render lane (`imagePromptJobs.ts:423`), and processing-job recovery can make interrupted work runnable again (`asyncJobs.ts:637`).
- **The legacy fixture loader upserts configuration rows after migrations** (`legacyFixture/load.ts:114`), and the committed fixture holds video engines, `pulid-flux`, the Zazzle keys and `debug_mode_active`.
- **No `docs/retired/` exists and no `pre-cut/` tag exists** (`ls docs/retired`, `git ls-remote --tags origin 'pre-cut/*'`, both empty at `8b42ee5`).

## Source-of-Truth Analysis

- **What the product does** is the code on `main`; after each removal, the deleted part's truth is the `pre-cut/<feature>` tag. No second copy of the code or of its docs is made.
- **Why a feature was cut** stays in `launch-feature-inventory.md` and `decisions.md`, which are not edited to remove history. The ledger row points at the entry; it does not restate it.
- **Where a feature's docs were** is derivable at the tag; the ledger row carries the paths so a reader does not need to search an old tree.
- **The lessons page** is the one new source of truth, and only for what nothing else holds. It must not restate the product definition the Manual held at the tag; it links to it.
- **`admin_config.value`** becomes the only value of each config key when Debug mode goes. No key's live behaviour changes in an environment where `debug_mode_active` is `"false"`.
- **Live docs** (Manual, `docs/ai-context/`, in-app help) describe only what exists after each PR. A doc describing deleted code is a defect, not history.

## Proposed Design

### The removal unit (every PR)

Each removal PR, branched fresh from `main`:

1. **Re-runs its inventory at its base** and draws its scope from the hit list, plus the routes, tables and config keys that caller tracing finds for the deleted modules.
2. **Traces every route in a file it deletes** against every client fetch and server caller first. A retained endpoint hosted in a cut module (the class `/api/look-styles` in `videos.ts` belongs to) moves to a retained module before the file goes.
3. **Deletes the feature end to end, producers included**: UI and entry points, routes, jobs and workers, engines and config rows (by migration, since reconciliation leaves rows behind), generated API types (regenerated, not hand-edited), env-var reads, boot-time seed entries, queued and in-flight work in the feature's own queues, tests that exist only to test it, and schema through a migration where schema is involved. Already-merged migration files stay byte-for-byte unchanged.
4. **Keeps the product whole.** Anything that offered the cut feature now offers what remains, with no dead control, empty tab or link to a 404. A capability is removed from a shared module, not the module: shared code, tables and libraries a retained path still uses stay (`user_fact_preferences` for the hero rotator, `look_styles` and source-image analysis for the admin image bench, the generic async-job framework). Retained jobs in a shared queue still run after the PR.
5. **Sweeps the live docs** with the `prose-sweep` skill: the Manual chapter is rewritten to describe what exists, the subsystem doc likewise, and the in-app help regenerated.
6. **Retires its deferred UAT steps.** Each step that names the cut is closed in its UAT doc as retired with the cut, citing the ledger row; a step whose behaviour partly survives is rewritten to the surviving behaviour and its lane assigned under `uat-doc-format.md`, not deleted.
7. **Adds its ledger row**, and its lessons page where the oracle's rule calls for one.
8. **Tags at merge.** At close-out, `pre-cut/<feature>` is pushed on the squash commit's first parent, which is exactly the last `main` commit carrying the feature. The tag is required; the ledger row also names the deleting PR as a second route back. If a tag push is refused, the tag is reported as outstanding, never substituted.

The `docs/retired/README.md` ledger and its row format are created by the first PR.

### The order, and what each removal must make true

1. **Legacy meme studio** (`components/MemeStudio.tsx` and everything only it mounts, per `decisions.md` 2026-10-17; the routes only it calls; `VITE_MBFO_WIZARD` and the code behind its off branch). After it: `FactDetail` mounts only the wizard; the user AI generate route, `generate-v2`, `analyze-source`, the user render poll and the scene-prompt routes return 404; nonterminal render jobs from legacy user attempts are retired by provenance in the same deploy; the decision entry's revisit-if is satisfied and noted. Record: ledger row only. Deferred steps: the 13 legacy-studio steps (PR223, PR224, PR256, PR288, PR425, PR443).
2. **Video.** The wizard's step 1 offers no video card, and the wizard skips step 1 when one artifact type remains. Gone: video jobs and their routes, the pipeline runner and direction, video engines and their pricing rows, motion presets and Video Styles (admin screen, config, route), video hero examples, `/video/:id` and its OG route, the video meme columns and the `video_jobs` table. `/api/look-styles` moves out of `videos.ts` to a retained module first. The generic async-job framework stays. Record: ledger row and lessons page. Deferred steps: 9.
3. **PuLID everywhere.** The wizard's `ai-you` source (its create action calls `/memes/pulid-jobs`, `Step2Image.tsx:277`), its loading takeover and no-face fallback, the PuLID job routes, the `fal-ai/flux-pulid` default in the AI meme pipeline (`aiMemePipeline.ts:60`), PuLID engines, the stylise toggle and every doc mention. The remaining wizard is described as it is; no copy promises face-in-scene. After it: the wizard's image step offers `self-upload` only (see *Accepted consequences*). Record: ledger row and lessons page. Deferred steps: 3.
4. **Merch and Zazzle**: the share-screen merch teaser, `/wear`, the export and redirect, the admin Affiliate screen, any Zazzle reference in the OG router, and the Zazzle config keys and their seed. Record: ledger row only. Deferred steps: 1.
5. **Templates**: the gradient template backgrounds. `template_id` stays as the meme background discriminator; only the gradient values lose their renderer. Record: ledger row only. Deferred steps: 1.
6. **Stock photos, Pexels, image preferences**: the stock source and its picker, the Pexels client, the `fact_pexels` queue and worker lane, the moderation Pexels panel and its backfill buttons, the stock-photo keyword extractor, `facts.pexels_images` and `pexels_status`, `PEXELS_API_KEY`, and the `image_index` and `ai_meme_image_index` columns. `user_fact_preferences` and its hero column stay. Staging prep enqueues enrichment only. Record: ledger row and lessons page. Deferred steps: 8.
7. **Dead surfaces**: `pages/Hashtags.tsx` and its redirect, `pages/admin/comments.tsx` and `ai.tsx`, the dead profile Memes tab code, the Replit Auth remnant comments. Record: one ledger row for the group.
8. **Debug mode** (sensitive): `debug_value` and `debug_value_label` dropped, the `debug_mode_active` row deleted, every getter reads `value`, and every reader found by the inventory (29 files at `8b42ee5`, including the live config components, enrichment provenance and fixture tooling, not the five of the 2026-10-05 estimate) moves to `value`. The membership timing route keeps its validation and its row locking over the one resolution that remains. The admin config screen loses the debug field. Record: ledger row and lessons page.
9. **Route-visit counters**: the `route_stats` table, its writer and its admin display. Record: ledger row only.
10. **Dead leaderboard pills**: the time-window and hashtag pills on `/top-facts`; the page ships all-time. Record: ledger row only.
11. **Orphans after verification**: each candidate (A27's `GET/DELETE /facts/:id/links`, the Journey I code-only items, the legacy `ratings` table) is deleted only when caller tracing and a grep show no caller, and the PR body quotes that evidence; a candidate with a live caller is reported and kept. `/facts/:factId/pexels-images` goes with removal 6, not here. Record: one ledger row for the group.

**The dev-admin-login backdoor is untouched** in every PR; its six deferred UAT steps and the 2026-10-14 decision are re-pointed to Phase 15 in the first PR.

## Data Model and Migration Impact

Five removals change schema: video (table, columns, rows), Pexels and preferences (columns), Debug mode (columns, one row), route stats (table), orphans (the `ratings` table if verified dead). Each runs `overhype-migration-review`. Rules for every one:

- **Forward-only and idempotent.** Each migration uses `IF EXISTS`; re-running it is a no-op. Rollback is the tag plus a restore of the dev database; production is not migrated by this plan (below), and Phase 3 replaces it with a database built from code.
- **The seed and the migration agree in the same PR.** No boot-time seed recreates what a migration drops (the Settled Decision above). Checked by booting against the migrated test database and reading `information_schema`.
- **Rows that would render broken are retired, not left.** The row-state matrix for memes, applied by the video, template and Pexels migrations:

Classified by serving path, never by the historical `template_id` label:

| Row state (live in dev) | Fate |
|---|---|
| Stored image, no recipe (22) | Kept; served from object storage as today, whatever its label. Phase 4 does not touch that path. |
| Upload recipe, PuLID-labelled or not (17) | Kept; composes from the user's stored image. The `pulid` label stays as historical data with no writer. |
| Stock recipe, with or without `photoUrl` (8) | Soft-deleted in removal 6 (David, 2026-10-21). |
| Gradient-template recipe (0) | Soft-deleted in removal 5 if any exists in the environment being migrated. |
| Video meme (1) | Soft-deleted in removal 2; agreed with the video cut. |
| Already soft-deleted | Untouched. |
| Unknown background type | Untouched and counted; the migration reports it rather than guessing. |

Each migration logs the count per row state; the committed fixture applies the same classification. Soft delete, not hard delete, so an admin can still see what existed and the fixture's foreign keys hold. A soft-deleted permalink returns the existing 410 (`routes/memes.ts:379`).

- **Debug mode's drop checks the flag first.** If `debug_mode_active` is `"true"` in the environment being migrated, the migration refuses and names the keys whose `debug_value` would stop applying. Dev and production both seed it `"false"` (`seed.ts:212,308`); the refusal turns an unknown into a loud stop instead of a silent config change on the payments path.
- **Admin-curated rows for cut features are deleted**: video and PuLID engine rows, their pricing cache rows, motion presets, Zazzle and debug config rows. `look_styles` stays (the admin image bench reads it); a look style's video-only fields go with video.
- **Queued work is retired by the feature that produced it, not by queue.** The 39 dev `video_jobs` go with the table; `fact_pexels` jobs are retired with their lane. Nonterminal render jobs belonging to legacy-studio user attempts are retired in removal 1 by the attempts' existing provenance, while moderation and eval jobs in the same queues are untouched; a predicate on a missing review id alone is not enough, since single-review and eval attempts also lack one. Ordering is the cutover below; a retired job is terminal, so recovery cannot revive it once no old process can write it back. No new queue mechanism is introduced.
- **Cutover: retirement and destructive migrations run only after old producers and workers can no longer execute against the affected database.** Sharing a release with the producer removal is not enough. On the Repl, `scripts/post-merge.sh` runs `migrate` and `seed` while the running dev server keeps serving, and the server's own boot also migrates (`index.ts:234`). An executing prompt job persists its result and enqueues its successor without re-reading its queue row (`imagePromptJobs.ts:270`); a retry finalization updates by row id alone and can turn a retired row back to `pending` (`asyncJobs.ts:474`); and the old config reader selects the debug columns (`adminConfig.ts:33`), so it falls back to defaults once they are dropped. So each PR with a job retirement or a destructive migration closes out in this order:
  1. Stop every Repl workflow that serves requests or runs workers, through the connector, and confirm the supervisor, watcher and server processes have all exited. If that cannot be confirmed, the migration waits. Planned cutovers run while retained work is idle where practical.
  2. Fast-forward the Repl to the merge commit and run the post-merge script: install, codegen, migrate, seed.
  3. Start the workflows; the boot migration is a no-op.
  4. Run post-cutover checks: dropped objects absent, no nonterminal job of the retired feature, and one retained path of the shared module exercised. The checks distinguish resumed work from work awaiting recovery.

  Retained job rows survive the stop. Pending retained jobs resume when workers restart. A processing job interrupted by the stop stays preserved and recovers through the existing delayed recovery: shutdown does not drain background handlers (`shutdown.ts:62`), and startup recovery takes a processing row only once its claim is more than 30 minutes old (`asyncJobs.ts:1057`). So an admin render caught by the stop can sit for up to about 30 minutes before it resumes. Verification shows retained work recovers and retired work stays terminal. The cost is a dev-only outage of a few minutes per such PR, with no users on dev. The PR's Post-merge verification section records the sequence and its check results. `unable to verify: whether Replit Agent stops and restarts workflows on request through the connector; the first such close-out (removal 1) settles it`. If it cannot, the sequence is run as a scripted stop inside the post-merge step instead, and that PR says so.
- **Production is not touched by this plan.** Publishing stays David's per-use action, and Phase 3 replaces production with a database built from code. A Replit publish prepares the new version beside the running one before switching traffic, so publishing a schema-removal head over the current production database would run destructive migrations while old code still serves. Any publish between this phase and Phase 3 therefore needs its own cutover decision when it is asked for. That is named in the approval ask.
- **The fixture follows rows as well as schema.** Every removal, with or without DDL, prunes its retired config, engine, pricing and permission rows from the committed fixture and updates the manifest; absence is verified after migrate, fixture load and boot, in that order.
- **The legacy fixture follows the schema.** A removal that drops a column or table removes it from the committed fixture and the allowlist in the same PR, and soft-deletes the affected memes in the fixture as the migration would. No AI recording is re-recorded: the removals delete AI calls rather than change their request content. If a removal would change a recorded request's content, that PR stops for a paid-run go-ahead under the budget rule.

## Runtime Behavior

- After each PR, every route the removal deletes returns 404 (the removal's own assertions), and no surviving page or server path calls one (caller tracing).
- The wizard after removals 2, 3 and 6 opens on the image step with one source: the user's own photo. An unregistered visitor sees the existing sign-up panel in that source.
- Staging prep after removal 6 enqueues enrichment and reports it; no Pexels status appears in moderation or queue health.
- Config reads after removal 8 return `value` in every environment.

## Admin/User UX Impact

- **Admin**: the Affiliate, Video Styles and Pexels panels and buttons are gone; the config screen has one value per key; queue health lists no video or Pexels lane; engines list no video or PuLID engine. The nav reaches no deleted screen.
- **User**: no video, no stock, no PuLID, no merch teaser, no dead pills.
- **Accepted consequences**, already implied by settled decisions and the parent plan's order (Phase 7 depends on Phase 4 for "templates/stock/Pexels gone"), and named here so approval accepts them in words:
  1. Between this phase and Phase 7, the wizard's only background is the user's own photo. A free or anonymous visitor cannot make a meme without signing up and uploading, and Legendary has no AI meme feature until Phase 7 builds face-in-scene on the new model.
  2. Nine dev memes stop resolving: eight built on a Pexels recipe (David, 2026-10-21) and one video meme. Their permalink shows the existing 410 copy, which says the creator removed it; no new copy is written for a pre-launch row. The acceptance run's Pexels-only meme read (David, 2026-10-14) is retired with Pexels.

## Security, Permissions, and Validation

The phase removes privilege surface and adds none. Deleted routes are removed, not guarded. The permission chokepoint checks (`check-permission-chokepoint*.mjs`) keep passing with the deleted entries removed from their tables, not suppressed. Debug mode's removal is the sensitive step: the refusal above, and a test that every membership timing key reads `value` with no debug column present.

## Testing Plan

- **Per PR, the general invariant is "the feature is unreachable and nothing that remains depends on it"**, established by four kinds of evidence, each for what it can show (the map's place, David, 2026-10-21):
  - **Structure**: a route and page inventory taken from `App.tsx` and the server's route registrations at the PR's base and head shows only the removal's routes gone; caller tracing finds no client fetch or server call to a removed route; a grep for the removal's inventory pattern returns only the ledger, the lessons page, `decisions.md`, the inventory and the retired UAT lines; the typecheck catches dangling imports and types (it does not connect handwritten fetch URLs to routes, which is why caller tracing is separate).
  - **Behaviour**: each removal adds or adapts assertions in the existing API and frontend suites for its removed endpoints (404) and controls (absent), and exercises the retained behaviour that shares its paths.
  - **The route-load smoke** keeps its own purpose: its selected routes load without a crash or reload loop.
  - **David's end-of-phase pass** supplies the judgement beyond those assertions.
- **Retained paths still work**: the hero rotator, the admin image bench with its look styles, the runtime prompt preview, and moderation and eval render jobs each keep a passing assertion after the PR that touches their shared module. Removal 1's job retirement is tested with pending and already-claimed legacy jobs and retained jobs in the queue together, under the cutover order.
- **Fixture order**: the PRs that touch the fixture run migrate, fixture load and boot, and assert the retired rows and objects are absent afterwards.
- **Migration tests** for each schema removal: the row-state matrix above as fixtures (each state in, its fate out, counts logged), re-run idempotence, and a boot after migration that leaves the dropped objects absent.
- **Debug mode**: the membership timing route's tests rewritten to one resolution; the refusal tested with the flag on.
- **Tests that exist only for a cut feature are deleted with it**; a test that covers surviving behaviour through a cut path is rewritten to the surviving path.
- **CI**: `Build`, `Test`, `Frontend Test`, `E2E Smoke` on every PR; the Acceptance workflow on the PRs that touch the fixture or the acceptance driver. Runner commands per `docs/tests/TESTING.md`.
- **No UAT doc** is written for a removal: each one's product-visible change is an absence its own 404 and absence assertions establish. The judgement residue for David is one pass at the end of the phase: click through the wizard and admin and confirm nothing reachable promises a cut feature.

## Implementation Steps

Eleven PRs in the order above, each taking the removal unit. PR 1 also creates the ledger, re-points the six backdoor steps to Phase 15, and amends the 2026-10-06 and 2026-10-14 decision entries and the launch-definition and parent-plan lines they govern, by `prose-sweep`.

## Risks and Mitigations

- **A removal deletes shared code a live path still uses.** Targeted caller tracing on every deleted module before deletion; the typecheck and the route-load smoke after; the retained-path tests.
- **A boot-time seed resurrects a dropped object.** The seed and migration in one PR, checked by a boot.
- **Debug mode flips live config.** The refusal when the flag is on.
- **The fixture drifts from the schema.** Fixture and allowlist edited in the same PR; the Acceptance workflow on those PRs.
- **A removal changes a recorded AI request and needs a paid re-record.** That PR stops for David's go-ahead; none is expected.
- **Tag pushes may be refused by the rulesets or the proxy.** `unable to verify: whether a tag push succeeds; the first PR's close-out settles it`. If refused, the tag is reported as outstanding and the ledger row's PR pointer keeps the commit findable meanwhile; a different deliverable would be David's call.
- **A retained endpoint lives in a cut file.** Route tracing before deletion; known instance `/api/look-styles` in `videos.ts`.
- **Legacy jobs run after their routes are gone, or an old process writes to dropped schema.** Retirement by provenance and destructive migrations only after every old process is stopped (the cutover); post-cutover checks confirm.
- **The fixture reinserts retired rows.** Rows pruned with the schema; absence asserted after migrate, load and boot.

## Items for David's approval

Not open questions. These are the consequences and irreversible-list items that approving this plan accepts:
1. **Writes against the shared dev database** across the eleven removals, each run at close-out under the cutover sequence: the schema changes, the soft-deletes of 9 dev memes, and the feature-owned job, engine, pricing, permission and configuration retirements (PuLID's engine and pricing rows and Zazzle's config rows included). They are on the irreversible list (a write, migration or deletion against a shared database), so they are named here.
2. **A dev-only outage of a few minutes per cutover**, and an interrupted admin render that may take up to about 30 minutes to recover.
3. **The upload-only interval and the 410 copy** (*Accepted consequences*).
4. **No production publish of a schema-removal head before Phase 3** without its own cutover decision.

## Questions for David

None open. Answered 2026-10-21: the stock-recipe memes are retired with Pexels (the question as first asked said 18; the serving-path count is 8, and the 10 stored images are kept), and the map criterion is replaced by the evidence in the Testing Plan, with map adoption left to #683. The two accepted consequences above are asked as part of approval.

## Definition of Done

- Each of the eleven removals merged, with its ledger row, its `pre-cut/` tag (or reported as outstanding if a push is refused), and its lessons page where called for.
- `git grep -n 'Deferred:\*\* #628 — Phase 4' -- docs/tests/UAT/` returns nothing.
- The route and page inventory re-run shows no cut item; each removal's 404 and absence assertions and its retained-path assertions are green on `main`.
- The Manual, `docs/ai-context/` and the in-app help describe only what exists.
- No dropped table or column reappears after a boot on a migrated database.
- David's one end-of-phase pass finds nothing reachable that promises a cut feature.
