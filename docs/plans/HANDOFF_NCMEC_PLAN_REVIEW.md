# Handoff — NCMEC CyberTipline plan review (PR #280)

**Rewritten 2026-07-30 after round 16.** The loop is **paused awaiting David's decision** —
see §2. Do not resume it without his answer.

---

## 1. Where things stand

| | |
|---|---|
| Plan file | `docs/plans/PLAN_NCMEC_CYBERTIPLINE_SUBMISSION.md` (~2,800 lines) |
| Branch | `plan-review/ncmec-cybertipline-submission` — **never merged, never reused for implementation** |
| PR | **#280**, draft, `[PLAN REVIEW] … — DO NOT MERGE` |
| Head | `f4aad02` — round 15's fixes, pushed and reviewed |
| Rounds completed | **16.** 138 findings raised, 116 addressed, **22 open (round 16)** |
| Owed | All 22 round-16 replies, the round-16 ledger entry, and the fixes themselves |
| Implementation branch (not started) | `claude/ncmec-reporting-integration-8mwpho` |

---

## 2. Why the loop is paused

CLAUDE.md's plan-review rule 9 says to stop and bring David the state "sooner [than ~20
rounds] if the SAME category of finding keeps resurfacing without narrowing." That
condition is now met, on three independent measures:

- **Findings per round are increasing, not narrowing:** round 14 → 12, round 15 → 18,
  round 16 → 22.
