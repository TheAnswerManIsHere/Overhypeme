# Codex cloud environment: startup script

Codex boots a fresh container per task and runs a setup script before the task
begins. That script used to live only in the Codex environment UI, where it was
invisible to review. It is now checked in as
[`scripts/codex-setup.sh`](../../scripts/codex-setup.sh); the UI's setup field
should call `bash scripts/codex-setup.sh` so the startup path changes through
PRs like any other code.

This is Codex's environment only. Claude's sandbox uses
[`scripts/setup-test-db.sh`](../../scripts/setup-test-db.sh) via a SessionStart
hook, Replit uses its own workflows, and CI uses
[`.github/workflows/build.yml`](../../.github/workflows/build.yml).

## Why it looks the way it does

**pnpm 9, pinned.** CI pins `pnpm/action-setup@v6` to version 9, so Codex
resolving with 9 gets the same tree CI does. `pnpm-workspace.yaml` carries
`overrides`, `onlyBuiltDependencies` and `minimumReleaseAge`; a frozen install
under 9.15.9 accepts the lockfile unchanged ("Lockfile is up to date"). Bumping
Codex without bumping CI in the same change re-opens that gap.

**`--ignore-scripts` is safe here.** The four allowlisted build deps
(`@swc/core`, `esbuild`, `msw`, `unrs-resolver`) all resolve native binaries
from their platform packages at runtime rather than from a postinstall step, so
skipping lifecycle scripts costs nothing that this repo uses. `msw` is a
transitive dependency with no source-level usage, so its skipped service-worker
postinstall is inert.

**The explicit lib build on the last line is load-bearing.** `--ignore-scripts`
also skips the *root* project's `prepare` script, which is what normally builds
`lib/**` after install.

## What the fast path can and cannot do

Verified by running the script against a clean tree exported from `HEAD`
(2026-08-05) and then running each check in the resulting environment:

| Check | Result |
| --- | --- |
| `pnpm --filter @workspace/api-spec run codegen` | passes |
| `pnpm run typecheck:libs`, `pnpm run typecheck` | passes |
| `pnpm run build` (full Vite production build) | passes |
| Frontend vitest suite (`@workspace/overhype-me`) | 88 files, 909 tests, all pass |
| `@workspace/redact` unit tests | passes |
| api-server integration suite | **cannot run** — fails in test-schema setup |

The last row is the whole trade-off. `artifacts/api-server/src/__tests__/` runs
against real Postgres + pgvector (see
[`../engineering/testing-guide.md`](../engineering/testing-guide.md)); with no
database the runner dies before the first test, so the suite that backs CI's
`Test` job is unavailable to Codex on the fast path.

**David settled this on 2026-08-05: the fast boot wins.** A DB-less container is
the standing default for every Codex task. Codex reviews by reading, GitHub CI
owns the integration suite, and paying database provisioning on every boot to
serve the minority of tasks that could use it is the wrong trade. Do not flip
the default back without David.

## The DB is opt-in, and it has to be opt-in *at setup time*

Set `CODEX_SETUP_DB=1` in the Codex environment for the exceptional task that
needs the integration suite, then unset it. It cannot be deferred to a lazily-invoked helper: Codex
disables network access for the task phase, and provisioning needs
`postgresql-16-pgvector` from apt. Setup is the only phase that can install it.

`scripts/setup-test-db.sh` assumes a Debian-style Postgres install
(`pg_ctlcluster`, `sudo -u postgres`). That holds in Claude's sandbox image; it
is **unverified against Codex's image**, so the first `CODEX_SETUP_DB=1` boot is
the test of it.
