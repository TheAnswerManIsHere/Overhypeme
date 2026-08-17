# Review-loop receipts

Machine-read state for the **review-round budget guard**
(`scripts/review-budget.mjs`). `guard-decision.mjs` reads these files when a
tool call would post an `@codex review` comment, and refuses the post when they
say the loop is out of rounds.

They are **committed deliberately**. The container is ephemeral, so an
uncommitted tally dies with the session and the round count silently resets —
which is the failure the guard exists to close. Committing them also makes the
week's budget events readable by the `/maintenance` digest.

## The three files

| File | Written by | Holds |
|---|---|---|
| `loop-budget-<pr>.json` | `review-budget.mjs declare`, before round 1 | tier, budget, criticality, artifact |
| `loop-rounds-<pr>.json` | the guard, on every **allowed** review request | one entry per round requested |
| `loop-extension-<pr>-<n>.json` | the session, after an adjudication or David's authorization | the verdict and what it grants |

## Shapes

```jsonc
// loop-budget-<pr>.json — tier decides the number; it is not a free field.
// autoOpeningReview: true for a normal PR (Codex reviews it on open, with no
// trigger comment, and that pass IS round 1); false only for a draft, which
// gets no automatic pass.
{ "pr": 502, "tier": "internal", "budget": 3, "criticality": 30,
  "artifact": "review-round budget guard", "autoOpeningReview": true,
  "declaredAt": "2026-08-17T21:00:00.000Z" }

// loop-rounds-<pr>.json — appended before the post, so a failed post still counts.
// Rounds spent = this array's length + the opening pass, so the cap matches the
// repo's definition of a round rather than "comments the guard saw".
{ "pr": 502, "rounds": [ { "at": "…", "tool": "mcp__github__add_issue_comment" } ] }

// loop-extension-<pr>-1.json — tripwire 1, from the fresh-context adjudicator.
{ "pr": 502, "kind": "adjudication", "verdict": "continue", "grant": 2,
  "risk": "<the named unaddressed behavioral risk>",
  "recordPath": ".agents/adjudications/502-1.json", "createdAt": "…" }

// loop-extension-<pr>-2.json — tripwire 2, David only. Never a second adjudication.
{ "pr": 502, "kind": "david", "grant": 3, "authorization": "<his words>", "createdAt": "…" }
```

Tiers: `internal` = 3 rounds, `product` = 5, `sensitive` = uncapped with a
mandatory 🛑 to David at 5 (and no self-serve extension at all).

A receipt the guard cannot parse, or one that disagrees with its tier, refuses
the post rather than being ignored — a guard that skips receipts it can't read
is a guard that a syntax error switches off. The same posture covers a tally
naming another PR, a non-canonical filename (`loop-extension-1-01.json`), two
receipts claiming one sequence, and a `continue` verdict citing a record that
does not exist.

**Commit the tally with each round.** The guard refuses the next request while
the on-disk tally differs from the one in `HEAD` — an uncommitted tally dies
with the container and silently re-grants the rounds it recorded, which is the
reset these receipts exist to prevent.

**An extension is dormant until the stage before it is spent.** A `continue`
receipt written early does not raise the allowance early; it activates at the
exact round its adjudication was about. Otherwise the loop sails past its cap
and the tripwire never fires at all.