- **Reconciliations came back Still Open in all three of the last rounds.** 15.7 came back
  Still Open **twice** — I fixed two copies of the null-intent rule and missed a third in
  the schema contract, plus an entire retained block (§5.2.3's clock-bucket protocol) that
  my own sweep did not catch. I had explicitly told Codex to treat that sweep as unverified;
  it was right to.
- **My round-15 rewrite generated the majority of round 16.** Replacing the clock-keyed
  alert window with an open-interval incident model fixed the four-days-of-silence defect
  and introduced roughly six new P1s in its place (opener/closer races, `opened_at` lower
  bound vs. transaction-scoped `now()`, recovery-notice dedupe collision, unbounded
  aggregate on a resolved incident, no incident for a typeless crash).

**Half of round 16 — 11 of 22 findings — is in the incident-alert subsystem**, which has
now produced defects in rounds 11, 14, 15 and 16. Every rewrite of it trades one set of
race conditions for another, because it is a distributed-coordination problem being solved
in prose with no ability to run it.

The rest of the plan is not behaving this way. The submission worker, the duplicate-filing
guard, the lease, the reconciler's repair matrix, provenance, and the admin surface have
all been stable for several rounds.

---

## 3. Round 16's 22 findings

Comment IDs are not recorded here — re-fetch them with `pull_request_read` /
`get_review_comments`, `perPage: 30`, using the `after` cursor from page 1 (the result
overflows to a file; parse it there rather than pulling it into context).

### Incident-alert subsystem — moot if David cuts it (11)

| Line | Sev | Finding |
|---|---|---|
| 548 | P1 | `now()` is transaction-scoped: an older failure can commit after the winning opener, so `opened_at` excludes it and pass 3 cannot recover it while retrying |
| 562 | P1 | Closure is not serialized against a failure committing after pass 4's check — that failure attaches to no open incident |
| 568 | P1 | A recovery notice reuses `incidentId:N` and dedupes into a still-pending reminder, but `resolved_at` commits anyway — recovery lost |
| 580 | P1 | A delayed recovery handler's aggregate has no upper bound, so it reports the *next* incident's rows |
| 751 | P1 | An entire retained block still specifies the superseded clock-bucket protocol |
| 1009 | P1 | A handler crashing before any typed result opens no incident, so pass 3 has none to enqueue — permanently unnotified |
| 1031 | P2 | `deliverFromOutbox` / Resend 6.9.4 await `fetch` with no timeout; two stalled alert jobs occupy both `fast` slots and starve the reconciler |
| 1184 | P1 | **15.11 Still Open** — the 5-min cadence timer still lives in the bulk runner, so job *creation* is behind the batch even though execution is fast |
| 1567 | P2 | `ncmec_alert_reminder_interval_ms` has no positive lower bound; zero makes the predicate true every pass |
| 1578 | P1 | An activation-time recipient check does not hold over time — the last notifying admin can opt out afterwards |
| 2345 | P2 | **15.17 Still Open** — the link resolves on `failed_at` while the aggregate counts `last_attempt_failed_at`; during the retryable phase the link shows none of the counted rows |

### Independent of that decision (11)

| Line | Sev | Finding |
|---|---|---|
| 472 | P2 | Nothing releases the lease on a completed exit, so a terminal row stays "leased" until timeout — blocking `mark-manually-filed` and inflating `inFlight` |
| 1213 | P2 | A typed error observed after lease loss cannot be persisted, so exhaustion still repairs to `-1` |
| 1372 | P2 | `CREATE FUNCTION` / `CREATE TRIGGER` are unguarded; `0094` is required to be rerunnable |
| 1377 | P2 | A `BEFORE` row trigger returning NULL **cancels** the operation — the maintenance escape hatch silently blocks the very correction it exists to permit |
| 1389 | P2 | `TRUNCATE` is unprotected, so the app role can erase the whole audit ledger in one statement |
| 1409 | P1 | **15.7 Still Open** — the schema contract still states the pre-split null-intent rule |
| 1490 | P2 | `attempt_count` increments at lease acquisition, which precedes retract-first — a `5102` recovery inflates it without ever calling `/submit` |
| 1641 | P2 | `inFlight` reports 0 while an already-issued `/finish` can still land — it is a lower bound, not a guarantee |
| 2231 | P2 | Retry resets `attempt_count` even when `enqueued: false`, so the operator sees a fresh budget on a job whose real budget is unchanged |
| 2265 | P1 | An orphan dispositioned `report` keeps its pre-cutoff `created_at` and is never stamped `backlog_audited_at`, so `isSubmittable` immediately refuses it as unaudited |
| 2282 | P2 | The compare-and-set overwrites `report_intent`, which §5.2.4 defines as immutable — and leaves `false` behind after a `reopen` |

---

## 4. The decision David was given

Three options, with my recommendation being 3 or 1:

1. **Simplify alerting to per-report.** One email per terminal failure; an outage sends
   many. Removes the incident table, the intervals, the sequences, and every coordination
   race — all 11 findings above evaporate.
2. **Keep it and keep going.** Fix round 16, request round 17, accept that this subsystem
   may need several more rounds.
3. **Split it out.** Ship reporting + the admin surface with per-report alerting; make
   incident aggregation its own plan with its own review loop.

The case for cutting: David's stated intent was *"see reporting working, see what failed,
and retry it"* — that is the **admin surface**, which is healthy. Email aggregation is a
nice-to-have that is consuming the majority of review effort and producing the majority of
defects. **He has kept incident aggregation twice before** (rounds 9 and 12), so this is
not a re-litigation of settled ground — it is new evidence about a subsystem that has since
failed four more rounds.

---

## 5. Standing constraints — these do not lapse

- **The repo is public.** The disclosure check passed before this PR opened; its
  attestation in the PR body is deliberately contentless.
- **NCMEC credentials are never committed** and appear nowhere in the plan. They are
  consumed only as `NCMEC_ISPWS_USERNAME` / `NCMEC_ISPWS_PASSWORD`.
- **Evidence bytes stay unreadable over HTTP** — no route, no signed URL, no proxy.
  `getObjectEntityDownloadURL` (`objectStorage.ts:245-251`) signs any private subpath with
  **no `restricted/` guard** and must never be called on evidence.
- **Nothing in this plan calls `deleteObject`.** Deletion belongs to the companion plan (#281).
- Codex convergence is **not** plan approval. Only David approves.

## 6. Open, and owed by David — not blockers

Three questions need NCMEC's answer, from the walkthrough call with Maya Mizuki. None
blocks approval; the classifier path is hard-refused until #2 is answered.

1. `<industryClassification>` mapping — `A1` / `A2` / `B1` / `B2`.
2. `<incidentType>` for wholly AI-generated material.
3. Notice before an evidence purge (belongs to the retention plan, #281).

Plus the **reminder-interval** question from round 15 (seeded at 6 h), which becomes moot
under options 1 and 3.

## 7. Environment notes that cost time to learn

- `git push --force` and `git reset --hard` are **blocked** by `.claude/guard.sh`; remote
  branch deletion does not work through the proxy. `git checkout -B <branch> <ref>` is the
  sanctioned reset primitive.
- This container's `GITHUB_TOKEN` is proxy-scoped and **403s** against `api.github.com`.
  GitHub access is via the MCP tools only.
- `pull_request_read` results and every `add_reply_to_pull_request_comment` result echo the
  full diff hunk — for a 2,800-line new file that is 50–170 KB per call. They overflow to a
  file on disk; **parse the file, never pull it into context.** That overflow is also the
  cheap way to harvest comment IDs in bulk.
