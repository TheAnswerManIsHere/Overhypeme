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
   notification** — or sits in an **acknowledged waiting state**, each of which is
   enumerated here and each of which is *itself* durably surfaced with its own count on
   `/admin/safety`:

   **These are the branches of one ordered classifier, not five independent predicates.**
   A row can genuinely satisfy several at once — a disabled deployment sits in the default
   `test` environment, so *every* waiting row matches both "submission disabled" and a
   test-mode branch; an identity-unresolved legacy row is usually also unaudited.
   Evaluating the predicates independently and counting each would double-count rows and
   make "every non-final row appears in exactly one count" unsatisfiable. So the plan
   defines **`classifyWaitingState(row, config)`**, a single function returning **exactly
   one** label by taking the first matching branch in this order:

   | # | State | Branch condition | Waiting on | Surfaced |
   |---|---|---|---|---|
   | 1 | Unaudited backlog | `created_at < cutoff AND backlog_audited_at IS NULL` | The pre-activation audit | §7 step 2, §5.8 |
   | 2 | Identity unresolved | `reporter_snapshot IS NULL AND user_id IS NOT NULL AND identity_omission_approved_at IS NULL` | An operator dispositioning a legacy row | §5.7, §5.8 |
   | 3 | **Test attempt uncertain** | `test_submission_started_at IS NOT NULL AND test_report_id IS NULL` | Portal inspection — `exttest` may hold a submission whose id was lost | §5.8 |
   | 4 | Submission disabled | `ncmec_submission_enabled = false` | The operator turning it on | §5.5 |
   | 5 | Test mode — not yet test-submitted | `environment = 'test' AND test_submitted_at IS NULL` | A `send-to-test`, or the production transition | §5.3, §5.8 |
   | 6 | Test mode — already test-submitted | `environment = 'test' AND test_submitted_at IS NOT NULL` | The production transition (a test submission is not a filing) | §5.3, §7, §5.8 |
   | 7 | **Awaiting reconciliation** | eligible, but **no non-terminal `ncmec_submit` job exists** | The next reconciler pass (≤5 min) | §5.3, §5.8 |
   | 8 | **In flight** | eligible, and a non-terminal job exists | Nothing. It is queued or running | §5.8, as *active*, not as waiting |

   **Branches 7 and 8 are why this is a classification of non-final rows, not a list of
   waiting states.** An audited, identity-resolved row in enabled production is not waiting
   on anybody — it is queued or executing — and an earlier version had no branch for it,
   which made "every non-final row appears in exactly one count" unsatisfiable in the
   **normal steady state** rather than in some corner.

   **The signature therefore takes job state: `classifyWaitingState(row, job, config)`.**
   A first attempt at this fix used a single *in flight* fallback computed from the row
   alone, which is mathematically total but factually wrong: an eligible row whose job is
   **missing** — just released by an audit or identity approval and not yet swept, or
   stranded by queue loss — would be reported as *queued or running*. That is precisely the
   condition §5.3's reconciler exists to detect and repair, displayed as though the system
   were already working on it. A total function is not the same as a correct one, and
   "eligible" cannot distinguish these two without consulting the job.

   `/admin/safety` renders branch 8 as active work, branch 7 as a short-lived transitional
   state with its own count, and branches 1–6 as things awaiting a person — which is the
   distinction an operator actually needs. A branch-7 count that does not drain within a
   reconciler interval is itself the signal that the reconciler has stopped.

   **Branch 3 sits above the test-mode branches deliberately.** A crashed `send-to-test`
   leaves `test_submission_started_at` set with no `test_report_id`, and under the
   previous ordering that row was absorbed by branch 5 and reported as "waiting for a
   `send-to-test`" — inviting exactly the blind re-submission §5.8 says must not happen.
   It is waiting on portal inspection, which is a different action, so it gets its own
   branch above both test-mode ones.

   **The order is the design, not an implementation detail.** It runs from *most specific
   blocker the operator must personally resolve* to *most general state of the
   deployment*, so a row is reported against the thing actually standing in its way. The
   per-row blockers (1, 2) outrank the global switches (3, 4, 5) because turning
   submission on does **not** release them — telling an operator a row is "waiting on
   activation" when it is really waiting on their own unmade decision is the specific
   misdirection this ordering prevents.

   **One classifier serves the table, the API counts, and the tests.** Three
   implementations of five overlapping predicates would drift, and the drift would be
   invisible: the counts would still add up to something. §6 asserts exhaustive-and-
   disjoint against this function, which is only a meaningful assertion because there is
   one function to assert against.

   Branches 4 and 5 were missing for three rounds, and the miss is instructive: §5.3's fix
   — automatic enqueue requires `production` — **created** a waiting state satisfying none
   of the then-existing predicates. They stay separate rather than merged because they
   wait on different actions: 4 can be released by a `send-to-test` *or* the production
   flip, 5 only by the flip.

   A row stuck outside both lists, with nobody told, is the worst outcome this subsystem
   can produce: it looks exactly like success from every surface. See §5.3.

   **The enumeration is the invariant, not a footnote to it.** The earlier phrasing —
   "every row reaches a final state" — was **contradicted by the design's own disabled
   path**, which deliberately parks rows at `pending` indefinitely; the revision after
   that named exactly *one* waiting state, and then two more were added in §5.3 without
   coming back here. An invariant a design knowingly violates is worse than no invariant:
   it makes review look satisfied. So the rule is that a waiting state is legitimate only
   once it appears in this table with a surface — **adding a skip condition anywhere in
   the design means adding a row here**, and a skip with no row is a defect by
   construction rather than by argument.

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

So `ncmec_submit` sets **8 attempts with a horizon past 72 hours** — but **not** by the
mechanism an earlier revision claimed. That revision said the schedule "adds 24 h and 48 h
tail delays," which this queue **cannot express**: `getRetryConfig` reads exactly four
delay keys (`async_job_<queue>_retry_delay_1..4_ms`) and returns a five-element array
(`asyncJobs.ts:138-147`); there is no fifth or sixth slot to put a tail delay in. Raising
`maxAttempts` past 5 does not fail — `finalizeJob` falls back to
`retryDelays[retryDelays.length - 1]` for any attempt beyond the array
(`asyncJobs.ts:452-453`) — it simply **repeats the last delay**. So the plan was
describing a curve the shared infrastructure has no way to produce, and adding slots would
mean changing that shared contract for one consumer, which §5.2.2 explicitly refuses to do.

The horizon is reached with the four slots that exist, by widening the last one:

| Key | Value |
|---|---|
| `async_job_ncmec_submit_max_attempts` | `8` |
| `async_job_ncmec_submit_retry_delay_4_ms` | `24 h` (default is 8 h) |

Delays 1–3 keep their defaults (5 min / 30 min / 2 h), and attempts 5 through 8 each wait
the repeated 24 h. Cumulative elapsed time before the 8th and final attempt:

> 5 min + 30 min + 2 h + 24 h + 24 h + 24 h + 24 h ≈ **98.6 hours**

Comfortably past 72, with the first four attempts still front-loaded inside the first
three hours so a brief blip resolves quickly. **This arithmetic matters more than it did
before:** with bulk retry deferred (§5.8), the automatic budget is the *only* thing
standing between a multi-day outage and per-row manual recovery, so a horizon asserted
rather than computed would have been a deferral resting on a number nobody checked.

