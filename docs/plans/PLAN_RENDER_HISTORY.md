# Plan — a gag's render history, and the Gags and Renders views each earn their place (Issue #1304)

```plan-oracle
# Oracle: a gag's render history, and the Gags and Renders views each earn their place (Issue #1304)

**Direction served:** the fact lifecycle rebuild (Issue #1018), whose plan has every render drawn on request (PLAN_RENDERS_MANUAL.md, 2026-11-25) and every gag's male, female and pet examples approved by a human (rule 12). Moderation's Test Renders step and the fact sheet's Gags and Renders tabs share one panel (`GagsPanel`).

**David, 2026-11-25, verbatim (UAT of PR #1297 T1):** "it's still extremely unclear what the purpose of the images on the Gags tab are vs. the images on the Render tab. This needs to be made clear and obvious so that an admin knows exactly what's going on. The images shouldn't be in two places unless each place earns it's place. I think that having the "official" renders on the gag page is fine, so long as it's clear that that's what they are, the approved live examples. The Renders panel should show the status of renders, if there are official ones, those can be there, but they should be locked off from the "draw this render" section. Also, the Renders tab should keep a history of all the renders with all the metadata that created them. We pay for every render so they should all be saved for future reference so I can see how images have evolved over time. There should be a way to delete an old render if I don't want it anymore. If I click the Draw again button the system should keep the existing render, move it into history with all the appropriate metadata about how it was rendered and then kick off the new render. When the new render appears, it should be the only one I see unless I go back in the history and expand an old entry. Each visual gag has its own history, of course. I'll let you go and design this properly given the goal is to be able to create new renders when the gag has changed, as well as to browse all the old renders with their metadata."

**His answers (2026-11-25), Q46–Q52:** Q46: 1 — with an official render, a new one can still be drawn; the official stays live and locked, and a new draw replaces it only if approved. Q47: 1 — delete removes a render for good, image file included; official renders and any render in use can't be deleted. Q48: 2 — each entry shows when and by whom, the gag's scene and bubbles at that moment, which picture and reference photo, the engine and the exact prompt, whether it worked or why it failed, whether it was ever approved, and its cost, "so long as the cost lookup isn't an expensive thing to build or execute". Q49: 1 — the same on moderation's Test Renders step and the fact sheet. Q50: 1 — every stored render appears, failed ones included, back to when gags got their own table.

## Product intent

1. **The Gags view shows a gag's official renders** — its approved male, female and pet examples that members are offered (or will be, at publish) — labelled plainly as the approved live examples, and nothing else of its renders.
2. **The Renders view shows, per gag and per picture (male, female, pet): the official render if there is one, locked (no draw or delete on it), and separately the current working render with its status and "Draw this render" / "Draw again".** An admin can tell at a glance which picture is live and which is a draft attempt.
3. **"Draw again" keeps the current working render**: it moves into that gag's history with its metadata, and the new render becomes the one shown. Only the newest working render is shown per picture until the admin opens the history.
4. **Each gag has a render history**: every render ever drawn for it, newest first, failed ones included, each expandable to its metadata — when and by whom, the gag's scene and bubbles as drawn, which picture and reference photo, the engine and the exact prompt sent, whether it worked or why it failed, whether it was ever approved, and its cost.
5. **Cost is what fal actually billed for that render**, from fal's Billing Events API (`GET /v1/models/billing-events`, which returns each request's `cost_total` in USD), matched by the fal request id every render already stores (`image_generation_requests.vendor_request_id`). It is fetched in the background and stored once fal has posted it, so viewing the history makes no fal call. Until fal posts it, or where fal no longer has it, the entry says so rather than guessing (David, 2026-11-25: "The cost should be an easy lookup from the fal.ai API endpoint, no?").
6. **An old render can be deleted for good**, its image file with it, after a confirmation. The server refuses to delete an official render, the current draft pick, or any render a member's content uses, and says why.
7. **An official render can be replaced only by approving a newer one**, under rule 12, exactly as today.
8. **A rejected submission is purged** (David, Q52, 2026-11-25: "We should delete renders associated with rejected submissions… If a fact isn't going to live in the system, it should be purged."). Rejecting a submission deletes its renders with their image files, and its staging fact with everything that exists only to make it a fact. The rejection record the submitter sees (their Library card and its reason) and the admin record of the rejection stay. Submissions already rejected are purged once, with counts. This supersedes 1.2c-i's tie-break that a rejected submission's pictures are "never offered", not deleted.
9. **Older renders whose approval can't be established say "Approval history not recorded"**, never "Never approved"; from now on every approval is recorded in the same transaction as the pick (David, Q51: 1).

## Must not change

- Rule 12 and the go-live and publish checks; which renders members are offered; how approval works.
- Every render is drawn on request (PLAN_RENDERS_MANUAL.md); nothing draws by itself.
- What a render draws once requested; paid-run accounting and the budget gate.
- The member-facing meme and picture flows.

## Settled decisions

- Q46–Q52 as above (David, 2026-11-25); Q51: 1; Q52: purge rejected submissions (intent 8).
- Renders are already kept: no server code deletes a gag's render attempts today, and "Draw again" creates a new attempt beside the old one (code read at `cc4652b`), so the history is a view over stored renders plus a delete, not a new store.

## Now / next / never

- **Now:** the two views' split and labels, the per-gag history with metadata and fal's billed cost, delete with its guards, on moderation's Test Renders step and the fact sheet; the purge of rejected submissions, going forward and once for those already rejected.
- **Next:** "draw all three"; comparing two renders side by side.
- **Never (here):** changing rule 12, approval, or the member flows.

**Ceremony tier:** product (production phase). Deleting renders and their files is a destructive action on stored data and gets the migration-review lens. Storing the billed cost adds one nullable column (an additive migration).
```

