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
8. **No reportable hit is ever silently unreported.** Every `ncmec_reports` row reaches
   a final state — `submitted`, `filed_manually`, or `failed` **with a durable
   notification** — no matter where a crash lands. A row stuck at `pending` with nobody
   told is the worst outcome this subsystem can produce: it looks exactly like success
   from every surface. See §5.3.

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

**XML.** The workspace has no XML library (checked `artifacts/api-server/package.json`).
I propose adding **`fast-xml-parser`** — zero runtime dependencies, actively
maintained, handles both build and parse. Hand-rolling is tempting since we control
the outbound shape, but a subtle escaping bug in a legally-significant federal
submission is exactly the failure worth spending a dependency to avoid. Flagging it
explicitly because a new dependency in this repo deserves a deliberate nod.

### 5.2 The submission worker — and the duplicate-report problem

**Queue:** register `ncmec_submit` with the existing `async_jobs` infrastructure
(`lib/asyncJobs.ts`) rather than building a bespoke worker. It provides durable rows,
`FOR UPDATE SKIP LOCKED` claiming, exponential backoff, boot-time reclaim of stuck
rows, and `terminalFailure(code, error)` for non-retryable outcomes. Lane: `bulk`.

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

1. **Acquire before any ISPWS call**, as a conditional update:
   ```sql
   UPDATE ncmec_reports
      SET submission_lease_owner = $workerId,
          submission_lease_until = now() + interval '3 minutes'
    WHERE id = $id
      AND (submission_lease_until IS NULL OR submission_lease_until < now())
   ```
   **Zero rows updated → another worker holds the lease → return a retryable failure
   immediately and make no ISPWS call at all.** This is the fence.
2. **Renew between steps.** Each renewal re-asserts `submission_lease_owner = $workerId`
   in the `WHERE`. A renewal that updates zero rows means the lease was lost (we
   overran); the worker **aborts the sequence without calling `/finish`** and returns
   retryable. The stranded report is then handled by §5.2.1's retract-first on the next
   attempt.
3. **Hard sequence deadline of 3 minutes**, strictly below the 5-minute boot-recovery
   cutoff, with per-call timeouts summing under it. Exceeding the deadline aborts before
   `/finish` rather than racing it.

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
  `terminalFailure(...)`: sets `submission_status='failed'`, `last_error_code`, and
  **enqueues** an admin notification as an `email` job rather than sending inline, so
  the notification is itself durable. This mirrors the established pattern the queue's
  own comment cites — the image-prompt handler persists its terminal code inside
  `run()` for exactly this reason.
- **The reconciler (§5.3) is the backstop** for every case `run()` cannot cover:
  a crash mid-finalization, exhaustion-boundary crashes, and rows whose job vanished.

#### 5.2.4 Enqueue is not atomic with the row — the reconciler owns that

`quarantine.ts` inserts the `ncmec_reports` row and then calls `enqueueJob()`. These
are two writes; a crash between them commits a `pending` row with no job, which nothing
would ever process. Rather than force atomicity through the shared queue (which would
mean threading a transaction handle through `enqueueJob` for one caller), **the row is
the source of truth and the job is derived from it.** The reconciler makes any
`pending` row without a live job actionable, which covers the crash window, disabled
periods, and pre-migration rows with one mechanism (§5.3).

`submitNcmecReport()` keeps its signature and its "never throw into the caller"
contract. The existing admin email stays — useful independently of automation.

### 5.3 The reconciler — nothing stays silently unreported

The single mechanism that closes every "row stuck in a non-final state with nobody
told" path. `ncmec_reconcile` runs periodically (`bulk` lane) and at boot, and repairs
any `ncmec_reports` row in a non-final state by comparing it against its job:

| Row state | Job state | Cause | Repair |
|---|---|---|---|
| `pending` / `in_progress` | **no job row** | Crash between insert and enqueue (§5.2.4); pre-migration legacy row; row created while submission was disabled | Enqueue one — **only if `ncmec_submission_enabled`** |
| `pending` / `in_progress` | `failed` | Terminal failure whose in-`run()` finalization was lost to a crash (§5.2.3) | Set row `failed`, record the code, enqueue an admin notification |
| `pending` / `in_progress` | `done` | Handler no-opped (submission disabled) or returned success without finalizing | Re-enqueue if enabled; otherwise leave `pending` — it is not lost, the reconciler will find it again |
| `in_progress` | any, lease expired > 1 h | Worker died mid-sequence | Re-enqueue; §5.2.1's retract-first resolves whatever NCMEC still holds |

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
| `submission_lease_owner` | `text` | §5.2.2 fencing — worker holding the lease |
| `submission_lease_until` | `timestamptz` | §5.2.2 fencing — lease expiry |
| `manually_filed_at` | `timestamptz` | §5.3 — filed by a human through the manual form |

`report_id` (existing, `varchar(64)`) holds the ISPWS-assigned report id. No new column
needed — the existing one was declared for exactly this.

