# Handoff — NCMEC CyberTipline plan review (PR #280)

**Rewritten 2026-07-30 after round 17.** The session that ran rounds 14–17 exhausted its
context here. Round 17's four Still Open reconciliations are fixed and pushed; **sixteen
findings remain open, and none of round 17's twenty replies have been posted.**

---

## 1. Where things stand

| | |
|---|---|
| Plan file | `docs/plans/PLAN_NCMEC_CYBERTIPLINE_SUBMISSION.md` (~3,100 lines) |
| Branch | `plan-review/ncmec-cybertipline-submission` — never merged, never reused for implementation |
| PR | **#280**, draft, `[PLAN REVIEW] … — DO NOT MERGE` |
| Head | `7ed2475` |
| Rounds | **17.** 158 findings raised; 142 addressed; **16 open** |
| Owed | All **20** round-17 thread replies, the round-17 ledger entry, the 16 fixes |
| Implementation branch (not started) | `claude/ncmec-reporting-integration-8mwpho` |

**David's standing decision (2026-07-30):** option 3 — ship reporting + the admin surface
with **per-report alerting**; incident aggregation is deferred to its own plan (§9). That is
done and is not up for revisiting.

---

## 2. Trajectory — read this before deciding to continue

Findings per round: **12 → 18 → 22 → 20.** The aggregation cut removed eleven of round 16's
twenty-two, and round 17 still returned twenty. The loop is finding real defects at a
roughly constant rate rather than converging.

Two things a fresh session should weigh honestly:

- **Round 17 found a defect that sixteen prior rounds missed** (finding 771): the existing
  stub already writes `request_metadata.quarantineId`, but `0094` leaves every legacy
  report's new `quarantine_id` NULL — so pass 2 sees every legacy Arachnid quarantine as
  unreferenced and creates a **second** report row for the same hit, both independently
  filable. That is invariant 7 (exactly one report per hit) broken for the entire back
  catalogue. It is not a regression from a recent rewrite; it was always there. That
  suggests unreviewed surface remains, not that the end is near.
