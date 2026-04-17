# DIST_DECOMMIT_PLAN.md

> Phase 1 investigation. The plan is **pivoted** away from the original
> "decommit committed `dist/`" framing because the recon below shows there is
> nothing committed to remove. The real failure mode behind Task #148 is stale
> *local* lib build output combined with consumer typechecks that never
> refresh it. Phase 2 must close those two specific gaps, not perform a mass
> de-commit.

---

## 1. Inventory of build output in version control

### 1a. No `dist/`, `build/`, or `out-tsc/` directories are tracked

```
$ git ls-files | grep -E '/(dist|build|out-tsc)/'
(no output, exit 1)
```

### 1b. No `*.tsbuildinfo` files are tracked

```
$ git ls-files | grep -E '\.tsbuildinfo$'
(no output, exit 1)
```

### 1c. No `.d.ts` files are tracked outside `src/generated`

```
$ git ls-files '*.d.ts' | grep -v src/generated
(no output, exit 1)
```

### 1d. `.gitignore` already excludes the build outputs

`.gitignore` lines 3–7:

```
# compiled output
dist
tmp
out-tsc
*.tsbuildinfo
```

### 1e. Local `dist/` directories on disk (untracked)

None of these are in git. The columns distinguish two different producers:

- **`prepare` builds it?** — does `pnpm install` (root `prepare` =
  `pnpm --filter './lib/**' --if-present run build`) emit `dist/` for this
  lib? Only libs with their own `build` script qualify.
- **`tsc --build` builds it?** — does the root `pnpm typecheck:libs`
  (`tsc --build`) emit `dist/` for this lib? Any lib with a `composite: true`
  tsconfig that is reachable via the root `tsconfig.json` `references` graph
  qualifies.
- **Currently on disk in this container?** — what's actually there right now,
  after the most recent `pnpm install` + typecheck cycle in this workspace.

| Lib                                  | `prepare` builds | `tsc --build` builds | Currently on disk? |
| ------------------------------------ | ---------------- | -------------------- | ------------------ |
| `lib/api-client-react`               | no               | yes                  | yes (`.d.ts`)      |
| `lib/api-spec`                       | no (no build)    | no (no tsconfig)     | no                 |
| `lib/api-zod`                        | no               | yes                  | yes (`.d.ts`)      |
| `lib/db`                             | no               | yes                  | yes (`.d.ts`)      |
| `lib/integrations`                   | no               | no                   | no                 |
| `lib/integrations-anthropic-ai`      | no               | yes                  | yes (`.d.ts`)      |
| `lib/integrations-openai-ai-server`  | no               | yes                  | yes (`.d.ts`)      |
| `lib/redact`                         | yes              | yes (alias)          | yes (`.js`+`.d.ts`)|
| `lib/replit-auth-web`                | no               | yes                  | yes (`.d.ts`)      |

Implication: a *fresh clone that runs only `pnpm install`* gets only
`lib/redact/dist`. Any other lib's `dist/` exists on disk only because
something — the root `pnpm typecheck`, the post-merge hook (which explicitly
calls `pnpm tsc -p lib/api-zod/tsconfig.json` and
`pnpm tsc -p lib/api-client-react/tsconfig.json` and then
`pnpm --filter './lib/**' --if-present run build`), an artifact build via
`tsc --build`, or a previous `tsc --build` invocation — has run since the
clone. That mismatch is part of the Task #148 mechanism (see §4b).

> **Conclusion of section 1: there is nothing committed to remove.** Any plan
> that performs `git rm --cached` on `dist/` directories is a no-op against
> the actual repo state.

---

## 2. Per-lib package configuration

For every `lib/*` package, the source-of-truth `exports` field, the
`tsconfig.json` settings, and notes on what the local `dist/` is actually used
for.

### 2.1 `lib/api-zod`

- `package.json`: `"exports": { ".": "./src/index.ts" }`. No `main`, no
  `module`, no `types`. **Consumers resolve directly to source `.ts`.**
- `tsconfig.json`: `composite: true`, `emitDeclarationOnly: true`,
  `outDir: "dist"`, `rootDir: "src"`.
- Local `dist/` purpose: holds emitted `.d.ts` and `.tsbuildinfo` so that
  TypeScript project references in dependent tsconfigs (`tsc --build`) can
  use them as a project boundary.

