# Plan — renders are always a manual step (amendment to PLAN_FACT_LIFECYCLE_REBUILD.md)

```plan-oracle
# Oracle: amendment to PLAN_FACT_LIFECYCLE_REBUILD.md — renders are always a manual step (Issue #1282)

**Direction served:** the fact lifecycle rebuild (Issue #1018), plan `docs/plans/PLAN_FACT_LIFECYCLE_REBUILD.md`, approved 2026-11-17 (approval sha256 b0b7761956bd599eebc8f99bda5293eda096abdc045ea85fee484550cd28cc9c). This amends its oracle item 11 and design 1E.

**David, 2026-11-25, verbatim (UAT of PR #1227 T1):** "The male render should not start on save. I may want to change the bubbles or other items before render. Make all renders a manual step on both the moderation and fact pages." Answered Q41: 1 — do it now, before increment 3.3. Scope approved in words 2026-11-25: "approved".

## Product intent

1. No render starts by itself anywhere an admin works on gags: not on saving a gag, not on arriving at the moderation Test Renders step, not on opening the fact sheet or any of its tabs, not on creating a gag or on a gag being pre-filled.
2. Every render — male, female and pet alike — is drawn only when an admin asks for that render, on the moderation steps and on the fact sheet alike.
3. A save stores the gag and draws nothing. A saved change to a gag still makes that gag's existing renders out of date, as today, so they can't be approved for the changed gag.
4. Each render window with no current render offers the admin a clear way to draw it, and says it has not been drawn yet, rather than showing a spinner or waiting state for a render nobody started.

## Must not change

- Rule 12: three approved renders (male, female and pet) per published gag before a fact goes live or a change is published. The go-live refusal keeps naming what is missing.
- Paid-run accounting and the budget gate on every render that is requested.
- What a render draws once requested (prompt, engine, references).
- The member-facing meme and picture flows: this is about admin test renders on the moderation and fact-sheet screens only.
- Approving, redrawing and the existing "request female / pet" controls, which keep working.

## Settled decisions

- Item 11's "male runs automatically, female and pet on request" and 1E's "male starts on arrival for any gag without a current male render" are replaced by "every render on request" (David, Q41: 1).
- Test Renders still shows three render windows per gag and nothing else from the gag setup (item 11, unchanged otherwise).
- 1.3c's rule that nothing draws on the Gags step stands.
- The automatic-render job and its queue are removed, not left idle, and any of its jobs still waiting are deleted (Astra's scope concern C1, under "Deprecated means removed", decisions.md 2026-11-17).

## Now / next / never

- **Now:** remove every automatic render trigger (server and screen), the job and its queue with a data clean-up of its leftover jobs; make every window's draw manual; update the tests, acceptance journeys and recordings that expect the automatic male render; the parent plan's item 11 and 1E, a `decisions.md` entry superseding where earlier entries say the male render starts by itself, and the Moderation chapter of the Manual with the help built from it.
- **Next:** a "draw all three" convenience button, if David wants one after using it.
- **Never (here):** changing rule 12 or the member flows.

**Ceremony tier:** product (production phase). One data-only clean-up migration, no schema change.
```

## Problem

Three server paths start an admin test render without anyone asking for one, and all three draw the male render only (code read at `cedcf67`):

- **Creating a gag** — `POST /admin/facts/:factId/gags` calls `enqueueGagIterationRender` (`artifacts/api-server/src/routes/gags.ts:110`).
- **Saving a gag** — `PUT /admin/facts/:factId/gags/:gagId` calls `enqueueGagIterationRender` (`gags.ts:142`). Idea "use on gag N", Discard and every fact-sheet save reach it. This is PR #1227's "one paid male render" on a live fact's save.
- **Approving the Gags step** (arrival at Test Renders) — `POST /admin/reviews/:id/approve-visual-concept` calls `enqueueReviewIterationRenders` (`reviews.ts:1010`) and returns `renderPrepareJobId`.

All three queue jobs on `review_render_scenarios_prepare` (`lib/reviewRenderScenarios.ts:82`). Its handler (`:685-720`) ends in `scheduleIterationRender` → `drawGagKinds(gagId, [ITERATION_KIND])`, the same draw function the explicit route uses (`gags.ts:172-184`, `POST …/renders`, whose `kinds` is required, `.min(1)`).

