# The Repl needs `pnpm install` after syncing a merge that added dependencies

**Symptom.** Post-merge verification in the Repl fails on a script that worked
fine locally and in CI:

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'unified' imported from
/home/runner/workspace/artifacts/overhype-me/scripts/generate-help-content.ts
```

**Cause.** The GitHub → Repl sync updates the **working tree**, including
`package.json` and `pnpm-lock.yaml`. It does **not** run an install, so
`node_modules` still reflects the pre-merge lockfile. Any script that imports a
newly added package fails immediately — and the failure looks exactly like a
genuine code defect if you only read the error.

**Fix.** After a sync that follows a dependency-adding merge, run
`pnpm install --frozen-lockfile` through the connector before drawing any
conclusion from a failing check, then re-run the check. On PR #472 this
installed 78 packages and turned the failing gate straight to
`generate:help --check: up to date (16 files)`.

**Diagnose before installing, though.** Two things are worth checking first,
because they change how you report it:

1. **Is the missing package a `dependency` or a `devDependency`?** If it's a
   devDependency used only by a build-time script, the *running app was never
   affected* — the failure is confined to the check. Say that explicitly rather
   than letting a red check imply the app is broken.
2. **Is the failing script on the app's run path?** Grep the workspace's
   `package.json` scripts. If `dev` and `build` don't invoke it, the blast
   radius is the check alone.

**Related:** [`replit-environment.md`](../../docs/ai-context/replit-environment.md)
for how sync and publish actually work, and `CLAUDE.md`'s close-out contract for
where post-merge verification sits in the sequence.
