---
name: A control that cannot evaluate must refuse, and a PreToolUse hook that throws fails OPEN
description: The blocking signal for a PreToolUse hook is exit code 2; an escaping exception exits 1, which the harness reads as a hook error and lets the tool call proceed. The handbook's own hooks are gone, but the exit-code contract and the general rule both still apply to anything that runs as one.
---

<!-- SYNCED FROM AI-Handbook — do not edit in a consumer repo. Local edits are overwritten by the next sync and their reasoning is lost; change the handbook instead. -->

## The mechanism this was written about is gone

The handbook shipped three `PreToolUse` hooks — a destructive-command guard, a
review-request guard and a merge gate — all forwarding to one decision script.
The #89 cut removed them (#94, #97) in favour of server-side GitHub rulesets,
which cannot fail open because there is no local process whose exit code
decides anything.

This note is kept, narrowed to the two things that outlive it: the harness
contract, which anyone writing a hook still has to know, and the general rule,
which this repo has now paid for three times.

## The exit-code contract, for any PreToolUse hook

**The blocking signal is exit code 2.** A Node entry point written as
`main().then(code => process.exit(code))` exits **1** on a rejected promise,
and **the harness reads 1 as a hook error and lets the tool call through.** So
the failure directions are inverted from the intuition:

| What happens | Exit | Harness reads it as |
|---|---|---|
| Deliberate refusal | 2 | **blocked** |
| Uncaught exception | 1 | hook error → **allowed** |
| Script cannot launch at all (bad path, no `node`) | 127 | hook error → **allowed** |
| Ran and permitted | 0 | allowed |

So in a hook, **never let an exception escape**. Wrap every fallible step —
filesystem reads, JSON parsing, a subprocess — in `try`/`catch` and **return a
blocked verdict from the catch**. "Rethrow so it fails closed" is wrong here:
rethrowing is what opens it.

## The general rule, which is the part that matters

**A control that cannot evaluate must refuse, and one that reports success
having evaluated nothing is the worst available failure.** Three instances are
on this repo's file:

- **#11** — a script compared `import.meta.url` against a hand-built
  `file://${process.argv[1]}` string. Those differ whenever the checkout path
  needs percent-encoding (a space, a `#`), so `main()` never ran and the
  process exited 0. A directory name disarmed every guard judgement at once.
  The fix, and the only correct comparison, is
  `pathToFileURL(process.argv[1]).href`. Both test suites still refuse the old
  form (`scripts/__tests__/entry-point-comparison.test.mjs` and the payload's
  copy), and that check outlived the hooks it was written for.
- **#16** — `guard.sh` read **any** non-2 exit as allow, so every new way of
  failing to produce a verdict failed open the same way. It wanted a sentinel
  on the allow path, so "ran and allowed" was distinguishable from "never ran".
  It was closed by removing the hook rather than by adding the sentinel.
- **#59** — a third control reporting success when it could not read its input.

The lesson is not about hooks. Any check — a CI step, a validator, a
dispatched reviewer — that can complete without having examined its subject
will eventually do exactly that, and say nothing.
