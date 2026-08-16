# `github-slugger` IS GitHub's anchor algorithm — never hand-roll a slug regex

**Symptom.** A link checker, anchor validator or search index reports broken
`#fragment` links that are demonstrably fine when you click them on GitHub. Or
the reverse: a guard rejects a link the generator legitimately produced.

**Cause.** A hand-written slugifier that looks obviously correct and isn't. The
canonical near-miss is stripping punctuation with something like
`[^a-z0-9 \-]` — which removes **underscores**. GitHub's algorithm *keeps*
them, so every heading containing an identifier (`parent_id`, `created_at`)
gets a different anchor than you computed, and every link to one is reported
broken.

This cost real time on PR #472: a sweep of the Manual reported broken fragment
links into `decisions.md`, and the links were fine — my regex was wrong. After
switching to the real slugger: 222 fragment links, **0 broken**.

**Fix.** Use the `github-slugger` package. It is not an approximation of
GitHub's algorithm, it *is* the algorithm, including its dedupe counter for
repeated headings (`foo`, `foo-1`, …) — which is why you must run it over a
document's headings **in document order** rather than slugging one heading in
isolation.

**Do not try to enumerate its output alphabet either.** Measured on PR #472:

- `[\p{L}\p{N}]` excludes **1164** characters the slugger really emits
  (all combining marks).
- Adding `\p{M}` still excludes **61** more (connector punctuation `‿ ⁀ ⁔`,
  enclosed alphanumerics `Ⓐ Ⓑ`…).

It also *strips* things you might assume survive — emoji, quotes, backslashes,
`<`, `>`, `;`, `%`, `.` — so `emoji 🎉 heading` becomes `emoji--heading`, not
`emoji-🎉-heading`.

If you need to validate a slug, either run it through the slugger and compare,
or don't pattern-match it at all: percent-encode it where a URL needs it and
decode on the way back. Anything else is a guess, and every guess so far has
been wrong.

**Where this bites.** `artifacts/overhype-me/scripts/generate-help-content.ts`
(anchor collection, fragment validation, search-index attribution) and
`artifacts/overhype-me/src/components/admin/helpLinkGuard.ts` (which now
validates only the ASCII *path* and leaves the fragment to percent-encoding for
exactly this reason).
