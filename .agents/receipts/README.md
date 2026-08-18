# Receipts

Machine-read state for the guards in `.claude/guard.sh`. Two families live
here, and the difference between them is the organising idea:

**Evidence is ephemeral. Decisions are durable.**

Evidence describes a PR at a moment — it is worthless once the moment passes
and re-derivable at will, so it is gitignored and dies with the session. A
decision is taken once and binds afterwards, so it is committed.

| File | Kind | Written by |
|---|---|---|
| `pr-<pr>.json` | evidence | `pr-ready.mjs` — merge readiness, checked by the merge hook |
| `loop-round-check-<pr>.json` | evidence | `review-budget.mjs check` — rounds counted from a snapshot |
| `loop-budget-<pr>.json` | **decision** | `review-budget.mjs declare`, before round 1 |
| `loop-extension-<pr>-<n>.json` | **decision** | the session, after an adjudication or David's authorization |

`.gitignore` ignores this directory and then un-ignores the two decision
shapes. That is not a fudge of the readiness-receipt rule — it is its
complement.

## Why there is no round tally

The first design of the round budget kept a committed tally that the guard
incremented on every allowed post. In one evening of dogfooding on its own PR
it produced, in order: a double-count (the guard and I both wrote to it), a
phantom round (a request Codex never answered), a repair command for the
phantom, a durability check to stop the cache dying with the container, and
then a review round in which six of thirteen findings were against those
repair mechanisms rather than against the design.

Every one of those is a cache-coherence failure, because that is what the
tally was: a cache of something GitHub already holds authoritatively. This
repo's own measured lesson is that recalled numbers are wrong (3 out of 3)
and counted ones are right (3 out of 3) — and a tally is a recalled number.

So rounds are counted fresh, from evidence, at the moment of the decision:

```
node scripts/review-budget.mjs check --pr <n> --mcp-snapshot <file>
```

A **round is a completed reviewer pass** (`reviewerPasses()` from
`loop-metrics.mjs`, the same function the ledger uses), plus at most **one**
pending request — a trigger comment sitting after the last pass. At most one
round can be in flight, so a stall and its retry are one pending round, not
two, and a stalled request stops costing anything the moment its retry's pass
lands. Nothing needs reconciling because nothing was written down.

The automatic opening review needs no special handling under this model: it is
simply one of the passes.

## Shapes

```jsonc
// loop-budget-<pr>.json — COMMITTED. Tier decides the number; not a free field.
{ "pr": 503, "tier": "internal", "budget": 3, "criticality": 45,
  "artifact": "review-round budget guard", "declaredAt": "…" }

// loop-extension-<pr>-1.json — COMMITTED. Tripwire 1, from the Fable adjudicator.
// recordPath must cite a mechanical record generated AT the cap, which is how
// the guard knows the adjudication followed its tripwire rather than preceding it.
{ "pr": 503, "kind": "adjudication", "verdict": "continue", "grant": 2,
  "risk": "<the named unaddressed behavioral risk>",
  "recordPath": ".agents/adjudications/503-1.json", "createdAt": "…" }

// loop-extension-<pr>-2.json — COMMITTED. Tripwire 2, David only. Never a second adjudication.
{ "pr": 503, "kind": "david", "grant": 3, "authorization": "<his words>", "createdAt": "…" }

// loop-round-check-<pr>.json — EPHEMERAL, gitignored, one post per receipt.
{ "pr": 503, "repo": "TheAnswerManIsHere/Overhypeme", "capturedAt": "…",
  "delivered": 2, "pending": 1, "spent": 3 }
```

Tiers: `internal` = 3 rounds, `product` = 5, `sensitive` = uncapped with a
mandatory 🛑 to David at 5 (and no self-serve extension at all).

## Fail-closed, everywhere

A receipt the guard cannot parse, one that names another PR or repo, a
non-canonical filename (`loop-extension-1-01.json`), two receipts claiming one
sequence, an unlistable directory, a `continue` citing a record that does not
exist or was generated below the cap, and a round-check receipt that is
missing, stale, or already consumed — all **refuse the post** and name the
file. A guard that ignores what it cannot read is a guard a syntax error
switches off.

**One check authorizes one post.** The receipt is marked `consumedAt` when the
guard allows a request, so the same evidence cannot wave through a second
round. Re-run `check` for each one — the count comes from GitHub, so this
costs a snapshot, not a round.
