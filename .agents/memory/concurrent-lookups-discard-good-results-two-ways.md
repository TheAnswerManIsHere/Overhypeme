# Two ways a concurrent lookup pair throws away a result you already had

When two independent lookups feed separate consumers, there are two distinct
mistakes that both end in "we had the answer and dropped it." They look
different and fail identically, and fixing the first walks you straight into
the second — this happened in consecutive review rounds on PR #498.

**1. `Promise.all` rejects as a unit.** One lookup fails, the other's perfectly
good value is discarded with it. Use `Promise.allSettled` and read each
`status` independently.

**2. `allSettled` under ONE shared deadline has the same defect on the time
axis.** `allSettled` stays pending until *both* settle, so a timeout wrapped
around the aggregate fires while one result is already sitting there resolved.
Put the deadline on **each lookup**, then `allSettled` the bounded promises.

```
// wrong twice over
await withTimeout(Promise.all([a(), b()]))        // fails as a unit
await withTimeout(Promise.allSettled([a(), b()])) // times out as a unit

// right
await Promise.allSettled([withTimeout(a()), withTimeout(b())])
```

**Why it mattered here rather than being cosmetic:** a discarded stage-1 figure
made its writer skip, and on the PuLID no-face path that writer is the *only*
one — so a paid attempt went unrecorded, which is the fail-open the release
existed to close.

**Bonus:** once each lookup is bounded, `allSettled` cannot reject, so the
surrounding `try`/`catch` becomes unreachable. Delete it — that block had
produced a finding in each of two rounds, and removing the construct beat
patching it a third time.

**Verify by execution, not argument.** A three-line probe (one promise that
resolves instantly, one that never settles) distinguishes all four shapes in
under a second. Reasoning about it is what produced both bugs.

**Reference:** PR #498 rounds 5–6, `videoPipelineRunner.startVideoJob`.
