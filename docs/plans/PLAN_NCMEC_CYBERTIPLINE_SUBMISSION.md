# Plan — NCMEC CyberTipline submission + safety admin surface

**Status:** draft, in Codex plan review
**Subsystem:** legal/safety moderation (`artifacts/api-server/src/lib/moderation/`)
**Companion plan:** `PLAN_NCMEC_EVIDENCE_RETENTION.md` (separate review PR — evidence
expiry and deletion). Neither plan depends on the other's outcome.

---

## 1. Product intent

Availeron Consulting, Inc. is now a registered CyberTipline ESP (approval received
2026-07-23). Credentials cover both NCMEC's testing and production environments.

Today `submitNcmecReport()` is a stub: it writes a row to `ncmec_reports` and emails
the admins. It has never contacted NCMEC. The intent is to make reporting **real** —
an actual, automated CyberTipline submission for every reportable moderation hit —
and to give David a surface where he can see that reporting is working, see what
failed, and retry it.

The statutory backdrop is unchanged: 18 U.S.C. § 2258A obliges a provider with actual
knowledge of apparent CSAM to report it, and to preserve the report and its supporting
bytes. This plan delivers the *reporting* half. Preservation and expiry are the
companion plan.

## 2. Must not change

These are invariants a correct implementation preserves. Breaking any of them is a
defect regardless of what else the change achieves.

1. **Detection behavior is untouched.** Arachnid, the NSFW classifier, and fal safety
   keep their current thresholds, fail-open/fail-closed semantics, and non-production
   bypasses exactly as they are. This plan changes what happens *after* a hit, never
   what counts as a hit.
2. **Quarantine still fails closed.** `quarantineImage()` throws on storage failure so
   the caller can refuse the upload. A submission failure must never turn a rejected
   upload into an accepted one.
3. **Reporting failure never blocks the user-facing rejection.** Today `quarantine.ts`
   catches submission errors so the upload still gets rejected. That stays true.
4. **Evidence bytes remain unreadable over HTTP.** The `restricted/` prefix is not
   served by `/storage/objects/*` or `/storage/public-objects/*`, and
   `deleteObject` refuses restricted paths without `force: true`. This plan adds no
   route that serves those bytes — see §5.7.
5. **No evidence is deleted.** Nothing in this plan calls `deleteObject` at all,
   with or without `force`. Deletion belongs entirely to the companion plan.
6. **Default-off in production.** Merging this plan must not cause a single live report
   to be filed. Real submission turns on only by an explicit admin-config change.
7. **Exactly one report per reportable hit.** Duplicate filings to a federal
   clearinghouse are a serious defect, not a cosmetic one. See §5.2.1 and §5.2.2.
8. **No reportable hit is ever silently unreported.** Every `ncmec_reports` row either
   reaches a final state — `submitted`, `filed_manually`, or `failed` **with a durable
   notification** — or sits in the **one acknowledged waiting state**: `pending` because
   submission is disabled, which is *itself* durably surfaced (§5.5). A row stuck outside
   both, with nobody told, is the worst outcome this subsystem can produce: it looks
   exactly like success from every surface. See §5.3.

   The carve-out is stated because the earlier phrasing — "every row reaches a final
   state" — was **contradicted by the design's own disabled path**, which deliberately
   parks rows at `pending` indefinitely. An invariant a design knowingly violates is
   worse than no invariant: it makes review look satisfied. The waiting state is
   legitimate; being unsurfaced was not.

## 3. What exists today

| Piece | File | State |
|---|---|---|
| Submission "client" | `lib/moderation/ncmec.ts` | Stub — one INSERT + admin email, 73 lines |
| Quarantine funnel | `lib/moderation/quarantine.ts:72` | Real |
| Arachnid client | `lib/moderation/arachnid.ts` | Real HTTP client |
| NSFW classifier | `lib/moderation/nsfwClassifier.ts` | Real |
| fal safety | `lib/moderation/falSafety.ts` | Real |
| Tables | `lib/db/src/schema/moderation.ts` | `quarantined_memes`, `ncmec_reports` (migration 0043) |
| Admin surface | — | **None.** No route, no page. |

Call sites that reach `quarantineImage()`: `userImageUpload.ts:162`,
`createMemeRecord.ts:324`, `aiMemePipeline.ts:271` and `:520`, plus `routes/memes.ts`.

`ncmec_reports` today holds `report_id` (always NULL), `submitted_at` (always NULL),
`submission_status` (always `pending`), `match_source`, `evidence_uri`,
`evidence_retention_until`, `user_id`, `request_metadata`.

Reportability today is decided at `quarantine.ts:101`:
`input.reportToNcmec ?? input.source === "arachnid"` — Arachnid hits only. The schema
comment claims classifier reports are "gated by config"; **no such config key exists.**
§5.5 makes that comment true.

## 4. External-claim verification

Verified 2026-07-29 against NCMEC's public ISPWS documentation at
`https://report.cybertip.org/ispws/documentation/` (fetched directly; the
documentation is publicly readable without credentials).

| Claim | Verified value |
|---|---|
| Auth | HTTP Basic, NCMEC-issued username/password |
| Production base URL | `https://report.cybertip.org/ispws` |
| Testing base URL | `https://exttest.cybertip.org/ispws` |
| Submission sequence | `POST /submit` → `POST /upload` (repeatable) → `POST /fileinfo` → `POST /finish` |
| Cancellation | `POST /retract` |
| Connectivity check | `GET /status` |
| Schema download | `GET /xsd` |
| Wire format | XML; roots `<report>`, `<fileDetails>`; responses `<reportResponse>`, `<reportDoneResponse>` |
| `/upload` format | `multipart/form-data` with `id` (report id) and `file` fields |
| `/upload` response | `<fileId>`, `<hash>` (MD5), `<reportId>` |
| Unfinished-report expiry | Deleted 24 h after opening, or **1 h after last modification** |
| Response codes | `0` success · `1000` server error · `2000` authentication required · `3000` not authorized · `4100` validation failed · `5001` report does not exist · `5102` report already finished |
| File annotations | include `<potentialMeme>`, `<viral>`, `<infant>`, `<generativeAi>` |
| Industry classification | `A1`, `A2`, `B1`, `B2` |

Two facts from this table drive the design more than anything else: the **1-hour
modification expiry** (§5.2) and **`5102 Report already finished`** (§5.2's duplicate
guard). One is a product-fit detail worth flagging: NCMEC's schema has a
**`<generativeAi>`** file annotation, and this platform's output is AI-generated
imagery (§5.6).

The credentials themselves were delivered by NCMEC as a password-protected attachment.
They are not in this document, will not be committed, and are consumed only as
environment variables (§5.4).

## 5. Design

### 5.1 The ISPWS client — `lib/moderation/ncmecClient.ts`

A thin, stateless HTTP client. Same shape as `arachnid.ts`: no persistence, no
decisions, test seams for `fetch` and credentials, a discriminated result type.

```ts
export interface NcmecClientOverrides {
  fetchImpl?: typeof fetch;
  credentials?: NcmecCredentials | null;
  baseUrl?: string;
}

export type NcmecCall<T> =
  | { status: "ok"; data: T }
  | { status: "err"; responseCode: number | null; message: string; retryable: boolean };
```

