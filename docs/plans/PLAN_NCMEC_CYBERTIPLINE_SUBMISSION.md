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
   clearinghouse are a serious defect, not a cosmetic one. See §5.2.

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
(`lib/asyncJobs.ts`) rather than building a bespoke worker. It already provides
durable rows, `FOR UPDATE SKIP LOCKED` claiming, exponential backoff, boot-time
reclaim of stuck rows, `terminalFailure(code, error)` for non-retryable outcomes, and
an `external_id` column its own docstring reserves for "queues that submit to a
third-party service and poll for completion." Lane: `bulk`.

**One job runs the entire sequence.** Because an unfinished report is deleted one hour
after its last modification, spreading `/submit` → `/upload` → `/fileinfo` → `/finish`
across separate job rows invites a partially-built report expiring between steps. One
job execution performs all four calls; a failure anywhere restarts from `/submit` on
the next attempt.

**The duplicate-filing hazard.** Restart-from-scratch is only safe if we can tell
whether a previous attempt already finished. There is no per-report status endpoint —
`GET /status` is connectivity only. So a crash after `/finish` but before we persist
`submitted` would, on retry, file the same material twice.

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

This turns an unanswerable question ("did it land?") into an answerable one, using
the error codes as the oracle. It is the single most important mechanism in this plan
and the part I most want stress-tested in review.

**Enqueue point.** `quarantine.ts` currently calls `submitNcmecReport()` inline.
That call keeps its signature and its "never throw into the caller" contract, but its
body changes to: insert the `ncmec_reports` row (as now), then `enqueueJob({ queue:
"ncmec_submit", payload: { reportId }, dedupeKey: \`ncmec:${reportId}\` })`. The
dedupe key is a second guard against double-enqueue. The admin email stays — it is
useful independent of automation, and it is the only notification if the queue stalls.

**Terminal failure handling.** When the job exhausts retries or hits a terminal code,
`onAbandon` marks the row `failed`, records `last_error_code`, and emails the admins
with an explicit "manual filing required" instruction pointing at
`https://report.cybertip.org/cybertip/login`. A failed automated report must degrade
to a human filing a manual one, not to silence.

### 5.3 Schema — migration `0094_ncmec_submission.sql`

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

`report_id` (existing, `varchar(64)`) holds the ISPWS-assigned report id. No new column
needed — the existing one was declared for exactly this.

**Status vocabulary** extends from `pending | submitted | failed` to add `in_progress`
and `retracted`. This is a CHECK constraint change; the schema comment in
`moderation.ts:81` warns to keep it in lockstep with migration 0043, so the migration
drops and recreates the constraint and `NCMEC_SUBMISSION_STATUSES` is updated in the
same commit. Existing rows are all `pending` and remain valid.

Per `docs/engineering/`, the migration ships with its snapshot and passes the
migration-snapshot validator.

### 5.4 Configuration and environment safety

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

### 5.5 The classifier gate

`quarantine.ts:101` becomes config-driven:

```ts
const shouldReport =
  input.reportToNcmec ??
  (input.source === "arachnid" ||
   (input.source === "classifier" && await getConfigBool("ncmec_report_classifier_hits", false)));
```

Default `false` preserves today's behavior byte for byte: Arachnid hash matches report,
nothing else does. The capability exists and is off until its real-world precision has
been measured. `fal_safety` and `manual` sources remain non-reporting unless a caller
passes `reportToNcmec` explicitly.

This also makes the `moderation.ts:62` schema comment honest — it currently describes a
gate that does not exist.

### 5.6 Report content mapping

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

### 5.7 Admin surface — `/admin/safety`

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
- `POST /admin/safety/reports/:id/retry` — re-enqueue a `failed` row. Guarded by the
  §5.2 retract-first logic like any other attempt, so a retry cannot duplicate.
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
  the row `submitted`, and **files nothing new.** The duplicate guard.
- Retry on a stranded unfinished report: retract succeeds → clean restart.
- Retry on an expired report: retract returns `5001` → clean restart.
- `4100` on `/submit` → terminal, no retry, admin email fires.
- `2000`/`3000` → terminal, alert.
- `ncmec_submission_enabled=false` → job no-ops, row stays `pending`, **zero fetch
  calls** (asserted, not assumed).

Gate:
- `ncmec_report_classifier_hits=false` → a classifier quarantine writes **no**
  `ncmec_reports` row. Guards against silently starting to report a new content class.
- Arachnid quarantine reports regardless of the flag.

Config drift: if any new `lib/api-zod/src/` export is added for the admin types, the
line goes into `patch-generated.mjs`'s `apiZodIndexLines` and
`pnpm run check:codegen-drift` runs **before** any consumer is written — the failure
this repo has hit twice (`known-failure-patterns.md`).

## 7. Rollout

1. Merge with both switches off. Production behavior is byte-identical to today.
2. Set `ncmec_ispws_environment=test`, `ncmec_submission_enabled=true`. Exercise the
   connectivity check, then let a real quarantine hit flow end to end against
   `exttest.cybertip.org`.
3. Verify in the ledger: report id assigned, `finished_at` set, `submission_environment`
   = `test`.
4. Flip to `production` only after David has seen a complete test-environment
   submission and NCMEC has confirmed receipt on their side.
5. Classifier reporting stays off through all of the above. It is a separate decision
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