## Preflight

- **Increment test.** This makes four things true. Each gag's renders are kept, browsable with how they were made and what fal billed. The two views have distinct jobs. Old renders can be deleted safely. A rejected submission leaves nothing behind but its rejection record. It is bounded by intent items 1–9, and completion is the Definition of Done below. Three increments (Implementation steps); each ships alone.
- **Affected-surface inventory** (run at `cc4652b`):
  - **Code that deletes render rows:** `git grep -n "delete(imagePromptAttemptsTable)\|DELETE FROM image_prompt_attempts"` over server source, tests excluded, prints nothing. Render rows go today only by the facts→attempts cascade (`image_prompt_attempts.fact_id ON DELETE CASCADE`).
  - **What builds a gag's render windows:** `git grep -n "buildGagKindCards\|examplesStandingIn"` finds one builder (`reviewRenderScenarios.ts:496`) with one caller (`gagView.ts:121`).
  - **Where the panel appears:** `git grep -n "<GagsPanel"` finds `FactSheet.tsx:734` and `moderation.tsx:819, 870`.
  - **What Reject removes:** `git grep -n "delete(factGagsTable)"` finds one hit, the reject route (`reviews.ts:902`).

  The scope below is drawn from these.

## Problem

Today a gag shows one render per picture: the newest whose content matches the gag as it is now (`attemptForContent`, `reviewRenderScenarios.ts:165`), with approved picks standing in, marked stale, when none matches. Every other render is stored and shown nowhere. "Draw again" adds a render and the previous one disappears from view. The Gags step / Gags tab and the Renders tab both show pictures, with no plain statement of which one members see.

A rejected submission keeps its unpublished ("staging") fact. With it stay the fact's renders, image files, readings and taxonomy runs, reachable by no screen.

What fal charged for a render is not recorded. The engine comparison already reads fal's Billing Events API with a separate billing-read key (`lib/comparison/billedCost.ts`, `FAL_BILLING_API_KEY`).

## Proposed design

**D1. Each picture has up to three roles, and each role is computed from existing records** (no new stored state):
- **Live example:** the gag's published pick for that picture.
- **Approved for next publish:** the draft pick, when it differs from the published one.
- **Working render:** the newest render of that picture for this gag, whatever its content or status.

One render can hold several roles; the screen shows each role once and says which roles a render holds.
- **A draw from the working area always makes a new render** (the explicit route with `redraw`). The "this content already has one" reuse never applies to a request an admin makes, so a click can never quietly draw nothing (Astra C2).
- **The newest render stays working even after it is approved.** Approval does not move the working render back to an older one (C2).
- **A changed gag's working render is marked "drawn from an earlier version"**, as today's stale flag does.

