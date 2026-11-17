# Moving the render-failure control's target strands its old recording

**The gotcha.** The acceptance run's render-failure control is a recorded
vendor error (`FAILURE_CONTROLS` in `artifacts/api-server/scripts/acceptance-run.ts`,
target `RENDER_FAILURE_ENDPOINT`). When the target moves to another endpoint,
the error recording for the old target is no longer a declared control, and
record mode (`strayErrorRecordings`) fails the whole paid re-recording with
"answered only by a recorded 422 vendor error". It looks like a real vendor
failure on a live render; it is a leftover file.

**The fix.** In the same change that moves the target, delete the old
`fal.subscribe--<hash>.json` whose `target` is the old endpoint and whose
`error.status` is 422 (`grep -l '"status": *422' …/aiDouble/recordings/*.json`).
Re-recording with `--resume` then captures the new control.

Happened twice: Phase 1 of the compiler review (Nano Banana 2's control) and
Phase 2 (GPT Image 2.6 text-to-image), the second costing a failed paid run.
