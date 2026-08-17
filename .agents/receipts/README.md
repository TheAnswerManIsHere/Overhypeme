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
{ "pr": 502, "tier": "internal", "budget": 3, "criticality": 30,
  "artifact": "review-round budget guard", "declaredAt": "2026-08-17T21:00:00.000Z" }

// loop-rounds-<pr>.json — appended before the post, so a failed post still counts.
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
is a guard that a syntax error switches off.