Operations: `checkStatus()`, `submitReport(xml)`, `uploadFile(reportId, bytes, mime)`,
`submitFileInfo(fileDetailsXml)`, `finishReport(reportId)`, `retractReport(reportId)`.

**How the worker reads evidence bytes — and what it must never use.** `uploadFile` needs
the bytes, and the plan previously left the read path unspecified. That is not a harmless
omission: `ObjectStorageService.getObjectEntityDownloadURL()` (`objectStorage.ts:245-251`)
signs **any** private subpath and has no `restricted/` guard — it is the natural helper to
reach for, and reaching for it would mint a time-limited, credential-free **bearer URL to
suspected CSAM**. Invariant 4 would be broken without anyone adding a route, which is
exactly the kind of violation route-level review would miss.

So the plan is explicit: the worker reads evidence via `getObjectEntityFile(evidenceUri)`
and an **in-process** byte read, streaming into the multipart body. **Signed URLs and proxy
routes are forbidden for evidence, categorically.** §6 asserts `getObjectEntityDownloadURL`
is never called on a `restricted/` path during submission.

**Response-code classification** — this is the client's most important job, because it
decides whether the worker retries:

| Code | Meaning | Classification |
|---|---|---|
| `0` | Success | — |
| `1000` | Server error | Retryable |
| `2000` | Authentication required | **Terminal** + alert (bad credentials) |
| `3000` | Not authorized | **Terminal** + alert |
| `4100` | Validation failed | **Terminal** — our XML is wrong; retrying cannot fix it |
| `5001` | Report does not exist | Context-dependent, see §5.2 |
| `5102` | Report already finished | Context-dependent, see §5.2 |
| Network / timeout | — | Retryable |

`4100` being terminal matters: a validation bug would otherwise burn the retry budget
on every report and bury the real signal.

**XML.** No workspace package depends on an XML library directly, so one is promoted to a
direct dependency: **`fast-xml-parser`, pinned at `5.5.9`** — already present transitively
(`pnpm-lock.yaml:3855`), so this adds no new code to the tree, only an explicit contract
with a version we control. An earlier revision described it as having *zero runtime
dependencies*; that was asserted without checking and is **wrong** — 5.5.9 carries runtime
dependencies of its own.

Hand-rolling is still worse: a subtle escaping bug in a legally-significant federal
submission is exactly what a maintained library prevents.

**Parser hardening is part of the dependency decision, not an afterthought.** We parse
responses from a remote host, and a malformed or hostile document must not become an
availability or memory problem:

- **DTDs rejected by an explicit pre-parse gate, not by a parser option.**
  `processEntities: false` disables *expansion* but does **not** reject a document
  containing a DOCTYPE — 5.5.9 parses
  `<!DOCTYPE foo [<!ENTITY x "boom">]><foo>&x;</foo>` successfully under that option and
  returns the literal reference. So the mechanism is ours: **before the body reaches the
  parser, reject any response whose content contains a `<!DOCTYPE` declaration**, with
  `processEntities: false` retained as defence in depth rather than as the control.

  The hostile-DTD test therefore asserts that a **harmless** DOCTYPE with no entity
  declaration is *also* rejected. Otherwise the test could pass because expansion happened
  to be off, while the gate it is supposed to prove does not exist.
- **Response body capped at 1 MiB, read as a bounded stream.** `response.text()` and
  `arrayBuffer()` buffer the entire remote body *before* any size check could run, so the
  cap must be enforced during the read: consume `response.body` and abort once the
  threshold is crossed. ISPWS responses are small XML acknowledgements; 1 MiB is orders of
  magnitude of headroom.
- **Nesting depth capped at 50** via the parser's `maxNestedTags`.
- Advisories and the changelog for the pinned version reviewed at adoption, and the pin
  recorded so an upgrade is a deliberate decision rather than a transitive drift.

§6 adds hostile-DTD and oversized-response tests, so the hardening is asserted rather than
configured-and-hoped.

### 5.2 The submission worker — and the duplicate-report problem

**Queue:** register `ncmec_submit` with the existing `async_jobs` infrastructure
(`lib/asyncJobs.ts`) rather than building a bespoke worker. It provides durable rows,
`FOR UPDATE SKIP LOCKED` claiming, exponential backoff, boot-time reclaim of stuck
rows, and `terminalFailure(code, error)` for non-retryable outcomes. Lane: `bulk`.

**The retry budget must be set explicitly — the queue's default is wrong for this.**
`getRetryConfig`'s defaults give five attempts at 5 min / 30 min / 2 h / 8 h, so a report
goes final `failed` after roughly **10.5 hours**. NCMEC being unreachable for a day is an
ordinary event, and under the default every report in that window would exhaust, land
`failed`, drop out of the reconciler's scope (which only repairs non-final rows), and
require per-row manual retry — while emitting one alert each. A day-long outage would
produce a terminal backlog that never resumes on its own plus an alert storm that trains
an operator to ignore the alert that matters.

So `ncmec_submit` sets **8 attempts with a horizon past 72 hours** (adding 24 h and 48 h
tail delays), which outlasts any plausible outage; and §5.8 adds a **bulk retry** action
plus **incident-level alert aggregation** for the case where it does not.

**What the queue does *not* provide, and this plan must therefore supply itself.**
Three of its properties are load-bearing here and none of them work the way a naive
reading assumes. Verified by reading `asyncJobs.ts`:

| Queue behavior | Verified location | Consequence for this design |
|---|---|---|
| A terminal failure **never fires `onAbandon`** — the finalizer returns before it | `asyncJobs.ts:474-484` (explicit comment) | Domain finalization cannot live in `onAbandon` (§5.2.3) |
| On retry exhaustion the `failed` commit lands **before** `onAbandon` | `asyncJobs.ts:455-497` | A crash between them permanently skips the hook (§5.2.3) |
| Claim stamps `updated_at` **once**; recovery requeues `processing` rows after 5 min (boot, `:843`) / 10 min (periodic, `:757`) | `asyncJobs.ts:588-597` | There is **no lease renewal** — a long-running handler can be reclaimed underneath itself (§5.2.2) |

Everything below follows from those three facts.

**One job runs the entire sequence.** Because an unfinished report is deleted one hour
after its last modification, spreading `/submit` → `/upload` → `/fileinfo` → `/finish`
across separate job rows invites a partially-built report expiring between steps. One
job execution performs all four calls; a failure anywhere restarts from `/submit` on
the next attempt.

#### 5.2.1 The duplicate-filing guard

Restart-from-scratch is only safe if we can tell whether a previous attempt already
finished. There is no per-report status endpoint — `GET /status` is connectivity only.
So a crash after `/finish` but before we persist `submitted` would, on retry, file the
same material twice.

The resolution uses `5102`:

1. Call `/submit`, and **persist the returned report id immediately**, before any
   upload, with status `in_progress`.
2. On a retry that finds a persisted report id, call `POST /retract` **first**:
   - Retract succeeds → the report was still unfinished. It is now gone. Safe to
     restart cleanly from `/submit`.
   - `5102 Report already finished` → **the previous attempt did finish.** Do not
     re-file. Mark the row `submitted` and stop.
   - `5001 Report does not exist` → it expired or was already removed. Safe to
     restart from `/submit`.
