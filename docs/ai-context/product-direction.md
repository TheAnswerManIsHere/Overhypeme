# Product Direction

> Current direction and settled decisions, so agents stop re-litigating them.
> Strategic items here were set by David; factual "current direction" items are
> confirmed against the repo. When this conflicts with an older note, this wins.

## Current product bet

Overhype.me is **pre-launch**, betting on a **personalized impossible-facts →
meme** loop. **Launch is now defined**, in checkable terms, in
[`launch-definition.md`](./launch-definition.md): the feature set, the cuts,
the readiness criteria and the four stages (Seed → Soft launch → Full launch
US → Full launch Global). The phased programme that makes it true is #628.
The two things that matter now:

1. **Get to launch** — make the launch definition true, phase by phase, with
   the scripted-verification build first so every phase ships verified.
2. **Content volume & quality** — more approved facts live, faster, that *render
   well and land the joke*; at Seed, every fact comes from a real user who is
   not David.

Growth and conversion optimization are real but **come after** launch; the
one growth surface that *is* launch-critical is the share loop itself
(personalised share links, "make this about you", Open Graph previews, share
by every modality) — see *Launch-critical vs deferrable work* below.

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
- **Video is deferred past launch** (David, 2026-10-05). The video pipeline,
  the legacy one-shot path, the PuLID stage and the video engines are deleted
  in the launch programme's cut phase and video is rebuilt post-launch on top
  of the image pipeline. **PuLID is removed everywhere**: *"We're going to be
  using a much stronger model."*
- **Free-tier image memes are the fact's moderation-approved hero renders**,
  captioned by the user; templates, stock photos and user-facing
  text-to-image are gone. Legendary is *your face in the scene*. The default
  image engine is chosen by an evaluation of the latest models on the same
  facts (the planner/compiler split stays; the engine behind the compiler may
  change).

## Moderation direction

- **Staged moderation**: no paid enrichment/render work runs at submission —
  explicit cheap human triage comes first, then paid prep against a **staging
  fact**, then production review, then approval flips the fact live.
- **Approved hero images are a hard gate: a fact cannot go live without
  them** (David, 2026-10-06). There is no "no-hero fallback"; the
  render-approval waiver is retired for the hero scenario and remains an
  auditable override for any other render scenario. Pexels is deleted
  entirely (it was a review aid and the source of user-facing stock
  backgrounds; both are cut).
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
- One orthogonal boolean role (`is_admin`) layered over the membership tier —
  **not** a general multi-role RBAC system. The tester role is gone from the
  docs (David, 2026-10-05): the invite gate is the Seed gate, and a beta
  opt-in overlay follows post-launch. See *Permissions direction* below.

## Permissions direction

> **End state:** one screen answers "who is allowed to do what," for every
> **product entitlement** an account may hold. David, 2026-08-10: *"I want all
> functions that check permissions to exclusively use this matrix so there is
> only ever one place to check and one source of truth for what different
> accounts can do in the system."* His words were totalising; the two-rail
> split immediately below is how that intent is honoured without also making
> operational **privileges** — admin console access chief among them —
> runtime-editable, which would reopen the lockout risk the whole effort exists
> to close. The grid is the single source of truth **for entitlements**;
> privileges stay code-owned, deliberately off this screen, and are documented
> rather than displayed there.

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

**Overlays are unions, never overrides.** `admin` adds to the account's
tier; more permissive wins. An admin who also pays never loses a feature by
being an admin. (The `tester` overlay was retired from the launch scope on
2026-10-05; the union rule is unchanged for any overlay that exists.)

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
while console access ignores the toggle; admins may *view* any ordinary
content (a meme, a fact, a comment) but not *act* on content they don't own
outside their granted moderation/operational privileges — this is about
ownership on user-generated content, never a viewing right, and it does not
touch or loosen the moderation privileges that already let an admin approve,
reject, or otherwise act on submissions they didn't create; **quarantined and
restricted CSAM/abuse evidence is categorically excluded from admin viewing**
regardless of this rule — [`legal-safety-moderation.md`](./legal-safety-moderation.md)
governs that boundary and wins any conflict, there is deliberately no admin
viewer for that content, and no permissions increment may add one; engine
access granted by **band**
(standard / premium / experimental) rather than per engine, so a new model is
labelled rather than added to the grid; admin-only creation dials (model,
duration, resolution, engine override) are operator tools, not entitlements;
and queued work is authorized as of submission, not execution.

**Deferred, deliberately:** impersonating a specific user ("log in as") — a
wanted support capability, but a session/auth feature with its own write,
audit and privacy policy, out of scope for the permission architecture itself.

## Launch-critical vs deferrable work

The authoritative list is [`launch-definition.md`](./launch-definition.md);
this section is the direction behind it. Two reversals of the earlier text
here are David's (2026-10-05), recorded in `decisions.md`: **video is
deferred** (it was launch-critical) and **Open Graph previews and the share
loop are launch-critical** (sharing polish was deferrable).

**Launch-critical (do these):**

- The scripted-verification build first; every later phase ships with its
  mechanical checks scripted.
- The loop, rebuilt properly: personalisation, sharing by every modality,
  "make this about you" on every shared meme page, Open Graph previews for
  meme and fact pages, public creator pages, reactions and heat.
- Moderation speed & tooling (cut reviewer toil), with the hero-render hard
  gate and finished speech bubbles.
- Render/enrichment quality (memes that land the joke; robust versioned
  refresh; clean stale-render handling); the engine evaluation.
- The safety, legal and compliance package; spend controls; security
  hardening with every key rotated — all gates for Seed.
- Pipeline stability / regression reduction across the board.

**Deferrable (post-launch, by decision):**

- Video, rebuilt on the image pipeline.
- Public-growth surfaces beyond the loop; free→Legendary conversion
  optimization; Legendary Pro; NSFW mode; the beta overlay.
- Annual and lifetime membership as new sales.
- R2 storage consolidation.
- New content formats beyond "facts."
- Data export (lands with GDPR readiness at the Global stage).

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
  — and the union (never override) semantics of overlays. See *Permissions
  direction* above.
- **Approved hero images as a hard gate** on going live (2026-10-06).
- **The four launch stages and the full readiness bar before Seed**; the
  Stripe evidence split; the geography rule (everyone except GDPR territories
  and OFAC countries at the US launch). See
  [`launch-definition.md`](./launch-definition.md).

## Open questions for David

*(None blocking as of this writing. Add here when a direction is genuinely
ambiguous rather than guessing.)*

- *(Answered 2026-10-06: the hero scenario is a hard gate; every other render
  scenario stays waivable. Decisions David makes at each launch phase
  boundary are listed on #628, not here.)*
