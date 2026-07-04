# Product Direction

> Current direction and settled decisions, so agents stop re-litigating them.
> Strategic items here were set by David; factual "current direction" items are
> confirmed against the repo. When this conflicts with an older note, this wins.

## Current product bet

Overhype.me is **pre-launch**, betting on a **personalized impossible-facts →
meme** loop. The two things that matter now:

1. **Get to launch / stability** — reduce regressions, harden the end-to-end
   pipeline.
2. **Content volume & quality** — more approved facts live, faster, that *render
   well and land the joke*.

Growth and conversion optimization are real but **come after** stability + content
quality.

## Current AI/media direction

- The **human-authored or human-picked Visual Concept is the authoritative scene**
  for moderated renders. The **frontier planner realizes** the concept, but the
  human concept is the scene source of truth.
- **Candidate Visual Concepts** (3 AI-drafted picks) exist to avoid blank-page
  authoring; a pick becomes the concept.
- The render path is the **frontier visual planner (`gpt-5.5`) + deterministic
  Nano Banana 2 compiler**. Older `gpt-4o-mini`/`gpt-image-1`/FLUX render paths are
  **retired** (see [`visual-pipeline.md`](./visual-pipeline.md)).
- **Render-time planning + compiler output is the source of truth** for the image
  — not any enrichment-time preview (that's retired).
- **Readable in-scene text is allowed** when the concept/strategy requires it; there
  is no blanket text ban.
- Video memes go through PuLID stylization → image-to-video (Kling) → captions.

## Moderation direction

- **Staged moderation**: no paid enrichment/render work runs at submission —
  explicit cheap human triage comes first, then paid prep against a **staging
  fact**, then production review, then approval flips the fact live.
- Pexels + test renders are **review tools, not hard gates** (approving despite
  stale/missing renders records an auditable waiver).
- Near-term focus: **reduce manual moderation toil** (faster approve, better queue
  ergonomics, smoother taxonomy-health remediation).
- See [`moderation-workflow.md`](./moderation-workflow.md).

## Taxonomy/enrichment direction

- Enrichment is **durable classification metadata, not an image prompt.**
- **AI-derived baseline and human overrides stay distinguishable**, and **human
  overrides survive re-enrichment.**
- **Enrichment versioning + staleness tracking** preserve AI/human history and
  surface facts processed under old prompt/taxonomy assumptions; the stale-fact
  refresh runs on a candidate while the live fact stays published.
- **Moderator-curated final hashtags are what ship** (not raw AI suggestions).
- Known gap: **processing signatures are a TODO** — the plumbing exists but nothing
  stamps a signature yet.
- See [`taxonomy-and-enrichment.md`](./taxonomy-and-enrichment.md).

## Admin UX direction

- Internal tools favor **speed and legibility over visual polish.**
- **Runtime behavior must match admin preview/debug surfaces** — the Runtime
  Compiled Prompt preview is a contract with production.
- **Async work must show per-item + aggregate status** at all times (Taxonomy
  Health is the reference implementation).
- One `is_admin` role; no multi-role permission model planned.

## Launch-critical vs deferrable work

**Launch-critical (do these):**

- Moderation speed & tooling (cut reviewer toil).
- Render/enrichment quality (memes that land the joke; robust versioned refresh;
  clean stale-render handling).
- Video meme pipeline maturity **including its user-facing status/experience**.
- Pipeline stability / regression reduction across the board.

**Deferrable (fine to touch when it serves a launch goal, not where to spend
energy now):**

- Broad public-growth surfaces (leaderboard/search/sharing/OG polish).
- Free→Legendary conversion optimization.
- R2 storage consolidation.
- New content formats beyond "facts."

## Decisions agents should not reverse without David

*(The **why/when** behind each is in the [decision log](./decisions.md) — read it
before proposing to reverse one.)*

- The Visual Concept as the authoritative scene; the planner/compiler split.
- The no-blanket-text-ban policy.
- Staged/cost-gated moderation (no paid work pre-triage).
- Keeping AI baseline and human overrides separate; overrides surviving
  re-enrichment.
- `facts.*` as the sole active enrichment truth (versions table is an archive).
- **On-by-default, no rollout-flag gating** pre-launch.
- **No new external vendors** without David's sign-off.

## Open questions for David

*(None blocking as of this writing. Add here when a direction is genuinely
ambiguous rather than guessing. Candidates an agent might surface:)*

- Processing signatures (PR3) — is closing the TODO in scope soon, and what should
  a signature capture? **Needs David confirmation.**
- Whether any render scenario should become a **hard** approval gate (today all are
  waivable). **Needs David confirmation.**