3. Only then proceed with the fresh sequence.

This turns an unanswerable question ("did it land?") into an answerable one, using the
error codes as the oracle. **It is necessary but not sufficient** — it only works once
a report id is persisted, which leaves the `/submit`-to-persist window uncovered.
§5.2.2 closes that.

#### 5.2.2 The submission lease — fencing the `/submit`-to-persist window

The queue's stuck-row recovery flips a `processing` row back to `pending` once its
`updated_at` is 5 (boot) or 10 (periodic) minutes old, and `updated_at` is stamped
**only at claim time** — there is no heartbeat. So a worker still legitimately running
a slow upload can have its job requeued and claimed by a second worker.
`FOR UPDATE SKIP LOCKED` does not help: after recovery the row is genuinely `pending`
and genuinely claimable.

If that second worker starts before the first has persisted its report id, both see a
null id, both call `/submit`, and both can `/finish` **different** reports. The §5.2.1
guard cannot see this, because the guard keys off a report id that does not exist yet.

The fix is a lease on `ncmec_reports`, owned by the domain rather than the queue —
this plan must not change the shared queue's contract for one consumer:

1. **The lease owner is a fresh token minted per handler invocation** — a `randomUUID()`
   generated at the top of `run()`, never a process id, worker id, or `async_jobs` row id.
   Those can all be **reused**: a reclaimed execution of the same job row would present
   the same identity as the execution it replaced, which is precisely the collision the
   lease exists to detect.
2. **Acquire before any ISPWS call**, as a conditional update:
   ```sql
   UPDATE ncmec_reports
      SET submission_lease_owner = $token,
          submission_lease_until = now() + interval '3 minutes'
    WHERE id = $id
      AND submission_status IN ('pending','in_progress')      -- never a final row (§5.3)
      AND (submission_lease_until IS NULL OR submission_lease_until < now())
   ```
   **Zero rows updated → another worker holds the lease, or the row is already final →
   return a retryable failure immediately and make no ISPWS call at all.** This is the
   fence.
3. **Renewal requires the token *and* an unexpired lease:**
   ```sql
   ... WHERE id = $id
         AND submission_lease_owner = $token
         AND submission_lease_until >= now()
   ```
   Checking the owner alone is not enough. After expiry, the overrunning worker could
   renew *first* and resurrect a lease a replacement was entitled to take — two live
   workers, which is the original defect wearing a lease. Requiring `>= now()` means an
   expired lease is unrenewable by anyone; it must be re-acquired through step 2, and only
   one caller can win that.
4. **A renewal that updates zero rows means the lease is lost.** The worker **aborts
   without calling `/finish`** and returns retryable. The stranded report is resolved by
   §5.2.1's retract-first on the next attempt.
5. **Hard sequence deadline of 3 minutes**, strictly below the 5-minute boot-recovery
   cutoff, with per-call timeouts summing under it. Exceeding the deadline aborts before
   `/finish` rather than racing it.
6. **Every state write after acquisition is conditional on still owning the lease and the
   row still being non-final** — the same `WHERE` predicate as renewal. A worker that lost
   its lease, or whose row was marked `filed_manually` by an operator meanwhile (§5.8),
   cannot overwrite that decision.

The lease is what makes "only one report can finish" true. `5102` is what makes
"and we can tell afterwards" true. Both are needed; neither alone suffices.

#### 5.2.3 Terminal finalization does not use `onAbandon`

`onAbandon` cannot carry the domain update. For a terminal failure the finalizer
returns before ever reaching it (`asyncJobs.ts:474-484` — deliberate, with a comment);
for retry exhaustion the queue commits `failed` *before* invoking it, so a crash or a
hook exception loses the update permanently. Either way a `4100`, `2000`, or `3000`
could leave the NCMEC row sitting at `pending`/`in_progress` forever with nobody told.

Two layers instead:

- **The handler finalizes its own domain row inside `run()`**, before returning
  `terminalFailure(...)` — and does it in **one transaction**: the
  `submission_status='failed'` / `last_error_code` update **and** the admin notification
  are committed together. The notification is an `email` job rather than an inline send,
  so it is durable, and `enqueueJob(options, dbOverride)` already accepts a transaction
  handle (`asyncJobs.ts:247`), so both writes share the caller's transaction with no
  change to the shared queue API.

  Atomicity is load-bearing here, not decorative: if the status update commits and the
  process dies before the notification is inserted, the row is now **final** — so the
  reconciler, which only repairs non-final rows, will never look at it again, and the
  required alert is lost permanently. A durable notification that can be orphaned is not
  durable.

  The notification insert carries a **kind-scoped** dedupe key —
  `ncmec:notify:failed:<reportId>`, never a bare `ncmec:notify:<reportId>`. The dedupe
  index covers any non-terminal job for a `(queue, dedupe_key)` pair, so a single key
  shared with the "awaiting activation" alert (§5.5) would mean: the disabled-state email
  is still `pending` when submission is enabled, the submission then fails terminally, the
  failure alert enqueues, **the index returns the existing awaiting-activation job**, and
  the row commits as final `failed` with nobody ever told it failed. One collided string
  would have silently defeated invariant 8. Every notification kind gets its own key
  segment.
- **The reconciler (§5.3) is the backstop** for every case `run()` cannot cover:
  a crash mid-finalization, exhaustion-boundary crashes, and rows whose job vanished. Its
  repairs are transactional on the same terms (§5.3).

#### 5.2.4 Enqueue is not atomic with the row — the reconciler owns that

`quarantine.ts` inserts the `ncmec_reports` row and then calls `enqueueJob()`. These are
two writes; a crash between them commits a `pending` row with no job.

**Both fixes apply, and they are not alternatives.** An earlier revision of this plan
chose reconciliation over atomicity on the stated grounds that atomicity would require
threading a transaction handle through `enqueueJob` for one caller. That reasoning was
wrong: `enqueueJob(options, dbOverride)` already takes one (`asyncJobs.ts:247`). So:

- **The insert and the enqueue share one transaction.** Cheap, available today, and it
  removes the crash window rather than compensating for it.
- **The reconciler remains** (§5.3), because atomicity only closes *this* window. Rows
  created while submission was disabled, pre-migration rows, and rows whose job went
  terminal without finalizing are all states no transaction can prevent, and they need
  a mechanism that derives desired state from actual state.

The governing principle stands either way: **the `ncmec_reports` row is the source of
truth and the job is derived from it**, never the reverse.

`submitNcmecReport()` keeps its signature and its "never throw into the caller"
contract. The existing admin email stays — useful independently of automation.

### 5.3 The reconciler — nothing stays silently unreported

The single mechanism that closes every "row stuck in a non-final state with nobody
told" path. `ncmec_reconcile` runs periodically (`bulk` lane) and at boot, and repairs
any `ncmec_reports` row in a non-final state by comparing it against its job:

| Row state | Job state | Cause | Repair |
|---|---|---|---|
| `pending` / `in_progress` | **no job row** | Pre-migration legacy row; row created while submission was disabled; a crash window §5.2.4's transaction does not cover | Enqueue one — **only if `ncmec_submission_enabled`** |
| `pending` / `in_progress` | `failed` | Terminal failure whose in-`run()` finalization was lost to a crash (§5.2.3) | Set row `failed` with the reconciliation code (below), enqueue an admin notification |
| `pending` / `in_progress` | `done` | Handler returned success without finalizing | Re-enqueue if enabled — **unless already test-submitted in the current environment** (below) |

