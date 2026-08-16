# Editing `docs/manual/` requires regenerating the in-app help content

**The gotcha.** `docs/manual/` stopped being purely human-facing prose when PR
#472 shipped the in-app help system. Chapters are now a **build input**: they
are rendered at `/admin/help` from generated modules under
`artifacts/overhype-me/src/generated/help/`, and `check:help-content` fails the
Build job whenever those modules drift from their source.

So a **docs-only** PR that edits one chapter and touches nothing else will
still go red. That is the surprising part — the change looks like prose, the
failure looks like a build problem, and nothing in the editing experience hints
that a generator is involved.

**The fix, in the same commit as the chapter edit:**

```
pnpm --filter @workspace/overhype-me run generate:help
```

Expect exactly **two** files to change per edited chapter: that chapter's
content module and `searchIndex.ts`. A wider diff means something else moved
too — check before committing rather than assuming the generator is noisy.

**`README.md` counts as a manual file.** Editing the charter regenerates
`content/_index.ts`, not a chapter module — so "I only touched the README, not a
chapter" is not an exemption. Verified the hard way: the first fix for this
gotcha edited the README to document it, and that edit failed the same check.

**In a fresh container, the generator may not run at first.** It imports
`unified` and the remark/mdast chain, which are declared dependencies of
`@workspace/overhype-me` but may postdate the container image, giving
`ERR_MODULE_NOT_FOUND: Cannot find package 'unified'`. That is a stale install,
not a missing dependency — `pnpm install --filter @workspace/overhype-me...`
fixes it and leaves the lockfile untouched. Don't "fix" it by adding the
package.

**Why this bites agents specifically.** A `/document` harvest routes a learning
into a manual chapter as its final step, which is precisely when the session is
winding down and least likely to expect a build failure. It also means the
local docs guards passing (`check-docs-accuracy`, `check-manual-tuning-language`)
is *not* sufficient evidence a manual edit is ready — neither of them knows
about the generated modules.

**Reference:** hit on PR #477 (the `/document` harvest for PR #474); the rule is
also recorded in [`docs/manual/README.md`](../../docs/manual/README.md), which is
where someone editing a chapter is most likely to look.
