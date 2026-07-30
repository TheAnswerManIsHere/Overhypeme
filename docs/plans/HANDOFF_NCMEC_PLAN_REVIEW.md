# Handoff — NCMEC CyberTipline plan review (PR #280)

**Written 2026-07-30, end of a session that ran out of context.** This document exists so a
fresh session can resume the Codex plan-review loop without re-reading a compacted
transcript. It lives on the never-merged review branch, like the plan itself.

---

## 1. Where things stand

| | |
|---|---|
| Plan file | `docs/plans/PLAN_NCMEC_CYBERTIPLINE_SUBMISSION.md` (2,744 lines) |
| Branch | `plan-review/ncmec-cybertipline-submission` — **never merged, never reused for implementation** |
| PR | **#280**, draft, `[PLAN REVIEW] … — DO NOT MERGE` |
| Head | `258a789` — round 14's fixes, pushed |
| Rounds completed | **14**. 98 findings, all accepted, zero rebutted |
| Companion | PR #281 (evidence retention) — **parked**, not under review |
| Implementation branch (not yet started) | `claude/ncmec-reporting-integration-8mwpho` |

**David's decision, 2026-07-30: keep the full scope and keep the loop running.** He was
offered a scope cut (defer the `/admin/safety` surface to a second plan) and declined it.
Do not re-raise it unless the shape of the problem changes materially.

---

## 2. Do this first — twelve replies are owed

