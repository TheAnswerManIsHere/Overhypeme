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

## Gotcha 1: plain `install`/`--force` doesn't re-resolve an already-locked package against a new override — `pnpm update <pkg> -r` does

Checked the regenerated `pnpm-lock.yaml`'s own `overrides:` block, expecting
it to echo the new `fast-uri: 3.1.4` entry (pnpm does echo *some* override
config there). It didn't — and initially read that absence as "the override
isn't being applied." **That diagnosis was wrong.** Confirmed later: even
once `fast-uri@3.1.4` was correctly resolved and shipped (PR #246, merged),
that lockfile `overrides:` block *still* omits both `fast-uri` and the
pre-existing bare `esbuild: 0.27.3` entry — it only ever echoes
**selector-style** entries (`esbuild>@esbuild/darwin-arm64: '-'`, etc.), never
bare package-name overrides, regardless of whether they're actually in
effect. **Don't use that block's contents as a signal for whether a bare
override is applied — it isn't diagnostic either way.**

The real, reliable check is the package's **actual resolved version**:
`grep "^  <pkg>@" pnpm-lock.yaml` (or `pnpm why <pkg>`). That's what actually
showed `fast-uri` stuck at 3.1.0 despite the override being added.

**What worked:** `pnpm update fast-uri --recursive` (equivalently `-r`) —
explicitly targeting the package for an update across the workspace forced a
real re-resolution; the version moved to 3.1.4 immediately. Plain
`pnpm install`, even with `--force`, reuses an already-resolved lockfile
entry for a package rather than re-evaluating it against a newly-added or
-changed override.

**Takeaway:** after adding/changing a workspace override for a package
that's already resolved in the lockfile, don't trust `pnpm install`/`--force`
to pick it up, and don't use the lockfile's `overrides:` echo block to
diagnose whether it did — check the package's actual resolved version
directly, and run `pnpm update <pkg> --recursive` if it hasn't moved.

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
