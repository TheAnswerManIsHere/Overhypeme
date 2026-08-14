---
name: Signal-safe spawn loops need the PID published inside a critical section
description: Publishing a spawned child's PID to a cleanup-visible array "immediately after" the spawn still leaves a real bash safe-point gap a signal can land in; close it with a defer-flag, not just tighter ordering.
---

# A spawn (`&`) and its PID-recording append are two separate commands — a signal can land between them

`artifacts/api-server/scripts/run-tests-sharded.sh` backgrounds several worker
processes in a loop and needs every one killed by its `do_cleanup` trap on
`SIGINT`/`SIGTERM`, however far the loop got. The first fix — publish each PID
to the global `WORKER_PIDS`/`PREFIX_PIDS` array right after spawning it,
instead of batching all of them into a local array and assigning it to the
global one only after the whole loop finished — closed the *loop-iteration*
version of the race (a signal between iterations) but not the *instruction*
version: bash only checks for a pending trapped signal at command boundaries,
and `cmd &` followed by `ARRAY+=("$!")` is still two separate simple commands.
A signal delivered in that gap runs the trap with the array still missing the
PID that was just spawned — reproduced directly by self-delivering the signal
at that exact point (`kill -TERM "$$"` between the two lines) before writing
either fix, and again after, to prove closure.

**The fix that actually closes it: a defer flag, not tighter ordering.**
Ordering can always be made *tighter* but never *zero-width* — there is
always some gap between "the child exists" and "bookkeeping says so," no
matter how few lines separate them. The pattern that removes the gap instead
of shrinking it:

```bash
_in_critical=0
_deferred_sig=""
on_signal() {
  if [ "$_in_critical" = "1" ]; then _deferred_sig="$1"; return; fi
  # ... real cleanup + exit ...
}
check_deferred_signal() { [ -n "$_deferred_sig" ] && on_signal "$_deferred_sig"; return 0; }

_in_critical=1
some_cmd &
ARRAY+=("$!")
_in_critical=0
check_deferred_signal
```

A signal caught while `_in_critical=1` is **recorded, not dropped**, and
redelivered via the explicit check right after the section ends — so a real
Ctrl-C during the section still fires cleanup, just deferred by a few
instructions, never lost. Setting `_in_critical=1` is itself atomic with
respect to signal delivery (bash never preempts mid-instruction, only at
command boundaries), so there's no smaller window hiding inside the flag
assignment itself.

**How to apply:** any future spawn-loop-with-signal-safety work in this repo
(another sharded runner, a supervisor script) should reach for this pattern
directly rather than re-deriving "publish sooner" and stopping there — sooner
is not soon enough once two commands are involved.

**Testing gotcha that cost real time verifying this:** two different broad
`pkill -f`/`pgrep -f` patterns used to test the interruption *didn't actually
match the runner process* — once matching nothing (the run completed normally
and self-cleaned, producing a false "clean" read that proved nothing was
tested) and once matching this session's own wrapper shell instead. Before
trusting either a "clean" or an "orphaned" process-list snapshot from a signal
test, check the target's own log for evidence it was actually interrupted
(e.g. `Killed` lines from a worker's exit) — a snapshot from an unconfirmed
interruption is not evidence of anything.