### 2.2 `lib/api-client-react`

- `package.json`: `"exports": { ".": "./src/index.ts" }`. Same shape as
  `api-zod`.
- `tsconfig.json`: `composite: true`, `emitDeclarationOnly: true`,
  `outDir: "dist"`, `rootDir: "src"`.

### 2.3 `lib/db`

- `package.json`: `"exports": { ".": "./src/index.ts", "./schema": "./src/schema/index.ts" }`. Source-only resolution.
- `tsconfig.json`: `composite: true`, `emitDeclarationOnly: true`,
  `outDir: "dist"`, `rootDir: "src"`.

### 2.4 `lib/integrations-anthropic-ai`

- `package.json`: `"exports": { ".": "./src/index.ts", "./batch": "./src/batch/index.ts" }`. Source-only resolution.
- `tsconfig.json`: `composite: true`, `emitDeclarationOnly: true`,
  `outDir: "dist"`, `rootDir: "src"`.
- Note: there is **no `build` script** in this package's `package.json`, so
  the root `prepare` (`pnpm --filter './lib/**' --if-present run build`) does
  *not* build it. Its `dist/` is produced only by the root
  `tsc --build` (i.e., by `pnpm typecheck:libs`).

### 2.5 `lib/integrations-openai-ai-server`

- `package.json`: `"exports": { ".": "./src/index.ts" }`. Source-only.
- `tsconfig.json`: same shape as the others.
- Same note as 2.4: no `build` script.

### 2.6 `lib/redact`

- `package.json` is the **odd one out**:
  ```json
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "workspace": "./src/index.ts",
      "default": "./dist/index.js"
    }
  }
  ```
  Consumers that resolve under the `workspace` condition (TypeScript with
  `customConditions: ["workspace"]`, see §3) get source `.ts`. Anything else
  falls through to `./dist/index.js`.
- `tsconfig.json`: `composite: true`, `declaration: true` (i.e., emits both
  `.js` and `.d.ts`), `outDir: "dist"`, `rootDir: "src"`.
- Has its own `build` script: `tsc -p tsconfig.json`. Built by `prepare`.

### 2.7 `lib/replit-auth-web`

- `package.json`: `"exports": { ".": "./src/index.ts" }`. Source-only.
- `tsconfig.json`: composite/emitDeclarationOnly/dist/rootDir as the others.

### 2.8 `lib/api-spec`

- Codegen-only package (`orval`). No `tsconfig.json`, no `build` script, no
  `dist/`. Out of scope for this plan.

### 2.9 `lib/integrations`

- No `tsconfig.json`, no `build` script, no `dist/`. Out of scope.

---

## 3. Consumers and module resolution

`tsconfig.base.json` sets `"customConditions": ["workspace"]` and
`"moduleResolution": "bundler"`. This means TypeScript honors the
`"workspace"` export condition when resolving package names.

Combined with §2:

- For every lib **except** `redact`, `exports["."]` points only at
  `./src/index.ts`. There is no fallback to `dist/`. Consumers always see the
  source `.ts` files at type-check time. **Local `dist/` is not consulted via
  package-name resolution at all** — its only role is as the project-reference
  output read by `tsc --build`.
- For `redact`, the `"workspace"` condition routes to source `.ts`. Anything
  outside that condition (e.g., the runtime Node import in the bundled
  api-server output) gets `./dist/index.js`.

### Consumers of each lib

| Lib                                  | Consumers (workspace deps)                           |
| ------------------------------------ | ---------------------------------------------------- |
| `@workspace/api-zod`                 | `@workspace/api-server`                              |
| `@workspace/api-client-react`        | `@workspace/overhype-me`, `@workspace/replit-auth-web` |
| `@workspace/db`                      | `@workspace/api-server`, `@workspace/scripts`        |
| `@workspace/redact`                  | `@workspace/api-server`, `@workspace/overhype-me`    |
| `@workspace/replit-auth-web`         | `@workspace/overhype-me`                             |
| `@workspace/integrations-anthropic-ai`   | `@workspace/api-server`                          |
| `@workspace/integrations-openai-ai-server` | `@workspace/api-server`                        |

