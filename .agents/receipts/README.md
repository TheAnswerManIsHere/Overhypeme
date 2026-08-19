# Receipts

Machine-read state for the guards in `.claude/guard.sh`. Two families live
here, and the difference between them is the organising idea:

**Evidence is ephemeral. Decisions are durable.**

Evidence describes a PR at a moment — it is worthless once the moment passes
and re-derivable at will, so it is gitignored and dies with the session. A
decision is taken once and binds afterwards, so it is committed.

**And a decision is *read* from the commit, never from the working tree.** That
is what makes the line above load-bearing rather than decorative: the guard
resolves the branch's upstream ref and reads the budget and every extension out
of it with `git show` / `git ls-tree`. A receipt sitting only in the working
tree is not "present but undurable" — it is simply absent, because the read
that would have seen it never happens.

The practical consequence, and the one thing that changed for the workflow: **a
budget must be committed *and pushed* before round 1**, not merely written.
Extensions already carried that requirement. `HEAD` is deliberately not
accepted as a fallback — a commit that never reached a remote dies with the
container, which is exactly the failure the rule exists to prevent — so a
branch with no upstream has no durable ref and every review request on it is
refused until it is pushed.

| File | Kind | Written by |
|---|---|---|
| `pr-<pr>.json` | evidence | `pr-ready.mjs` — merge readiness, checked by the merge hook |
| `loop-round-check-<pr>.json` | evidence | `review-budget.mjs check` — rounds counted from a snapshot |
| `loop-round-check-<pr>.json.<nonce>.claim` | evidence | the guard — an atomic single-use claim on **one generation** of that receipt |
| `loop-budget-<pr>.json` | **decision** | `review-budget.mjs declare`, before round 1 |
| `loop-extension-<pr>-<n>.json` | **decision** | the session, after an adjudication or David's authorization |

The claim is keyed to the receipt's `nonce` rather than to the PR, so a fresh
`check` writes a *different* claim file instead of deleting a live one — and
`.gitignore` therefore has to match `loop-round-check-*.claim`, not the
narrower `*.json.claim`. That pattern silently stopped matching when the nonce
was introduced, and the only symptom was an untracked file after every guarded
post.

`.gitignore` names the ephemeral shapes explicitly and leaves the decision
shapes tracked. It cannot be written the other way round: git will not
re-include a file whose parent directory is excluded, so a `.agents/receipts/`
exclusion plus negations reads correctly and does nothing. The cost is that a
new ephemeral shape must be added to that list; the benefit is that the rule
actually works.

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

**A retry of a stalled round is allowed even at the cap.** The gate reads
`delivered`, and only when `pending` is 0. Gating on `spent` deadlocked the one
case the pending count exists for: two passes delivered plus one stalled
request equals an internal cap of 3, so the retry was refused — and the
self-serve recovery could not clear it either, since the adjudication record
would show 2 completed passes against a required 3. A reviewer outage at the
cap became a hard stop to David. The distinction is exact rather than
approximate: `pending` is defined as a trigger after the last pass, so if it is
1 then nothing has been answered since, and any request now is a retry of that
same round.

**The trigger may only be posted as an issue comment.** The count detects a
pending round by scanning issue comments; a trigger in a review thread or a
review body lands somewhere else and would be invisible, so a check taken while
one was in flight could authorize an extra round at the cap. Rather than widen
counting to every surface — where a snapshot missing one silently under-counts
— posting is narrowed to the surface counting can see, which makes
`issueComments` complete by construction.

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
// `capturedAt` is the SNAPSHOT's capture time, not the command's: freshness is
// a property of the evidence, or a saved snapshot mints a renewable receipt.
{ "pr": 503, "repo": "TheAnswerManIsHere/Overhypeme", "capturedAt": "…",
  "mintedAt": "…", "delivered": 2, "pending": 1, "spent": 3 }

// loop-round-check-<pr>.json.claim — EPHEMERAL, gitignored, zero bytes.
// Created by exclusive open(…, "wx"), a single atomic syscall, so exactly one
// hook process can win it. `consumedAt` alone is a read-then-write, and two
// posts issued in one turn run as two processes.
```

Tiers: `internal` = 3 rounds, `product` = 5, `sensitive` = uncapped with a
mandatory 🛑 to David at 5 (and no self-serve extension at all).

## Fail-closed, everywhere

A receipt the guard cannot parse, one that names another PR or repo, a
non-canonical filename (`loop-extension-1-01.json`), two receipts claiming one
sequence, an unlistable directory, a `continue` citing a record that does not
exist or was generated below the cap, and a round-check receipt that is
missing, stale, already consumed, already claimed, or carrying an incoherent
delivered/pending split — all **refuse the post** and name the file. So does a
snapshot that names no repository, carries no capture time, was captured more
than an hour ago, or omits a body where the count reads one. A guard that
ignores what it cannot read is a guard a syntax error switches off.

**One check authorizes one post.** The receipt is marked `consumedAt` when the
guard allows a request, so the same evidence cannot wave through a second
round. Re-run `check` for each one — the count comes from GitHub, so this
costs a snapshot, not a round.