- **Four consecutive rounds had Still Open reconciliations caused by my incomplete sweeps.**
  Root cause is now identified and is mechanical, not judgemental: **I grepped for prose
  that markdown emphasis had split.** `**four** passes` does not match a search for
  `four passes`. Fixed by stripping `*`, `` ` `` and `_` before matching — see the verify
  step in `7ed2475`. **Use that method; do not hand-roll a grep list again.**

If a fresh session reaches ~round 20 without the count dropping, that is the moment to take
the trajectory back to David rather than continue silently.

---

## 3. Round 17's twenty findings

Comment IDs: re-fetch via `pull_request_read` / `get_review_comments`, `perPage: 30`, using
the `after` cursor from page 1. Results overflow to a file on disk — **parse the file, never
pull it into context.** Filter to threads whose only comment is by
`chatgpt-codex-connector`; those are the unanswered ones.

### Closed in `7ed2475` — all four were Still Open reconciliations, all my own sweep misses

| Line | Finding |
|---|---|
| 825 | §5.3 still said the reconciler makes **four** passes while its table said three |
| 1044 | The retained Scheduling section still put the 5-minute cadence timer in the **bulk** runner |
| 2091 | `POST /config`'s wire contract still defined `inFlight` as leases only |
| 2615 + 2790 | Two tests still required unguarded `TRUNCATE` to succeed, contradicting the new trigger |
| 2542 | An incident-era "unalerted" test still described a handler-wide aggregate query |

### Still open — sixteen

| Line | Sev | Finding |
|---|---|---|
| 771 | P1 | **`0094` must backfill `quarantine_id` from the stub's existing `request_metadata.quarantineId`** before the unique index and pass 2 go live, with counts for missing/conflicting/linked — otherwise every legacy Arachnid quarantine gets a second report row |
| 715 | P1 | The copy contract sets `match_source = source`, but `quarantined_memes.source` permits `fal_safety`/`manual` while `NCMEC_MATCH_SOURCES` permits only `arachnid`/`classifier` — pass 2 and the orphan `report` action fail their insert |
| 592 | P1 | **Still Open.** §5.8's tuple gate still accepts a notifying admin *instead of* the fallback key, and §5.5 leaves that key on the generic route — production can activate with no fallback, then lose its last admin |
| 884 | P1 | Moving the notifier to `bulk` starves the *submitter*: three stalled untimed provider calls occupy all three bulk slots and stop every `ncmec_submit` retry. Needs a bounded timeout or a third lane |
| 1223 | P1 | `app.audit_maintenance` is settable by the ordinary application role, so the role the trigger blocks can `SET LOCAL` and bypass it. Needs a privileged role or a permissioned function |
| 1503 | P1 | The pre-`/finish` recheck tests only `enabled`; the tuple `enabled = true, environment = test` passes it, so a worker can `/finish` a **production** report after the operator switched to test |
| 1594 | P1 | `report_intent` is captured with `getConfigString`, which is process-cached for 60 s — a stale instance keeps freezing `true` for a minute after classifier reporting is disabled |
| 1852 | P1 | §5.7 says manual filing rejects a non-null `report_id`; §5.8.1 accepts a `failed` row and calls the retained id "inert". If `/finish` succeeded but its response was lost, manual filing then duplicates a real filing |
| 1969 | P1 | The backlog cutoff writes an **application** `$now` against `created_at` values from the database clock; host skew lets pre-existing rows land after the cutoff and skip the audit entirely |
| 2084 | P1 | "Every transition out of `failed`" omits `mark-manually-filed`, which now accepts `failed` — so `failed → filed_manually → reopen → pending` keeps a stale `alert_notified_at` |
| 478 | P2 | Rule 7's "completed exit" list omits the ordinary retryable return and a caught handler exception, so those still leave the lease held for up to 3 minutes |
| 1080 | P2 | The non-final-only fence lets a **stale** worker's older observation overwrite a newer one's `last_error_code` / `last_attempt_failed_at`. Needs a monotonic generation fence |
| 1392 | P2 | `IDX_ncmec_failed_alerting` keys on `(submission_environment, failed_at)` and covers all failed rows, but pass 3 filters `alert_notified_at IS NULL` — put that in the partial predicate |
| 1437 | P2 | The two retry keys are editable with no minimums; lowering either silently destroys the >72 h horizon the §9 deferral rests on |
| 1517 | P2 | Nothing clears `finish_started_at` after a crash mid-`/finish`, so `inFlight` can be inflated forever. Define clearing for each retract-first outcome and the pass-1 repair |
| 1943 | P2 | Branch 3 (test attempt uncertain) has no endpoint to record the portal-inspection result, so the row cannot leave that state |

---

## 4. Then, in order

1. Fix the sixteen. Several interact — 478/1517 both concern markers left set on exit;
   1852/2084 both concern `mark-manually-filed`'s new acceptance of `failed`.
2. Post all **twenty** round-17 replies, one per thread, never resolving threads.
3. Update the ledger in the PR body with round 17.
4. Request round 18 with a fresh lens and the full reconciliation list.
5. On convergence: close PR #280 **unmerged**, unsubscribe, ask David for approval linking
   the final plan file. **Codex convergence is not approval.**
6. Then build on `claude/ncmec-reporting-integration-8mwpho`.

---

## 5. Standing constraints — these do not lapse

- **The repo is public.** The disclosure check passed before this PR opened; its attestation
  in the PR body is deliberately contentless.
- **NCMEC credentials are never committed** and appear nowhere in the plan; they are consumed
  only as `NCMEC_ISPWS_USERNAME` / `NCMEC_ISPWS_PASSWORD`.
- **Evidence bytes stay unreadable over HTTP** — no route, no signed URL, no proxy.
  `getObjectEntityDownloadURL` (`objectStorage.ts:245-251`) signs any private subpath with
  **no `restricted/` guard** and must never be called on evidence.
- **Nothing in this plan calls `deleteObject`.** Deletion belongs to the companion plan (#281).
- Codex convergence is **not** plan approval. Only David approves.

## 6. Open, and owed by David — not blockers

1. `<industryClassification>` mapping — `A1` / `A2` / `B1` / `B2` (needs NCMEC).
2. `<incidentType>` for wholly AI-generated material (needs NCMEC). The classifier path is
   hard-refused until this is answered.
3. Notice before an evidence purge (belongs to the retention plan, #281).

## 7. Environment notes that cost time to learn

- `git push --force` and `git reset --hard` are **blocked** by `.claude/guard.sh`; remote
  branch deletion does not work through the proxy. `git checkout -B <branch> <ref>` is the
  sanctioned reset primitive.
- This container's `GITHUB_TOKEN` is proxy-scoped and **403s** against `api.github.com`.
  GitHub access is via the MCP tools only.
- `pull_request_read` and every `add_reply_to_pull_request_comment` result echo the full diff
  hunk — for a 3,100-line new file that is 50–170 KB **per call**. They overflow to a file on
  disk; parse the file. That overflow is also the cheap way to harvest comment IDs in bulk.
  Budget for this: twenty replies is most of a context window on its own.
- **Verify sweeps with markdown stripped.** `re.sub(r'[*\`_]','',text)` before matching.
  Four rounds of Still Open findings came from skipping this.