**D2. The Gags view shows only official renders:** each picture's Live example and, when different, its Approved-for-next-publish pick, each under its label. A picture with neither says "No approved example yet". On moderation, where nothing is live yet, the label reads "Approved for publishing".

**D3. The Renders view (moderation's Test Renders step and the fact sheet's Renders tab), per gag, per picture:**
- the **official render** (Live example / Approved for next publish), locked, with no draw or delete on it;
- beside it the **Working render**, with its status, Approve (as today) and "Draw this render" / "Draw again".

Below the pictures, each gag has a **History** section, collapsed by default.
- **What it lists:** every render of that gag, newest first, failed ones included, the current working and official renders among them, each with a tag naming its current roles.
- **Each entry** is one line (picture, when, by whom, status, billed cost) and opens to its full record (D4), so the working and official renders' records are reachable too.
- **Reads are paged** (50 at a time), with "Load older" until the history runs out, so no paid render is out of reach (Astra C3). Approving a render from history is not offered; approval stays on the working render (the next of the deferred items, if wanted).

**Removed gags.** A removed gag keeps its history in a collapsed "Removed gags" section, grouped by the gag's own id, never by its slot, which another gag may now occupy.

**D4. A history entry's full record** is read from what the render stored:
- **When and who:** created time, and the admin from the render's audit (`renderControls.reviewAudit.adminUserId`, named as History names admins).
- **The gag as drawn:** scene and bubbles from the render's frozen gag content (`factEnrichmentSnapshot`).
- **Which picture:** the picture kind and the reference photo (identity type and asset version).
- **Engine and prompt:** the engine actually used, including a fallback when one happened, and the exact input sent to it (`image_generation_requests.request`).
- **Outcome:** done, or failed with its error.
- **Approval:**
  - **"Approved"** when it is, or was, a pick: the current draft or published pick, a retained selection snapshot naming it, or a `gag_render_approval` record naming it;
  - **"Approval history not recorded"** when there is no such evidence and the render was drawn before approvals were guaranteed to be recorded. Until D8 ships, a failed audit write was swallowed after the pick committed (`adminActions.ts:39`), so a later-replaced approval can have left no trace;
  - **"Not approved"** only for a render drawn after that guarantee began, with no evidence (Q51; Astra C1).

  **When the guarantee begins:** a migration's time does not mark it, because the previous release keeps serving after migrations run and before promotion (`deploy-and-rollback.md:55`). The boundary is set by the new release itself once it is serving, `admin_config` `render_approval_audit_complete_since`, with a conservative margin the build chooses and states. A render drawn by the previous release after the migration applied stays "not recorded".
- **Billed cost:** see D5.

**D5. Billed cost** is what fal charged, read from fal's Billing Events API with the existing billing-read key and fetcher (`lib/comparison/billedCost.ts`, `FAL_BILLING_API_KEY`).
- **Storage:** two new nullable columns on `image_generation_requests`:
  - `billed_usd`;
  - `billing_checked_at`, the time of the last successful lookup whose window covered the request. A failed lookup leaves both untouched, so "not checked" and "checked, no bill" stay distinct (Astra C5).
- **Filling:**
  - **Who fills it:** an hourly monitored task fills it for requests that reached fal (a vendor request id) and have no bill yet.
  - **How far back:** it looks back as far as such requests go, in windows no longer than fal's 90-day limit per query. That is a query limit, not a retention limit (Astra C5), so age alone never marks a bill unavailable.
  - **Several events for one request** are summed.
  - **Viewing makes no fal call.**
- **What an entry shows:**
  - **A render's cost** is the sum over its requests (a retry or fallback makes several). When only some requests have a bill, it shows the known amount and "1 request not billed yet", never a partial sum as the whole.
  - **"Not checked yet"** before any successful lookup.
  - **"No bill found at fal yet"** when a successful lookup covering that request's date found none. This says only that, never that fal dropped it.
  - **"Billing key not set"** when the key is absent, which is checked on dev and production at close-out.

**D6. Deleting an old render** removes it for good, after a confirmation naming the picture and date. It removes the render's row and its image file. The provenance records stay, as the 2026-11-10 tracing decision keeps them after content deletion.

