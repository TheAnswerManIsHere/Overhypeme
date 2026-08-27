# Live-environment evidence during diagnosis

Loaded from step 2 of [`SKILL.md`](SKILL.md) when a bug's root cause or tier
depends on something the repo cannot show me. Skip it entirely for a bug I can
reproduce from the code and a test — most bugs.

The environment facts this page operates on live in
[`replit-environment.md`](../../../docs/ai-context/replit-environment.md); it is
the source of truth and this page does not restate it. What follows is the
bugfix-scoped operational layer: when to reach for live evidence, how to ask for
it so the answer is trustworthy, and what to do with it once I have it.

## The decision: does this bug need live evidence at all?

The repo answers *what the code does*. It cannot answer *what the running system
actually contains*. Reach for live evidence when the diagnosis turns on one of
these, and not otherwise:

- **Which inputs actually trigger it.** Not "can this field be undefined" — the
  code answers that — but "is it undefined for every row, or only rows written
  before some change." The distinction usually decides the blast radius.
- **What live data or config actually looks like** — a column's real null rate, a
  constraint that is or isn't present, a config value as stored rather than as
  defaulted in code.
- **Whether the symptom reproduces at all** outside the reported path.
- **What the server actually logged** when it failed, when the report carries a
  symptom but no stack trace.

**Do this before classifying, not after.** The tier and the blast radius are
downstream of these answers, so classifying first means classifying on a guess
and re-tiering when the evidence lands. The enrichment-crash diagnosis on #579 is
the shape: the useful question was whether fresh submissions hit the error or
only refresh-seeded ones, which is a question about live job payloads, and the
tier moved with the answer.

## Which source answers which question

Three sources, and picking the wrong one is the common waste:

| Question | Source |
|---|---|
| What did production actually throw, with what stack and how often | **Sentry** — see [`maintenance/SKILL.md`](../maintenance/SKILL.md) §2 and [`docs/SENTRY.md`](../../../docs/SENTRY.md) |
| What does dev data/config/schema actually look like right now | **The Repl**, via the connector |
| What does the code do with that input | **The repo** — read it, don't ask an agent to summarize it |

**The Repl's database is the *development* database (`heliumdb`); production
(`neondb`, on Neon) is deliberately not reachable from the workspace.** So a live
query there tells me the *shape* of the data and whether the mechanism
reproduces — it does not show me the production rows that broke. For a bug
reported against production, Sentry is the production-facing source and the Repl
is where I reproduce what Sentry describes. Conflating the two produces a
confident "I checked the data" that checked a different database.

## Driving the connector so the answer is evidence

Two calls, two jobs, and only one of them returns text:

- **`ask_question` reads.** It is the only channel that returns an answer.
- **`update_app_using_prompt` acts.** It returns a status, never a result, so
  polling it for an answer is a dead end.

A read-only diagnostic is usually one `ask_question`. Anything that has to *run*
something first is the two-call sequence: `update_app_using_prompt` to kick it
off with the commands and an explicit read-only instruction, wait, then
`ask_question` for the output.

**Name the commands and ask for their raw output.** This is the whole ballgame,
and it is the single most expensive lesson in the connector's history: an answer
composed from the agent's *understanding* of how something works can be fluent,
specific, and false — that is exactly how a two-way auto-sync toggle that does
not exist got recorded as fact. An answer that quotes the command it ran and that
command's literal output is deterministic evidence.

So: **"run `<command>` and paste its exact output"**, never "how does X behave?"
An answer describing behavior is a working assumption until corroborated; an
answer carrying raw output can be recorded as fact and quoted in the PR body.

**Scope every request and say what it must not touch.** Replit Agent defaults to
*building*. An unscoped diagnostic question can come back as a feature, so state
read-only explicitly and name what is off-limits.

**`phase: "busy"` means the request was dropped — re-ask.** `"updating"` is not
busy; re-invoking there opens a brand-new agent turn.

## What this never becomes

**Diagnosis only. The fix goes through the pipeline.** Branch → PR → Codex
review → merge → sync. A repair applied through the connector has had no Codex
review and no CI, and routing my own unreviewed patch through Replit is
laundering, not shipping — a sanctioned live repair has to be David-originated.

Ephemeral probes are fine and are reverted in the same session. **Never commit or
push one**: Publish snapshots uncommitted files, so a forgotten probe is a
production hazard sitting in the worktree.

## Carrying the evidence into the PR

Live evidence is only worth gathering if it survives into the artifact:

- **Root cause** quotes the output, not a paraphrase of it. "Every row written
  before the backfill has a null here — `select count(*) …` returned 1,240"
  beats "the column is sometimes null."
- **Blast radius** — step 5's mechanical search is still mandatory and live
  evidence does not substitute for it. What live data adds is *how many* of the
  sites that search found are actually affected.
- **A live read that contradicts the code is a finding, not a discrepancy to
  reconcile quietly.** On questions of live fact, the environment's read wins
  over what a diff or a schema file implies; if they disagree, that gap is
  usually the bug.
