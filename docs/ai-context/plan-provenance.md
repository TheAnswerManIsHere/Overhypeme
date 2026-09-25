<!-- SYNCED FROM AI-Handbook — do not edit in a consumer repo. Local edits are overwritten by the next sync and their reasoning is lost; change the handbook instead. -->
# Plan provenance: the declared block

**This file is the wire format.** Every producer that tells an author what to
write, and the one parser that reads it, are written from this page. Nothing
else restates the key sets or the grammars — a second statement of a format is
a second source of truth, and the two drift.

Approved-plan source: Plan-review PR #43, final plan commit `fa59cce`, approved
by David on 2026-09-07.

## Why a block and not a sentence

The generator used to recognise provenance by matching phrases in free-form
Markdown. Across #38's fourteen review rounds that matching produced roughly
twenty of fifty-five findings, each one a Markdown topology the previous round
had not masked: a fenced example, indented code, a blockquote, a heading whose
section held a sample, and finally ordinary prose carrying the label ahead of
the real declaration. The trend never declined, and the judge named the shape
at two separate gates — **the class does not converge by review rounds**,
because the ways a provenance-shaped string can appear in prose without being
the declaration are open-ended.

A fenced block with a dedicated info string ends that. Every prose matcher in
the generator masks fenced regions *out*, so the declaration lives exactly
where prose cannot be mistaken for it.

## The block

The info string is exactly `plan-provenance`. Not `yaml`: a `yaml` block is
ordinary content in a PR body, and a sentinel must not be.

````markdown
```plan-provenance
kind: approved-plan
plan_review_pr: 37
plan_commit: 972b60d
plan_file: docs/plans/PLAN_FABLE_REVIEW_FOUNDATIONS.md
approved_by: David
approved_on: 2026-09-06
```
````

## Kinds and their keys

Every key not required for a kind is **forbidden** for that kind. There are no
optional keys, so present-or-absent is never ambiguous.

| `kind` | Required keys |
|---|---|
| `approved-plan` | `plan_review_pr`, `plan_commit`, `plan_file`, `approved_by`, `approved_on` |
| `approved-plan-split` | `plan_review_prs`, `combined_plan_commit`, `combined_branch`, `plan_file`, `approved_by`, `approved_on` |
| `private-plan` | `plan_filename`, `plan_sha256`, `approved_by`, `approved_on` |
| `bugfix` | `fix_tier` |
| `trivial` | *(none)* |
| `plan-review` | *(none)* |

**Which plan kind applies, since the plan loop changed transport (David,
2026-09-09).** A plan reviewed **in-session** is never committed and never
pushed, so it declares **`private-plan`** — the kind's keys already describe
exactly that (a filename, a digest, and who approved it when), and it is now
the ordinary case rather than the confidentiality carve-out it was named for.
**`approved-plan` and `approved-plan-split` both require a plan-review PR**,
which the in-session loop does not produce; they stay in the format because
they are still the correct declaration for the PRs that used them, and nothing
about validating an existing body changes. Neither is emitted by a new loop.

## Value grammars

| Key | Grammar |
|---|---|
| `plan_review_pr` | a positive integer, written without `#` |
| `plan_review_prs` | two or more positive integers, comma-separated |
| `plan_commit`, `combined_plan_commit` | 7–40 lowercase hexadecimal characters |
| `combined_branch` | `plan-review/`, then a slug of 1–100 characters from `[A-Za-z0-9._-]`, then `-combined`. The slug may not be empty, may not begin or end with `.`, `_` or `-`, and may not contain two adjacent separators. |
| `plan_file` | a repository-relative path matching `docs/plans/PLAN_[A-Z0-9_]{1,100}\.md` |
| `plan_filename` | a bare filename matching `PLAN_[A-Z0-9_]{1,100}\.md`, no path separators — a `private-plan` was never committed, so it has a name and no repository path |
| `plan_sha256` | exactly 64 lowercase hexadecimal characters |
| `approved_by` | exactly `David` |
| `approved_on` | `YYYY-MM-DD` |
| `fix_tier` | one of `A`, `B`, `C` |

