---
name: pnpm workspace `overrides:` — bare entries can silently no-op; scope is narrower than it looks
description: A bare package-name override in pnpm-workspace.yaml didn't change the resolved version even after `pnpm install --force`; `pnpm update <pkg> -r` was what actually worked. Separately, a workspace-wide override does not force a package's own direct dependency specifier for that same package.
---

# pnpm `overrides:` — two gotchas discovered forcing `fast-uri` and `esbuild` versions

## What happened (PR #246, patching Dependabot CVE alerts)

Needed to force `fast-uri` (pulled in transitively via `ajv`) to a patched
version. `ajv`'s own declared range (`^3.0.1`) already permitted the target
version, so no override should have been strictly necessary — but the
existing lockfile had it pinned at the oldest satisfying version (3.1.0), and
plain `pnpm install` reuses an already-resolved lockfile version rather than
jumping to the newest one that satisfies a range.

Added `fast-uri: ^3.1.4` (then tried an exact `3.1.4`, matching the style of
a working override elsewhere in the file) to `pnpm-workspace.yaml`'s
`overrides:` block. Ran `pnpm install`, then `pnpm install --force`. **The
resolved version never moved off 3.1.0.**

## Gotcha 1: bare overrides aren't always recorded/applied by plain `install`

Checked the regenerated `pnpm-lock.yaml`'s own `overrides:` block (pnpm
echoes its effective override config there) — it only listed the file's
**selector-style** entries (`esbuild>@esbuild/darwin-arm64: '-'`, etc.), never
the bare `fast-uri: 3.1.4` entry I'd just added, nor even the pre-existing
bare `esbuild: 0.27.3` entry. That absence was the tell that `install`
(even `--force`) wasn't actually re-resolving against the new override.

**What worked:** `pnpm update fast-uri --recursive` (equivalently `-r`) —
explicitly targeting the package for an update across the workspace forced
the real re-resolution; the version moved to 3.1.4 immediately.

**Takeaway:** after adding/changing a workspace override, don't trust
`pnpm install`/`--force` alone. Verify the resolved version actually changed
in `pnpm-lock.yaml` and, if it didn't, run
`pnpm update <pkg> --recursive` before assuming something is broken or the
override syntax is wrong.

## Gotcha 2: a workspace-wide override does NOT lock a project's own direct dependency

While investigating, found the workspace already had `esbuild: 0.27.3` as a
bare root override (used to dedupe/pin the many transitive esbuild copies a
monorepo like this accumulates). Initially assumed this meant esbuild was
locked repo-wide and bumping it would require editing that override.

**It didn't.** `artifacts/api-server/package.json` declares `esbuild` as its
**own direct** devDependency (`^0.27.3`). Bumping *only* that direct specifier
to `^0.28.1` — leaving the root override at `0.27.3` completely untouched —
correctly resolved `esbuild@0.28.1` for that package (confirmed: this exact
combination was already proven safe in the parked Dependabot PR #243's own
green CI). The root override apparently constrains transitive/indirect
resolutions, not a workspace member's own direct specifier for the same
package.

**Takeaway:** "there's a root `overrides:` entry for package X" does not mean
every consumer of X is locked to that version — check whether the package
you're bumping declares X **directly** first; if so, its own specifier is
very likely what actually needs to change, not the root override.