### Project references in artifact tsconfigs

`artifacts/api-server/tsconfig.json` declares `references` to:
`lib/redact`, `lib/db`, `lib/api-zod`, `lib/integrations-openai-ai-server`,
`lib/integrations-anthropic-ai`.

`artifacts/overhype-me/tsconfig.json` declares `references` to:
`lib/redact`, `lib/api-client-react`, `lib/replit-auth-web`.

These references matter when you run `tsc --build` from the artifact (or from
the root). They have no effect on a plain `tsc -p tsconfig.json --noEmit`,
which is what each artifact's `typecheck` script actually runs (see §4b).

---

## 4. CI status and typecheck invocation paths (the two real gaps)

### 4a. Gap (a): no CI runs the full typecheck

```
$ ls .github
ls: cannot access '.github': No such file or directory
$ ls .circleci
ls: cannot access '.circleci': No such file or directory
$ ls .gitlab-ci.yml
ls: cannot access '.gitlab-ci.yml': No such file or directory
```

There is no GitHub Actions / CircleCI / GitLab pipeline. The only CI-shaped
job is the `typecheck` workflow defined in `.replit` (`isValidation = true`):

```toml
[[workflows.workflow]]
name = "typecheck"
author = "agent"

[workflows.workflow.metadata]
isValidation = true

[[workflows.workflow.tasks]]
task = "shell.exec"
args = "pnpm --filter @workspace/api-spec run codegen && pnpm tsc -p lib/api-zod/tsconfig.json && pnpm tsc -p lib/api-client-react/tsconfig.json && pnpm --filter @workspace/redact run build && (pnpm --filter @workspace/api-server run typecheck 2>&1 | grep -E 'redact|has not been built' && echo 'FAIL: redact errors remain' && exit 1 || echo 'PASS: no redact errors')"
```

Read the trailing pipeline carefully:

```
pnpm --filter @workspace/api-server run typecheck 2>&1 \
  | grep -E 'redact|has not been built' \
  && echo 'FAIL: redact errors remain' && exit 1 \
  || echo 'PASS: no redact errors'
```

`grep` exits 0 only if it matches at least one line. The `&& exit 1` branch
fires only when at least one error line contains `redact` or
`has not been built`. **Every other type error is discarded** — the
`grep`-then-`||` construct turns a failed-but-non-redact typecheck into a
"PASS" line and exit 0. The workflow also never invokes `pnpm typecheck` or
typechecks `overhype-me` or `scripts` at all.

#### Concrete demonstration (cold typecheck, current `main`):

```
$ rm -rf lib/*/dist
$ pnpm typecheck
...
error TS2688: Cannot find type definition file for 'node'.
lib/integrations-anthropic-ai/src/batch/utils.ts(78,30): error TS2339:
  Property 'AbortError' does not exist on type ...
lib/integrations-anthropic-ai/src/batch/utils.ts(118,32): error TS2339: ...
ELIFECYCLE  Command failed with exit code 2.
```

Three real type errors live on `main` right now. None of them mentions
`redact` or `has not been built`, so the `.replit` `typecheck` workflow
prints `PASS: no redact errors` and exits 0. **There is no automated gate
that catches general type errors.**

### 4b. Gap (b): per-artifact typecheck does not refresh lib `dist/`

Per-artifact scripts (verbatim):

```
artifacts/api-server/package.json:
  "typecheck": "tsc -p tsconfig.json --noEmit"

artifacts/overhype-me/package.json:
  "typecheck": "tsc -p tsconfig.json --noEmit"

artifacts/mockup-sandbox/package.json:
  "typecheck": "tsc -p tsconfig.json --noEmit"

scripts/package.json:
  "typecheck": "tsc -p tsconfig.json --noEmit"

lib/redact/package.json:
  "typecheck": "tsc -p tsconfig.json --noEmit"
```

Root scripts (verbatim):

```
package.json:
  "typecheck:libs": "tsc --build",
  "typecheck": "pnpm run typecheck:libs && pnpm -r --filter \"./artifacts/**\" --filter \"./scripts\" --if-present run typecheck"
```

