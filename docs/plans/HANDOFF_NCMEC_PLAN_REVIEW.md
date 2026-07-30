# Handoff — NCMEC CyberTipline plan review (PR #280)

**Rewritten 2026-07-30 after round 17 was fully closed.** All twenty of round 17's findings
are fixed (`7ed2475` + `7102b63`), all twenty replies are posted, and **round 18 has been
requested**. The only thing owed is the round-17 ledger entry in the PR body.

---

## 1. Where things stand

| | |
|---|---|
| Plan file | `docs/plans/PLAN_NCMEC_CYBERTIPLINE_SUBMISSION.md` (~3,100 lines) |
| Branch | `plan-review/ncmec-cybertipline-submission` — never merged, never reused for implementation |
| PR | **#280**, draft, `[PLAN REVIEW] … — DO NOT MERGE` |
| Head | `7102b63` |
| Rounds | **17 closed, 18 requested.** 158 findings raised, **158 addressed, 0 open** |
| Owed | The round-17 **ledger entry** in the PR body — nothing else |
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

### All sixteen closed in `7102b63`

| Line | Fix |
|---|---|
| 771 | `0094` backfills `quarantine_id` from the stub's `request_metadata.quarantineId` **before** the index and pass 2 go live, reporting linked / missing / conflicting |
| 715 | `match_source` is **normalized** via `quarantine.ts:104`'s existing rule, not copied — `fal_safety` / `manual` would have violated `0043`'s CHECK |
| 592 | The activation gate requires the **key**, not "a recipient resolves"; the generic route refuses to empty it while production is live |
| 884 | `AbortSignal.timeout(30_000)` on the notification send — three untimed stalls would have occupied all three bulk slots and stopped `ncmec_submit` |
| 1223 | The audit bypass is `overhype_audit_maintenance` **role membership**, not a settable GUC |
| 1503 | The pre-`/finish` recheck evaluates the whole tuple; `enabled=true, environment=test` passed an enabled-only gate |
| 1594 | `report_intent` is captured from an **uncached** read — it is written once and never re-derived |
| 1852 | A retained `report_id` must be resolved (retract, or an audited portal determination) before manual filing |
| 1969 | The backlog cutoff comes from `now()` with `RETURNING`, not an application clock |
| 2084 | `mark-manually-filed` joins the enumerated set that clears `alert_notified_at` |
| 478 | Retryable returns and caught exceptions release the lease |
| 1080 | A monotonic guard (`last_attempt_failed_at < $observed_at`) on the observational triple |
| 1392 | The pass-3 index carries `alert_notified_at IS NULL` in its predicate |
| 1437 | The guarded write validates the **resulting** retry schedule still crosses 72 h |
| 1517 | `finish_started_at` clearing defined across five resolution paths, including pass 1's repair |
| 1943 | `resolve-test-attempt` gives branch 3 the found / not-found exit it lacked |

Three endpoints were added to §5.8.1's **contract table**, not left in prose — the
prose/table split is the defect class that reopened findings in rounds 12, 14, 15 and 17.

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