No screen starts a render on mount. The screens instead **expect** the automatic one:

- `GagsPanel.tsx` has a 60-second "prepare window" (`PREPARE_WINDOW_MS`, `:38-44`, `:175-195`). It polls while any gag lacks a male render and is reopened after every save (`windowKick`, `:160-163`).
- Moderation passes `rendersExpected` (`moderation.tsx:874-875`).
- The window-level "Render {missing}" button offers female and pet only (`REST_KINDS`, `:702-712`).
- A missing male render can be drawn only from its own tile's "Draw this render" (`RenderTile`, `:813-817`).
- Copy on `VisualConceptCard.tsx:131` says saving draws a male render.

## Proposed design

**D1. The server starts no render by itself.**
- Remove the calls at `gags.ts:110`, `gags.ts:142` and `reviews.ts:1010`.
- Remove the helpers `enqueueGagIterationRender`, `enqueueReviewIterationRenders`, `ensureReviewIterationRenders` and `scheduleIterationRender`, and the handler `reviewRenderScenariosPrepareHandler` with its queue registration and the queue constant. Anything only they use goes too.
- `approve-visual-concept` stops returning `renderPrepareJobId`.
- `drawGagKinds`, the explicit `POST …/renders` route and its guard `assertCanRunGagRenders` stay unchanged. That includes the guard's `GAGS_STEP` refusal (1.3c), its scope checks and the budget gate.
- Whatever else lists the queue (`adminQueueHealth`, retention lists) drops it.

**D2. Leftover jobs are deleted.** One data-only migration deletes every job on `review_render_scenarios_prepare`, whatever its state. Its notice counts them by state. It is idempotent, so a second run deletes 0. It ships in the same PR as D1 and runs when the new release boots.
- **A job deleted before it ran costs nothing.** The render it would have drawn is simply not drawn, and the admin draws it when wanted.
- **The migration slot is claimed on Issue #1018 and Issue #1030 first**, per the collision rule.
- **At publish the old release can still queue one after the clean-up has run** (Astra, C1). The deploy runbook prepares the new release beside the old one and migrates before promotion (`docs/engineering/deploy-and-rollback.md:55`), so an old-process gag save or Gags approval could enqueue one more job. The fix is operational, with no new mechanism:
  - The PR's publish notes and Issue #1018's *Publish order* say to make no gag creates, saves or Gags approvals from the moment the publish starts until the new release is serving.
  - Once it is serving, a read-only count of jobs on the queue must be 0.
  - The same count is taken on dev after the Repl sync.
- **Upgrade rehearsal:** the queue's deletion is listed as intended in the rehearsal's loss accounting (`artifacts/api-server/scripts/upgrade-rehearsal.ts:133`), so a snapshot holding such jobs doesn't report it as unintended loss.

**D3. Every window is drawn by hand.**
- Remove `GagsPanel`'s prepare window: `PREPARE_WINDOW_MS`, `windowKick`, `awaitingMale` and the `rendersExpected` prop and its passing from moderation.
- Polling stays only while a render the admin requested is queued or drawing, or while a gag pre-fill is in progress.
- Each tile keeps "Draw this render" and "Draw again" for all three kinds. A first male render is drawn from its own tile.
- The existing combined female-and-pet control stays as it is. Adding male to a combined action is the deferred "draw all three" (Now / next / never), not part of this plan (Astra, C2).
- Each undrawn tile says "Not drawn yet", with no spinner.
- The same panel serves moderation and the fact sheet, so both change together.

**D4. A save still makes old renders out of date.** Unchanged code: `saveGagContent` clears selections that no longer match, and approval and `checkGoLive` check each render against the gag's current content. Tests prove it still holds with no automatic draw.

**D5. Words.**
- Remove "saving draws a male render" from `VisualConceptCard.tsx:131` and every other copy line found by a sweep of the screens for "male render" and "drawn on arrival".
- Update stale code comments the same way (`gags.ts:170`, `gagStore.ts:252-253`, the `GagsPanel` header and docblocks).

