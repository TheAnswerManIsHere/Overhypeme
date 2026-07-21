# Current Roadmap

> Short and current — near-term context, not a speculative roadmap. Keep it
> trimmed; when a slice ships, move it up to "recently merged." No invented
> deadlines. Items not verifiable from the repo are marked **Needs David
> confirmation**.
>
> *Snapshot date: 2026-07-07 (through PR #208) — the visual-enrichment cleanup
> (PR #189, #192/#198, #206) and the stale-fact-refresh arc (through PR #205)
> are both reflected below; read `git log` for anything more recent.*

## Active area of focus

The **moderation + visual-render pipeline**: making moderation faster and the
rendered memes better, plus maturing the video pipeline. This maps to the current
business goals (launch/stability + content volume & quality) and near-term
priorities (moderation speed, render/enrichment quality, video). See
[`product-direction.md`](./product-direction.md).

## Recently merged or completed work

(From recent history — read `git log` for the live picture.)

- **Async-jobs worker split into fast/render/bulk lanes** — fixed head-of-line
  blocking where a pure-DB admin action or a moderator-watched test render
  could queue for 30s+ behind unrelated slow/bulk work; each lane now has its
  own timer, re-entrancy guard, and concurrency bound (PR #216). See
  [`decisions.md`](./decisions.md#2026-07--split-the-async-jobs-worker-into-fastrenderbulk-lanes)
  and [`architecture-map.md`](./architecture-map.md#async-jobs-and-queues).
- **Auto-tokenize admin Visual-Concept authoring** — moderators write plain
  English in the Visual Strategy Override; Save auto-tokenizes (reusing the
  fact-submission tokenizer) and shows the result before persisting; a role
  binding's `entity` is a plain label, never a token, enforced client-side and
  by a schema backstop (PR #206). See
  [`token-rendering-and-grammar.md`](./token-rendering-and-grammar.md) and
  [`visual-pipeline.md`](./visual-pipeline.md#visual-strategy-override-authoring-auto-tokenize-on-save).
- **Visual Concept leads the compiled prompt** — the compiler now leads every
  render mode with the moderator's Visual Concept (CORE SCENE); the old
  `REFERENCE INTERPRETATION` section (which could double a subject's name) is
  retired, replaced by the additive `ROLE DETAILS` section (PR #192, #198).
  See [`visual-pipeline.md`](./visual-pipeline.md#prompt-compiler).
- **`subjectFactCompatibility` never blocks rendering** — a "poor"
  subject/fact-compatibility rating stays advisory-only in every render mode;
  it no longer hard-blocks a generation (PR #189).
- **Three-step moderation (Visual Concept gate)** — split the bundled visual-review
  step into an explicit **Visual Concept** gate (`concept_review`) before any render
  spend, then **Test Renders** (`production_review`); renders force-fire on gag
  approval (PR #179). See [`moderation-workflow.md`](./moderation-workflow.md).
- **Candidate Visual Concepts** — backend + frontend 3-card picker (PRs #163, #166)
  and lowercase-token acceptance in the Visual Concept field (#167).
- **Versioned enrichment / stale-fact refresh — full arc shipped.** Core +
  send-back UI + version history + candidate editing (PRs #160, #164); manual
  ProcessingSignature/engine-revision staleness tracking + Taxonomy Health
  lens (PR #168); bulk send-back — fan the single-fact primitive out via the
  async queue, initiation only, never auto-promotes (PR #205). See
  [`taxonomy-and-enrichment.md`](./taxonomy-and-enrichment.md).
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

## Explicitly deferred work

- **Async-jobs DB connection pool `max`.** The fast/render/bulk lane split
  (PR #216, 2026-07) deliberately left the `pg.Pool` default `max` of 10
  unraised — the three lanes' combined handler concurrency (8) fits under it,
  but only with thin headroom shared with concurrent HTTP traffic. Raise it
  only if pool-acquisition wait time or provider rate-limit errors actually
  show up under load; it's an infra/cost decision, not a code change to make
  proactively. See [`decisions.md`](./decisions.md#2026-07--split-the-async-jobs-worker-into-fastrenderbulk-lanes).
- Broad public-growth surfaces and free→Legendary conversion optimization.
- R2 storage consolidation (images currently on Google Cloud Storage).
- New content formats beyond "facts."
- A multi-role admin permission model.
- Version rollback (archive rows exist; `TODO(version-rollback)` not wired).
- **Overhype.me Manual — one-time chapter backfill.** The manual scaffold
  (`docs/manual/README.md`) and the `/document` ceremony that grows it
  incrementally are in place; writing the initial set of chapters for the
  remaining already-built areas (content lifecycle, visual pipeline,
  personalization/grammar, admin console, background work — moderation and
  taxonomy/enrichment are now written) is a separate deferred pass. **Needs
  David confirmation** on timing (he plans to kick it off when usage resets).

## Open product questions

- Should any render scenario become a **hard** approval gate (today all waivable)?
- Should any subset of a refresh (e.g. one where only non-render-affecting
  inputs moved) ever skip a human gate? Explicitly NOT decided by PR4 — bulk
  send-back only initiates; see the PR #168/#205 entry in
  [`decisions.md`](./decisions.md).
- *(Add here when a real product decision is pending — don't guess.)*
