---
name: buildreport
description: An independent, short, plain-English account of a finished unit of work, written by the Fable role `fable-build-report` from GitHub rather than by the builder — ONLY when David types /buildreport or asks for a build report in words. Nicknamed FLAG, the foundation that reviews every one of Michael's missions. Takes the unit the session just finished, or pull request numbers or a prototype branch he names. Never dispatched at close-out, after a merge, or on the builder's own initiative.
---

<!-- SYNCED FROM KITT — do not edit in a consumer repo. Local edits are overwritten by the next sync and their reasoning is lost; change KITT instead. -->

# /buildreport (FLAG) — an independent account, on request

**It runs only when David asks** (David, 2026-11-25: *"eliminate the build
report unless I explicitly ask for it"*). Nothing in close-out, `pr-watch`,
`prototype` or any other skill dispatches it, and I never offer one unasked.

**What he gets**, in this order, each in simple plain English (his words:
*"easy to understand and less technical"*), and nothing else:

1. **What was built** — at most three sentences, from the diff.
2. **Agrees**, or each disagreement with my account, one line each. "Agrees"
   prints only when nothing below is a concern; with a concern below it
   reads *"No dispute with the builder's account, but see its concerns
   below"*, and when something could not be checked, *"Agrees, as far as it
   could check"*.
3. **Decisions it questions** — only those it has a concern about.
4. **Should not have shipped unfixed** — only those it calls unreasonable.
5. **Overbuilt** — only when there is something.
6. **Caveats** — only when something could not be assessed, or the model
   that wrote it is not the one this repository asks for.
7. **Next** — one sentence: the next step of this workstream.

A unit with nothing wrong is about five lines. **It is an independent
assessment, not a guarantee**: it defends against my being *wrong*, never
against my being deliberately misleading.

## Which unit

- **No argument** — the unit this session most recently finished: the pull
  requests of its last merge report, or the prototype version just
  delivered.
- **Pull request numbers** — those pull requests, with their workstream
  issue.
- **A prototype branch** — that branch from after `--since` (the head named
  in the previous version's merge report or hand-back, or the branch's base
  for the first version) through its head.

The workstream issue is required, or on the private path its relayed text.

## How it runs

The script is `core/scripts/build-report.mjs` here and `scripts/build-report.mjs`
in a consumer.

1. **Write the brief and prepare the answer path in one call**:
   `node <dir>/build-report.mjs brief --unit <slug> --issue <n> --issue-title "<title>" --pr <n> --pr-title "<title>" [--pr <n> --pr-title "<title>" …]`,
   or `--branch prototype/<feature> --since <sha> --head <sha>` in place of
   the pull requests. The slug names the answer file (`pr-231`,
   `ingest-v2`). **Every number carries its title, as read from GitHub**
   (`claude-core.md`, interaction rule 14): `brief` refuses an `--issue`
   without `--issue-title` and a `--pr` without its `--pr-title`, in order.
   Preparing clears any earlier attempt's answer and coordinates, so a
   re-dispatch that writes nothing reads as a failure, never as its
   predecessor. **A workstream whose plan is on a private draft Project
   item** is reported from **the item's text, relayed by David**: I ask him
   to paste it, write it to the scratchpad, never the repository, and pass
   `--private-source <file>` with `--private-ref <the item's reference>`, in
   place of `--issue` or beside a sanitized one. `brief` refuses a source
   inside the checkout, quotes it inline under its provenance, and marks the
   unit private; `--private yes` without a source is refused.
2. **Dispatch `fable-build-report`** with `model:` set to the pin's alias
   (`dispatchModel().agentModel`) and **the printed brief as the whole
   prompt**: the role holds no file-reading tool, so a brief handed to it as a
   path is unreachable. One line announces the dispatch.
3. **Read only after the harness reports the dispatch complete**, in the tool
   result or a later task notification
   ([`backgrounded-subagent-answer-is-in-its-own-transcript.md`](../../../.agents/memory/backgrounded-subagent-answer-is-in-its-own-transcript.md)).
   The answer is the file, never the role's closing message. No file is a
   failed report, never a quiet one.
4. **Paste the report verbatim**: `node <dir>/build-report.mjs report --unit <slug>`,
   **in chat only**, and say nothing else about the unit. A private-path
   unit's report says at its top that David keeps it in the private item.

- **The report is the role's words, not my summary of them.** `chatReport`
  composes it from the validated answer's own fields; the only text that is
  not the role's is the labels. My own account is welcome beside it, labelled
  as mine.
- **A failure is honest.** No file, unparseable JSON and a schema-invalid
  answer are each a visible **failed** report. If the dispatch itself is
  refused — a newly added agent type is not dispatchable for some minutes, and
  an edited one may be served stale — I say so in plain English and offer to
  try again.
- **The model is disclosed, not observed**: the role reports its own, and the
  report mentions it only on a mismatch or an absence.
- **`Write` is not path-scoped, and this role reads every comment on the pull
  request, from anyone.** A path specifier in a `tools:` list removes the tool
  rather than narrowing it, so the bare grant ships and the exposure is named:
  an injected instruction could direct the one write tool at any path in the
  checkout. What bounds it: the answer directory is `*`-gitignored; the
  container is ephemeral; and the only route to `main` is a commit I make.
  **So after every dispatch, I read `git status --porcelain`**: an untracked
  file inside `.agents/reviews/` is the one kind of noise, and anything else
  — a tracked file modified anywhere, `.agents/reviews/.gitignore` included —
  is a finding.