**D6. The parent plan, the decisions and the Manual.**
- Edit `PLAN_FACT_LIFECYCLE_REBUILD.md`: item 11 becomes "Test Renders: three render windows per gag and nothing else from the gag setup; every render drawn on request (Issue #1282, amended 2026-11-25); 'Back to gags'. Final hashtags and 'Approve for production' are on this step." In 1E, "male starts on arrival for any gag without a current male render; female and pet start on request" becomes "every render starts on request (amended 2026-11-25, Issue #1282)". An amendment line under the oracle names this plan and its digest.
- Add a `decisions.md` entry: renders are always drawn on request. It supersedes the 2026-11-21 entry's "The male render starts on arrival" and any line of the 2026-11-15 entry that says renders are drawn as the moderator iterates. Both are marked superseded, pointing at the new entry.
- Correct `docs/manual/3-moderation.md` wherever it says a male render starts on arrival or on save, and regenerate the help files built from it with the repo's own generator.

## Testing plan

**Absence: nothing draws by itself.** Server tests assert that each of these leaves zero new `image_prompt_attempts` rows and zero jobs on any render queue:
- creating a gag;
- saving a gag, on a live fact and in moderation;
- applying an idea;
- a gag pre-fill;
- approving the Gags step;
- `GET` of the fact sheet and the gags view.

This replaces the tests that asserted the opposite:
- `routes.gags.test.ts:146-171`, `:452-471`;
- `gagExampleSets.test.ts:289-349` (the handler's cases go with the handler);
- `routes.approveVisualConcept.test.ts:269-281`;
- `imageProvenance.test.ts:176-186`, whose provenance property moves to the explicit route if it is not already covered there.

**Presence: a requested draw still works.** The explicit route draws exactly the requested kinds, male alone included. It is still refused on the Gags step (`GAGS_STEP`) and by the budget gate. A saved change still makes an approved render unusable for the changed gag, and publication still names the missing kinds.

**Screen.** `GagsPanel.test.tsx`:
- no polling after a save or at arrival with nothing requested;
- each tile's "Draw this render" requests its own kind, a first male draw included (`kinds: ["male"]`);
- the existing female-and-pet control still sends `kinds: ["female","pet"]`;
- polling runs while a requested render is drawing;
- no spinner on an untouched window.

The tests at `:247-258`, `:276-292`, `:327-385` are rewritten to the new behaviour.

**Migration.** A migration test plants jobs in several states, plus jobs on other queues, and checks three things: the counts, that the other queues' jobs survive, and that a re-run deletes 0.

**Acceptance journeys.**
- Journey 3 (`testing/acceptance/driver.ts:362-388`) requests the male render explicitly, because it evaluates and approves it. The render-failure control then observes that requested render.
- `captureJourneys.ts:128-146` waited for the automatic male render only to free its reservation before the shot's own render request. That wait is removed, and the shot-producing request stays.
- The existing recordings are replayed first. They are keyed by the vendor request's content, not by what triggered it, so a male render requested with the same content should match.
- If a recording does not match, a top-up recording is made. Its ceiling is **$3** (the last top-up cost $1.54), within David's monthly budget, and it is logged on the paid-run ledger.

**Browser.** The admin screens suite still passes, and Test Renders shows a draw button on a gag with no renders.

## Implementation steps

One PR (D1–D6), branched from fresh `main`, merging `main` first if PR #1290 has not landed. It touches neither file that PR does.

## Risks

- **A render an admin expected won't appear.** That is the intended change, and the copy now says so plainly.
- **Recordings may need a paid top-up.** It has a ceiling and is logged.
- **Leftover queued jobs on production.** Deleted by D2, with counts. One more may be queued while the old release is still serving during a publish, which the publish note and the 0-count check after cutover cover.

## Questions for David

None. Every behaviour here is in the agreed scope.

## Definition of Done

- No code path outside the explicit render route creates a scenario-keyed render attempt.
- The automatic-render queue and its handler no longer exist, and its jobs are deleted.
- On moderation and the fact sheet, a gag with no renders shows three undrawn windows, each with its own draw button.
- After the first publish that carries this change, the retired queue holds 0 jobs on production, by a read-only count.
- All suites and the acceptance journeys are green.
- The parent plan, `decisions.md` and the Manual say every render is drawn on request.
