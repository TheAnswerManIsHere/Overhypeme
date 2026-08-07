# Loop metrics store

One JSON record per review loop, named for the PR it measures:
`.agents/metrics/loops/<pr>.json`.

**Don't hand-write these.** Run:

```
node scripts/loop-metrics.mjs --pr <number> --write   # or --mcp-snapshot <file> --write
```

then fill the `judgment` block and set `adjudication`. The mechanical half is
derived; typing it from memory is the failure this whole system exists to
prevent (recalled figures in this repo were wrong three times out of three).

**Reading the data is not the point.** The answers live in the digest:

```
node scripts/loop-report.mjs [--since YYYY-MM-DD] [--inventory <file>]
```

`/maintenance` runs it weekly and narrates the result to David in plain
language. If you find yourself reading records to answer a question, the
digest should probably answer it instead.

## Why one file per loop

The predecessor was a single markdown table
([`../loop-ledger.md`](../loop-ledger.md), now frozen at rows 1–42). Every
concurrent session appended to the same lines and hand-assigned the same
ordinals, so two sessions closing loops at once collided by construction —
PRs #327 and #335 each made the other un-mergeable. Different loops now touch
different paths and cannot conflict at all.

## The two record shapes

**Measured** — the normal case. See `scripts/check-loop-metrics.mjs` for the
enforced schema; the parts worth knowing before you write one:

- `mechanical` carries exactly eight keys and nothing else. `derive()` returns
  more (its own `pr`, a null judgment, a sampling verdict, a coarse state);
  storing any of them would duplicate something authoritative elsewhere and
  go stale on the next refresh.
- `judgment.causes` must sum exactly to `mechanical.findings`. Ambiguous
  causes default to self-inflicted.
- `preOpenPreflightMin` may be `null` **with a `preOpenPreflightReason`** when
  the figure genuinely can't be isolated. Null is not zero and is never summed
  as zero.
- `adjudication.status` is `never-run` (the usual case — adjudication is
  sampled), `completed` (stores only `population` and `disagreements`; the
  percentage and verdict are derived at read time), `n/a` (no valid findings
  to adjudicate), or `deferred` (with a reason — and it stays listed in every
  digest until resolved).

**Exempt** — a deliberate decision not to measure a loop:

```json
{ "schemaVersion": 1, "pr": 351, "exempt": "why this loop isn't measured" }
```

It carries no `closedAt` and no `mechanical`, and no report path may assume
it does.

## What is deliberately not enforced

Coverage and permanence are **not** CI gates (David, 2026-08-07). A missing
record is named in the weekly digest rather than failing an unrelated PR's
build, and a record can be edited or deleted in an ordinary commit with PR
review as the control. Both are accepted risks, recorded in
[`decisions.md`](../../../docs/ai-context/decisions.md) — this is an internal
tracking tool, and the earlier attempts to enforce these produced more
defects than they prevented.

The contract that governs all of it, for every agent, is
[`working-modes.md`](../../../docs/ai-context/working-modes.md#the-loop-ledger).
