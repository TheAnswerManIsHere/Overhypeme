<!-- SYNCED FROM AI-Handbook — do not edit in a consumer repo. Local edits are overwritten by the next sync and their reasoning is lost; change the handbook instead. -->

# The agent-legible codebase eval

> **Why this exists.** David, 2026-10-14: *"I want to make sure that there is
> an eval that we can perform once this is built to prove that it actually
> helps. And that if it doesn't, it's very easy for us to back out of it."*
> This is the eval; the back-out is
> [`agent-legible-codebase.md`](agent-legible-codebase.md#backing-out). The
> harness is `scripts/map-eval.mjs`.

## The hypothesis

With the map adopted and the forcing rule in force, an agent finds the files
that answer a **hidden-dependency** question (one whose answer shares no
vocabulary with the question: callers behind a barrel, raw-SQL users of a
table) markedly more often, at no material cost in tokens. On questions grep
already answers, the research predicts no gain, and the eval checks that the
map does not make those worse.

## The task set

`.agents/map/eval-tasks.json`, consumer-owned, thirty questions over the
repository, ten per tier, each with its own id. `keys`, `prompts` and `score`
refuse a set with a repeated id or a tier of any other size, naming the tier
and the ids, since either would make the eval a different experiment:

| Tier | The answer… |
|---|---|
| `keyword` | shares vocabulary with the question; grep finds it |
| `structural` | lies two to four import hops from a named file (`hops` records it) |
| `hidden` | shares no vocabulary with the question: callers behind barrels or aliases, SQL-text users of a table |

Each task names its target: a `symbol` (`file#name`), a `relation` (a table or
external relation's name, optionally with its Drizzle `symbol`), or `files` (an
authored list, for questions neither mechanism answers).

## Answer keys, independent of the tool

A key built by the tool under test grades the tool against itself. So
`node scripts/map-eval.mjs keys` shares no module with `scripts/map.mjs`,
never reads the map's index, and builds each key by a different mechanism:

- **Symbol**: the compiler's own reference finder (the language service's
  find-references) over every declared program, counting files other than
  the declaring one, which is the definition the map's symbol query uses.
- **Relation**: every compiler-parsed string and template literal carrying the
  relation's whole name that reads as SQL (bare or quoted; an unqualified name
  also matches its `public.` form, and another schema's relation of the same
  name does not), plus find-references on the table symbol
  when one is given. Literals that mention the name but do not read as SQL are
  listed as `incidental`, for the person verifying.

**Compiler diagnostics never define a key.** Break a declaration that a barrel
re-exports by name and the compiler blames only the barrel; the real callers
stay silent. Diagnostics may corroborate; they cannot be complete.

Every key is written with `"verified": false`. A person checks each one, adds a
missed file or removes an incidental one, and sets it true. `score` refuses
while any key is unverified, and a key whose files or incidental list change
on a rebuild loses its verification, since a new incidental candidate is one
nobody has checked.

## The arms

| Arm | Tree | Tooling |
|---|---|---|
| **B** | the repository at its pre-adoption commit | grep and file reading only |
| **A** | the repository at its adopted commit | the map, with the forcing rule in force |

Same model in both (Sonnet, where mechanical work already routes), a fresh
agent and a fresh run repository per run, two seeds per task per arm: about 120 runs.

**Grading material never reaches an agent.** `node scripts/map-eval.mjs
prepare --ref <commit> --out <dir>` exports the tree at that commit without
the task file, the keys or any earlier results, and makes it a fresh
repository with one commit, so neither arm's files nor its history hold an
answer; the scorer keeps them in the main checkout. `node scripts/map-eval.mjs prompts --out <dir>` writes one
prompt per task carrying the question and the answer format, never the target.

## Running it

1. Write the task set, run `keys`, verify every key by hand, commit both.
2. For each task, arm and seed: `prepare` a run repository at that arm's commit, and
   dispatch a fresh agent into it with the task's prompt, started with the
   run repository as its working directory: an agent started in the scorer's
   checkout has the keys beside it, and nothing `prepare` does can undo that.
   The checkout `prepare` runs from must have its dependencies installed:
   `prepare` gives the run repository its own copy of them (hard-linked where
   the filesystem allows, with no link back into the source checkout), so
   neither arm installs anything inside a measured run, and it refuses when
   no `node_modules/typescript` is reachable.
   Where the tree carries the map's index, it also runs one map query there
   and refuses unless it answers, so arm A is never handed a map that cannot
   run (a different installed compiler would make every query refuse). Record a run line:
   `{task, arm, seed, files, tokens, toolCalls, seconds}`, with tokens read
   from the dispatch's own usage report, never estimated.
3. `node scripts/map-eval.mjs score --runs <file>` prints recall and precision
   per arm and tier, median tokens per arm, and the verdict. It gives no
   verdict unless the file is the complete matrix: every task in both arms
   under exactly two distinct seeds, no duplicate or unknown record, each
   with its `files` and measured `tokens`; it lists what is missing instead.
4. Record the result, the verdict and the runs file on the consumer's
   workstream issue, and set `enabled` in `.agents/map/config.json` to match.

## Metrics

Recall and precision of each answer against its key, averaged per arm and
tier; median input-plus-output tokens per run, per arm; tool calls and wall
time, reported but not thresholded.

## The pre-registered thresholds

Written before the first run (David approved them, 2026-10-14). Changing them
after a run has been seen invalidates the eval.

| Verdict | Condition |
|---|---|
| **keep** | hidden-tier recall up by at least **20 points**, and median tokens across all tiers up by at most **10%** |
| **disable** | hidden-tier recall up by fewer than **10 points**, or median tokens up by more than **25%** |
| **the agent decides and reports** | anything between, with the numbers (David, 2026-10-21; [`agent-working-rules.md`](agent-working-rules.md#a-reversible-choice-proceeds-on-the-recommendation-david-2026-10-10)) |

A flat hidden tier means either the forcing rule was not followed or the index
did not answer; each run's transcript says which, and that is the first thing
to read.

## Cost

About 120 agent runs. The per-run size is unknown until the first ten runs
measure it; at a guessed 60,000 tokens each, one eval is roughly 7 million
tokens, about $22 at the Sonnet proxy rate in
[`token-pricing.md`](token-pricing.md). The first ten runs replace the guess.

## The lagging indicator

After the eval, `/maintenance` counts review findings that name a caller or
user the class sweep missed, before adoption and after. It never overturns
the verdict alone; it says whether the effect held in real work.