**A completed test submission must not re-fire every five minutes.** §7 leaves a
test-submitted row at `pending` so it stays eligible for a real filing — but a `pending`
row with a `done` job is exactly what the third line above re-enqueues. Left alone, the
reconciler would re-submit every pending report to `exttest` on a 5-minute loop, dragging
the entire audited backlog through NCMEC's test environment repeatedly rather than the one
rollout hit. So the reconciler skips any row where
`ncmec_ispws_environment = 'test' AND test_submitted_at IS NOT NULL`. Flipping to
`production` makes that predicate false and the row eligible again — which is the exact
behavior §7 needs, and it falls out of the environment check rather than a second flag.

`pending` and `in_progress` are the only non-final states, and every one of them appears
above — that exhaustiveness is what makes invariant 8 checkable rather than aspirational.
There is deliberately **no `retracted` status** (§5.4): retraction is a step *inside* an
attempt, not a resting state, and adding it as a status would create a fourth non-final
state that a crash could park a row in, outside every repair.

**Scheduling — the reconciler does not run merely by being registered.**
`registerJobHandler()` only populates a registry and `runAsyncJobsWorker()` only claims
rows that were already enqueued; there is no recurring-job abstraction in this codebase.
So the schedule is specified explicitly, following the pattern the queue already uses for
its own stuck-row backstop (`asyncJobs.ts:751-757`):

- **A boot pass**, once per process start.
- **A periodic timer in the bulk runner**, every 5 minutes, enqueuing an
  `ncmec_reconcile` job with the fixed dedupe key `ncmec:reconcile` — the partial unique
  index on non-terminal `(queue, dedupe_key)` means concurrent instances collapse to one
  in-flight pass rather than N.
- Without this, the "backstop" would run once at boot and silently stop, which is worse
  than no backstop because the plan would claim coverage it does not have.

**Repairs are transactional and conditional.** Two overlapping passes, or a pass racing a
live worker or an admin retry, must not double-enqueue or clobber. Every repair therefore:

- Uses the report-scoped dedupe key **`ncmec:submit:<reportId>`** on the enqueue, so two
  reconcilers observing "no job" produce one job, not two.
- Re-reads the row `FOR UPDATE` and re-checks, inside the transaction: the status is still
  non-final, there is **no unexpired lease**, and there is still no non-terminal job for
  that key. A stale `failed` observation must not mark a row failed after an admin retry
  has already acquired its lease.

**The reconciler cannot recover the ISPWS code, and must not pretend to.** `async_jobs`
persists only `last_error`; `HandlerResult.code` is never written to the queue row
(`asyncJobs.ts` finalizer, `schema/asyncJobs.ts`), and this plan forbids re-deriving a
code by parsing an error string. So when in-`run()` finalization is lost, the true ISPWS
code is genuinely gone. The repair writes an explicit **`last_error_code = -1`
("reconciled — original code lost")** rather than inventing a plausible one, and the
notification says so. A wrong code is worse than a missing one here: it would be
classified, filtered, and acted on as though it were real.

**The lease predicate must be `submission_lease_until IS NULL OR submission_lease_until <
now()`** — identical to acquisition (§5.2.2), never a bare `< now()`. In Postgres
`NULL < now()` evaluates to *unknown*, not true, so a bare comparison silently excludes
every never-leased row: new rows, rows created while submission was disabled, and
pre-migration legacy rows. That is precisely the population the reconciler exists to
repair, so the naive predicate would make it a no-op exactly where it matters while
appearing to work everywhere else.

Three properties make this the right shape:

- **The row, not the job, is the source of truth.** Any row that should be filed and
  is not eventually gets a job, regardless of how it lost one.
- **Disabled is a genuinely safe state, not a silent drop.** While
  `ncmec_submission_enabled` is false, rows accumulate as `pending` with no job —
  byte-identical to today's behavior. When the flag is turned on, the reconciler's very
  next pass enqueues every accumulated row. **This is the same code path that handles
  pre-migration legacy rows**, so the `disabled → enabled` transition and the backfill
  of historical rows are one tested behavior rather than two.
- **It is idempotent.** It derives desired state from actual state on every pass, so a
  crashed reconciler run costs nothing.

**Historical rows already filed by hand.** Rows created before this ships may have been
manually filed through `report.cybertip.org/cybertip/login`. Re-filing them on
activation would duplicate real reports. So `manually_filed_at` and the status
`filed_manually` are added in §5.4, the admin UI exposes "mark as manually filed" on
`pending` rows, and **the reconciler skips `filed_manually` rows entirely.** Auditing
and marking the existing backlog is an explicit prerequisite in the rollout (§7), not
an assumption.

### 5.4 Schema — migration `0094_ncmec_submission.sql`

Additive on `ncmec_reports`:

| Column | Type | Purpose |
|---|---|---|
| `finished_at` | `timestamptz` | When `/finish` returned `0` |
| `attempt_count` | `integer not null default 0` | Observability |
| `last_error` | `text` | Human-readable last failure |
| `last_error_code` | `integer` | ISPWS response code — classify by code, never by parsing the string |
| `submission_environment` | `varchar(16)` | `test` or `production` — which host received it |
| `uploaded_files` | `jsonb` | `[{ fileId, md5 }]` from `/upload` |
| `retracted_at` | `timestamptz` | When we retracted a stranded report |
| `submission_lease_owner` | `text` | §5.2.2 fencing — per-invocation token, not a worker id |
| `submission_lease_until` | `timestamptz` | §5.2.2 fencing — lease expiry |
| `manually_filed_at` | `timestamptz` | §5.3 — filed by a human through the manual form |
| `test_submitted_at` | `timestamptz` | §7 — a test-environment submission, which is **not** a filing |
| `test_report_id` | `varchar(64)` | §7 — the id `exttest` assigned, kept for debugging |
| `content_origin` | `varchar(16)` | §5.7 provenance, copied from the quarantine row |

**And additive on `quarantined_memes`** — this table was missing from an earlier revision
of this section entirely, so §5.7's provenance requirement had no schema behind it:

| Column | Type | Purpose |
|---|---|---|
| `content_origin` | `varchar(16)` | `generated` \| `user_upload` \| `stock` \| `template` \| `identity`, **nullable** — null means genuinely unknown, and §5.7 omits the annotation rather than guessing |

Both columns carry a CHECK constraint over the same value list, kept in lockstep with a
`CONTENT_ORIGINS` constant the same way `NCMEC_SUBMISSION_STATUSES` is.

**`is_generative` is not stored.** An earlier revision described it as a derived column
alongside `content_origin`, which is two representations of one fact and therefore two
things that can disagree — the report would then depend on which one the mapping happened
to read. It is computed where it is used (`content_origin === 'generated'`) and nowhere
persisted.

| `reporter_snapshot` | `jsonb` | §5.7 — uploader identity as of quarantine, immutable |

`report_id` (existing, `varchar(64)`) holds the ISPWS-assigned **production** report id.
No new column needed — the existing one was declared for exactly this.

