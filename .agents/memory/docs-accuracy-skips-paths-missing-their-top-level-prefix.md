# Path citation: two deliberate conventions, and what the docs-accuracy gate actually covers

## The mechanic

`scripts/check-docs-accuracy.mjs` treats a backticked token as a repo path only
when it starts with a known top-level directory:

```js
const TOP_LEVEL = /^(docs|lib|artifacts|scripts|cloudflare|\.agents|\.claude|\.github)\//;
```

Anything else is **skipped, not flagged**.

**And the path check runs on the "library" only** — `docs/ai-context`,
`docs/engineering`, `docs/manual`, `AGENTS.md`, `.agents/PLANS.md`. Not
`docs/tests`, not `CLAUDE.md` (link-checked only, deliberately), and **not
`.agents/memory/`** — so the citations in this very note are unverified.

So the precise claim is: **a green `check:docs` means every prefixed path *in
the path-checked library* resolves.** Not every prefixed path, and certainly
not every path. Don't over-read it.

## Two conventions, both deliberate — don't flatten them

**`docs/ai-context/` and `docs/engineering/`: shorthand is fine.** Measured
2026-08-16, 46 shorthand citations across 13 docs, every one pointing at a file
that really exists. In a doc entirely about frontend auth pages,
`` `pages/Login.tsx` `` is unambiguous and reads better than thirty characters
of prefix mid-sentence. Not sloppiness — practice.

**`docs/manual/` chapters: root-relative is REQUIRED**, by the manual's own
charter (see its README's *Citing code in a chapter*), for exactly the reason
above — bare filenames are skipped by the checker, so a chapter could keep a
confidently wrong reference under green CI. The charter already knew about this
blind spot and handled it for chapters.

An earlier version of this note said "in a monorepo, always cite from the repo
root," full stop. That was right for `docs/manual/` and wrong for
`docs/ai-context/`, and stated as a blanket rule it would have driven a 46-file
rewrite of a convention nobody asked to change.

## The real guidance

1. **Writing a manual chapter → root-relative, always.** Non-negotiable, per
   the charter.
2. **Writing ai-context / engineering docs → shorthand is fine**, and often
   better.
3. **Consistency applies to adjacent paths from the SAME workspace**, not
   across a whole doc or list. Mixed lists are correct and common: see
   `accounts-and-auth.md`'s file inventory, which fully qualifies
   `artifacts/api-server/…` and `lib/db/…` and then lists the frontend files as
   bare `pages/…`. That's rule 4 working, not an inconsistency to fix.
4. **Qualify anything outside the doc's obvious workspace.** A doc about the
   frontend can say `pages/Login.tsx`; the moment it references the API server
   or a shared lib, that reference gets its prefix.
5. **Qualify when you want the checker to verify it.** Shorthand is unverified
   by construction — that's the trade for readability, and it's a fine trade
   for a path a reader can place from context.

**The failure this note exists for** was none of the above: PR #475 had a
five-row table with *two* frontend-workspace paths qualified and *three*
shorthand — same workspace, same table, adjacent rows. That's rule 3, and it's
what made those three read and behave as broken.

## A gate for this was built and rejected — don't rebuild it

A narrow check was implemented (flag an unprefixed token only when it's a
suffix of a file that really exists — near-zero noise, and the error names the
correct path). It worked. **David declined it** once the 46 findings showed it
would impose root-relative style on `docs/ai-context/`, where shorthand is
deliberate: the blast radius (a reader re-derives a path in seconds) doesn't
carry 46 edits plus permanent verbosity plus an ongoing constraint.

Recorded so it isn't rediscovered and re-proposed. Full reasoning and the
rejected implementation: issue #479, closed as accepted-and-documented.