**The refusal is a construct, checked inside one transaction** that takes the fact row lock every gag action takes, so it holds against an approval or publish at the same moment. The server refuses when the render:
- is any gag's draft or published pick (also enforced by `fact_gag_examples.attempt_id`'s foreign key);
- is still queued or drawing;
- belongs to another fact.

**Member content:** members' memes require an owned upload (`createMemeRecord.ts:190`), and gag render producers do not mirror into members' content. No present member path uses a gag render other than through the published picks the first refusal covers. The build re-checks this inventory and adds a refusal for any retained reference it finds.

**Legacy columns:** the unread recovery-snapshot columns on `fact_gags` (`approved_/pending_example_attempt_id`) that point at it are cleared in the same transaction.

**The row and the obligation to delete its file commit together** (Astra C4):
- **In one transaction:** the render's row is deleted and its file paths are written to a durable cleanup list, `stored_file_deletions`. That covers the render's own path and every path its provenance records for it, which includes a picture uploaded but never linked.
- **After commit:** a cleanup runs at once. A sweeper retries anything outstanding every hour, using `ObjectStorageService.deleteObject` (its seven-day media backup is the settled safety net; an already-missing file counts as done).
- **What the admin is told:** "Deleted" once the file is gone, or "Deleted; its picture file is still being removed" while the list holds it.
- **What the list holds:** each path keeps its reason, attempts and last error until done, and the list's outstanding count shows on queue health. Nothing is ever abandoned silently.
- **A deleted render can no longer be approved:** its row is gone, so a stale screen's approval is refused as not found.
- **The delete is recorded in History** (a new admin action, `render_delete`, with the picture and date).

**D7. A rejected submission is purged.** A rejected submission's staging fact is one that was never approved:
- no approval, and not active;
- no "ever approved" record (1.2b);
- no other open review on it.

That fact is deleted with everything that exists only to make it a fact. The facts foreign keys do this by cascade: its renders, gags, readings, taxonomy runs and hashtag links. The fact's hashtags are detached through their one writer first, as the permanent delete does, so their counts stay right. Its render image files go onto the same durable cleanup list as D6, in the same transaction: every render's own path and every path its provenance records.

**What stays:** the review row, which is all the submitter's Library reads (`mySubmissions.ts`: text, reason, note; never `facts`), and its `staging_fact_id` is set to null. The admin record of the rejection also stays, with its fact link nulled and its review link kept.

**A render still running when its fact is purged leaves no file behind** (Astra C4, rounds 1 and 2). Today the worker uploads the picture first (`imagePromptJobs.ts:459`) and then updates the render row without checking that the row exists (`:509`).

**The worker's final storage now serializes with the purge:**
- once fal's result is in hand, the worker takes the fact lock and re-checks that the fact and the render exist **before** it records provenance or uploads;
- if either is gone, it stores no picture;
- otherwise it holds the lock through provenance, upload and linking the picture to the render.

**Interruption:** the purge and the delete take the same lock and gather every committed provenance path for the render. That covers a picture uploaded but never linked because the worker stopped. The vendor wait stays outside the lock, and the upload keeps its existing timeout, so the lock is held for seconds.

**At reject:** the purge runs inside the reject transaction for a submission past Triage.