## Syntax

One `key: value` per line, surrounding whitespace trimmed, blank lines ignored.
`kind` comes first. No comments, no nesting, no quoting, no multi-line values,
no repeated keys.

A repeated key, an unknown key, a missing required key, a forbidden key, or a
value failing its grammar **refuses, naming the key**. Two blocks in one body
refuse as a contradiction — first-wins is the precise defect this replaces, in
which a sample declaration ahead of the real one silently became the oracle.

A present-but-malformed declaration refuses and **never falls through to the
prose path**. Fall-through would let a typo silently re-enter the class the
block closes, which is the one failure that would make the whole thing
worthless.

## What the block replaces, and what it does not

The block replaces the *selector* — the sentence or phrase that used to say
which oracle governs the PR. It does not replace *oracle prose*, which is what
a reviewer reads. A body carrying both a block and the legacy selector **for
that same kind** refuses: two statements of one fact drift, and nobody can tell
which is authoritative.

| Kind | Legacy selector it replaces | Prose that stays |
|---|---|---|
| `approved-plan`, `approved-plan-split`, `private-plan`, `trivial` | the `Approved-plan source` line | the plan's quoted Product Intent / Must Not Change / Settled Decisions |
| `bugfix` | the `Fix tier:` line | every other tier field — and the tier's reason, now its own `**Tier rationale:**` field for tiers A, B and C |
| `plan-review` | the phrase `Plan review only` | the rest of the `## Review mode` section — never merge, do not implement, apply the plan-review contract |

The refusal is **scoped to the declared kind's own selector**. A documentation
PR that declares an approved plan and whose live prose begins a line with
`**Fix tier:**` is describing the format, not claiming a tier.

`kind: plan-review` must agree with a `[PLAN REVIEW]` title, and disagreement
in either direction refuses. That is a safety property, not a formatting one:
without it an ordinary PR can declare itself a plan-review loop and take the
*mutable head plan* as its oracle.

## Where the block is read from

Only from live text — the author's own assertion. A block inside a fenced
example, a blockquote, an indented code block or an **HTML comment** is quoted,
not claimed, and the parser does not see it.

HTML comments are inert on the prose path too (David, 2026-09-07). A PR-template
placeholder *is* an HTML comment, and those placeholders carry the very strings
the generator scans for — a template's own note under `**Fix tier:**` spells out
"A or B". A body nobody filled in could otherwise be read as one that answered.

## The record's discriminator is gone, and so is the shortcut it offered

The adjudication record used to carry `planOracle.declaredBy`, either
`"declaration"` or `"prose"`, as sampled diagnostics on how many PR bodies had
migrated. The record generator was removed in the #89 cut, so the field no
longer exists.

It was never migration proof anyway, and the reasoning outlives it: a record
existed only where a judge was dispatched, and a clean or all-declined round
ended with no dispatch, so an absence of prose-selected records observed only
the PRs that reached adjudication. **Removing the prose fallback needs an
exhaustive pass over PR bodies**, which is what it needed then too.

**Nothing reads a PR body's block at runtime now.** The parser lives at
`core/scripts/plan-provenance.mjs` and its only caller is the producer-drift
test, which checks that this document and the skills that teach the format
still agree with it. The block is still contract — `claude-core.md` PR rule 4
requires one — so what changed is that a malformed block is caught by a person
reading the PR rather than by a generator refusing.

## Enabling this in a consuming repository

The parser refuses a body whose producers still emit a legacy selector. That
used to need sequencing — the producer documents had to reach a consumer before
the parser did — and a gate script enforced it. **Both are gone, and the
ordering hazard with them:** the payload now syncs whole, so the parser and the
documents that teach the form it accepts always arrive in the same copy.

What still needs care is the part no sync controls. Each consuming repository
owns its own `.github/pull_request_template.md`, which is outside this
repository, so no search run here can prove the producer inventory is
exhaustive. If a consumer's own template emits a legacy selector, its PR bodies
are refused until that template is updated — check it at enrollment, because
nothing here can check it for you.
