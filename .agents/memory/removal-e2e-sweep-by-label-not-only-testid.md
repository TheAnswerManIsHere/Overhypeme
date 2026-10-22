# A removal's E2E sweep greps visible labels and accessible names, not only test ids

**Shape.** A change that deletes UI (a removal, a rename, a reworked control)
leaves browser tests that still look for it. A test can find an element four
ways: a `data-testid`, its role plus accessible name (`getByRole("tab", {
name: /ai you/i })`), its visible text (`getByText(...)`), or a label
(`getByLabel(...)`). A sweep that greps only the deleted test ids misses the
other three, and the miss surfaces as a red E2E shard after the PR opens.

**Evidence.** Launch Phase 4, removal 2 (#752): the capture kit and two specs
still clicked the deleted Step 1, found by text; the sweep then learned to grep
every `data-testid` in the deleted files. Removal 3 (#754): that test-id sweep
was clean, and `publicScreens.spec.ts` still asserted the deleted "AI you" tab
was disabled, found by role and name; CI's `E2E Smoke (screens)` shard caught it.

**Do this before opening the PR.** Collect every user-visible string the diff
removes from `src/` (JSX text, `aria-label`, `label:`, `title`, button and tab
names; a crude but sufficient pass is the quoted and `>…<` strings on the diff's
`-` lines), plus every test id, and grep each against `e2e/` and the acceptance
harness (`artifacts/api-server/src/testing/`). A hit is either an absence
assertion (keep) or a stale test (fix). Then run the E2E shard that owns the
touched screens against a local stack; `TESTING.md` has the commands.
