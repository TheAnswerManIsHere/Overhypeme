# `check-docs-accuracy` only validates repo-root-prefixed paths — shorthand is unchecked *and* allowed

**The mechanic.** `scripts/check-docs-accuracy.mjs` treats a backticked token as
a repo path only when it starts with a known top-level directory:

```js
const TOP_LEVEL = /^(docs|lib|artifacts|scripts|cloudflare|\.agents|\.claude|\.github)\//;
```

Anything else is **skipped, not flagged**. So `` `src/components/admin/helpMap.ts` ``
— a path that exists under no repo root — passes silently, while
`` `artifacts/overhype-me/src/components/admin/helpMap.ts` `` is verified.

**A green `check:docs` therefore does not mean every cited path resolves.** It
means every *prefixed* cited path resolves. Know which claim you're relying on.

## The important half: shorthand is the house convention, not a bug

Do **not** conclude from the above that unprefixed citations are errors to be
hunted. Measured on 2026-08-16: **46 shorthand citations across 13 docs**
(`meme-and-video-studio.md`, `community-and-engagement.md`,
`public-site-and-sharing.md`, `accounts-and-auth.md`, `visual-pipeline.md`,
`known-failure-patterns.md`, `decisions.md` and others). Every one points at a
file that really exists — they are real paths with the workspace prefix
omitted, not dangling references.

That's deliberate practice, and it reads better: in a doc entirely about the
frontend auth pages, `` `pages/Login.tsx` `` is unambiguous, while
`` `artifacts/overhype-me/src/pages/Login.tsx` `` is thirty characters of noise
in the middle of a sentence.

**An earlier version of this note said "in a monorepo, always cite from the
repo root."** That was wrong — I generalized it from a single inconsistent
table without checking whether the repo agreed. It doesn't. Correcting it here
because that sentence would have pushed the next agent into a 46-file rewrite
of a convention nobody asked to change.

## What actually goes wrong, and the real guidance

The incident behind this note (PR #475) was **not** shorthand. It was
**inconsistency inside one table**: two rows repo-root-qualified, three rows
shorthand, in the same five-row table. That's what made those three read and
behave as broken.

So:

1. **Be consistent within a doc, and especially within a table or list.** Mixed
   styles side by side are what mislead.
2. **Prefer the repo-root form when the file is outside the doc's obvious
   workspace**, or when the doc spans several workspaces — that's where
   shorthand genuinely stops resolving in a reader's head, not just in `cat`.
3. **Use the repo-root form when you want the checker to actually verify it.**
   Shorthand is unverified by construction; that's the trade for readability.

## A gate for this was built and rejected — don't rebuild it

A narrow check was implemented (flag an unprefixed token only when it's a
suffix of a file that really exists, so the noise floor is near zero and the
error can name the correct path). It worked. **David declined it** once the 46
existing findings showed it was a house-style change across 13 docs rather than
a bug sweep — the blast radius (a reader re-derives a path in seconds) doesn't
justify 46 edits plus permanent verbosity plus an ongoing constraint on every
future doc author.

Recorded so this isn't rediscovered and re-proposed. See #479, closed as
accepted-and-documented, for the full reasoning and the rejected
implementation.