§5.8 adds **incident-level alert aggregation** so the case where even this is exceeded is
one alert rather than hundreds. (Bulk retry was specified alongside it and is deferred —
§5.8.)

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

  **The notification is incident-scoped, not report-scoped — and an earlier revision had
  these two requirements flatly contradicting each other.** §5.8 promises that two hundred
  failures produce one alert; this paragraph previously specified a per-report dedupe key
  `ncmec:notify:failed:<reportId>`, which produces two hundred distinct keys and therefore
  two hundred emails. Neither `enqueueJob`'s dedupe path nor anything else in the plan
  updated an existing job's payload or maintained a running count, so the aggregation §5.8
  describes had **no mechanism at all** — it was a property asserted in one section and
  contradicted by the key format in another.

  **The mechanism — and it no longer keeps a counter.** An earlier revision maintained
  `failure_count` and `dominant_code` on an incident row. Codex found two independent
  defects in that — a first-write `dominant_code` later failures never correct, and no
  per-code data to recompute it from — and both are the same mistake: **maintaining a
  derived aggregate beside the source of truth.** The report rows already record every
  failure, its code, and its time. So the incident table keeps only what cannot be derived
  — *whether this window's alert has been sent* — and every number in the email is computed
  from `ncmec_reports` at send time.

  1. **A derived window identity.** `incident_key = '<environment>:<window start>'` on a
     **one-hour tumbling bucket**. Derived from the clock, so N workers failing at once
     compute the same key without coordinating.
  2. **One email job per window**, enqueued in the failing worker's own transaction with
     `dedupeKey = 'ncmec:notify:incident:' || $key` and **`nextAttemptAt` = window end plus
     a 2-minute commit grace**. The partial unique index collapses concurrent enqueues to
     one job. The grace exists because a transaction that *began* before the boundary can
     *commit* after it; without it the handler reads before that commit lands and
     undercounts. (`enqueueJob` accepts `nextAttemptAt` — `asyncJobs.ts:261` — and claiming
     requires `next_attempt_at <= now`, `:548`.)
  3. **The handler computes everything at send time**, from the rows themselves:
     ```sql
     SELECT count(*), min(failed_at), max(failed_at),
            mode() WITHIN GROUP (ORDER BY last_error_code)
       FROM ncmec_reports
      WHERE submission_status = 'failed'
        AND submission_environment = $env
        AND failed_at >= $window_start AND failed_at < $window_end
     ```
     `mode()` is Postgres's own aggregate and gives the genuine dominant code across the
     whole window rather than the first one seen. No counter to drift, no histogram to
     maintain, no per-code column to get wrong.
  4. **`ncmec_alert_incidents` therefore holds two meaningful columns** — `incident_key`
     (primary key) and `notified_at`. It is a send-ledger, not an aggregate.

  **The handler is a new queue, not the existing `email` one.** `email`'s handler takes a
  pre-rendered `{to, subject, text, html}` payload and calls `deliverFromOutbox` straight
  away (`email.ts:98-115, 227-236`) — it cannot run a query at send time and cannot stamp a
  ledger. Calling this "an `email` job" left an implementer to either freeze the first
  failure's numbers into the payload (the exact defect the rewrite removed) or invent a
  worker. So it is named:

  | | |
  |---|---|
  | Queue | **`ncmec_incident_alert`**, registered beside `ncmec_submit` and `ncmec_reconcile`; lane `bulk` |
  | Payload | `{ incidentKey, environment, windowStart, windowEnd }` — identifiers only, **never rendered content** |
  | On run | `SELECT … FROM ncmec_alert_incidents WHERE incident_key = $key` → if `notified_at IS NOT NULL`, this is a supplementary alert (below); run the §5.2.3 aggregate query over `ncmec_reports`; render; send; **then** stamp `notified_at = now()` |
  | Delivery | Reuses the same provider path as `email`; only the *rendering* differs |

  **A failure that commits after the grace still alerts — as a supplementary email.** The
  2-minute grace covers transactions that begin before the boundary and commit shortly
  after, but nothing bounds commit latency, so a transaction can stamp a pre-boundary
  `failed_at` and commit *after* the window's alert has sent. That row must not be silent:
  invariant 8 requires every terminal failure to be notified, and "it is in the ledger" is
  not a notification.

  It is covered without new machinery, because the queue's dedupe index covers **only
  non-terminal** jobs. Once the window's alert job completes, a later enqueue with the same
  `incident_key` no longer collides — it creates a **second** job, which sends a
  supplementary alert for that window. The late row is reported.

  The cost is stated rather than hidden: the supplementary email re-reports rows the first
  one already covered, because the handler always aggregates the whole window. So the
  §5.8 guarantee is **"at most one alert per environment per hour in the normal case, plus
  a supplementary alert if a failure commits after that window was notified."** Weakening
  the alert-count guarantee is the right trade against dropping a notification — the same
  asymmetry as at-least-once delivery, for the same reason.

  **Windows are tumbling, and the plan now says so instead of claiming a rolling window.**
  §5.8 previously described "a rolling window" and illustrated it with a single alert
  spanning 03:12 to 09:48. A derived key cannot produce that: two failures either side of a
  boundary fall in different windows and send two alerts. Rather than build the
  close-and-quiet-period protocol a true rolling window needs, the guarantee is stated as
  what it actually is — **at most one alert per environment per hour**. A six-hour outage
  sends six emails rather than two hundred, which is the harm this exists to prevent, and
  §5.8's example is corrected to match.

  **Delivery is at-least-once, deliberately.** `notified_at` cannot be committed atomically
  with an HTTP send to Resend, so a crash between provider acceptance and the local commit
  means the job retries and the alert arrives twice. Stamping `notified_at` *before* the
  call turns the same crash into **permanent silence** — and this alert is invariant 8's
  only delivery mechanism. So the plan stamps after, accepts the duplicate, and says so
  rather than claiming exactly-once. A repeated alert is an annoyance; a missed one is a
  reportable hit nobody hears about.

  Per-row atomicity is unchanged: the status update and the enqueue are one transaction, so
  a row cannot commit `failed` without its alert accounted for. The *unit of alerting* is
  the window; the *unit of record* stays the row.
  A window that has already sent still alerts for later failures: the next failure falls in
  a new bucket, producing a new key and a new job.

  **Every deduped enqueue inside a caller transaction must be wrapped in a SAVEPOINT.**
  This is a plan-wide rule, not an aggregation detail, and it invalidates an assumption
  running through §5.2.3, §5.2.4 and §5.3. `enqueueJob` implements dedupe by **catching a
  `23505`** from the insert (`asyncJobs.ts:272-290`) — and in PostgreSQL a unique violation
  **aborts the surrounding transaction**. When the caller passes `dbOverride`, the conflict
  is raised inside *their* transaction, so every subsequent statement fails with "current
  transaction is aborted" and the whole unit of work rolls back. `enqueueJob` then reads
  the existing row through `defaultDb` and returns successfully, so the caller sees a
  normal return value from a transaction that can no longer commit.

  The consequence is precisely the aggregation case: the first worker creates the incident
  job; the next hundred and ninety-nine hit the dedupe path, abort, and **lose their status
  updates**. The design that was supposed to make two hundred failures produce one alert
  would instead have committed one failed row and rolled back the rest.

  So every enqueue that (a) passes a transaction handle and (b) carries a dedupe key is
  wrapped in a savepoint, with the conflict caught at the savepoint boundary:

  ```
  SAVEPOINT enqueue_attempt;
    -- insert; on 23505 →
  ROLLBACK TO SAVEPOINT enqueue_attempt;   -- outer transaction survives
  ```

  That covers **every** deduped enqueue in this plan, and the list is exhaustive by
  intent: `ncmec:submit:<reportId>` from §5.2.4's insert-plus-enqueue, from §5.3's
  reconciler repairs, **and from §5.8's admin retry** — which shares its mutation/audit
  transaction and can hit the same conflict whenever the operator retries a `pending` or
  stale `in_progress` row that still has a live job. An earlier revision of this list
  omitted retry, which is the one of the three an operator triggers by hand and therefore
  the one whose transaction rollback would be noticed as "the button did nothing."
  Also `ncmec:notify:awaiting:<reportId>` (§5.5) and this incident enqueue. Each of
  those was specified as "share the caller's transaction" on the assumption that a dedupe
  hit is a benign no-op — and on the *first* concurrent duplicate, none of them would have
  committed.

  Changing `enqueueJob` to `ON CONFLICT DO NOTHING` would be the cleaner fix and is the
  right long-term shape, but it alters a shared API's return contract for every queue in
  the system; the savepoint is caller-local and achieves the same result. §6 asserts the
  real-concurrency case: two hundred concurrent terminal transactions all commit, exactly
  one non-terminal incident job exists, and the alert reports two hundred.

  **Kind-scoping still applies.** `ncmec:notify:incident:<key>` and
  `ncmec:notify:awaiting:<reportId>` (§5.5) are deliberately distinct namespaces: the
  dedupe index covers any non-terminal job for a `(queue, dedupe_key)` pair, so a shared
  key would let a still-pending awaiting-activation email swallow a terminal-failure alert
  and commit the row as final `failed` with nobody told. One collided string would silently
  defeat invariant 8.
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

**One window sits *upstream* of that transaction, and it was uncovered.** `quarantine.ts`
commits the `quarantined_memes` row **first**, then calls `submitNcmecReport()` — whose
errors are deliberately caught so the user-facing rejection still happens (invariant 3).
So a failure in the report insert leaves a committed quarantine row for a reportable
Arachnid hit with **no `ncmec_reports` row at all**. The reconciler cannot repair it: the
reconciler's whole design reads *from* `ncmec_reports`, and there is nothing to read.
Every mechanism in this plan operates downstream of a row that was never created.

Two changes, and the second is the durable one:

- **`ncmec_reports.quarantine_id`** — a real FK to `quarantined_memes`, so the link is a
  column rather than an inference from timestamps. Without it there is no query that can
  find the orphan.
