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
- See [`taxonomy-and-enrichment.md`](./taxonomy-and-enrichment.md).

## Admin UX direction

- Internal tools favor **speed and legibility over visual polish.**
- **Runtime behavior must match admin preview/debug surfaces** — the Runtime
  Compiled Prompt preview is a contract with production.
- **Async work must show per-item + aggregate status** at all times (Taxonomy
  Health is the reference implementation).
- Orthogonal boolean roles (`is_admin`, `is_tester`) layered over the
  membership tier — **not** a general multi-role RBAC system. See
  *Permissions direction* below.

## Permissions direction

> **End state:** one screen answers "who is allowed to do what," for
> everything an account may do. David, 2026-08-10: *"I want all functions that
> check permissions to exclusively use this matrix so there is only ever one
> place to check and one source of truth for what different accounts can do in
> the system."*

The **Feature Permission Grid** (`tier_feature_permissions`) is that screen.
Reaching the end state is incremental; the constraints below bind every
increment, so plans cite them rather than re-deciding them.

**Two rails, kept apart.** *Entitlements* — what product features an account
gets — resolve through the grid, at runtime, editable with no deploy.
*Privileges* — what an account may do to the system (admin console, user
management, moderation, config editing, the grid editor itself) — resolve
through a role check in code and are **never** grid features. This is what
makes admin lockout impossible by configuration: nothing that grants console
access lives in the grid.

**Ownership is a third thing** and stays out of the grid — "may I act on *my
own* resource" is not an entitlement. Likewise **deliberately public** routes:
browsing without an account is core product behaviour, declared rather than
inferred.

**The grid holds anything that determines what a given account may do**,
including numeric limits (spend, upload and rate caps), not just on/off
switches. `admin_config` keeps global tuning that is identical for everybody.
That boundary is what decides where the *next* setting goes.

**Overlays are unions, never overrides.** `admin` and `tester` add to the
account's tier; more permissive wins. An admin who also pays never loses a
feature by being an admin.

**Tier privileges are an upsell surface, not just plumbing** (David,
2026-08-11). Withholding a capability from lower tiers and unlocking it on
upgrade is a deliberate conversion lever — custom avatars are the worked
example: lower tiers get a non-configurable generated icon, and setting a
custom image is a paid unlock. Such privileges must be **enforced
server-side**, not merely hidden in the UI, or the incentive is decorative.

**The client is told what it may do; it never derives it.** A client that
re-derives permissions from a role will eventually disagree with the server —
that divergence published a private meme (PR #402) and is the defect class
this direction exists to close.

**Settled and not to be re-litigated per increment:** the union semantics
above; "view as user" normalizing to `registered` so a preview is faithful,
while console access ignores the toggle; admins may *view* any content but not
*act* on content they don't own; engine access granted by **band**
(standard / premium / experimental) rather than per engine, so a new model is
labelled rather than added to the grid; admin-only creation dials (model,
duration, resolution, engine override) are operator tools, not entitlements;
and queued work is authorized as of submission, not execution.

**Deferred, deliberately:** impersonating a specific user ("log in as") — a
wanted support capability, but a session/auth feature with its own write,
audit and privacy policy, out of scope for the permission architecture itself.

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
- The **two permission rails** — entitlements in the grid, privileges in code
  — and the union (never override) semantics of the `admin` / `tester`
  overlays. See *Permissions direction* above.

## Open questions for David

*(None blocking as of this writing. Add here when a direction is genuinely
ambiguous rather than guessing. Candidates an agent might surface:)*

- Whether any render scenario should become a **hard** approval gate (today all are
  waivable). **Needs David confirmation.**