Only the **root** `typecheck` runs `tsc --build` (which rebuilds every
referenced lib's `dist/`/`.tsbuildinfo`) before invoking the per-package
typechecks. A direct invocation like
`pnpm --filter @workspace/api-server run typecheck` skips the lib build
entirely and reads whatever stale `dist/`/`.tsbuildinfo` happens to exist on
disk.

#### Why this is the Task #148 mechanism

Even though `lib/api-zod/package.json` exports source `.ts` files, the
artifact's tsconfig declares `references: [{ path: "../../lib/api-zod" }]`.
With project references, `tsc -p tsconfig.json --noEmit` will not re-check
the referenced project's source — it expects a previously built
`.tsbuildinfo` and trusts the emitted `.d.ts` in `lib/api-zod/dist/`. So:

1. Developer modifies `lib/api-zod/src/foo.ts`, changing a type contract.
2. Developer (or `.replit` `typecheck` workflow) runs
   `pnpm --filter @workspace/api-server run typecheck`.
3. `tsc` consults `lib/api-zod/dist/foo.d.ts` — the *old* one, because no
   `tsc --build` has been run since the source change.
4. The artifact reports green even though the lib's actual current source
   would surface a real type error. That is exactly the Task #148 footprint.

The pre-existing `prepare` hook only fires on `pnpm install`; subsequent edits
do not invalidate the dist artifacts that `prepare` produced. `tsc --build`
does perform up-to-date checking via `.tsbuildinfo`, but the per-artifact
script never invokes it.

---

## 5. Build graph, timings, and runtime/deploy behaviour

### 5.1 Build graph triggered by `pnpm install`

```
package.json:
  "prepare": "pnpm --filter './lib/**' --if-present run build"
```

Of the libs, only `lib/redact` defines a `build` script, so `prepare` only
builds `lib/redact/dist`. **Every other lib's `dist/` is *not* produced by
`pnpm install`.** It only appears on disk after one of:

- `pnpm typecheck:libs` (`tsc --build`, walks the root references graph),
- `pnpm typecheck` (which runs `typecheck:libs` first),
- `scripts/post-merge.sh` (explicit `pnpm tsc -p lib/api-zod/tsconfig.json`,
  `pnpm tsc -p lib/api-client-react/tsconfig.json`, then `pnpm --filter
  './lib/**' --if-present run build`),
- an artifact's `tsc --build` invocation that walks into the lib via
  `references`.

This is what the §1e table's "currently on disk" column reflects: in this
container the libs have a `dist/` *because* a prior typecheck has run, not
because `pnpm install` produced it.

### 5.2 Timings (current state, this container)

```
$ pnpm install --prefer-offline       # warm install + prepare
... Done in 6.2s   (Elapsed: 6s)

$ rm -rf lib/*/dist
$ pnpm typecheck                       # cold (libs rebuilt)
... 9s

$ pnpm typecheck                       # incremental (no source changes)
... 3s
```

Cold typecheck is dominated by `tsc --build` re-emitting every lib's `.d.ts`.
Incremental is fast because `.tsbuildinfo` shortcuts the recheck.

### 5.3 Deploy

`.replit`:

```
[deployment]
router = "application"
deploymentTarget = "autoscale"

[deployment.postBuild]
args = ["pnpm", "store", "prune"]
env = { "CI" = "true" }
```

Deploy runs `pnpm install` (per the autoscale build pipeline) which fires
`prepare` → builds `redact`. It does **not** run `pnpm typecheck` or
`pnpm build`. The api-server's runtime entry is `node ./dist/index.mjs`,
produced by `artifacts/api-server/build.mjs` (esbuild bundle of
`src/index.ts`); that bundle does not depend on `lib/*/dist/` at runtime —
esbuild reads source `.ts` via the `workspace` export condition for every
lib except `redact`, and `redact`'s runtime fallback is `./dist/index.js`
which `prepare` will have built.

Net: deploy itself is safe even with stale lib `dist/`, because it
re-`pnpm install`s and re-bundles from source. The blast radius of stale
lib `dist/` is **type-checking**, not runtime.

### 5.4 `scripts/post-merge.sh`

```
#!/bin/bash
set -e
pnpm install --frozen-lockfile
pnpm --filter @workspace/api-spec run codegen
pnpm tsc -p lib/api-zod/tsconfig.json
pnpm tsc -p lib/api-client-react/tsconfig.json
pnpm --filter './lib/**' --if-present run build
pnpm --filter @workspace/db run migrate
pnpm --filter @workspace/scripts run seed
```

After every merge the post-merge hook explicitly rebuilds `api-zod`,
`api-client-react`, and `redact` dist outputs, but it does **not** rebuild
`db`, `integrations-anthropic-ai`, `integrations-openai-ai-server`, or
`replit-auth-web` `dist/`. Mid-session lib edits between merges remain
uncovered by post-merge.

### 5.5 Developer experience

A fresh clone runs `pnpm install`, which fires `prepare` and produces
`lib/redact/dist`. tsserver in the editor resolves all other libs via the
`"workspace"` export condition straight to source `.ts`, so
"go to definition" and inline diagnostics work without any extra
`tsc --build` step. No additional manual setup is required to get working
intellisense.

---

## 6. Proposed Phase 2 (scoped to the two real gaps)

> **Do not perform a mass `git rm --cached` of `dist/` directories.** §1
> proves there is nothing committed to remove. The only work that fixes
> Task #148-class drift is closing gaps (a) and (b) from §4.

### 6.1 Close gap (b): make every artifact's `typecheck` rebuild lib references first

**Recommended approach: chain `pnpm run typecheck:libs` (root `tsc --build`)
before each artifact's local `tsc -p ... --noEmit`.** That is:

```jsonc
// artifacts/api-server/package.json (and overhype-me, mockup-sandbox, scripts)
"typecheck": "pnpm -w run typecheck:libs && tsc -p tsconfig.json --noEmit"
```

This chain:

1. Invokes the root `typecheck:libs` script (`tsc --build`), which walks the
   root `tsconfig.json` references graph and incrementally re-emits any lib
   whose source is newer than its `.tsbuildinfo`. Because libs use
   `composite: true` and `emitDeclarationOnly: true`, this is the supported
   path for refreshing their `.d.ts`.
2. Then runs the per-artifact `tsc -p tsconfig.json --noEmit` against the
   freshly emitted `.d.ts`.
3. Stays incremental — the second cold call from §5.2 (3 s) is the
   `.tsbuildinfo`-cached path.

#### Why not `tsc --build --noEmit` directly?

It is tempting to write `"typecheck": "tsc --build --noEmit"` against the
artifact's own tsconfig (which already lists its lib `references`). That
**does not work in this repo**: the artifact tsconfigs themselves have no
`composite: true` (and shouldn't — they are leaves, not referenced
projects). When `tsc --build` enters via the leaf and `--noEmit` is set on
the referenced composite projects, TS reports `TS6310: Referenced project
... may not disable emit`. The chain above sidesteps the problem by letting
`typecheck:libs` invoke `tsc --build` *without* `--noEmit` (so libs emit
their `.d.ts` as designed), and then doing the artifact's own check with a
plain `tsc -p ... --noEmit` (no `--build`, no project-reference traversal).

Trade-offs vs. alternatives:

| Option | Pros | Cons |
| ------ | ---- | ---- |
| **A. `pnpm -w run typecheck:libs && tsc -p tsconfig.json --noEmit`** (recommended) | Reuses the existing root script that's already proven to work; small, two-line script change per artifact; no TS6310 hazard; libs emit `.d.ts` as the composite contract requires. | Always rebuilds *all* libs in the references graph, even if a single artifact only consumes a subset (negligible: cold ~6 s, warm <1 s). |
| B. `tsc --build --noEmit` against the artifact tsconfig | Single command, no shell chaining. | Triggers `TS6310: Referenced project may not disable emit` because the lib composite projects need to emit. Not viable. |
| C. Add a per-artifact `tsconfig.build.json` that owns the `references`, mark each artifact `composite: true`, then `tsc --build` | Lets each artifact carry its own incremental cache. | Significant refactor of every artifact tsconfig; introduces composite mode on leaves that don't need it; out of scope. |
| D. Drop project references and rely on `customConditions: ["workspace"]` for all libs (including aligning `redact` to match) | Removes `dist/` from the type graph entirely. | Larger refactor; loses incremental-build cache benefits; changes how `redact` is consumed at runtime; out of scope. |

Recommend (A) — the smallest change that closes gap (b) without any
TS6310 hazard, no new tsconfigs, and reusing scripts that already exist.

### 6.2 Close gap (a): replace the `.replit` `typecheck` workflow command with the unfiltered root typecheck

Replace:

```
args = "pnpm --filter @workspace/api-spec run codegen && pnpm tsc -p lib/api-zod/tsconfig.json && pnpm tsc -p lib/api-client-react/tsconfig.json && pnpm --filter @workspace/redact run build && (pnpm --filter @workspace/api-server run typecheck 2>&1 | grep -E 'redact|has not been built' && echo 'FAIL: redact errors remain' && exit 1 || echo 'PASS: no redact errors')"
```

with something like:

```
args = "pnpm --filter @workspace/api-spec run codegen && pnpm typecheck"
```

The codegen step still has to run before typecheck because
`lib/api-zod/src/generated` and `lib/api-client-react/src/generated` are
emitted by orval at install/codegen time. After 6.1 lands, `pnpm typecheck`
already rebuilds every lib's `dist/` via `typecheck:libs` and then runs
each artifact's typecheck — no per-lib `pnpm tsc -p ...` shims required, no
`grep` filter, all errors gate.

### 6.3 Optional: deploy-time guard

If autoscale's build pipeline supports an extra command between `pnpm
install` and `postBuild`, add `pnpm typecheck` there. As §5.3 shows, deploy
is currently runtime-safe regardless of type errors, but a deploy-time
typecheck would prevent shipping code that doesn't compile in
non-bundled-runtime contexts (e.g., `scripts/`).

### 6.4 Explicitly NOT in Phase 2

- No `git rm --cached` of any `dist/` directory (nothing tracked).
- No `.gitignore` change (`dist`, `*.tsbuildinfo`, `out-tsc` already listed).
- No change to lib `package.json` `exports` shape, no removal of project
  references, no migration to a different build orchestrator.

---

## 7. Risks and unknowns

1. **Cold artifact typecheck slows down.** With option 6.1.A, a fresh
   `pnpm --filter @workspace/api-server run typecheck` will pay the lib
   rebuild cost up front (~6 s extra in this container). Incremental runs
   stay fast (~3 s) because `.tsbuildinfo` is cached on disk. Acceptable.

2. **`prepare` hook side effects.** `prepare` only builds `redact` today.
   After 6.1 every artifact typecheck also rebuilds the rest. That is the
   intended fix, but anyone scripting against current `dist/` contents
   (e.g., custom dev tooling that imports `lib/api-zod/dist/index.js`)
   would now see those files exist where they previously didn't —
   double-check `artifacts/api-server/build.mjs` externals before merging
   6.2. (Quick read: build.mjs externals are runtime-package names, not
   lib `dist/` paths, so this is most likely a non-issue.)

3. **`tsc --build` behaviour when source and dist disagree.** If a previous
   crashed build leaves a partial `dist/` and a stale `.tsbuildinfo`, `tsc
   --build` may incorrectly consider the project up-to-date. Mitigation:
   document `rm -rf lib/*/dist lib/**/*.tsbuildinfo` as the recovery
   command, and consider having `scripts/post-merge.sh` delete stale
   `.tsbuildinfo` before rebuilding.

4. **Pre-existing type errors will surface.** §4a's cold typecheck output
   already shows 3 unrelated errors on `main` (`Cannot find type definition
   file for 'node'`, two `AbortError` errors in
   `lib/integrations-anthropic-ai`). Once gap (a) is closed those errors
   gate the workflow and must be fixed before 6.2 ships. They are out of
   scope for Phase 2 itself but are an implicit prerequisite — flag them
   when scheduling the work.

5. **`grep`-filtered workflow exists for a reason.** The current filter was
   presumably introduced because some lib's `dist/` was chronically out of
   sync. Once 6.1 makes per-artifact typecheck self-rebuilding, the filter
   becomes both redundant and dangerous; removing it in 6.2 should be done
   in the same change as 6.1 to avoid a window where the filter hides
   legitimate failures from the new flow.

6. **`mockup-sandbox` and `scripts` were not in the §4a CI workflow at
   all.** They will start being checked once 6.2 invokes the root `pnpm
   typecheck`. Expect first-run errors there as well.