Round 14's fixes are committed and pushed. **The thread replies are not.** Every finding
must get a reply on its own thread (never a summary comment, never resolve the thread —
that is David's).

The reasoning behind each fix is in `258a789`'s commit message, which is unusually detailed
precisely so these replies can be written from it plus the plan diff.

| # | Comment ID | Finding | Severity |
|---|---|---|---|
| 14.1 | `3678684539` | Copy every report-mapping input during orphan recovery — **13.1 Still Open** | P1 |
| 14.2 | `3678684533` | Match the partial index in the orphan upsert — **13.2 Still Open** | P1 |
| 14.3 | `3678684526` | Clear alert coverage when retrying a failed row — **13.3 Still Open** | P1 |
| 14.4 | `3678684552` | Make phase 1 independent of the phase-6 config route — **13.4 Still Open** | P2 |
| 14.5 | `3678684542` | Make the retry contract accept failed reports — **13.6 Still Open** | P1 |
| 14.6 | `3678684546` | Define a terminal outcome for not-reportable audits | P1 |
| 14.7 | `3678684560` | Surface null-intent quarantine orphans for audit | P1 |
| 14.8 | `3678684563` | Select the latest job when reconciling terminal history | P1 |
| 14.9 | `3678684565` | Add an endpoint for the global safety audit feed | P1 |
| 14.10 | `3678684573` | Create the incident ledger row before the alert runs | P1 |
| 14.11 | `3678684580` | Bypass the process-local cache for safety configuration | P1 |
| 14.12 | `3678684584` | Define when the report attempt counter changes | P2 |

Two of these were **verified empirically rather than accepted on assertion**, and the
replies should say so because the verification is the substance:

- **14.2** — `ON CONFLICT ("quarantine_id") DO NOTHING` cannot infer a *partial* unique
  index. Confirmed against the local test DB: it raises `there is no unique or exclusion
  constraint matching the ON CONFLICT specification`. The round-13 fix would have made
  orphan recovery raise on **every** run and repair nothing — worse than the duplicate
  filing it was added to prevent. Reproduce with `CREATE UNIQUE INDEX … WHERE q IS NOT
  NULL` then a bare-target upsert.
- **14.11** — `adminConfig.ts` caches every getter (including `getConfigStringRaw` /
  `getConfigIntRaw`) for 60 s per process at `CACHE_TTL_MS = 60_000`, and
  `bustConfigCache()` nulls a module-level variable, so it clears **only the writing
  instance**.

---

## 3. Then, in order

1. **Post the twelve replies** (above).
2. **Update the findings ledger** in the PR body with round 14 — 12 findings (10 P1 + 2
   P2), commit `258a789`, lens *"the mechanisms round 13 introduced, plus a sweep for other
   over-strong claims."* Running total becomes **98**.
3. **Request round 15** with a fresh lens and an explicit reconciliation list naming all
   twelve of round 14's items. The trigger comment states the lens; Codex does not declare
   its own framing.
4. Continue the loop to convergence: three conditions — no new Required Revision findings,
   zero Still Open in the ledger, and a fresh lens that round.
5. **Close PR #280 unmerged**, unsubscribe, and ask David for approval, linking the final
   plan file on the branch. **Codex convergence is not approval — only David approves.**
6. Then build on `claude/ncmec-reporting-integration-8mwpho`.

---

## 4. The pattern worth hunting

Four of the last two rounds' findings shared one shape: **a summary sentence asserting a
safety property the design does not actually enforce.** Each read like a conclusion and was
really an assumption, which is why they survived a dozen rounds:

- *"It is idempotent because the FK makes 'already has a report' a lookup"* — a foreign key
  is not a uniqueness constraint. Two sweeps, two reports, two federal filings.
- *"Nothing files a report until phase 6"* — phase 5 registers the worker.
- *"…that is the complete input set"* — it omitted `created_at` and `classification`, so a
  delayed recovery would state the **recovery** time as the incident time in a filing.
- *"The backlog audit owns them"* — the audit queries `ncmec_reports`; those rows have no
  report row, so they were in neither population.

**When reviewing or extending this plan, treat every "by construction", "exhaustive",
"idempotent", "atomic", "impossible", or "complete" as a claim to verify, not a conclusion
to rely on.** Round 14's second lens was exactly this sweep and it found two more.

A second, older pattern: **rewriting a section without sweeping for the superseded version
elsewhere.** Round 12 found four instances at once. The consolidation pass in `fb7ad35`
addressed the accumulated cases; the habit still needs watching.

---

## 5. Standing constraints — these do not lapse

- **The repo is public.** The disclosure check ran before this PR was opened and passed;
  its attestation in the PR body is deliberately contentless.
- **NCMEC credentials are never committed** and appear nowhere in the plan. They are
  consumed only as `NCMEC_ISPWS_USERNAME` / `NCMEC_ISPWS_PASSWORD`. David was told not to
  paste the values into chat; that still holds.
- **Evidence bytes stay unreadable over HTTP** — no route, no signed URL, no proxy.
  `getObjectEntityDownloadURL` (`objectStorage.ts:245-251`) signs any private subpath with
  **no `restricted/` guard** and must never be called on evidence.
- **Nothing in this plan calls `deleteObject`**, with or without `force`. Deletion belongs
  entirely to the companion plan (#281).
- The admin UI never renders evidence imagery and never emits a storage path, in the API
  payload or the DOM.

---

## 6. Open, and owed by David — not blockers

Three questions need NCMEC's answer, from the walkthrough call with Maya Mizuki that David
is booking. None blocks approval or implementation; the classifier path is hard-refused
until #2 is answered.

1. `<industryClassification>` mapping — `A1` / `A2` / `B1` / `B2`.
2. `<incidentType>` for wholly AI-generated material.
3. Notice before an evidence purge (belongs to the retention plan, #281).

Plus her own question back to David about the trusted-flagger workstream, which is his
answer to give and not a code change.

---

## 7. Environment notes that cost time to learn

- `git push --force` and `git reset --hard` are **blocked** by `.claude/guard.sh`; remote
  branch deletion does not work through the proxy. Never rewrite pushed history — a
  rebased branch here becomes unpublishable. `git checkout -B <branch> <ref>` is the
  sanctioned reset primitive.
- This container's `GITHUB_TOKEN` is proxy-scoped and 401s against `api.github.com`. GitHub
  access is via the MCP tools only.
- `pull_request_read` with `get_review_comments` paginates; PR #280 now has **104 threads**,
  so fetch the last page by cursor rather than scanning from the start. Reply tool results
  echo the full diff hunk and are very large — expect them to dominate context.