**Status vocabulary** extends from `pending | submitted | failed` to add `in_progress` and
`filed_manually`. Final states are `submitted`, `filed_manually`, and `failed`; non-final
are `pending` and `in_progress`.

**No `retracted` status.** An earlier revision proposed one. It was wrong: retraction is a
step within an attempt (§5.2.1), not somewhere a report rests, and adding it would create
a non-final state a crash could strand a row in, outside every reconciler repair — a
direct violation of invariant 8. `retracted_at` remains as a timestamp for audit; the row's
status stays `in_progress` throughout, which is already covered.

This is a CHECK constraint change; the schema comment in `moderation.ts:81` requires
`NCMEC_SUBMISSION_STATUSES` to stay in lockstep with migration 0043, so the migration drops
and recreates the constraint and the constant is updated **in the same commit**, with a
test asserting the two agree so the lockstep is enforced rather than remembered. Existing
rows are all `pending` and remain valid.

An index on `(submission_status, id)` filtered to the non-final statuses keeps the
reconciler's sweep cheap as the ledger grows.

**Migration authoring follows this repo's current reality, not the documented ideal.**
`drizzle-kit generate` is broken on a malformed snapshot around 0063
(`migrations-and-backfills.md:21-26`), and recent migrations use hand-written idempotent
SQL plus a `SNAPSHOT_EXEMPT_TAGS` entry in `lib/db/scripts/check-migration-snapshots.ts`.
An earlier revision of this plan promised a generated snapshot, which cannot currently be
produced. So `0094` ships as: hand-authored idempotent SQL (`ADD COLUMN IF NOT EXISTS`,
`CREATE INDEX IF NOT EXISTS`), a `SNAPSHOT_EXEMPT_TAGS` entry carrying the one-line
explanation that file requires, and both snapshot checks passing.

### 5.5 Configuration and environment safety

**Credentials** (environment variables, never committed, matching the Arachnid naming
convention already in use):

```
NCMEC_ISPWS_USERNAME
NCMEC_ISPWS_PASSWORD
```

**Admin config keys** (seeded in 0094):

| Key | Default | Effect |
|---|---|---|
| `ncmec_submission_enabled` | `false` | Master switch. False → the job no-ops and the row stays `pending`, exactly today's behavior. |
| `ncmec_ispws_environment` | `test` | `test` → `exttest.cybertip.org`; `production` → `report.cybertip.org`. |
| `ncmec_report_classifier_hits` | `false` | §5.5. |

**A hit quarantined while submission is disabled must still be durably visible.** The
existing admin email in `ncmec.ts:45-65` is inline and best-effort — wrapped in a `catch`
by design, so an email failure or a crash right after the insert leaves the row `pending`
with nobody told, indefinitely. Since the disabled path deliberately creates no job, the
reconciler will not touch it either, so nothing else surfaces it.

Two changes make the waiting state honest:

