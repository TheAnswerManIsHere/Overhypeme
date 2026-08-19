---
name: An uncaught throw in the PreToolUse guard fails OPEN, not closed
description: guard-decision.mjs signals "block" with exit code 2; an escaping exception exits 1, which the harness reads as a hook error and lets the tool call proceed. Wrap anything fallible in try/catch and return a blocked verdict.
---

## Rule
In `scripts/guard-decision.mjs` (and anything `.claude/guard.sh` forwards to),
**never let an exception escape.** Wrap every fallible step — filesystem reads,
receipt claim/consume, JSON parsing — in `try`/`catch` and **return a blocked
verdict** from the catch. "Rethrow so it fails closed" is wrong here.

## Why — the exit-code contract
The blocking signal is **exit code 2**. `main()` is
`.then(code => process.exit(code))`, so a rejected promise exits **1**,
`guard.sh` forwards that 1, and **the harness reads 1 as a hook error and lets
the tool call through.** So the failure directions are inverted from the
intuition:

| What happens | Exit | Effect |
|---|---|---|
| Guard decides to block | 2 | tool call refused — the intended behavior |
| Guard decides to allow | 0 | tool call proceeds |
| **Exception escapes** | **1** | **harness treats it as a broken hook — tool call proceeds** |

## How it was found
PR #503 round 5. Round 4 had added a receipt claim/consume step whose review
comments explicitly promised that a filesystem fault would fail closed. It did
the opposite: the precise `EACCES`/`ENOENT` faults named as the fail-closed
cases were the ones letting review requests through, because they threw rather
than returning a verdict. Fixed by wrapping claim and consume in `try` and
returning `blocked`.

## The generalizable half
Fail-closed is a property of the **transport**, not of the throw. Before
claiming a component fails closed, trace what the *caller* does with the
exception — if the channel between them is an exit code, a status field, or an
HTTP code, an uncaught throw produces whatever that channel's error value maps
to, and "error" very often maps to "ignore this component."

## Related
- `.claude/guard.sh` also has a **node-unavailable fallback path** that does not
  load `guard-decision.mjs` at all. It refuses review-request payloads rather
  than failing open, but it is a separate code path — a fix in
  `guard-decision.mjs` is absent from it by construction.