**Status vocabulary** extends from `pending | submitted | failed` to add `in_progress`,
`retracted`, and `filed_manually`. This is a CHECK constraint change; the schema comment
in `moderation.ts:81` warns to keep it in lockstep with migration 0043, so the migration
drops and recreates the constraint and `NCMEC_SUBMISSION_STATUSES` is updated in the
same commit. Existing rows are all `pending` and remain valid.

An index on `(submission_status, id)` filtered to non-final statuses keeps the
reconciler's sweep cheap as the ledger grows.

Per `docs/engineering/`, the migration ships with its snapshot and passes the
migration-snapshot validator.

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
- `<personOrUserReported>` — uploader identity when known: `user_id` resolved to email,
  plus the captured IP and headers already stored in `request_metadata`. Anonymous
  uploads omit the element rather than sending empty values.

`<fileDetails>` per uploaded file:

- `<originalFileName>` where captured.
- `<industryClassification>` — from the Arachnid classification, mapped to `A1`/`A2`/
  `B1`/`B2`. **The exact mapping is an open question (§8.1)** — I will not guess a
  classification taxonomy on a federal report.
- `<fileAnnotations>` — **`<generativeAi>` set when the evidence came from a
  generation pipeline** (`createMemeRecord.ts` / `aiMemePipeline.ts` call sites) rather
  than a user upload (`userImageUpload.ts`). This platform produces AI imagery; NCMEC
  added the annotation precisely so that is distinguishable, and getting it right is
  materially useful to the analysts who triage these. `<potentialMeme>` likewise
  deserves consideration given what this product is.

The quarantine source is already recorded, so provenance is available without new
plumbing.

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
- `POST /admin/safety/reports/:id/retry` — re-enqueue any **non-final** row (`failed`,
  `pending`, or a stale `in_progress`), not only `failed`. Restricting retry to `failed`
  would leave the rows the reconciler cares about — `pending` with no job — unactionable
  by hand. Guarded by §5.2.1's retract-first and §5.2.2's lease like any other attempt,
  so a manual retry cannot duplicate or race the worker.
- `POST /admin/safety/reports/:id/mark-manually-filed` — records `manually_filed_at`
  and sets `filed_manually`, taking the row out of the reconciler's scope (§5.3).
  Requires the operator to enter the CyberTipline report id from the manual filing, so
  the ledger stays complete rather than merely quiet.
- `GET  /admin/safety/connectivity` — calls ISPWS `GET /status` and reports
  reachability and which environment is configured. This is the "is it actually
  working?" answer that no amount of row-reading gives.

Frontend: `artifacts/overhype-me/src/pages/admin/safety.tsx`, modeled on
`emailQueue.tsx` (815 lines — a durable-queue admin page with statuses, the closest
existing analogue). Async status follows `docs/ai-context/async-ui-status.md`, with
Taxonomy Health as the reference for the two altitudes.

**Hard invariant: the admin UI never renders the evidence image.** No thumbnail, no
preview, no signed URL, no proxy route. Admins see metadata, hashes, classifications,
and file ids. There is no operational need to look at the bytes — the classification
and the hash are what the ledger is for — and building a viewer for suspected CSAM
creates legal exposure and a new exfiltration surface for no benefit. The detail view
shows the storage path as text only.

## 6. Testing

Following `docs/engineering/testing.md`. New: `moderation.ncmecClient.test.ts`,
`moderation.ncmecWorker.test.ts`; extensions to `moderation.quarantine.test.ts`.

Client (fake `fetch`, no network):
- XML round-trips for `<report>` and `<fileDetails>`, including escaping of hostile
  characters in filenames and metadata.
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
  calls**, and returns retryable. Only one report is ever finished. This is the test
  Codex's round-1 finding demanded and the one I would not ship without.
- Lease lost mid-sequence (renewal updates zero rows) → worker aborts **before**
  `/finish`.
- Sequence exceeding the 3-minute deadline aborts before `/finish`.
- An expired lease is acquirable by a later worker.

Reconciler (§5.3) — the "nothing is silently unreported" cases:
- Crash between the `ncmec_reports` insert and `enqueueJob` → reconciler enqueues.
- Terminal failure whose in-`run()` finalization was lost → reconciler sets `failed`
  and enqueues the notification.
- Retry exhaustion with a crash at the `onAbandon` boundary → same.
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
   connectivity check, then let a real quarantine hit flow end to end against
   `exttest.cybertip.org`.
4. Verify in the ledger: report id assigned, `finished_at` set, `submission_environment`
   = `test`. Confirm the backlog from step 2 was picked up by the reconciler and that no
   `filed_manually` row was touched.
5. Flip to `production` only after David has seen a complete test-environment
   submission and NCMEC has confirmed receipt on their side.
6. Classifier reporting stays off through all of the above. It is a separate decision
   on separate evidence.

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
