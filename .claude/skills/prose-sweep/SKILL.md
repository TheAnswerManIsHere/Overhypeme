---
name: prose-sweep
description: Reconcile the payload's prose with a landed design change by sweeping, never patching. Use after any change that RETIRES a rule, a mechanism or an authority — and again after every batch of fixes it produces, because each batch seeds fresh instances. Enumerates the retired rule's sub-shapes and exclusions as a spec, fixes the scope from git's tracked set including the role briefs and agent definitions a docs-shaped scope misses, fans the payload out to cold readers who declare what they read, and returns candidates with confidence plus every declined candidate with its exclusion. NOT a phrase checker; grep is a cross-check for a reader, never the method.
---

<!-- SYNCED FROM AI-Handbook — do not edit in a consumer repo. Local edits are overwritten by the next sync and their reasoning is lost; change the handbook instead. -->

# Prose sweep — the enactment

**The method is [`prose-sweep.md`](../../../docs/ai-context/prose-sweep.md),
and that file is its only statement.** This skill is the mechanics: what I
type, what I dispatch, what I read back. Nothing here restates a rule; where
a step below seems to, the doc wins.

Paths below are a consumer's. In the handbook the payload sits under
`core/`, the script knows, and a spec written payload-relative works in both.

## 1. Write the spec, before opening a file

One JSON file in the scratchpad, four required inputs. Placeholders, on
purpose: a worked example here went stale the first time its rule changed and
was then read as a template for the retired reading (#150). The real specs
are in the sweep PRs' bodies.

```json
{
  "rule": "<the retired reading in one sentence, and what replaced it>",
  "home": "<payload-relative path>#<section anchor>",
  "subShapes": [
    { "id": "a", "name": "<a SHAPE of the retired reading, never a phrase>", "example": "<a sentence a reader might meet>" },
    { "id": "b", "name": "<one carrying none of the class's vocabulary>", "example": "<…>" }
  ],
  "notInClass": ["<a live thing the class's wording would otherwise catch>"],
  "readInFull": ["<the rule's neighbourhood, as globs>"]
}
```

`subShapes` is by *shape*, never wording, and one of them should carry none of
the class's vocabulary. `notInClass` names every live thing the class's
wording would otherwise catch. `readInFull` is the rule's neighbourhood;
everything else in scope is swept. The script refuses a spec missing any of
the first four, and a `readInFull` glob that matches nothing.

## 2. Fix the scope with the script, never by hand

```
P=core/scripts/sweep-scope.mjs; [ -f "$P" ] || P=scripts/sweep-scope.mjs
node $P --spec <spec.json> --print-scope        # look
node $P --spec <spec.json> --workers 4 --out <dir>
```

The script sits at `core/scripts/` in the handbook and `scripts/` in a
consumer, so the first line picks the one that exists — the same shape
`plan-review-loop` and `pr-watch` already use. Spelling it `scripts/…` alone
fails in the handbook, where this skill is live by symlink.

It enumerates every tracked `.md` in the payload plus the root `CLAUDE.md`,
`AGENTS.md` and `README.md` — `.agents/roles/`, `.claude/agents/` and
`.agents/memory/` included by construction — partitions them across workers
(full reads balanced by line count; swept files kept whole by directory), and
writes `worker-N.md` briefs plus `inventory.json`. `--include <glob>` widens
it to non-payload docs when a rule reaches them. Four workers is the measured
shape; more for a bigger payload, never fewer than two.

## 3. Dispatch one cold reader per brief, and announce it

One `general-purpose` subagent per `worker-N.md`, in parallel, whose whole
prompt is: *read this brief and follow it exactly* plus the path. **Nothing
else** — no summary of the change, no list of instances I already know, no
hint of where I think the residue is. The brief is what makes the reader
cold, and anything I add warms it. Announced in chat, in one line, per the
dispatch rule.

If instances are already known, they are the control: withheld from every
reader, and checked against the reports afterwards. A known instance the
method does not surface is a finding about the spec — usually a missing
sub-shape — and it is worth more than the instance.

## 4. Read the reports as claims

For each candidate, open the file at the line and read the sentence in its
context before deciding anything. A reader's quote is evidence of what the
reader saw, not of what the file means. Then, for each:

- **Residue** → fix, by citing the home. A better restatement is a fresh
  copy that will drift.
- **History** → stays; note it as cleared with the exclusion that applies.
- **Wrong by omission** — a file that states the rule correctly in its own
  words and never names the home → cite the home. This is the shape grep
  cannot find and the reason the method exists.
- **Low confidence** → still read it. The band exists so that these reach
  me; a reader's own doubt is context, not a verdict.

Read the **declined** lists as carefully as the candidates. A pattern in what
readers declined — the same exclusion resolving many near-misses, or an
exclusion nobody used — is the signal that the class definition is wrong.

Check every inventory line. A file listed as swept with no escalation and a
file never listed are different facts; a worker that skipped a file it was
assigned is re-dispatched on that file, not trusted.

## 5. Record, then sweep the batch

The PR body carries: the spec as swept; the inventory (files, mode per file,
per worker); what was fixed with `path:line`; what was declined and under
which exclusion; and any shape a reader added. That record is what the next
sweep re-runs instead of re-inventing.

Then run steps 2–4 again over the fixes, with the spec **as amended** — a
shape a reader added goes into `subShapes` first, because every file cleared
before it existed was cleared against the old list and the whole scope owes a
pass against the new one. The second run is cheap and it is the point: every
batch seeds instances of the class it patched, and a sweep that runs once is
one batch behind by construction.

**The [two-review limit](../../../docs/ai-context/working-modes.md#the-two-review-limit-on-autonomous-iteration-david-2026-09-19)
counts reviews, not sweep runs.** A re-run after a
batch is part of composing the batch, before it is pushed, and is never
skipped to save a review — it costs none. A shape a *review round* reveals
goes into `subShapes` before that re-run, exactly as a reader's does. (#146
skipped both: two batches, no re-run after either, and the two gaps it shipped
were a sentence the batch itself added and a shape round 1 had just revealed.)
**A re-run re-dispatches only the briefs that own the files the batch
touched** — a batch can seed an instance only where it wrote — unless the spec
gained a shape, in which case the whole scope owes the pass, as above. So a
one-line fix costs one reader, not four.

## What this skill is not

Not a plan, not a review round, not a harvest. It produces a diff like any
other and that diff goes through the ordinary loop. And not a phrase checker
— there is no list of strings to grep for anywhere in it, on purpose.
