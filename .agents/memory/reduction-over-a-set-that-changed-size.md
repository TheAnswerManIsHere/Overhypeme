## A change to a set's cardinality invalidates every reduction over it

A reduction — `Math.min`, `Math.max`, `[0]`, `find`, "the first one" — encodes
an assumption about how many elements it folds. While the set is effectively a
singleton, `min` and `max` and `[0]` all agree, so the choice looks arbitrary
and never gets revisited. Widen the set later and they diverge silently: no type
error, and the singleton-era tests still pass because they only ever construct
one element.

**The worked example, stated precisely — because the imprecise version is the
lesson.** In `scripts/pr-ready.mjs`, `acceptedAt` used `Math.min` over the
qualifying review passes. Round 3 of PR #490 introduced a rule that let
`qualifying` hold more than one element, and `min` then selected the *earliest*
accepted response where the check needed the *latest*.

**What that actually broke:** `acceptedAt` does **not** decide whether a
response satisfies a request — `qualifying` does that, and it is a separate
filter. `acceptedAt` feeds only `checkCapture`, the capture-**ordering** check.
So with two qualifying passes, `Math.min` let snapshots captured *between* the
two passes satisfy the ordering check, meaning the receipt could be minted from
evidence that predates the later pass and therefore **misses its findings**.

That is stale *evidence ordering*. It is **not** "a stale response satisfying a
live request" — that describes the separate request-correlation gap, a different
defect in a different part of the same function. The first version of this note
said the latter, which would send a future debugger to the wrong code with the
wrong mental model. (Codex, #505 round 1.) Naming a mechanism you have not
traced is the failure this note is really about; the `Math.min` bug is just the
example.

**The rule:** when a change makes a collection able to hold more elements than
it could before, re-read **every** reduction over that collection in the same
commit — not only the code you were editing. The widening commit and the
reduction were in different functions on #490, and nothing connected them.

**Why "write more tests" isn't the fix:** the defect is invisible until someone
writes a test for the *widened* case, and the person who just widened it is the
least likely to think of it. Same asymmetry as *Fixing the flagged site and
leaving its siblings* in
[`known-failure-patterns.md`](../../docs/ai-context/known-failure-patterns.md).
