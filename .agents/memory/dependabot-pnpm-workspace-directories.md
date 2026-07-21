---
name: Dependabot npm on a pnpm workspace needs `directories` globs, not `directory: "/"`
description: Why a single `directory: "/"` Dependabot entry silently covers only the root manifest and leaves every workspace package.json (where most prod deps live) outside version/security updates.
---

# Dependabot must enumerate the pnpm workspace manifests

## What happened

The supply-chain PR (C10, PR #217) added `.github/dependabot.yml` with the npm
ecosystem at `directory: "/"`. Codex (P2) pointed out that `directory` is a
**single** manifest directory, so that entry scans only the root
`package.json` + `pnpm-lock.yaml` and **misses every workspace `package.json`** —
`artifacts/*`, `cloudflare/*`, `lib/*`, `scripts` — which is where most
production deps actually live (`@sentry/node`, `openai`, `helmet`, `wrangler`,
drizzle, …). Result: version and security-update PRs would cover almost none of
the real dependency tree.

## The generalizing rule

For a pnpm (or any) monorepo, use Dependabot's **`directories`** (plural, glob-
capable) list mirroring `pnpm-workspace.yaml`, not a single `directory`:

```yaml
- package-ecosystem: "npm"
  directories:
    - "/"
    - "/artifacts/*"
    - "/cloudflare/*"
    - "/lib/*"
    - "/scripts"
```

Cross-check the globs against the actual manifests before trusting coverage:

```bash
git ls-files '**/package.json' package.json | grep -v node_modules
```

`github-actions` can stay `directory: "/"` (workflows live at the repo root).

## Why this is easy to miss

- The config is valid YAML and Dependabot accepts it — the gap is silent; you
  only notice by the *absence* of update PRs for workspace packages weeks later.
- The root lockfile (`pnpm-lock.yaml`) holds every workspace dep, so it *looks*
  like the root entry should cover everything — but Dependabot keys on the
  manifest directory, not the lockfile contents.

## Overhype specifics

See [`security-model.md`](../../docs/ai-context/security-model.md#secrets--supply-chain-c10).
The workspace globs above were verified to cover all 13 workspace manifests +
root (PR #217).