- **The disabled-path notification is enqueued as an `email` job in the same transaction
  as the row insert** (§5.2.4's transaction), with
  `dedupeKey: ncmec:notify:awaiting:<reportId>` — kind-scoped, distinct from the
  terminal-failure key (§5.2.3), so a still-pending awaiting-activation alert can never
  swallow a later failure alert.
- **`/admin/safety` surfaces an explicit "awaiting activation" count** rather than letting
  those rows read as an ordinary backlog. A number an operator can see is what turns a
  parked row into a decision.

Three deliberate safety properties:

- Merging this plan changes **nothing** in production until two separate config keys
  are flipped. Invariant 6.
- The environment is a config key, not an inferred value. Deriving it from `NODE_ENV`
  would mean a staging deploy with production credentials files real reports.
- `submission_environment` is stamped on every row, so a test-environment report can
  never be mistaken for a real filing when reading the ledger later.

### 5.6 The classifier gate — and why it needs caller changes

A config check inside `quarantine.ts` alone **cannot work**, and it is worth being
precise about why, because the failure is silent.

Every classifier call site passes `reportToNcmec` **explicitly**:

| Call site | Value |
|---|---|
| `createMemeRecord.ts:335` | `reportToNcmec: false` |
| `aiMemePipeline.ts:282` | `reportToNcmec: false` |
| `aiMemePipeline.ts:531` | `reportToNcmec: false` |
| `userImageUpload.ts:249` | `reportToNcmec: false` |
| `userImageUpload.ts:176` (Arachnid) | `reportToNcmec: true` |

`quarantine.ts:101` is `input.reportToNcmec ?? input.source === "arachnid"`, and `??`
falls through only on `null`/`undefined`. An explicit `false` is neither. So a gate
written as `input.reportToNcmec ?? (…config…)` would be dead code: the flag could be
turned on and **no classifier report would ever be produced**, with nothing failing
loudly to say so.

The fix is at the callers, not the gate. `reportToNcmec` is redefined as a **narrow
override for `manual` quarantines only**, and the four classifier call sites stop
passing it:

```ts
// quarantine.ts — source and config decide; the override is an escape hatch.
const shouldReport =
  input.reportToNcmec ??
  (input.source === "arachnid" ||
   (input.source === "classifier" &&
    (await getConfigString("ncmec_report_classifier_hits", "false")).toLowerCase() === "true"));
```

The Arachnid site's explicit `true` is left in place — harmless, and it documents intent
at the call site where the legal obligation is unconditional.

Default `false` preserves today's behavior exactly: Arachnid hash matches report,
nothing else does. `fal_safety` remains non-reporting.

**The flag is hard-blocked until §8.2 is answered, not merely defaulted off.** `<incidentType>`
is mapped only for Arachnid classifications; where wholly AI-generated or classifier-flagged
material belongs is an open question for NCMEC. If the switch were merely default-off, turning
it on would leave the implementation with three bad options — guess an incident type, omit a
possibly-required element, or send reports NCMEC rejects with `4100`. A default is a weak
guard against a decision that has not been made. So the worker **refuses** classifier
submissions with an explicit "incident-type mapping unresolved" error until the mapping is
settled and encoded, regardless of the flag; the flag then becomes a live control rather than
a trapdoor.

This also makes the `moderation.ts:62` schema comment honest — it currently describes a
gate that does not exist.

### 5.7 Report content mapping

`<report>` is built from the `ncmec_reports` row plus its `request_metadata`:

- `<incidentSummary>` — `<incidentType>` (Child Pornography for Arachnid CSAM
  classifications) and `<incidentDateTime>` from `created_at`, ISO 8601 with timezone.
- `<reporter>` — Availeron Consulting, Inc. as the registered ESP, with the registered
  reporting contact's email.
- `<internetDetails>` — the Overhype.me URL/service context: the *platform where the
  content appeared* is Overhype.me, while the *registered reporting entity* is
  Availeron. Both appear; they are different fields and conflating them would misfile.
- `<personOrUserReported>` — uploader identity **from an immutable snapshot taken at
  quarantine time**, never resolved live at submission time.

  Resolving `user_id` → email when the job runs reports whoever that account is *then*,
  which can differ from who it was at the incident — and the gap is not hypothetical:
  `ncmec_reports.user_id` is `ON DELETE SET NULL`, so an account deleted before the job
  runs produces an **anonymous filing for a report that had an identified uploader**, and
  an email change produces a filing stating something that was not true at the incident.
  The window is wide by construction, since rows sit `pending` for the entire time
  submission is disabled and across every retry.

  So `request_metadata` carries a `reporterSnapshot` — email and display identity as of
  quarantine — written in the same transaction as the row, and the XML is built from that.
  `user_id` remains for linkage; it is not the source of reported identity. Anonymous
  uploads omit the element rather than sending empty values.

  **The captured context is not currently stored on most paths, and the plan must add it
  rather than assume it.** Only the Arachnid branch of `userImageUpload.ts` passes
  `ncmecMetadata` today (`ip`, `userAgent`, `route`). The classifier branch of that same
  request handler passes none, and neither `createMemeRecord` nor `aiMemePipeline` stores
  request headers at all. So enabling classifier reporting would file reports missing
  uploader network context that *was* available at the time. `request_metadata` gains an
  explicit documented shape — `{ ip, userAgent, route, requestId }` — and every call site
  with a live request captures it. Generation paths with no request omit those fields
  honestly; the distinction is "genuinely unavailable" versus "available and dropped."

`<fileDetails>` per uploaded file:

- `<originalFileName>` where captured.
- `<industryClassification>` — from the Arachnid classification, mapped to `A1`/`A2`/
  `B1`/`B2`. **The exact mapping is an open question (§8.1)** — I will not guess a
  classification taxonomy on a federal report.
- `<fileAnnotations>` — `<generativeAi>` and `<potentialMeme>`, from **persisted
  provenance**, never inferred from the calling function.

**Provenance must be recorded at quarantine time, not derived later.** An earlier revision
proposed setting `<generativeAi>` when the quarantine came from `createMemeRecord.ts` or
`aiMemePipeline.ts`. That is wrong twice over:

- `createMemeRecord()` is **not** exclusively a generation path — its `ImageSourceSchema`
  accepts template, stock, upload, and identity images. Treating every one of its
  quarantines as generative would assert to a federal clearinghouse that ordinary
  user-uploaded or stock content is AI-generated.
- The inference is not even available to the worker: all three call sites persist
  `source: "classifier"`, so the stored row carries **no** signal distinguishing them.
  The mapping would have had to re-derive provenance from information that was never
  written down.

So `quarantined_memes` and `ncmec_reports` gain explicit provenance — `content_origin`
(`generated` | `user_upload` | `stock` | `template` | `identity`) and a derived
`is_generative` — written at quarantine time from the **actual image origin** the caller
already knows. `<generativeAi>` is set from that column and nothing else; where origin is
genuinely unknown the annotation is omitted rather than guessed. Callers pass it
explicitly, which also means a new quarantine call site cannot silently inherit a wrong
default.

### 5.8 Admin surface — `/admin/safety`

A **new page**, not a tab on `/admin/moderation`. That page is 1,922 lines and is the
content-quality review workflow plus comment moderation — a different system from
legal/safety moderation, as `architecture-map.md:159-162` already notes. Mixing them
would be wrong on both structure and access-pattern grounds.

Route module: `artifacts/api-server/src/routes/adminSafetyReports.ts`, `requireAdmin`
on every endpoint, following `adminTaxonomyHealth.ts`'s structure.

- `GET  /admin/safety/reports` — paginated ledger, filterable by status, match source,
  and environment.
- `GET  /admin/safety/reports/:id` — detail: status, timestamps, attempts, last error
  and code, submission environment, uploaded file ids and MD5s, quarantine linkage.
- `POST /admin/safety/reports/:id/retry` — re-enqueue a `failed`, `pending`, or stale
  `in_progress` row. Restricting retry to `failed` would leave the rows the reconciler
  cares about — `pending` with no job — unactionable by hand.

  **A `failed` row must be reset to `pending` before the job is enqueued**, in the same
  transaction. `failed` is a *final* status (§5.4) and lease acquisition accepts only
  `pending`/`in_progress` (§5.2.2) — so simply enqueuing a job for a `failed` row creates
  a job that can never acquire its lease, silently no-ops forever, and makes retry useless
  for the one state the button exists to repair. The transition is conditionally fenced
  like every other state write: `UPDATE … SET submission_status='pending' WHERE id=$id AND
  submission_status='failed' AND (submission_lease_until IS NULL OR submission_lease_until
  < now())`, with the enqueue in the same transaction. Zero rows updated → the row moved
  under us; report that rather than enqueuing.

  Guarded by §5.2.1's retract-first and §5.2.2's lease like any other attempt, so a manual
  retry cannot duplicate or race the worker.
- `POST /admin/safety/reports/:id/mark-manually-filed` — records `manually_filed_at`
  and sets `filed_manually`, taking the row out of the reconciler's scope (§5.3).
  Requires the operator to enter the CyberTipline report id from the manual filing, so
  the ledger stays complete rather than merely quiet.

  **This transition is fenced against active workers, in both directions.** A row sits at
  `pending` while a leased worker is inside `/submit` and before it persists the returned
  id — so without a fence, an operator could mark it `filed_manually` in that window and
  the worker would then overwrite the status and finish a second, real report. The
  operator's decision must win:
  - The manual transition **rejects** any row with an unexpired `submission_lease_until`
    or a non-null `report_id`, telling the operator a submission is in flight rather than
    silently racing it.
  - Lease acquisition and every subsequent state write require a non-final status
    (§5.2.2), so a worker that acquired earlier cannot resurrect a row an operator has
    since marked. Whichever ordering occurs, exactly one outcome survives and it is never
    a duplicate filing.
- `POST /admin/safety/reports/bulk-retry` — resets and re-enqueues **every** `failed` row
  matching a filter (typically "failed since <time> with `last_error_code` in the retryable
  set"), using the same fenced per-row transition as single retry. This is the post-outage
  recovery path: after a multi-day NCMEC outage the per-row button would mean enumerating
  and clicking through the entire backlog by hand, which is not a recovery mechanism —
  it is a way to miss reports.
- `GET  /admin/safety/connectivity` — calls ISPWS `GET /status` and reports
  reachability and which environment is configured. This is the "is it actually
  working?" answer that no amount of row-reading gives.

**Alerts aggregate by incident; status stays per-report.** Emitting one email per failed
report is correct at one failure and actively harmful at two hundred — the volume trains an
operator to filter the channel, which is a worse outcome than a quieter alert. So failures
occurring within a rolling window collapse into **one incident alert** ("47 reports failed
against `report.cybertip.org`, first at 03:12, last at 09:48, dominant code 1000") linking
to the filtered ledger. Per-report `last_error` / `last_error_code` remain on each row —
the aggregation is in the *notification*, never in the record.

Frontend: `artifacts/overhype-me/src/pages/admin/safety.tsx`, modeled on
`emailQueue.tsx` (815 lines — a durable-queue admin page with statuses, the closest
existing analogue). Async status follows `docs/ai-context/async-ui-status.md`, with
Taxonomy Health as the reference for the two altitudes.

**Both registries must be edited, or the surface does not exist.** Creating the page and
the route module is not sufficient in this repo: the page needs a `lazy()` import and a
`<Route path="/admin/safety">` in `artifacts/overhype-me/src/App.tsx` plus an
`AdminLayout` navigation entry, and the API module needs registration in
`artifacts/api-server/src/routes/index.ts`. Implementing only the two new files would
leave `/admin/safety` resolving to Not Found and every endpoint unmounted — a failure that
looks like "the feature is missing" rather than "a wiring step was skipped," so it is
listed here as part of the change set rather than left to be discovered.

**Hard invariant: the admin UI never renders the evidence image.** No thumbnail, no
preview, no signed URL, no proxy route. Admins see status, classifications, hashes, and
file ids. There is no operational need to look at the bytes — the classification and the
hash are what the ledger is for — and building a viewer for suspected CSAM creates legal
exposure and a new exfiltration surface for no benefit.

**And the storage path is not shown either.** An earlier revision displayed `evidence_uri`
as text, reasoning that text is not an image. That was wrong on two counts: the path
`restricted/quarantine/…/<uuid>.<ext>` is a **precise locator for a restricted object**, so
publishing it to a browser DOM and an API response widens the set of places an attacker or
a misconfigured log has to reach to find one; and it puts a raw internal UUID on an admin
surface, which this repo's conventions do not exempt admins from.

`evidenceUri` and any storage path are therefore omitted from **both** the API response and
the DOM. §6 asserts that neither the endpoint payload nor the rendered page contains
`restricted/` or the object UUID — an assertion on the response body, not just on what the
component chooses to render.

**What replaces it is the retention deadline, not a claim that the evidence exists.** An
earlier revision showed "evidence preserved · expires 2028-03-01" — but this plan persists
no deletion or existence marker, and it cannot depend on the companion plan to add one. A
report row plus a future expiry proves preservation is *required*; it proves nothing about
whether the object is still there. "Preserved" would be an assertion the system has no
basis for, displayed on the one surface an operator would trust for exactly that question.

So the field reads **"preservation required until 2028-03-01"** — derivable entirely from
`evidence_retention_until`, and true regardless of storage state. When the companion plan
lands its lifecycle marker, this can become an existence claim honestly.

## 6. Testing

Following `docs/engineering/testing.md`. New: `moderation.ncmecClient.test.ts`,
`moderation.ncmecWorker.test.ts`; extensions to `moderation.quarantine.test.ts`.

Client (fake `fetch`, no network):
- **Schema-validate generated `<report>` and `<fileDetails>` against a version-pinned copy
  of NCMEC's XSD**, committed as a fixture (fetched once from `GET /xsd`). Round-tripping
  through `fast-xml-parser` proves well-formedness and escaping only — wrong element
  ordering, wrong nesting, an invalid enum, or a missing required element all round-trip
  cleanly and then come back as `4100`. Since `4100` is terminal (§5.1), a schema error
  burns the report rather than retrying it.

  **The validator is `xmllint` (libxml2), invoked from the test**, because
  `fast-xml-parser` cannot do this and nothing else in the workspace can either. It is
  present in this dev container at `/usr/bin/xmllint` but **CI does not install it** —
  `.github/workflows/build.yml:120-121` installs only `postgresql-client-16`, so
  `libxml2-utils` is added to that same `apt-get install` line. Naming an outcome without
  naming a mechanism is what left the previous revision unimplementable; the mechanism is
  a system package, an apt line, and a test that shells out to it.

  A **negative fixture** is required alongside the positive one: a document that is
  well-formed but schema-invalid, which the test asserts the validator **rejects**.
  Without it, a silently-skipped or misconfigured validator looks identical to a passing one.
- XML escaping of hostile characters in filenames and metadata, asserted separately from
  schema conformance.
- **Parser hardening** (§5.1), asserted against the real mechanisms rather than the
  intent:
  - A hostile DTD (`<!DOCTYPE foo [<!ENTITY x "boom">]>…`) is **rejected**.
  - A **harmless** DOCTYPE with no entity declaration is **also rejected** — the case that
    distinguishes a real pre-parse gate from expansion merely being disabled.
  - Byte cap: a body at **exactly 1 MiB** is accepted, **one byte over** is refused, and
    the refusal happens **during** the read — asserted with a missing and with a
    deliberately false `Content-Length`, since a cap that trusts the header is not a cap.
  - XML nested beyond **50** levels is refused.

Outage behavior (§5.2, §5.8):
- A simulated outage **longer than the retry horizon** leaves every affected report either
  automatically resumed or recoverable through one bulk-retry action — never requiring
  manual enumeration.
- Two hundred concurrent failures produce **one** incident alert, not two hundred emails,
  while each row still carries its own `last_error_code`.
- Notification dedupe keys are kind-scoped: an awaiting-activation alert still `pending`
  when a submission fails terminally does **not** suppress the failure alert.
- A lost finalization repaired by the reconciler records `last_error_code = -1` and says
  the original code was lost, rather than reporting a code it cannot know.

Evidence handling:
- **`getObjectEntityDownloadURL` is never called with a `restricted/` path** during
  submission — asserted on a spy. The helper signs any private subpath without a guard
  (`objectStorage.ts:245-251`), so this is the test that keeps invariant 4 true for the
  worker as well as for routes.
- The admin detail response and rendered page contain **neither `restricted/` nor the
  object UUID** — asserted against the API payload, not only the DOM.

Identity and disabled-state visibility:
- **Uploader email changes between quarantine and submission** → the report carries the
  email as of quarantine.
- **Uploader account deleted before the job runs** (`user_id` → NULL) → the report still
  identifies the uploader from the snapshot rather than filing anonymously.
- **Submission disabled**: the durable notification job is committed with the row, and an
  injected failure between the two leaves neither — so a retry produces both. The row is
  counted under "awaiting activation" in the admin surface.
- Each response code maps to the right retryable/terminal classification.
- Multipart shape of `/upload` matches the documented `id` + `file` fields.

Worker state machine — the cases that matter:
- Happy path: `submit` → `upload` → `fileinfo` → `finish` → row `submitted`, report id
  and `finished_at` persisted.
- **Crash after `/finish`, before persisting.** Retry retracts, receives `5102`, marks
  the row `submitted`, and **files nothing new.** The §5.2.1 guard.
- Retry on a stranded unfinished report: retract succeeds → clean restart.
- Retry on an expired report: retract returns `5001` → clean restart.
- First attempt with no persisted report id: retract is **not** called.
- `4100` on `/submit` → terminal, no retry, row reaches `failed` **inside `run()`**, a
  durable notification job is enqueued.
- `2000`/`3000` → terminal, alert.
- `ncmec_submission_enabled=false` → row stays `pending`, **zero fetch calls**
  (asserted on a spy, not inferred).

Lease and reclaim (§5.2.2) — the duplicate-filing race:
- **Reclaim during the `/submit`-to-persist window.** Job requeued while worker A is
  mid-sequence; worker B claims it, fails to acquire the lease, makes **zero ISPWS
  calls**, and returns retryable. Only one report is ever finished. The test I would not
  ship without.
- **Renewal racing re-acquisition after expiry.** The overrunning worker attempts renewal
  at the same moment a replacement attempts acquisition; the expired lease is
  **unrenewable**, the replacement wins, and the original aborts before `/finish`.
- **Token reuse.** Two successive executions of the same `async_jobs` row present
  *different* lease tokens, so the second cannot inherit the first's lease.
- Lease lost mid-sequence → worker aborts **before** `/finish`.
- Sequence exceeding the 3-minute deadline aborts before `/finish`.

Manual filing vs. active worker (§5.8) — both orderings:
- Operator marks `filed_manually` while a worker holds a lease → **rejected**, operator
  told a submission is in flight.
- Worker holds a lease, row becomes `filed_manually` → the worker's next conditional write
  updates zero rows and it aborts without finishing. The human decision is never
  overwritten, and no second report is filed.

Environment separation (§7):
- A row exercised end-to-end against `test` has `test_report_id` set and is **still
  `pending`**; `report_id` and `finished_at` remain null.
- **That row is not re-submitted by subsequent reconciler passes** while the environment
  stays `test` — asserted across several passes, since the naive reading of §5.3 would
  re-file it every five minutes.
- After flipping to `production`, that same row files **exactly once**.

Reconciler predicates and retry:
- **Never-leased rows** (`submission_lease_until IS NULL`) — new, disabled-period, and
  legacy — are repaired. The regression test for the `NULL < now()` trap, which would
  otherwise make the reconciler a silent no-op for exactly the rows it exists to serve.
- **Retry on a `failed` row** transitions it to `pending` and the enqueued job **acquires
  its lease and runs** — the assertion that would have failed against the previous design.

Report content (§5.7):
- `<generativeAi>` is set from persisted `content_origin`, **not** from the calling
  module. A `createMemeRecord` quarantine of a *stock* or *uploaded* image is **not**
  annotated as generative.
- Origin unknown → annotation omitted, never guessed.
- Classifier submission is **refused** while the §8.2 incident-type mapping is unresolved,
  even with `ncmec_report_classifier_hits=true`.
- Request-backed paths persist `{ ip, userAgent, route, requestId }`; generation paths
  omit them.

Reconciler (§5.3) — the "nothing is silently unreported" cases:
- Terminal failure whose in-`run()` finalization was lost → reconciler sets `failed`
  and enqueues the notification.
- Retry exhaustion with a crash at the `onAbandon` boundary → same.
- **Atomic terminal finalization**: an injected failure between the status update and the
  notification insert leaves **neither** committed, so the row stays non-final and the
  next pass repairs it. Asserted at every boundary between the two writes.
- **Two overlapping reconciler passes** produce **one** job, not two (report-scoped
  dedupe key).
- **A pass racing a live worker**: the reconciler observes an unexpired lease and makes no
  repair.
- **A stale `failed` observation racing an admin retry** that already acquired a lease →
  the conditional re-check inside the transaction refuses the repair.
- **The scheduled pass actually recurs**: a row created *after* the boot pass is repaired
  by a later periodic pass, proving the backstop does not stop after one run.
- **`disabled → enabled` transition**: rows accumulated while the flag was off are all
  enqueued on the first pass after it flips. Asserted end-to-end.
- Pre-migration legacy `pending` rows are picked up by that same pass.
- `filed_manually` rows are **skipped** — no duplicate filing of a hand-filed report.
- Reconciler is idempotent: two consecutive passes produce one job, not two.

Gate (§5.6):
- `ncmec_report_classifier_hits=false` → a classifier quarantine writes **no**
  `ncmec_reports` row.
- `ncmec_report_classifier_hits=true` → **each of the four classifier flows**
  (`createMemeRecord`, both `aiMemePipeline` paths, `userImageUpload`) produces a report.
  Tested per flow, because the caller-side change is what makes the flag live and a
  missed call site would fail silently.
- Arachnid quarantine reports regardless of the flag.

Config drift: if any new `lib/api-zod/src/` export is added for the admin types, the
line goes into `patch-generated.mjs`'s `apiZodIndexLines` and
`pnpm run check:codegen-drift` runs **before** any consumer is written — the failure
this repo has hit twice (`known-failure-patterns.md`).

## 7. Rollout

1. Merge with both switches off. Production behavior is byte-identical to today: rows
   accumulate as `pending`, nothing is filed.
2. **Audit the existing backlog before enabling anything.** Every pre-existing `pending`
   row is either (a) already filed by hand — mark it `filed_manually` with its
   CyberTipline report id, or (b) never filed — leave it `pending` to be submitted. This
   step is a prerequisite, not a cleanup task: enabling submission with an unaudited
   backlog is precisely how the reconciler would duplicate real reports.
3. Set `ncmec_ispws_environment=test`, `ncmec_submission_enabled=true`. Exercise the
   connectivity check, then let a quarantine hit flow end to end against
   `exttest.cybertip.org`.
4. Verify in the ledger: `test_report_id` assigned, `test_submitted_at` set — and the row
   **still `pending`**, because a test submission is not a filing.
5. Flip to `production` only after David has seen a complete test-environment submission
   and NCMEC has confirmed receipt. The real backlog is filed on this transition.
6. Classifier reporting stays off throughout. Separate decision, separate evidence.

**A test submission must never consume a real report's one filing.** An earlier revision
of this rollout had the reconciler pick up the audited backlog while the environment was
`test`. Those genuinely reportable rows would have reached final `submitted` stamped
`test` — and neither the reconciler (which skips final rows) nor the retry endpoint
(which skips final rows) would ever file them for real after the flip to production. The
rollout designed to prove the system works would have permanently swallowed the backlog
it was meant to file.

So the environments are separated in the data model, not just the URL:

- A submission against `exttest` writes **`test_submitted_at` and `test_report_id`, and
  leaves `submission_status` at `pending`.** `report_id`, `finished_at`, and `submitted`
  mean a production filing and nothing else.
- Consequently every genuinely reportable row remains eligible for **exactly one**
  production filing regardless of how many test runs preceded it, and the §5.2.1 duplicate
  guard operates only over production reports — a test report id can never be mistaken for
  one to retract.
- `submission_environment` stays on the row as the record of which host last handled it.

§6 asserts this directly: a row exercised end-to-end against `test` is still `pending`,
and after flipping to `production` it files exactly once.

## 8. Open questions

**8.1 — `<industryClassification>` mapping (needs NCMEC, not a guess).** The schema
accepts `A1`/`A2`/`B1`/`B2`. Mapping Arachnid's `csam` and
`harmful-abusive-material` classifications onto that taxonomy is a
determination I should not invent. Maya Mizuki offered a walkthrough call; this is
the question to bring. Until answered, the field is omitted (it is optional) rather
than populated with a guess — omitting an optional field is recoverable, misfiling a
classification is not.

**8.2 — `<incidentType>` for AI-generated material.** Eight incident types exist. Where
wholly synthetic imagery belongs is again NCMEC's call, not ours. Same escalation path.

**8.3 — Trusted-flagger workstream.** Maya asked whether Availeron offers a program
where NCMEC or other hotlines could be recognized as trusted flaggers, and whether
there is a workstream beyond the abuse email. This is David's answer, not a code
change — but the honest current answer is "the abuse email and nothing else," and
`/admin/safety` is the first thing that would change that. Worth answering after this
ships rather than before.

## 9. Out of scope

- **All evidence deletion.** Companion plan. Nothing here calls `deleteObject`.
- **Detection tuning.** No threshold, fail-open, or bypass semantics change.
- **The manual reporting form.** It remains the human fallback when automation fails
  and needs no integration.
- **The ESP Dashboard** (`esp.ncmec.org`). Separate credentials, separate product,
  read-only company/contact management. No API surface to integrate.
