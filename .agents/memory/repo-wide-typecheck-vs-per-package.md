---
name: Per-package tsc -b can pass while the repo-wide `pnpm typecheck` fails
description: A new cross-package workspace import needs the consuming package's tsconfig.json project reference updated, or `tsc -b`'s stricter resolution fails elsewhere in the repo than the package you were checking.
---

# Checking one package's `tsc -b` doesn't catch a missing project reference in another

`tsc -b` (TypeScript's project-reference build mode) resolves a workspace
import (`@workspace/api-zod`, `@workspace/db`, …) only through the consuming
package's `tsconfig.json` `references` array — this is stricter than plain
Node module resolution, which can still "work" via `package.json` `exports` /
`node_modules` symlinks even without a project reference.

**Concretely (PR #242):** added `@workspace/api-zod` as a new dependency of the
`scripts` package (for a shared seed helper) but never added
`{ "path": "../lib/api-zod" }` to `scripts/tsconfig.json`'s `references`. Running
`pnpm --filter @workspace/api-server exec tsc -b` and
`pnpm --filter @workspace/overhype-me exec tsc -b` (the packages actually being
worked on) both stayed clean — neither touches `scripts`. The repo-wide
`pnpm typecheck` (which the root `package.json` runs, and what CI/Codex actually
uses to catch this) failed with `TS2307: Cannot find module '@workspace/api-zod'`
in `scripts/src/seed.ts` and `reseed-facts.ts` — caught by Codex review, not by
any of the per-package checks run during the build.

**Rule:** after adding a new `@workspace/*` dependency to ANY package's
`package.json`, add the matching `{ "path": "../lib/<pkg>" }` reference to that
package's `tsconfig.json` immediately, and verify with the repo-wide
`pnpm typecheck` — not just a `tsc -b` scoped to the package you're actively
editing. A per-package check only proves that ONE package's references are
complete; it says nothing about a sibling package you didn't touch directly.
