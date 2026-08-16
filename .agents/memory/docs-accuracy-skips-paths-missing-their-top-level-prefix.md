# `check-docs-accuracy` silently skips a path missing its top-level prefix

**Symptom.** A doc cites `src/components/admin/helpMap.ts`. No such file exists
— the real path is `artifacts/overhype-me/src/components/admin/helpMap.ts` —
and `pnpm run check:docs` passes anyway. A human reviewer following the link
hits nothing.

**Cause.** `scripts/check-docs-accuracy.mjs` only *considers* a token a repo
path when it matches:

```js
const TOP_LEVEL = /^(docs|lib|artifacts|scripts|cloudflare|\.agents|\.claude|\.github)\//;
```

Anything not starting with a known top-level directory is skipped — not
flagged, **skipped**. So the check is blind in exactly the direction that
matters: a path is wrong *because* it omits its prefix, and omitting the prefix
is what makes the checker ignore it. Correct paths get validated; this specific
class of incorrect path is invisible.

The guard is doing what it was written to do (it can't validate every
slash-containing token in prose without drowning in false positives), but the
consequence is worth knowing before trusting a green `check:docs` as "every
cited path is real."

**What actually catches it.** Human or bot review. On PR #475 Codex caught
three such rows in one table while `check:docs` reported clean across 141
files — in the same run where it *did* catch a malformed `scripts/...` path,
because that one started with a known prefix.

**When writing docs.** In a monorepo, always cite from the **repo root**.
`artifacts/overhype-me/src/...`, never `src/...` — even inside a section that's
obviously about the frontend workspace, because the checker's coverage depends
on that prefix and so does anyone running `cat` on it.

**Improving the checker** is a real option (e.g. flag a token that looks like a
path, contains a known source extension, and resolves under no workspace root)
and would need to be weighed against false-positive noise. Logged as a
follow-up rather than fixed inside a `/document` run, which is docs-only by
contract.