- **The reconciler gains a second sweep**, over `quarantined_memes` rather than
  `ncmec_reports`: a **reportable** quarantine row (per §5.6's source rules) with no
  `ncmec_reports` row and no soft-delete tombstone gets one created, using the same
  `isSubmittable`-gated enqueue as everything else. It is idempotent because the FK makes
  "already has a report" a lookup.

Invariant 3 is preserved exactly: the report insert stays inside the caught block, so its
failure still cannot block the rejection. What changes is that the failure is no longer
**silent** — the quarantine ledger becomes the outer source of truth, and the report row is
derived from it the same way the job is derived from the report row. The recursion
terminates at the row whose write is already fail-closed (invariant 2).

The governing principle stands either way, now at both levels: **the upstream row is the
source of truth and the downstream one is derived from it**, never the reverse.

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

**But that predicate alone is one pass too late, so the reconciler does not auto-enqueue
in the test environment at all.** It suppresses re-submission only *after* a row has
already been sent to `exttest` — and the very first pass after `ncmec_submission_enabled`
flips on in `test` finds the entire legacy backlog as `pending` with no job, which is the
*first* line of the table, not the third. Every one of those rows would be enqueued and
sent before the guard ever applies. So the enqueue conditions are:

> **Automatic enqueue requires `ncmec_ispws_environment = 'production'`.** In `test`, the
> only thing that submits is the explicit per-row `send-to-test` action (§5.8).

The `test_submitted_at` predicate stays, because it still covers a row test-submitted by
hand and then left `pending` — but it is no longer load-bearing for the rollout.

**Two further classes are ineligible for automatic enqueue**, both because submitting them
would file something the system cannot stand behind:

- **`reporter_snapshot IS NULL AND user_id IS NOT NULL AND identity_omission_approved_at
  IS NULL`** — identity unresolvable and not yet dispositioned (§5.7). Surfaced under
  "identity unresolved". The third clause is what the operator's approval stamps, and
  without it in the predicate the approval action would change nothing.
- **`created_at < ncmec_backlog_audit_cutoff AND backlog_audited_at IS NULL`** —
  unaudited backlog (§7 step 2). This is belt-and-braces with the activation refusal in
  §5.8: the refusal stops the switch being thrown, and this stops a row slipping through
  if the switch was already on when the cutoff was set.

Neither is a silent skip. Both are counted on `/admin/safety`, and both are non-final
rows that invariant 8 requires be visible — they are waiting on a *named human decision*,
which is the same kind of acknowledged waiting state as `pending`-because-disabled.

#### Eligibility is a shared predicate the worker enforces, not a reconciler-local rule

Every eligibility condition above — environment, backlog audit, identity disposition —
lived **only in the reconciler's query**. That is the wrong place for them to live alone,
because the reconciler is not the only thing that enqueues: §5.8's retry creates
`ncmec_submit` jobs directly, and the worker's lease acquisition (§5.2.2)
checks only status and lease. So an admin could retry an unaudited legacy row, or a row
whose identity omission was never approved, and it would **file** — passing every check
the worker performs, because none of the checks that would have refused it are ones the
worker performs.

That is not a hypothetical path. Retry deliberately accepts `pending` rows (round 1's fix
for exactly this class of row), which means the button most likely to be pointed at a
stuck legacy row is the one that bypasses the rules governing legacy rows.

So the predicate is extracted:

> **`isSubmittable(row, config)`** — one function, returning submittable or a named
> refusal reason. Conditions: **`ncmec_submission_enabled` is true**; non-final status;
> environment is `production`; not unaudited backlog; identity resolved or omission
> approved; not `filed_manually`.

**The master switch belongs in the predicate, and leaving it out had a concrete hole.**
An earlier revision enumerated every condition except `ncmec_submission_enabled`, on the
implicit assumption that the disabled check lived in the callers — it did, in the
reconciler's own query, which is exactly the mistake this extraction was meant to end. The
gap opens during the §7 rollout: between setting the environment to `production` and
re-enabling submission (steps 2 and 4 of the transition), a fresh hit passes the predicate,
gets a `ncmec_submit` job, and contradicts §5.5's load-bearing claim that disabled rows
have **no job** and are represented by the awaiting-activation path. The window is small
and it is precisely the window the ordered transition creates.

- **The initial enqueue in `quarantine.ts`** (§5.2.4) evaluates it inside the
  insert-plus-enqueue transaction and **enqueues only if it passes**; otherwise it commits
  the row alone, which is the already-designed "row with no job" state the reconciler owns.
- **The reconciler** uses it to select rows.
- **Retry** evaluates it before enqueuing and refuses with the reason, so the
  operator is told *why* rather than watching a job appear and silently do nothing.
- **The worker re-evaluates it inside `run()`, in the same transaction as lease
  acquisition**, and refuses if it no longer holds — **but the *kind* of refusal depends on
  why.**

**`isSubmittable` returns a reason with a class: `reversible` or `terminal`.** Returning a
flat terminal refusal was wrong, and wrong in the direction that destroys reports.

- **Reversible** — the blocker is a config value an operator can change back:
  submission disabled, environment not `production`. The handler returns **success** and
  makes no ISPWS call, leaving the row **non-final** with no lasting mark. §5.3's matrix
  already covers exactly this shape (`pending` row, `done` job → re-enqueue when eligible),
  so the reconciler resumes it the moment the config allows.
- **Terminal** — the blocker is a property of the row itself: `filed_manually`, unaudited
  backlog, identity unresolved. These are resolved by an operator decision on that row, not
  by a switch, and they already have their own waiting-state branches and counts.

The race that forces the distinction is ordinary, not exotic: a job is enqueued while
enabled, and the operator disables submission — or starts the §7 production transition,
whose **first step is to disable** — before the worker claims it. Under a flat terminal
refusal the worker fails the job, the reconciler observes a `failed` job against a non-final
row (§5.3, line 2 of the matrix), and finalizes a **perfectly valid, still-reportable row as
`failed`**. Running the documented rollout procedure would terminally fail every report
enqueued in the preceding minutes, and §5.5's promise that disabled rows simply wait would
be false exactly when the switch is used.

§6 asserts the sequence: enqueue while enabled, disable before the job is claimed, confirm
the row stays non-final and no alert fires, re-enable, and confirm the **same row** files.

The **worker** check is the one that actually makes the rule true. The others are checks at
enqueue time, and the gap between enqueue and execution is exactly where a cutoff gets
set, an environment gets flipped, or an approval gets revoked. A check that has to be
remembered at every call site is a rule with as many holes as future call sites; a check
in the worker is the one place every submission provably passes through.

**The initial enqueue was the call site I forgot, and forgetting it had a specific
consequence.** With submission enabled in `test`, a fresh hit would get an ordinary
`ncmec_submit` job; the worker would then terminal-refuse it on the production-only
predicate, and the reconciler would finalize the row `failed` — a **new, genuinely
reportable hit driven to a terminal failure state during the rollout rehearsal**, before
the operator ever ran the explicit `send-to-test` action. The worker check alone catches
it, but "catches it" here means recording a failure for something that was never wrong.

Enqueuing only eligible rows means an ineligible one lands in the state this design
already handles well — a row with no job, visible in its waiting-state count, picked up by
the reconciler the moment it becomes eligible. That is the difference between deferring
work and failing it.

§6 asserts the bypass directly: an admin retry on an unaudited row and on an
identity-unresolved row both refuse, and a row that becomes ineligible *after* its job is
enqueued is refused by the worker rather than filed.

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
| `test_submission_started_at` | `timestamptz` | §5.8 — a `send-to-test` attempt is open. Set with `NULL` `test_report_id` means `exttest` may hold a submission whose id was lost |
| `quarantine_id` | `bigint` | FK to `quarantined_memes` — §5.2.4's upstream linkage, so an orphaned quarantine row is findable by query rather than by inference |
| `failed_at` | `timestamptz` | **When this row entered `failed`.** The bucketing timestamp §5.2.3's incident query reads — stamped in the same transaction as the status write, by **every** path that finalizes a row `failed`: in-`run()` terminal finalization (§5.2.3), retry exhaustion, and the reconciler's lost-finalization repair (§5.3, alongside `last_error_code = -1`). Uses the database clock (`now()`), never application time, so buckets cannot skew across hosts |
| `test_report_id` | `varchar(64)` | §7 — the id `exttest` assigned, kept for debugging |
| `content_origin` | `varchar(16)` | §5.7 provenance, copied from the quarantine row |
| `reporter_snapshot` | `jsonb` | §5.7 — uploader identity as of quarantine, immutable. **The single authoritative representation** |
| `backlog_audited_at` | `timestamptz` | §7 — this row has been through the pre-activation backlog audit |
| `backlog_audit_note` | `text` | §7 — what the operator decided and why, for the rows the audit dispositioned by hand |
| `identity_omission_approved_at` | `timestamptz` | §5.7 — an operator approved filing this legacy row with `<personOrUserReported>` omitted. **Write-once**; the reconciler reads it as the eligibility signal |
| `manual_report_id` | `varchar(64)` | §5.8 — the CyberTipline id an **operator typed** for a hand-filed report. Deliberately **not** `report_id` |

**`manual_report_id` exists because operator-asserted and machine-observed ids must never
share a column.** `report_id` means "ISPWS returned this to us from our own `/submit`",
and §5.2.1 treats a non-null value as proof of an earlier automated attempt — it retracts
against it. An operator-typed id put in that column would be read by the duplicate guard
as our own prior attempt, so a `reopen` (§5.8) would send `/retract` against an id we
never obtained. If that id is valid but identifies **someone else's finished report**, the
guard receives `5102`, concludes "our previous attempt landed," and marks this row
`submitted` — a report that was never filed, now permanently final, on the strength of a
typo.

The two columns therefore carry different provenance and are never conflated:
`report_id` is written only by `/submit`'s response; `manual_report_id` is written only by
`mark-manually-filed`; and §5.2.1 reads only `report_id`.

**New table `ncmec_alert_incidents` — a send-ledger, not an aggregate.** One row per
`(environment, one-hour window)`. **Two columns, and deliberately no more:**

| Column | Type | Purpose |
|---|---|---|
| `incident_key` | `text primary key` | `'<environment>:<window start ISO>'` — derived from the clock, so concurrent workers compute the same key without coordinating |
| `notified_at` | `timestamptz` | When this window's aggregated email actually sent. NULL = not yet |

**This table previously carried `first_failure_at`, `last_failure_at`, `failure_count` and
`dominant_code` on a 15-minute window, and that version is dead.** It was the derived-state
design round 11 removed — every count, span and dominant code is now computed from
`ncmec_reports` at send time (§5.2.3). This section was not updated when §5.2.3 was
rewritten, so the plan carried both designs at once and an implementer could reasonably
have built either. Anything specifying a stored counter, a stored dominant code, or a
15-minute window is superseded; §5.2.3 is the single contract.

The primary key **is** the concurrency control: N simultaneous failures produce one row and
one email job, with no lock taken and no coordination between workers.

**New table `ncmec_safety_audit_log` — append-only, one row per mutation.** Every action
on `/admin/safety` alters state with legal consequence, and until this round the design
recorded *no actor at all*: not on retry, `send-to-test`, audit, or manual filing. `admin_config.updated_by_id` preserves only the **latest** writer, so even a
config write that remembers to set it is overwritten by the next one. An operator who
marks forty rows `filed_manually` with fabricated report ids has permanently suppressed
forty federal reports and left a ledger that reads as complete.

| Column | Type | Purpose |
|---|---|---|
| `id` | `bigserial` | |
| `report_id` | `bigint` | FK to `ncmec_reports`, nullable — config writes are not row-scoped |
| `actor_user_id` | `varchar` | Who. **`ON DELETE SET NULL` is not used**: the actor is denormalized below so deleting the account cannot erase attribution |
| `actor_label` | `text not null` | Human-readable actor identity as of the action. **`NOT NULL` is load-bearing** — see below |
| `action` | `varchar(40)` | `retry` \| `send_to_test_started` \| `send_to_test_completed` \| `backlog_audit` \| `approve_identity_omission` \| `mark_manually_filed` \| `correct_manual_filing` \| `reopen` \| `config_write` |
| `reason` | `text` | Operator-supplied; **required** for the destructive actions (§5.8) |
| `before_state` | `jsonb` | The mutated fields as they were |
| `after_state` | `jsonb` | The mutated fields as they became |
| `attempt_id` | `uuid` | Pairs the two events of one `send-to-test` attempt (§5.8) |
| `created_at` | `timestamptz not null default now()` | |

**`actor_label` is `NOT NULL`, and the mutation is refused if one cannot be captured.**
An earlier revision specified a nullable `actor_email_snapshot`, which does not survive
contact with this schema: `users.email` is **nullable** (`schema/auth.ts:9`),
`PATCH /admin/users/:id` lets an admin clear it (`admin.ts:157`), and
`softDeleteUserLifecycle` nulls it outright (`dataLifecycle.ts:12`). So an admin with no
email could suppress a report and leave an audit entry whose only identity is a `user_id`
that becomes an orphaned opaque string once the account is deleted — the exact attribution
this table promises, absent in the exact case where it matters.

The label is built at write time from the first available of email, display name, or
`admin:<user_id>`, so it is always populable and never silently empty; if even that cannot
be resolved, the mutation is refused rather than recorded anonymously. Refusing is the
right failure here: with no authorization boundary (§8.4), an unattributable destructive
action is strictly worse than a blocked one.

**Append-only is enforced, not merely intended**, following the precedent in
`engineRevisionBumps.ts`: no application code path issues `UPDATE` or `DELETE` against
this table, and §6 asserts that the module exports no such helper. Every entry is written
**in the same transaction as the mutation it records**, so an action that commits without
its audit row is impossible rather than unlikely — the same atomicity argument as
§5.2.3's status-plus-notification pairing, for the same reason: an audit trail that can be
orphaned is not an audit trail.

`/admin/safety` renders the log per report and as a global feed, with human-readable
attribution, so a fabricated disposition stays detectable after later writes.

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

**`reporter_snapshot` is a column, not a key inside `request_metadata`.** An earlier
revision of this plan said both — this table listed a column while §5.7's prose said the
snapshot lived inside `request_metadata` — leaving the implementation two places to write
it and the report builder two places to read it. For a field that determines *who a federal
report names*, two possible sources is the defect, independent of which one is better.

The column wins for three reasons: `request_metadata` is an untyped grab-bag of request
context (`ip`, `userAgent`, `route`, `requestId`) and identity is not request context; a
column can carry its own CHECK/NOT-NULL-style expectations; and — decisively — the legacy
policy below needs `reporter_snapshot IS NULL` to be a **queryable** predicate, which a
nested JSON key makes awkward and easy to get subtly wrong. §5.7 is corrected to match.

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
| `ncmec_report_classifier_hits` | `false` | §5.6 — hard-blocked until §8.2 is answered, not merely defaulted off. |
| `ncmec_backlog_audit_cutoff` | unset | §7 step 2 — the audit **scope** boundary, captured **before** review begins. Rows created at or after it are new-code rows and need no audit. **Write-once**: once set it is never moved, or the scope of an in-progress audit would shift under the operator. |
| `ncmec_backlog_audit_completed_at` | unset | §7 step 2 — the audit **completion** marker, set when the operator declares the audit finished. Separate from the cutoff on purpose (below). |
| `async_job_ncmec_submit_max_attempts` | `8` | §5.2 — **seeded by `0094`**, not left to the queue default of 5 |
| `async_job_ncmec_submit_retry_delay_4_ms` | `86400000` (24 h) | §5.2 — **seeded by `0094`**, not left to the default of 8 h |

**The two retry keys are seeded by the migration, and that is load-bearing rather than
tidy.** An earlier revision computed the 72-hour horizon correctly and then never said
where the values come from — so production would have kept the queue defaults (5 attempts,
8-hour fourth delay) and exhausted at **≈10.5 hours**, while the plan claimed ≈98.6 and the
bulk-retry deferral (§9) rested on that claim. Tests that inject the config would have
passed against a production that never had it. §6 therefore asserts the schedule **from
post-migration defaults, with no fixture injecting them.**

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

The same treatment applies to **every** branch of invariant 8's classifier, not to this
one alone: `/admin/safety` renders **one count per branch** of
`classifyWaitingState` — currently **eight**: six awaiting a person, *awaiting
reconciliation*, and *in flight* shown as active work — never one undifferentiated
"pending" number. The count is stated as a number here only to be checkable against the
table; the list itself is derived from the classifier, so adding a branch adds a count. The count list is derived from
the classifier rather than enumerated here, so adding a branch adds a count automatically;
an earlier revision hardcoded "three" in this paragraph and was already stale by the time
two more branches existed.

Collapsing them would hide the only thing that distinguishes "waiting on a switch" from
"waiting on a decision nobody knows they owe," and the unaudited count additionally gates
production activation (§5.8), so it has to be computed rather than eyeballed regardless.

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

  So the row carries a dedicated **`reporter_snapshot` column** (§5.4) — email and display
  identity as of quarantine — written in the same transaction as the row, and the XML is
  built from that and nothing else. `user_id` remains for linkage; it is not the source of
  reported identity. Anonymous uploads omit the element rather than sending empty values.

  **Legacy rows cannot have a snapshot, and the migration must not pretend otherwise.**
  Every `ncmec_reports` row that exists before `0094` was written by code that never
  captured one, so `reporter_snapshot` is `NULL` on all of them — and §7 step 5 files that
  backlog. A nullable column cannot reconstruct historical identity, and resolving it live
  at submission is exactly what this section forbids, so the plan needs an explicit policy
  rather than a default:

  | Legacy row | Meaning | Policy |
  |---|---|---|
  | `reporter_snapshot IS NULL` **and** `user_id IS NULL` | Genuinely anonymous, or the account was deleted before the snapshot existed | Submits normally with `<personOrUserReported>` **omitted** — the same honest omission anonymous uploads already get |
  | `reporter_snapshot IS NULL` **and** `user_id IS NOT NULL` | An uploader was identified at the incident, but who they *were then* is unrecoverable | **Ineligible for automatic submission.** The reconciler skips it and `/admin/safety` surfaces it under "identity unresolved" |

  The second class is resolved by an operator decision, never by the worker: mark it
  `filed_manually` if it was already reported by hand, or take an explicit
  **"file without uploader identity"** action. Both are recorded; neither is silent.

  **That action needs its own persisted field, and an earlier revision gave it none.** It
  was described as stamping `backlog_audit_note` — a `text` column — while the reconciler's
  exclusion predicate reads `reporter_snapshot IS NULL AND user_id IS NOT NULL`. Neither of
  those changes, so the row would stay ineligible forever and the action would silently do
  nothing; the only ways to *make* it work would be to null out `user_id` (destroying the
  linkage the report needs) or to make the reconciler parse a free-text field. So:

  - **`identity_omission_approved_at`** (§5.4) is the dedicated, write-once disposition.
  - The reconciler's predicate becomes `reporter_snapshot IS NULL AND user_id IS NOT NULL
    AND identity_omission_approved_at IS NULL` — the stamp is what releases the row.
  - The endpoint is constrained **server-side** to
    `reporter_snapshot IS NULL AND user_id IS NOT NULL AND identity_omission_approved_at
    IS NULL AND created_at < ncmec_backlog_audit_cutoff`, refusing any other row.

  **That last clause is the actual legacy boundary, and the previous revision had no
  such thing.** "Snapshot missing and user id present" does not mean *legacy* — it means
  *the snapshot is absent*, and a **current** row can satisfy it through a capture defect:
  a new call site that forgets to pass the snapshot, or a bug in the quarantine
  transaction. Such a row has a live, knowable uploader, and the action would let an
  operator file it with that uploader stripped out — while §6 claimed non-legacy rows were
  refused. The cutoff timestamp is a durable boundary the row cannot drift across, so
  "legacy" becomes a fact about the row rather than an inference from a missing field.

  A current row with a missing snapshot is a **bug to fix, not a row to file anonymously**,
  and this predicate is what keeps those two responses distinct.

  That last constraint is the one that matters most. Without it the action is a
  general-purpose "file this report without naming the uploader" button usable on *any*
  row — including current rows that have a perfectly good snapshot. The narrow legacy
  remedy would become a broad capability to strip identity from federal reports, which is
  not what it was approved for. §6 asserts the refusal for rows with a snapshot, for
  anonymous rows, and for non-legacy rows.

  The reason not to simply resolve `user_id` live for these rows — the obvious shortcut —
  is that it produces a filing that *looks* complete and states something the platform does
  not know to be true. An omitted element is visibly incomplete and can be corrected; a
  confidently wrong one names a person on a federal report on the strength of a row that
  may have changed hands, changed email, or been reassigned since the incident.

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

So `quarantined_memes` and `ncmec_reports` gain **one** explicit provenance column —
`content_origin` (`generated` | `user_upload` | `stock` | `template` | `identity`) —
written at quarantine time from the **actual image origin** the caller already knows.
Callers pass it explicitly, which also means a new quarantine call site cannot silently
inherit a wrong default.

**`<generativeAi>` is computed as `content_origin === 'generated'` at the point of use.
There is no `is_generative` column and nothing ever writes one.** An earlier revision of
this paragraph described `content_origin` *and* "a derived `is_generative`" both written at
quarantine time, which is exactly the duplicate source of truth §5.4 rejects — and it
survived the round that fixed §5.4, because only the schema section was corrected. Two
representations of one fact are two things that can diverge, and the divergence would
surface as a **wrong annotation on a federal report**, decided by which of the two the
mapping happened to read.

Where origin is genuinely unknown (`content_origin IS NULL`) the annotation is omitted
rather than guessed — the same honest-omission rule the identity policy above uses.

### 5.8 Admin surface — `/admin/safety`

A **new page**, not a tab on `/admin/moderation`. That page is 1,922 lines and is the
content-quality review workflow plus comment moderation — a different system from
legal/safety moderation, as `architecture-map.md:159-162` already notes. Mixing them
would be wrong on both structure and access-pattern grounds.

Route module: `artifacts/api-server/src/routes/adminSafetyReports.ts`, `requireAdmin`
on every endpoint, following `adminTaxonomyHealth.ts`'s structure.

**The authorization boundary is `requireAdmin` and nothing more — settled by David
(§8.4), not by omission.**
`requireAdmin` resolves to a single boolean — `users.is_admin` (`schema/auth.ts:22`,
`admin.ts:97`) — and `PATCH /admin/users/:id` lets any admin set `isAdmin` on any account
(`admin.ts:152`). So as designed, every administrator holds full authority over federal
reporting state, and that authority is self-propagating. Whether this surface warrants a
second, separately-granted capability was put to David and **declined** (§8.4): no
capability system ships with this plan.

So everything below is a guard *within* one admin role. The audit log, the confirmations,
and the server-side constraints make destructive actions attributable and detectable —
they do not make them unavailable, and the plan does not describe them as though they
did. The audit log is consequently the **only** control on this surface, which is why
§5.4 states its requirements as non-negotiable rather than as good practice.

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

  **This is the sharpest edge on the whole surface, and it was unguarded.** It takes an
  operator-typed report id, moves the row to a **final** status, and removes it from every
  automatic repair path permanently — with no validation, no reason, and no way back. A
  typo and a deliberate fabrication produce byte-identical rows, and both mean a
  reportable hit is never filed while the ledger reads as complete. Invariant 8 is
  satisfied *formally* — the row reached a final state — while being violated in
  substance.

  Four requirements:

  - **Server-side normalization and format validation** of the report id (trim, case,
    the documented ISPWS id shape), rejecting anything malformed. This catches typos, not
    fabrication — those are different problems and only one of them is solvable here.
  - **A mandatory `reason` and an explicit typed confirmation**, both recorded in the
    audit log (§5.4) with actor and before/after state.
  - **An audited correction path** — `POST …/correct-manual-filing` — that replaces the
    report id while **preserving the original value** in the audit log's `before_state`.
    The stored id is corrigible; the record of what was originally claimed is not.
  - **An audited reopen path** — `POST …/reopen` — returning the row to `pending` for a
    row that was never actually filed, subject to §5.2.2's lease fence like every other
    state write.

    **Reopen must also clear `report_id`, and this is the step that is easy to miss.**
    Moving a row out of a final state puts it back under §5.2.1's retract-first guard,
    which treats a non-null `report_id` as our own unfinished prior attempt. Any stale
    automated id left on the row would be retracted against — and a `5102` reply would
    mark the row `submitted` without filing anything. So reopen sets `report_id`,
    `finished_at`, and `submitted_at` to NULL in the same transaction, preserving all
    three in the audit entry's `before_state`. `manual_report_id` is **retained**: it is
    the record of what the operator originally asserted, and the reason the row is being
    reopened is usually that the assertion was wrong.

    §6 tests the case Codex named: a reopened row whose operator-entered id was valid but
    identified an unrelated finished report must not be marked `submitted` — and with the
    id in `manual_report_id` and `report_id` cleared, the guard never sees it at all.

  **What the approver verifies before correcting or reopening, since the system cannot.**
  ISPWS has no per-report status endpoint — `GET /status` is connectivity only (§4) — so
  there is no programmatic way to confirm a manually-filed report exists. The evidence is
  therefore external and the plan names it rather than leaving it to judgment: the
  CyberTipline **submission confirmation email** NCMEC sends the filer, or the report's
  presence in the manual portal at `report.cybertip.org/cybertip/login` under the filing
  account. The reason field records which was checked. If neither can be produced, the
  correct action is **reopen and let it file**, because a duplicate report is recoverable
  through NCMEC and an unfiled one is not.

  That asymmetry is the tie-breaker for every ambiguous case on this endpoint, and it is
  stated here so the ambiguity does not get resolved the other way under time pressure.

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
- **Bulk retry is deferred to a follow-up (David, 2026-07-29).** An earlier revision of
  this plan specified `POST /admin/safety/reports/bulk-retry` with a preview endpoint, a
  signed confirmation token bound to the filter and matched row-id set, per-row filter
  revalidation at execution, batch audit grouping, and a hard per-batch limit.

  It was cut on Codex's round-9 assessment and David's decision: essentially all of that
  machinery existed to make **one button** safe, the button is not required for the first
  real report, and §1's ask — see reporting work, see failures, retry them — is satisfied
  by single-row retry. Rounds 7 and 8 each found a P1 inside it, which is a poor return on
  a mechanism outside the stated intent.

  **What covers the outage case without it**, since that is what it was built for: the
  8-attempt, 72-hour retry budget (§5.2) resumes automatically through any outage shorter
  than three days without an operator touching anything. Beyond that, recovery is per-row
  retry — which is genuinely worse, and is the accepted cost. An outage longer than 72
  hours is a conversation with NCMEC, not a button.

  **Incident alert aggregation is NOT deferred** — see below. It arrived with bulk retry
  in the same round-5 finding, but it is a few lines in the notification path rather than
  an endpoint, and deferring it would make the remaining design worse rather than smaller.

  Deferred with it: the `bulk_retry` audit action and the `batch_id` grouping column,
  which have no other consumer. `attempt_id` (§5.8's `send-to-test` events) is a separate
  column and stays.
- `POST /admin/safety/reports/:id/send-to-test` — submits **one** selected row against
  `exttest`, writing `test_submitted_at` / `test_report_id` and leaving the status
  `pending` (§7). This exists because the reconciler does not auto-enqueue in the `test`
  environment at all, so exercising the pipeline has to be an explicit, per-row act. It
  refuses when `ncmec_ispws_environment` is `production` — the button's whole purpose is
  that it cannot file for real.

  **It is a submission, so it obeys every rule submissions obey.** The previous revision
  described it as if a config read were sufficient protection. It is not: a config check
  is a point-in-time read, and the operation that follows makes external calls for up to
  the full sequence duration.

  > **Rule, stated once and applying everywhere: any code path that makes an ISPWS call
  > is a submission path.** The lease (§5.2.2), the captured environment, the
  > `isSubmittable` check (§5.3), and the durable-intention-before-remote-call discipline
  > attach to *that property* — not to which module initiated the call, and not to
  > whether the target host is `exttest`. This is written as a rule because the defect it
  > prevents was introduced by adding an endpoint that did not look like the worker, and
  > the next such endpoint will not look like it either.

  - **It acquires and renews the §5.2.2 lease** on the same terms as the worker, and
    every post-call write is conditional on the token and non-final status. Without the
    lease, an operator running `send-to-test` while the production transition happens
    leaves the row `pending` and visible to the next reconciler pass — which starts a
    **production** worker concurrently, after which the test path's completion write can
    land `test_submitted_at` and `submission_environment` over newer production state.
    Two writers, one row, and the loser is the real filing.
  - **The environment is captured once, at lease acquisition, and every subsequent write
    is conditional on it being unchanged.** Re-reading config mid-sequence, or trusting
    the initial read, both allow a sequence that started in `test` to finish writing after
    a flip to `production`.
  - **It runs the §5.3 `isSubmittable` check** for everything except the environment
    clause, which it inverts. A test submission of a row that is not allowed to be filed
    is not a useful rehearsal.

  **The remote call cannot be inside the local transaction, so an intention is recorded
  before it.** `/finish` succeeding at `exttest` and the process dying before the local
  commit would leave NCMEC holding a test submission with no `test_report_id` and no
  audit row — and a retry would submit it again. That is the same problem §5.2.1 solves
  for production, and it needs the same shape here rather than an assumption that a test
  submission does not matter:

  1. **Before the first remote call**, commit a `send_to_test_started` audit entry plus a
     `test_submission_started_at` stamp on the row, in one transaction.
  2. Perform the sequence.
  3. **After `/finish`**, commit `test_submitted_at` / `test_report_id` plus a
     **second** audit entry, `send_to_test_completed`, in one transaction.

  **Two append-only events, not one entry that gets opened and closed.** The previous
  wording said the first entry's `after_state` marks the attempt "open" and the completion
  "closes" it — which cannot be done without either updating that entry (violating
  append-only, §5.4) or leaving it stale (violating the audit-in-the-mutating-transaction
  rule, and §6's assertion that every mutation writes an entry). Both events therefore
  exist in their own right and share an **`attempt_id`** (§5.4) so they pair up.

  This is the general shape wherever a mutation spans an external call: **an append-only
  log records events, never object states.** An entry that needs revising is a state
  record wearing an event's clothes.

  A row with an open attempt and no `test_report_id` is a **recoverable** state, surfaced
  on `/admin/safety` rather than retried blindly: the operator can see that `exttest` may
  hold a submission whose id was lost. It resolves by inspection in NCMEC's test portal,
  and re-running `send-to-test` is an explicit decision rather than an automatic one.
  Consequences in the test environment are low — which is the argument for *not* building
  the full production guard here, and not an argument for leaving the state undefined.
- `POST /admin/safety/reports/:id/audit` — records the pre-activation backlog disposition
  (§7 step 2): stamps `backlog_audited_at` and `backlog_audit_note`. Its
  **"file without uploader identity"** variant is the operator's explicit resolution for a
  legacy row with `user_id IS NOT NULL` and no `reporter_snapshot` (§5.7): it records the
  reason and makes the row eligible for submission with `<personOrUserReported>` omitted.
  There is no path that fills that element from a live lookup.
- `GET  /admin/safety/connectivity` — calls ISPWS `GET /status` and reports
  reachability and which environment is configured. This is the "is it actually
  working?" answer that no amount of row-reading gives.
- `POST /admin/safety/backlog-audit/start` — sets `ncmec_backlog_audit_cutoff` to now,
  freezing the audit scope (§7 step 2). **Write-once**: a second call is refused, naming
  the existing value, because moving the cutoff mid-audit silently redefines what "done"
  means for rows already dispositioned against the old boundary.

  **Write-once is enforced by one conditional write, not by check-then-set.** The cutoff
  lives in an already-seeded `admin_config` row, so a read-then-update lets two concurrent
  starts both observe it unset and both write — different timestamps, and whichever loses
  still changed which rows require audit. The write is therefore a single conditional
  update whose **affected-row count decides the outcome**:

  ```sql
  UPDATE admin_config SET value = $now
   WHERE key = 'ncmec_backlog_audit_cutoff' AND (value IS NULL OR value = '')
  ```

  One row updated → this caller started the audit. Zero → someone else did; refuse and
  name the existing value. §6 tests **concurrent** starts, not just sequential ones: exactly
  one succeeds and the winning cutoff never moves.
- `POST /admin/safety/backlog-audit/complete` — sets `ncmec_backlog_audit_completed_at`.
  Refused if the cutoff is unset, or while the unaudited count is non-zero.

  **These two operations were specified nowhere.** §7 step 2 described a three-step audit
  lifecycle and §5.5 defined both keys, but the endpoint inventory exposed only "the two
  switches" — so the activation gate depended on two values with **no operation that could
  ever set them**, while the generic config route (which might otherwise have served) is
  now required to refuse exactly these keys. The gate was unreachable rather than strict.

- `POST /admin/safety/config` — the two switches. **The gate is on the resulting state,
  not on the field being written.**

  Phrasing it as "enabling submission while the environment is production" leaves the
  symmetric door open: from the permitted `enabled + test` state, changing **only the
  environment** to `production` reaches exactly the same live-filing configuration without
  ever evaluating the audit preconditions. The dangerous thing is the *tuple*, so the check
  is on the tuple:

  > Any write that would leave `environment = 'production' AND enabled = true` must satisfy
  > all three preconditions — cutoff set, completion marker set, unaudited count zero —
  > regardless of which field the request touches.

  **And the write is serialized.** Two concurrent requests — one enabling submission, one
  switching environment — can each validate against a safe *current* state and jointly
  commit the unsafe tuple, since neither sees the other's pending change. The guarded
  helper (below) therefore takes a lock covering the NCMEC config keys and re-reads both
  values inside it, so the prospective combined state is evaluated against what will
  actually be committed rather than against a snapshot taken before the other write.

  §6 tests the environment-flip path and the two-request interleaving against each of the
  three preconditions separately — the flip path being the one the old phrasing permitted
  outright.

  **This gate is worthless unless the generic config route is closed, and it is not.**
  `router.patch("/admin/config/:key", requireAdmin, …)` (`admin.ts:2198`) accepts **any**
  key that exists in `admin_config` and writes it with no per-key policy — it validates
  data type and min/max and nothing else. Migration `0094` seeds the NCMEC keys into that
  same table, so the moment this plan ships, `ncmec_submission_enabled` becomes writable
  through a route that knows nothing about backlog audits. The activation gate would be a
  door with a lock beside an open window.

  Two changes, and the plan requires **both**:

  - **A reserved-key policy on the generic route.** `admin.ts` gains an explicit set of
    keys the generic `PATCH` refuses, returning a message naming the endpoint that owns
    them. **All five NCMEC keys** are its first members — `ncmec_submission_enabled`,
    `ncmec_ispws_environment`, `ncmec_report_classifier_hits`,
    `ncmec_backlog_audit_cutoff`, and `ncmec_backlog_audit_completed_at`. An earlier
    revision said "four," written before the audit cutoff was split in two (§7 step 2);
    a reserved-key list that is one short is a list with a hole in exactly the key that
    was added last.
  - **One guarded helper owns every NCMEC config write.** Both routes call it; the gate
    lives inside it. A second bypass then requires someone to deliberately route around a
    named helper rather than to simply not know this policy exists.

  §6 tests **both** routes refuse unsafe activation. Testing only the new endpoint would
  assert the lock while leaving the window untested, which is how this defect would have
  reached production looking covered.

**Alerts aggregate by incident; status stays per-report.** Emitting one email per failed
report is correct at one failure and actively harmful at two hundred — the volume trains an
operator to filter the channel, which is a worse outcome than a quieter alert. So failures
occurring within **one hourly window** collapse into **one incident alert** ("47 reports
failed against `report.cybertip.org` between 03:12 and 03:58, dominant code 1000") linking
to the filtered ledger. The window is **tumbling, not rolling** — a six-hour outage sends
six emails, one per hour, not one spanning the whole outage. An earlier revision of this
sentence said "rolling" and illustrated it with a single 03:12–09:48 alert, which the
derived-key design cannot produce; §5.2.3 carries the reasoning. Per-report `last_error` / `last_error_code` remain on each row —
the aggregation is in the *notification*, never in the record.

**Kept, on David's explicit decision (2026-07-29), after being put to him twice.** When
bulk retry was deferred (round 9) I argued aggregation had to survive; round 10 then found
it had **no mechanism at all**, and round 11 found four more defects in the mechanism that
replaced it — a transaction-aborting enqueue, a wrong dominant code, tumbling windows
described as rolling, and unachievable exactly-once delivery. That is the same
defects-per-round profile that justified deferring bulk retry, so it was put to David again
rather than defended a second time.

He chose to keep it as rewritten. The rewrite is why: the version that generated those
findings maintained **derived state** (a counter and a dominant code beside the rows that
already held both), and every one of those four defects came from that choice. The current
design holds no derived state — a send-ledger row and a query — so the class of bug is
gone rather than patched. What remains is honestly scoped: at most one alert per
environment per hour, at-least-once delivery, numbers computed from the source of truth.

**This also survives the bulk-retry deferral, and deliberately.** Aggregation and bulk retry
both came out of round 5's outage finding, so it would be natural to cut them together.
They are not the same kind of thing: bulk retry is an endpoint with a token protocol and a
confirmation UX, while this is a few lines in the notification path. More importantly,
deferring it would make the **remaining** design worse rather than smaller — invariant 8's
guarantee that no failure is silent is delivered entirely through this alert channel, and
two hundred emails in an hour is how an operator learns to ignore it. Cutting the recovery
tool while keeping one report per row is a scope reduction; cutting the thing that keeps
the alert channel usable is a reliability regression wearing a scope reduction's clothes.

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

Following [`docs/engineering/testing-guide.md`](../engineering/testing-guide.md) — an
earlier revision cited `docs/engineering/testing.md`, which **does not exist**; the guide
is `testing-guide.md`, and citing a non-existent standard is how a plan appears to have
one.

**Files and runners, named rather than implied.** The previous revision listed two new
files and one extension, then went on to require API, migration, and frontend assertions
that fit in none of them — so a third of the list had nowhere to live.

| Area | File | Runner |
|---|---|---|
| ISPWS client | `artifacts/api-server/src/__tests__/moderation.ncmecClient.test.ts` | `pnpm --filter api-server test` |
| Worker, lease, reconciler, eligibility | `.../moderation.ncmecWorker.test.ts` | same |
| Admin endpoints, audit log, activation gate | `.../adminSafetyReports.test.ts` | same |
| Quarantine funnel changes | extends `.../moderation.quarantine.test.ts` | same |
| Migration `0094` and status/constant lockstep | `.../migrations.0094.test.ts` | same |
| `/admin/safety` page | `artifacts/overhype-me/src/pages/admin/__tests__/safety.test.tsx` | `pnpm --filter overhype-me test` (vitest) |

The api-server suite runs sharded via `scripts/run-tests-sharded.sh`, and its `pretest`
applies migrations — which is why the migration test belongs there rather than standing
alone.

**Cut deliberately, so the list stays executable.** A test list nobody can finish gets
abandoned wholesale, and the ceremonial entries take the load-bearing ones with them.
Removed: the standalone "no `is_generative` column" and "module exports no
update/delete helper" architecture negatives (both are assertions about source text, better
served by the schema itself and by review), the first-attempt-does-not-retract case
(subsumed by the retract-first cases), and the separate token-reuse test (subsumed by the
lease-interleaving case). The waiting-state and test-environment matrices are folded into
**parameterised** state-machine coverage rather than repeated per scenario.

**Retained without negotiation**, because each is the only check on a property nothing
else catches: XSD validation with its negative fixture, the lease races, `isSubmittable`
enforcement in the worker, the activation gate on both config routes, evidence isolation
(`getObjectEntityDownloadURL` never called on a `restricted/` path), and the core admin
flows including audit atomicity.

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
- **The retry schedule is asserted, not assumed** (§5.2): with `max_attempts = 8` and
  `retry_delay_4_ms = 24 h`, the 8th attempt occurs more than 72 hours after the first
  failure, and attempts 5–8 each use the repeated final delay rather than a configured
  tail. This is the test that keeps the bulk-retry deferral honest.
- A simulated outage **shorter than the 72-hour horizon** leaves every affected report
  automatically resumed, with no operator action at all. One **longer** than it leaves
  every affected row `failed` with a durable notification and visible in the ledger —
  recoverable per row, which is the accepted cost of deferring bulk retry.
- Two hundred concurrent failures produce **one** incident alert, not two hundred emails,
  while each row still carries its own `last_error_code`.
- Notification dedupe keys are kind-scoped: an awaiting-activation alert still `pending`
  when a submission fails terminally does **not** suppress the failure alert.
- A lost finalization repaired by the reconciler records `last_error_code = -1` and says
  the original code was lost, rather than reporting a code it cannot know.
- **A reconciled `-1` row is retryable by an admin** like the ordinary retryable failures
  around it, and its `attempt_count` is reset, so a retry after an exhausted automatic
  budget actually runs.

Round-8 mechanisms — the new endpoints against the worker and reconciler:
- **Eligibility cannot be bypassed by an admin enqueue**: retry on an unaudited row and on
  an identity-unresolved row both refuse with a named reason; and a row that becomes
  ineligible **after** its job is enqueued is refused **by the worker**, not filed.
- **Reopen clears `report_id`**: a reopened row whose `manual_report_id` was valid but
  identified an unrelated finished report is **not** marked `submitted` — the duplicate
  guard never sees an operator-typed id, because §5.2.1 reads only `report_id`.
- **`send-to-test` is lease-fenced**: it acquires the §5.2.2 lease, and a `send-to-test`
  racing the production transition cannot write `test_submitted_at` or
  `submission_environment` over production state. A production worker and the test path
  cannot both hold the row.
- **`send-to-test` crash after `/finish`** leaves an open attempt with no `test_report_id`,
  surfaced as recoverable on `/admin/safety` — asserted rather than left undefined, and
  **not** retried automatically.
- **`actor_label` is always populated**: an admin whose `email` is NULL still produces a
  human-readable label, and a mutation that cannot capture one is **refused**, not
  recorded anonymously.
- **Waiting-state counts come from `classifyWaitingState`**, one function shared by the
  table, the API, and these tests. Exhaustive-and-disjoint is asserted against it across
  disabled+test, enabled+test before and after `send-to-test`, and production — including
  the overlapping cases (disabled *and* test; identity-unresolved *and* unaudited) that
  made the previous independent-predicate version unsatisfiable.
- **Identity omission is bounded by the cutoff**: a **current** row with a missing
  snapshot — a capture defect, not a legacy row — is refused.

Admin surface as a privileged surface (§5.8):
- **Both config routes refuse unsafe activation** — the new safety endpoint *and* the
  generic `PATCH /admin/config/:key` (`admin.ts:2198`). Testing only the new one would
  assert the lock and leave the window untested.
- **Every mutation writes exactly one audit entry, in the mutation's own transaction**:
  an injected failure after the state write and before the audit insert leaves **neither**.
  Asserted for retry, `send-to-test`, audit, identity-omission approval,
  manual filing, correction, reopen, and config write.
- **Attribution survives account deletion** — `actor_label` still identifies who acted
  after the user row is gone, including for an actor whose `email` was already NULL.
- **Identity omission is narrowly constrained**: refused for a row with a
  `reporter_snapshot`, for an anonymous row (`user_id IS NULL`), and for a non-legacy row;
  accepted only for `reporter_snapshot IS NULL AND user_id IS NOT NULL`, and the stamp is
  what makes the reconciler pick the row up.
- **`mark-manually-filed`**: a malformed report id is rejected; a missing reason is
  rejected; correction preserves the original id in `before_state`; reopen returns the row
  to `pending` and the reconciler picks it up again.
- **Counts are computed set-based over the whole non-final population, never per page.**
  `GET /admin/safety/reports` is paginated but the counts are global, so the job lookup is
  **one join** over non-final rows against non-terminal `ncmec_submit` jobs — not a per-row
  fetch (N+1), not a classification of the returned page (counts that change as you
  paginate), and not the branch logic reimplemented in SQL (two implementations of the
  classifier, which is what having one function was for). Terminal job history is collapsed
  by the join's own predicate: only `pending`/`processing` jobs count as "a job exists," so
  a row with three `done` jobs and no live one classifies as *awaiting reconciliation*,
  correctly. §6 asserts counts across multiple pages with rows in every job state —
  missing, pending, processing, done, failed.
- **Waiting-state counts are exhaustive and disjoint** across all **eight** branches —
  including *awaiting reconciliation* (an eligible row with **no** non-terminal job) as a
  distinct asserted count, since that is the branch a matrix written from a stale "seven"
  would silently omit while still looking exhaustive — asserted in
  four configurations: disabled+test, enabled+test before `send-to-test`, enabled+test
  after it, and production — **parameterised over the configurations rather than written
  out per scenario**. Every non-final row lands in exactly one branch, including the
  steady-state *in flight* case and a crashed test attempt, which are the two the
  assertion was previously unsatisfiable without.

Deployment, transition, and rollback (§7):
- **Migration-before-code**: applying `0094` while the *old* code serves leaves the old
  path working unchanged — new columns nullable/defaulted, writes still `pending`.
- **The widened CHECK is a precondition, not a side effect**: writing `filed_manually` or
  `in_progress` against migration 0043's constraint fails, asserted directly so the
  ordering dependency is proven rather than assumed.
- `NCMEC_SUBMISSION_STATUSES` and the SQL CHECK agree — the lockstep test (§5.4).
- **Rollback**: with the schema at `0094` and the code reverted to the stub, rows holding
  `in_progress` / `filed_manually` are inert — nothing re-files, nothing errors.
- **Test environment does not sweep the backlog**: with `ncmec_ispws_environment='test'`,
  `ncmec_submission_enabled=true`, and a legacy backlog present, a full reconciler pass
  enqueues **zero** jobs; only the explicit `send-to-test` action submits, and it submits
  exactly the selected row. This is the acceptance check for §7 step 3.
- **Failed production preflight files nothing**: running the transition sequence with a
  connectivity check that fails leaves **zero** production submit jobs enqueued.
- **Activation's three preconditions are asserted separately, not as one happy path** —
  each refusal names which one is missing: (a) **cutoff unset** refuses unconditionally,
  without consulting the count, which is the fresh-deployment case where `created_at <
  NULL` silently returned zero; (b) **completion marker unset** refuses even with a zero
  count; (c) **non-zero unaudited count** refuses and names the count. Plus:
  **duplicate cutoff write** is refused and names the existing value, and a **successful
  activation** with all three satisfied is asserted as its own case — otherwise the tests
  prove only that the gate can say no.
- **The audit lifecycle endpoints exist and enforce their order**: `complete` before
  `start` is refused; `start` twice is refused; `complete` with rows outstanding is
  refused.
- **Incident aggregation is concurrency-correct**: two hundred simultaneous terminal
  commits produce **one** email reporting a count of two hundred — not two hundred emails
  and not one email reporting a count of one — and a failure after that window's job has
  sent produces a **new** incident and a new alert. Asserted against real concurrent
  transactions, since the whole mechanism is an `ON CONFLICT` upsert and a dedupe index.
- **The retry schedule crosses 72 hours**: with `max_attempts = 8` and
  `retry_delay_4_ms = 24 h`, the final attempt is scheduled more than 72 hours after the
  first failure — driven by an injected clock rather than by waiting.
- **Legacy identity policy**: a legacy row with `user_id` and no `reporter_snapshot` is
  not auto-enqueued and appears under "identity unresolved"; one with neither submits with
  `<personOrUserReported>` omitted; and **no code path resolves `user_id` to an identity at
  submission time** — asserted on a spy over the user lookup, since that is the shortcut
  the policy exists to forbid.

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

## 6b. Implementation order

**This ships incrementally, and every phase leaves the tree green.** §7 is *deployment and
activation* order — what an operator does after the code exists. It says nothing about what
to build first, and an earlier revision of this plan had no build order at all, which left
a cold implementer unable to tell whether this is one large landing or a sequence.

It is a sequence. Each phase below is independently typecheck- and test-clean, and each
verifies with the repository's own commands before the next begins. Nothing files a report
until phase 6, and nothing files a *production* report until §7.

| # | Phase | Depends on | Verify with |
|---|---|---|---|
| 1 | Migration `0094` + schema constants (`NCMEC_SUBMISSION_STATUSES`, `CONTENT_ORIGINS`), no consumers | — | `pnpm --filter @workspace/db run migrate`; `migrations.0094.test.ts`; `pnpm run check:codegen-drift` |
| 2 | ISPWS client `ncmecClient.ts` — pure, no persistence, no callers | 1 (none, strictly) | `moderation.ncmecClient.test.ts`, incl. XSD + parser hardening |
| 3 | `isSubmittable` + `classifyWaitingState`, as pure functions with no callers | 1 | unit tests in `moderation.ncmecWorker.test.ts` |
| 4 | Provenance + snapshot capture at quarantine time; `quarantine.ts` writes the new columns | 1 | `moderation.quarantine.test.ts` — behavior unchanged, columns populated |
| 5 | Worker + reconciler + alert handler, registered but **gated off** by `ncmec_submission_enabled = false` | 2, 3, 4 | `moderation.ncmecWorker.test.ts` full suite |
| 6 | Admin API + audit log + both config routes' reserved-key policy | 1, 3, 5 | `adminSafetyReports.test.ts`; both-routes activation gate |
| 7 | `/admin/safety` page + both route registries | 6 | `safety.test.tsx`; page resolves, endpoints mounted |
| 8 | Classifier caller changes (§5.6), flag still off and worker still hard-refusing | 4 | per-flow tests, all four call sites |

**Why this order and not another.** Phases 1–4 are additive: they add columns and functions
nothing calls yet, so each can land alone. Phase 5 is the first phase that *could* file
something, which is why the master switch must already exist (phase 1) and default false —
merging phase 5 with the switch absent would violate invariant 6 for the duration of a
deploy. Phase 8 is last because it is the only phase that changes existing call sites'
behavior, and §5.6's hard refusal means it is inert until §8.2 is answered regardless.

**The one ordering that is not negotiable** is phase 1 before anything that writes a new
status value — migration 0043's CHECK constraint rejects `in_progress` and
`filed_manually`, so phases 5 and 6 fail on their first write without it. §7 step 1 records
the same dependency at deploy time.

If any phase cannot be made green on its own during implementation, that is a finding about
this plan and should come back rather than be worked around by landing two phases together.

## 7. Rollout

1. **Merge with both switches off, migration first.** Production behavior is
   byte-identical to today: rows accumulate as `pending`, nothing is filed.

   **Ordering is not left to chance: `0094` applies before the new code serves.**
   `artifacts/api-server/src/index.ts` awaits `runMigrations()` (`:271`) before
   `app.listen()` (`:292`), so a deploy of this branch necessarily migrates first — this
   step records that dependency rather than assuming it, because §7's own later steps
   write values the *old* schema rejects. Step 2's `filed_manually` and step 4's
   `in_progress` both violate migration 0043's
   `CHECK (submission_status IN ('pending','submitted','failed'))`, so an admin surface
   reachable before the widened constraint exists would fail on its first write.

   Migration-first is also safe in the other direction: every added column is nullable or
   defaulted, and the old stub writes only `pending`, so old code running against the new
   schema is correct — merely unaware of the new columns. **Verify before using the admin
   surface:** the added columns exist, the widened CHECK accepts all five statuses, and
   the three config keys read their documented defaults.
2. **Audit the existing backlog before enabling anything — and prove it.** Every
   pre-existing `pending` row is either (a) already filed by hand — mark it
   `filed_manually` with its CyberTipline report id, or (b) never filed — disposition it
   for submission. This is a prerequisite, not a cleanup task: enabling submission with an
   unaudited backlog is precisely how the reconciler would duplicate real reports.

   **"Leave it `pending`" was not a durable disposition, and that was the defect.** An
   audited row that the operator decided *should* be filed looked byte-identical to a row
   nobody had looked at yet: both `pending`, both with no marker. There was no query that
   answered "is the audit finished," so the prerequisite could only be satisfied by
   someone's memory — and overlooking a single hand-filed row means the reconciler
   duplicates a real report to NCMEC.

   So the disposition is persisted per row. Auditing stamps **`backlog_audited_at`** (and
   `backlog_audit_note` where the operator's reasoning matters), whichever way the row is
   dispositioned; `mark-manually-filed` stamps it implicitly. A durable cutoff config key
   **`ncmec_backlog_audit_cutoff`** holds the timestamp at which the audit **began** —
   captured by `/backlog-audit/start` before any review, immutable thereafter — so rows
   created afterwards need no audit and the scope cannot silently grow. Completion is a
   **separate** key, `ncmec_backlog_audit_completed_at`. An earlier revision of this
   sentence described the cutoff as recording completion, which is the single-key design
   round 9 replaced: it would leave the boundary unavailable to §5.7's identity-omission
   predicate *during* the audit, which is exactly when that predicate is used.

   **The prerequisite is enforced, not remembered.** The unaudited count is

   ```sql
   SELECT count(*) FROM ncmec_reports
    WHERE submission_status IN ('pending','in_progress')
      AND created_at < $cutoff
      AND backlog_audited_at IS NULL
   ```

   `/admin/safety` displays it, and **enabling production submission is refused while it
   is non-zero**, with the count in the refusal message. A checklist step a deploy can
   skip is not a safeguard; this is the same reasoning that made §5.6's classifier gate a
   hard refusal rather than a default.

   **An unset cutoff blocks activation unconditionally — the count is not consulted.**
   This is the correction to a defect that inverted the whole gate: §5.5 previously said
   an unset cutoff means "the entire non-final backlog is unaudited," but the query above
   evaluates `created_at < NULL` as *unknown*, so it returns **zero** and the gate
   **passes**. On a fresh deployment — the one deployment where nothing has been audited
   and the entire backlog is at risk — the safeguard would have opened. A three-valued
   comparison silently produced the opposite of the stated semantics.

   So the cutoff is captured **before** the audit begins rather than derived from its
   completion, and the two facts are separate keys (§5.5):

   1. **Start the audit** — the operator sets `ncmec_backlog_audit_cutoff` to now. This
      freezes the scope: exactly the rows that exist at this instant. It is **write-once**,
      because moving it mid-audit would silently change what "done" means.
   2. **Work the backlog** — every in-scope row gets a `backlog_audited_at` disposition.
   3. **Declare completion** — the operator sets `ncmec_backlog_audit_completed_at`, which
      the endpoint refuses while the unaudited count is non-zero.

   Production activation therefore requires **all three**: cutoff set, completion marker
   set, unaudited count zero. Each is refused with a message naming which one is missing,
   so an operator is never left guessing why the switch will not move.

   This also removes the ordering contradiction the single key created: §5.7's
   identity-omission endpoint requires `created_at < cutoff`, so under the old scheme it
   was unusable until the audit was *complete* — while dispositioning identity-unresolved
   rows is part of doing the audit. Capturing the cutoff first makes the boundary
   available throughout, which is when it is actually needed.
3. **Set `ncmec_ispws_environment=test` and `ncmec_submission_enabled=true`.** Exercise
   the connectivity check first.

   **The test environment never sweeps the backlog.** Automatic enqueue by the reconciler
   (§5.3) happens **only when `ncmec_ispws_environment = 'production'`**. In `test`, the
   only thing that submits is an explicit per-row admin action, **"send to test
   environment."** Without that rule, flipping the master switch on in `test` makes the
   very first reconciler pass enqueue every legacy `pending` row with no job — the
   `test_submitted_at` predicate suppresses only *subsequent* passes, which is one pass
   too late, after each row has already been sent to `exttest`. The audited production
   backlog stays ineligible until the production transition; step 4 submits the one hit
   it intends to submit and nothing else.
4. Let a single quarantine hit flow end to end against `exttest.cybertip.org` via that
   action, and verify in the ledger: `test_report_id` assigned, `test_submitted_at` set —
   and the row **still `pending`**, because a test submission is not a filing.
5. **Flip to `production` in this order, not the reverse:** disable submission → set
   `ncmec_ispws_environment=production` → run the connectivity check against the
   production host and confirm it passes → **enable submission last**.

   Changing the environment while the master switch is still on hands the real backlog to
   the next reconciler pass — which can be seconds away (§5.3 runs every 5 minutes and at
   boot) — *before* anyone has confirmed the production host and credentials work. The
   first evidence that production credentials are wrong would then be a wave of `2000`/
   `3000` failures across the entire backlog. A failed production preflight must leave
   **zero** production submit jobs enqueued; §6 asserts exactly that.

   Flip only after David has seen a complete test-environment submission and NCMEC has
   confirmed receipt. The real backlog is filed on this transition.
6. Classifier reporting stays off throughout. Separate decision, separate evidence.

**Rollback.** If the code is rolled back after `0094` has applied, the schema stays ahead
of the code — the safe direction. The old stub writes only `pending` and reads none of the
new columns, so rows already carrying `in_progress` or `filed_manually` are simply inert to
it: it neither reads their status nor acts on them, because the stub has no worker, no
reconciler, and no retry path. Nothing re-files. The one real consequence is that
`in_progress` rows stop advancing until the code returns, which the reconciler resolves on
the next boot. **Do not roll the migration back** to re-file them: dropping the widened
CHECK while rows hold the new values would fail, and dropping `report_id`-adjacent state is
how a report already accepted by NCMEC becomes invisible and gets filed twice.

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

**8.4 — Does `/admin/safety` need its own authorization boundary? (David's call.)**
Raised by Codex in round 7 as a Product Decision, and it is genuinely one — it changes
scope, not just implementation.

The facts, verified: this repo has exactly one privilege level, the boolean
`users.is_admin` (`schema/auth.ts:22`), and any admin can grant it to any account through
the existing user editor (`admin.ts:152`). This plan's surface can suppress a federal
report (`mark-manually-filed`), file one with the uploader stripped out
(`approve-identity-omission`), retry a submission, and flip production submission on. Under
`requireAdmin` alone, every one of those is available to every administrator, and the role
that grants them is self-propagating.

Codex's proposal: keep read-only ledger and connectivity behind ordinary admin; require a
separately-granted **NCMEC operator** capability for production retry and audit actions; a
narrower **compliance approver** capability plus fresh confirmation for
`mark-manually-filed`, identity omission, and production activation (its proposal also
named bulk retry, since deferred — §9); and make
the grant path itself restricted and audited rather than self-grantable.

The trade-off, stated plainly because it is the reason this is David's and not mine:

- **Adopting it** means introducing this repo's *first* capability system — a schema
  change, a grant surface, migration of existing admins, and a real risk of locking David
  out of his own safety surface at the worst moment. Correct for a mature compliance
  organization; possibly ceremony for a platform whose admin set is currently one person.
- **Declining it** leaves the audit log (§5.4) as the only control: every destructive
  action is attributable and detectable after the fact, but none is *prevented*. That is a
  defensible posture for a single-operator platform and an indefensible one the moment
  admin access is granted to anyone whose judgment David would not stake a federal
  reporting obligation on.

My recommendation was to **decline for now and revisit when a second admin exists**,
because the audit log delivers most of the protection at none of the lockout risk.

**Answered — David chose to keep ordinary `requireAdmin` (2026-07-29).** No capability
system ships with this plan. Three consequences the implementation must carry, so the
decision is a recorded position rather than an omission:

1. **The audit log (§5.4) becomes the sole control on this surface, which raises its
   status from "good practice" to load-bearing.** Every requirement attached to it —
   append-only, written in the mutating transaction, actor snapshotted against account
   deletion — is now the only thing standing between a destructive action and an
   unexplainable ledger. None of them is negotiable during implementation on grounds of
   scope.
2. **The decision is scoped to a single-admin platform, and that is its expiry
   condition.** It was made on the stated basis that the admin set is one person. Granting
   `is_admin` to a second account hands that person full authority over federal-reporting
   state on day one — including suppressing a report and stripping identity from one.
   **That grant is the trigger to revisit §8.4**, not a later calendar date, and this
   paragraph exists so the reason survives the context that produced it.
3. **Nothing in the design may quietly assume a boundary that does not exist.** §5.8's
   server-side constraints, mandatory reasons, and confirmations are what they are —
   guards *within* one role. They are not an authorization model and the plan does not
   describe them as one.

## 9. Out of scope

- **Bulk incident response** — bulk retry, its preview-and-confirm token, per-row filter
  revalidation, batch audit grouping, and the hard-limit UX. **Deferred by David
  (2026-07-29)** on Codex's round-9 assessment; the reasoning and what covers the outage
  case without it are in §5.8. Incident **alert aggregation** is explicitly *not* part of
  this deferral and ships with this plan. Revisit if an outage ever exceeds the 72-hour
  automatic budget in practice, or once the ledger is large enough that per-row recovery
  is unrealistic.
- **All evidence deletion.** Companion plan. Nothing here calls `deleteObject`.
- **Detection tuning.** No threshold, fail-open, or bypass semantics change.
- **The manual reporting form.** It remains the human fallback when automation fails
  and needs no integration.
- **The ESP Dashboard** (`esp.ncmec.org`). Separate credentials, separate product,
  read-only company/contact management. No API surface to integrate.