**Already-rejected submissions** are purged by a one-time command using the same predicate and the same purge.
- **It reports first:** run without `--apply`, it reports the facts it matched and skipped, by reason, and the renders and files they hold, deleting nothing (the migration guidance's dry run).
- **With `--apply`,** it purges and logs the same counts, and a re-run finds nothing.
- **Dev** gets both steps at close-out.
- **Production** gets both at the publish that carries increment A, through the Repl agent, in Issue #1018's publish order (Astra C4). This supersedes 1.2c-i's tie-break that a rejected submission's pictures are "never offered", not deleted (David, Q52).

**D8. Approvals are recorded in the approval's own transaction from now on** (Q51). The `gag_render_approval` record is written in the same transaction as the pick, instead of after it, where a failed write was logged and swallowed.

## Data model and migration impact

- **Migration 0172 (increment A, additive):**
  - the table `stored_file_deletions` (path, reason, attempts, last error, created and done times; one open row per path);
  - the admin-action vocabulary gains `render_delete`;
- **Migration 0173 (increment B, additive):** `image_generation_requests.billed_usd numeric(10,4) NULL` and `billing_checked_at timestamptz NULL`.
- **Row states, for the purge:**
  - a qualifying staging fact: purged and counted;
  - a fact with any approval evidence: skipped and counted;
  - a fact with an open review: skipped and counted;
  - a fact already gone: a no-op;
  - a file already missing: counted as deleted.
- **Rollback:** the column and the action value are additive. The purge and render deletes are destructive by design. Files keep the seven-day media backup. Rows are not recoverable, and that is accepted under Q47 and Q52.
- **Slots** are claimed on Issue #1018 and Issue #1030 first.

## Security, permissions and validation

The new routes (history, delete) sit behind the existing admin check and are added to the permission grid and its test. A render id is checked against the fact and gag in the path, so an admin cannot delete another fact's render by id. The billing-read key stays server-side and is never sent to a client.

## Testing plan

- **Roles (server):** after redraw, approve, publish and edit, the working, approved-for-next-publish and live roles are the right renders. A requested draw always makes a new render. Approval never resurrects an older working render.
- **History (server):** every render of a gag is listed, removed gags' included and grouped by id, with each D4 field read from what it stored. The approval states cover each case, including "not recorded" for a pre-0152 render.
- **Billed cost:** from recorded fal responses:
  - several events for one request are summed;
  - a render with several requests sums them;
  - a partly billed render shows the known amount plus what is outstanding;
  - a request older than 90 days is looked up in its own window;
  - "No bill found" and "Billing key not set" read as stated.
- **Delete:** an eligible render's row goes and its file reaches the cleanup list in the same commit. A pick, a running render and another fact's render are refused, each with its reason, including under a concurrent approval. A rollback leaves both the row and the list unchanged. A storage failure leaves the path outstanding, and the sweeper's retry removes it. A stale approval of a deleted render is refused.
- **Purge:** the row-state matrix above, run twice. The dry run's counts equal what `--apply` then purges. The submitter's Library still shows the rejection with its reason. Hashtag counts drop.
- **The worker race:** these all leave no stored file outside the cleanup list:
  - a rejection before the final store;
  - a rejection while the worker holds the lock;
  - the combination: a purge before provenance is created, then an interruption after upload, followed by a restart and the sweeper.

  No surviving render becomes an official example with its file missing.
- **Approval states:** these include:
  - a post-0152 approval whose audit write failed and whose pick was later replaced;
  - a render drawn by the previous release after migration 0172 applied.

  Both read "Approval history not recorded".
- **History paging:** the oldest entry beyond the first page is reachable, and a render that is both working and official opens to its full record.
- **Screen:** the Gags view shows only labelled official renders. The Renders view shows official renders locked beside the working render; history is collapsed and opens an entry; delete confirms.
- **Acceptance:** journey 3's reject variant still sends its email, and the submission's fact is gone afterwards.
- **UAT (David):** whether the two views now read as clearly different jobs, and whether the history tells him enough.

## Implementation steps

1. **Increment A — purge on rejection and safe file cleanup:** D7, D8, the cleanup list and sweeper, the worker's final-step change, the one-time purge command, and migration 0172. No screen change.
2. **Increment B — history and cost on the server:** D1's roles, D4's paged history read, D5's fill (migration 0173), and D6's delete route on A's cleanup list.
3. **Increment C — the views:** D2, D3 and D6's confirmation, on moderation and the fact sheet.

## Risks

- **The billing-read key may be missing on dev or production.** The history then says so, and setting it is David's (the fal dashboard's BILLING preset).
- **Purging is irreversible.** The qualifying predicate is a construct, with three conditions plus the ever-approved record, and it is tested against a live and a previously approved fact.
- **History on a gag drawn many times could be long.** It is collapsed, newest first, and paged with "Load older".

## Questions for David

None open. Q46–Q52 are answered (scope). Q52 overrides an earlier call made on my recommendation (1.2c-i).

## Definition of Done

- Every render of a gag is listed in its history, with its record and fal's bill or a stated reason for none.
- "Draw again" keeps the previous render in history.
- Official renders are locked, and only they appear on the Gags view, labelled.
- Delete removes an eligible render and its file and refuses the rest, saying why.
- A rejection purges its submission's fact and renders, and already-rejected ones are purged once, with counts.
- All suites and the acceptance journeys are green.
