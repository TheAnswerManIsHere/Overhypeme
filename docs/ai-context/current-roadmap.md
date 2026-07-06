# Current Roadmap

> Short and current — near-term context, not a speculative roadmap. Keep it
> trimmed; when a slice ships, move it up to "recently merged." No invented
> deadlines. Items not verifiable from the repo are marked **Needs David
> confirmation**.
>
> *Snapshot date: 2026-07-04 (around PR #179/#180).*

## Active area of focus

The **moderation + visual-render pipeline**: making moderation faster and the
rendered memes better, plus maturing the video pipeline. This maps to the current
business goals (launch/stability + content volume & quality) and near-term
priorities (moderation speed, render/enrichment quality, video). See
[`product-direction.md`](./product-direction.md).

## Recently merged or completed work

(From recent history — read `git log` for the live picture.)

- **Three-step moderation (Visual Concept gate)** — split the bundled visual-review
  step into an explicit **Visual Concept** gate (`concept_review`) before any render
  spend, then **Test Renders** (`production_review`); renders force-fire on gag
  approval (PR #179). See [`moderation-workflow.md`](./moderation-workflow.md).
- **Candidate Visual Concepts** — backend + frontend 3-card picker (PRs #163, #166)
  and lowercase-token acceptance in the Visual Concept field (#167).
- **Versioned enrichment / stale-fact refresh** — core + send-back UI + version
  history + candidate editing (PRs #160, #164).
- **Faster moderation** — removed the slow approval preflight; instant approve,
  live "test renders" pills, reject-in-visual-review (PRs #162, #165).
- **Tokenizer grammar correctness batch** — `{NAME_POSSESSIVE}` rendering,
  sibilant `-sses` verb fix, `{NAME}`-subject object-separated coordination
  reach, retiring the never-valid "They's" render (+ backfill), and a single
  deterministic grammar pass (`applyDeterministicGrammar`) shared by every
  fact-writing route (PR #188). See
  [`token-rendering-and-grammar.md`](./token-rendering-and-grammar.md).
- **Frontier-model visual planner + moderator-authored Visual Concept** (PR #157).
- **Enrichment field-doc popovers** + generated `ADMIN_FIELD_REFERENCE.md` (#153),
  moderation override tracking (#155), AI-suggested hashtags on submission (#150),
  tokenizer conjugation fixes (#151).

## In-progress slices

- The **"Slice 2A" visual-concept** line of work (candidate concepts) is the most
  recent active thread. **Needs David confirmation** on what's next in that slice.

## Near-term planned slices

- **Moderation-speed / reviewer-toil reductions** — ergonomics of the review +
  visual-review flow. **Needs David confirmation** on specifics.
- **Render/enrichment quality** — robustness of versioned refresh and stale-render
  handling.
- **Video meme pipeline** — maturity + user-facing status/experience.
- **Processing signatures (PR3)** — close the `signature: null // TODO(PR3-signature)`
  gap so staleness reflects engine/prompt/code revision. **Needs David confirmation**
  on scope/timing.

## Explicitly deferred work

- Broad public-growth surfaces and free→Legendary conversion optimization.
- R2 storage consolidation (images currently on Google Cloud Storage).
- New content formats beyond "facts."
- A multi-role admin permission model.
- Version rollback (archive rows exist; `TODO(version-rollback)` not wired).
- **Overhype.me Manual — one-time chapter backfill.** The manual scaffold
  (`docs/manual/README.md`) and the `/document` ceremony that grows it
  incrementally are in place; writing the initial set of chapters for
  already-built areas (content lifecycle, moderation, visual pipeline,
  taxonomy/enrichment, personalization/grammar, admin console, background work)
  is a separate deferred pass. **Needs David confirmation** on timing (he plans
  to kick it off when usage resets).

## Open product questions

- Should any render scenario become a **hard** approval gate (today all waivable)?
- Signature stamping (PR3) scope and what a signature should capture.
- *(Add here when a real product decision is pending — don't guess.)*
