---
name: A stale lib/db/dist can make tsc show phantom or contradictory schema errors after a merge
description: lib/db uses TypeScript project references, and its gitignored dist/ output isn't rebuilt by `git merge` — a merge that adds schema exports can leave tsc reporting "no exported member" for exports that visibly exist in source, or "not built from source" errors, until dist is rebuilt.
---

# `lib/db/dist` doesn't rebuild itself when a merge changes the schema

`lib/db`'s package.json exports `./schema` as `./src/schema/index.ts`, but
`lib/db` is consumed via TypeScript **project references** (`tsc -b`), which
resolve through the package's compiled `dist/` output, not directly through
`src/`. `dist/` is gitignored — correctly, it's a build artifact — but that
means `git merge` never touches it. A branch that merges in schema changes
(new tables, new exports in `schema/index.ts`) can leave its **local** `dist/`
sitting at the pre-merge build.

**Concretely (PR #287):** merging `origin/main`'s work into a long-running
feature branch brought in a new `workerLaneHeartbeats` schema module, added to
`schema/index.ts`'s barrel exports. `npx tsc --noEmit -p artifacts/api-server`
then failed with `TS2305: Module '"@workspace/db/schema"' has no exported
member 'workerLaneHeartbeatsTable'` — even though the export was plainly
present in `lib/db/src/schema/index.ts` on disk. Deleting `lib/db/dist`
outright made it *worse*, not better: every consumer then failed with
`TS6305: Output file '.../lib/db/dist/index.d.ts' has not been built from
source file '.../lib/db/src/index.ts'` — a project reference with no dist to
point at is a harder failure than a stale one.

**Fix:** `npx tsc -b lib/db --force` (a normal `tsc -b lib/db` was a silent
no-op here — force was required to get it to actually rebuild). Do this any
time a merge touches `lib/db/src/schema/` or `lib/db/src/index.ts` and
`tsc --noEmit` on a consuming package reports an export that's visibly present
in source — check `git log -1 -- lib/db/src/schema/index.ts` against
`ls -la lib/db/dist` before assuming the export is actually missing.
