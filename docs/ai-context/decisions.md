# Decision Log

> Append-only record of **settled** decisions — the *why* and *when* behind the
> "don't reverse without David" list in
> [`product-direction.md`](./product-direction.md). Newest first. If a decision
> should be revisited, don't silently reverse it — raise it with David and, if it
> changes, add a new entry that supersedes the old one (leave the old entry in
> place as history).
>
> Format: **date · title** — Decision / Why / Reference / Revisit if.
> Dates are approximate where anchored only to a PR; the PR number is the durable
> reference.

---

### 2026-07 · dev-admin-login backdoor hardened fail-closed
- **Decision:** `GET/POST /api/auth/dev-admin-login` — which mints a
  bootstrap-admin session for any caller — is gated fail-closed by
  `isDevAdminLoginEnabled()`: OFF by default, opt-in only via
  `ENABLE_DEV_ADMIN_LOGIN=true` for a **non-production** preview, and NEVER
  enabled in production even if the flag is set. When disabled the handler 404s
  (no session, no cookie), and `app.ts` withholds the permissive CORS +
  origin-exemption; the UI trigger no-ops outside a dev build. The enabled path
  rotates the session (fresh sid, delete old — closes fixation) and sanitizes
  `returnTo`. Supersedes the earlier pre-launch decision to leave it open (that
  deferral is now closed).
- **Why:** it was the single highest-severity finding — unauthenticated
  privilege escalation — and must be inert on any live deployment. The flag
  preserves David's Replit-preview admin shortcut (set it in that env) while
  guaranteeing production can never enable it.
- **Reference:** finding C1, PR #221;
  [`security-model.md`](./security-model.md#dev-admin-login-backdoor-c1),
  `devAdminLogin.ts`.
- **Revisit if:** the preview admin workflow needs a different mechanism, or the
  flag's env-var contract changes.

### 2026-07 · Membership is granted only for Stripe products tagged `overhype_membership=true`
- **Decision:** "Does paying for this grant Legendary?" is decided by a
  positive allowlist keyed on the Stripe **product** metadata tag
  `overhype_membership=true`, enforced at the **grant layer** (checkout,
  subscription switch, the synchronous confirm endpoint, AND the webhook —
  grant *and* cancellation), not just at checkout. One-time grants verify the
  actual purchased product from the Checkout Session line items, never the
  mutable `membership=true` PI metadata stamp.
- **Why:** checkout previously accepted any active price and granted Legendary
  for any succeeded payment, never checking *which* product — a price/tier
  tampering hole that goes live the moment a non-membership product exists.
  David confirmed non-membership purchases are coming (render credits), so a
  product-metadata allowlist keeps the "is this membership?" decision next to
  the product in Stripe (no env/config to drift), and the grant layer is the
  authoritative gate because the webhook — not checkout — is what actually flips
  the tier.
- **Reference:** finding C6, PR #214;
  [`security-model.md`](./security-model.md#payment-trust--membership-grants-c6),
  `artifacts/api-server/src/lib/membershipPricing.ts`.
- **Revisit if:** membership products ever need per-mode (test/live) isolation
  beyond what the product tag gives, or a non-Stripe entitlement source appears.

### 2026-07 · `isPublic=false` on a meme means owner-only/secret
- **Decision:** A meme with `isPublic === false` is visible **only** to its
  creator or an admin — not "unlisted but link-shareable." Every non-owner
  (logged-in or not) gets a **404** (not 403), private responses are
  `no-store` and excluded from the Cloudflare public cache and OG preview, and
  the visibility gate runs *before* the soft-delete 410 so a deleted private
  meme is indistinguishable from a missing one.
- **Why:** David's explicit product call during the review — "private" is
  secret, so slug unguessability is not authorization. 404-over-403 avoids
  confirming a private meme exists.
- **Reference:** finding C3, PR #213;
  [`security-model.md`](./security-model.md#authorization--objects-media-and-memes),
  `artifacts/api-server/src/lib/memeVisibility.ts`.
- **Revisit if:** an "unlisted, link-shareable" tier is ever wanted as a
  *distinct* third state (it would be a new value, not a reinterpretation of
  `isPublic=false`).

### 2026-07 · Split the async-jobs worker into fast/render/bulk lanes
- **Decision:** The single async-jobs worker (`runAsyncJobsWorker`) that
  dispatched all queues through one FIFO claim query, one concurrency pool, and
  one shared re-entrancy guard is now **three independent lanes**, each with
  its own timer, its own closure-local re-entrancy guard, its own queue filter,
  and its own concurrency bound:
  - **`fast`** (`fact_send_back`, `projection_repair`) — pure-DB admin actions,
    2s poll / concurrency 2.
  - **`render`** (`image_prompt_generation`, `image_generation`) — single-item,
    moderator-watched renders, 5s poll / concurrency 3.
  - **`bulk`** (everything else: `enrichment`, `fact_enrichment_backfill`,
    `fact_pexels`, `fact_visual_concepts`, `email`,
    `review_render_scenarios_prepare` — the default for an unannotated queue)
    — 5s poll / concurrency 3 (down from the old shared default of 4).

  `registerJobHandler(queue, handler, { lane })` assigns a queue's lane
  (defaults to `bulk`); `asyncJobsTick` takes an options object
  (`{ queues?, maxConcurrency?, lane? }`) so a lane can filter its own claim and
  set its own concurrency, with `undefined` reproducing the exact legacy
  all-queues query. A queue's lane governs ONLY scheduling — retry/backoff,
  dedupe, and claim ordering (`nextAttemptAt, id`) are unchanged.
- **Why:** the shared worker caused real head-of-line blocking: a
  pure-DB admin action (Taxonomy Health "Send back to review," no model call)
  could sit in "Queued…" for 30s+ behind slow LLM/image-gen jobs claimed in the
  same batch or an unfinished prior tick, and a moderator-watched "test render"
  could wait behind an unrelated bulk backfill batch. David reported both
  symptoms directly. A 2-lane split (fast vs. everything else) was considered
  and rejected in favor of 3, specifically so moderator-watched renders also
  get isolation from bulk background batches, not just from the pure-DB
  actions. See the new "Head-of-line blocking in a shared background worker"
  pattern in
  [`known-failure-patterns.md`](./known-failure-patterns.md#head-of-line-blocking-in-a-shared-background-worker).
- **Reference:** PR #216; see
  [`architecture-map.md`](./architecture-map.md#async-jobs-and-queues).
- **Revisit if:** pool-acquisition wait time or provider rate-limit errors
  appear under simultaneous fast+render+bulk+HTTP load — the three lanes' combined
  handler concurrency (2+3+3=8) was deliberately kept under the DB pool's
  default `max` of 10, but raising that `max` was explicitly left out of scope
  and may become necessary. Also revisit if a future queue needs its own
  distinct lane rather than defaulting into `bulk`.

---

### 2026-07 · Auto-tokenize admin Visual-Concept authoring on Save
- **Decision:** Moderators author the Visual Strategy Override's rendered
  fields (Visual Concept, required/forbidden details, role visual roles,
  policy guidance) in **plain English** — naming the subject naturally, not
  hand-typed personalization tokens. Clicking **Save** runs every changed
  field through the same tokenizer core fact submission uses and **shows the
  tokenized result in the field** before it persists (shown-and-correctable,
  not a silent swap). A one-click model was chosen over a two-click
  review-then-confirm pause. A role binding's `entity` field is the one
  exception: it is a plain "subject"/role label, never tokenized — typing the
  subject's own name there auto-normalizes to `"subject"`, and a typed token
  is rejected as an error (client-side and via a hard schema backstop).
- **Why:** hand-typing tokens (possessive/reflexive/conjugation pairs) was
  error-prone and was the direct cause of the double-naming bug the compiler
  redesign (below) had to clean up; reusing the existing fact-submission
  tokenizer avoids a second, divergent tokenization implementation; showing
  (not hiding) the result keeps the moderator in control, mirroring the
  product's existing write→preview→confirm pattern for fact submission. The
  one-click model was David's explicit call over a review-pause UX.
- **Reference:** PR #206; see
  [`token-rendering-and-grammar.md`](./token-rendering-and-grammar.md#shared-core-fact-submission-and-admin-visual-concept-authoring-pr-206)
  and
  [`visual-pipeline.md`](./visual-pipeline.md#visual-strategy-override-authoring-auto-tokenize-on-save).
- **Revisit if:** a second *named* character in authored prose becomes a
  frequent real-world problem — today it's mitigated only by an authoring rule
  + tooltips (name only the subject, use roles for everyone else), not a hard
  server-side block; a scene-aware tokenizer prompt is the deferred fix if
  that mitigation proves insufficient.

### 2026-07 · Visual Concept leads the compiled prompt; REFERENCE INTERPRETATION retired
- **Decision:** The compiled image prompt now leads with the moderator-authored
  **CORE SCENE** (Visual Concept), immediately followed by an identity/reference
  clause (i2i) or a short task line (t2i); every other section is either
  operational (identity, style, policy) or **strictly additive** — it earns its
  place only by contributing a concrete detail the Concept didn't already
  state, de-duped by content-word contiguity against the emitted text (not a
  bare substring check). The old `REFERENCE INTERPRETATION` section — which
  could structurally double a subject's name ("Alex is Alex leans against the
  bar…") when a role binding already named the subject — is retired entirely,
  replaced by the additive `ROLE DETAILS` section
  (`composeAdditiveRoleDetails`), which never doubles a name.
- **Why:** image engines weight earlier prompt text more heavily, so burying
  the authoritative scene behind reference/identity boilerplate worked against
  the very thing meant to drive the render; the retired compose function's
  `"${subject} is ${role}"` template had no guard against the role already
  naming the subject, which is exactly the shape a moderator's role binding
  produces once role labels get token-canonicalized.
- **Reference:** PR #192, #198; see
  [`visual-pipeline.md`](./visual-pipeline.md#prompt-compiler).
- **Revisit if:** render quality regresses because `ROLE DETAILS` drops
  something genuinely needed — dropped candidates are recorded in
  `diagnostics.droppedCandidates` with a reason, so this is debuggable rather
  than a guess.

### 2026-07 · Processing signatures + engine revision; bulk send-back is initiation, never completion
- **Decision:**
  - Staleness gets a second, orthogonal dimension alongside the existing
    `classificationPromptVersion` check: a `ProcessingSignature` (engine
    revision + 4 code-version constants) stamped on `facts.lastProcessedSignature`
    at classify time. Engine/model IDs are deliberately **excluded** — a config
    toggle would otherwise flip corpus-wide staleness — so an LLM/engine swap
    registers only via a manual, admin-audited **`engineRevision` bump**
    ("Mark major update"), not automatically.
  - **First-time approvals stamp fresh; direct live re-enrich never stamps.**
    A newly-approved fact is never stale-for-reprocess on day one, but an
    already-live fact only becomes fresh by going through the versioned
    refresh (send-back → promote) — a direct re-enrich writes `facts.*`
    straight and can't clear the flag.
  - **Bulk "reprocess" (PR4) is bulk *initiation*, never bulk *completion*.**
    It fans the existing single-fact send-back primitive out across many stale
    facts via the async-jobs queue — every fact still has to clear **both**
    human moderation gates (Visual Concept, then Test Renders) before it can
    promote. Nothing auto-promotes.
- **Why:** David's initial instinct was that "bulk reprocessing" shouldn't
  exist at all, since the (concurrently rebuilt) three-step moderation process
  requires a human in the loop — and that instinct is correct for bulk
  *completion*. The resolving reframe: a refresh's Visual Concept is *carried
  forward* from the live fact (not rebuilt from scratch) via the send-back
  primitive's seeded override layers, so initiating many refreshes at once
  doesn't bypass or weaken the human gates — it just fills the moderation queue
  faster than clicking the single-fact button hundreds of times. Excluding
  engine/model IDs from the signature (vs. stamping them automatically) avoids
  every config toggle silently invalidating the whole corpus; the manual bump
  keeps that invalidation an explicit, audited admin act.
- **Reference:** PR #168 (ProcessingSignature + Taxonomy Health lens), PR #205
  (bulk send-back); see
  [`taxonomy-and-enrichment.md`](./taxonomy-and-enrichment.md) and
  [`async-ui-status.md`](./async-ui-status.md).
- **Revisit if:** the product ever wants auto-promotion of a subset of
  refreshes (e.g. when only non-render-affecting inputs moved) — that would be
  a deliberate, separate decision, not an incremental extension of PR4.

### 2026-07 · Tokenizer grammar correctness batch: possessive form, "They's" retirement, coordination reach
- **Decision:**
  - `{NAME_POSSESSIVE}` always appends `'s` — including names already ending in
    `s` ("James" → "James's") — matching the server canonical renderer's
    existing `possessive()` convention, rather than a "James'" bare-apostrophe
    style.
  - The never-valid "They's" render is retired with BOTH a deterministic
    ingress fix (new templates can never store the bare `{Subj}'s` contraction
    — it's expanded to `{Subj} {is|are}` before storage) AND a one-time backfill
    of existing stored rows, rather than renderer-safety alone.
  - Coordinated `{Subj}`-subject verb wrapping (auto-wrapping a *later* verb in
    "`{Subj} runs and hides`") is explicitly NOT added to the deterministic
    net — only the immediately-adjacent verb is ever auto-wrapped. See the
    matching
    [known-failure-patterns.md](./known-failure-patterns.md#regex-grammar-rewrite-reaches-past-a-safe-anchor)
    entry for why.
- **Why:** the possessive form needed to be unambiguous and viewer-independent
  regardless of the name's spelling; "They's" is never valid English and the
  fix has to hold for both new writes and the existing corpus; coordinated
  verb-wrapping by regex can't reliably distinguish a shared subject from a new
  one once a coordinating conjunction is crossed, so "prefer no rewrite over
  the wrong rewrite" wins over broader coverage.
- **Reference:** PR #188; see
  [`token-rendering-and-grammar.md`](./token-rendering-and-grammar.md).
- **Revisit if:** the product wants a "James'" possessive style instead, or a
  real parser (not regex) is ever introduced for tokenization, at which point
  coordinated-verb wrapping could be revisited.

### 2026-07 · Visual Concept is a mandatory human gate before any render spend (three-step moderation)
- **Decision:** Moderation gains a third gate. Enrichment success lands a review
  at a new **`concept_review`** stage (Step 2), where the human accepts/edits/
  writes the **Visual Concept** and **"approves the visual gag"** — and **no test
  renders run until then**. Approval advances `concept_review → production_review`
  (Step 3, "Test Renders"), which is the only stage renders fire in. Sub-decisions:
  - **D1** — gag approval requires a **saved, enabled, non-empty**
    `coreSceneOverride` on the cycle's effective enrichment (not just an AI
    candidate card, not a browser-only draft; the server checks the persisted
    value).
  - **D2** — **no hard-cancel** of in-flight renders on a Step-3→Step-2 bounce;
    they finish but are superseded, and re-approval **force-creates a fresh batch**.
  - **D3** — **no back-migration**: pre-deploy `production_review` rows stay at
    Step 3 under the existing render/enrichment gates; the new concept gate only
    bites if an admin voluntarily bounces one back to Step 2.
  - **Force batch is dedupe-safe** — the force render-prepare enqueue carries
    **no dedupe key**, and the stage transition is an **atomic compare-and-set**
    (`UPDATE … WHERE workflow_stage='concept_review' RETURNING id`); the CAS, not
    the queue, is the double-click/concurrency guard, so two concurrent approvals
    produce exactly one batch.
  - **Stale-but-saved is allowed** — the *saved* concept, not the AI candidate
    cards, is the approved artifact; a concept saved before a later Advanced-
    Options edit still approves (only failed/pending/never-generated ideas block).
- **Why:** With the frontier planner, the Visual Concept is now the core
  description of how a gag works visually, not a break-glass override — so it
  deserves a human eval on **every** fact, and renders (which cost money) should
  not fire until that eval passes. Splitting the old bundled "visual review" step
  makes the concept gate explicit and keeps render spend behind it.
- **Reference:** PR #179; see [`moderation-workflow.md`](./moderation-workflow.md).
- **Revisit if:** the Visual Concept is later split per-scenario (the gate is
  keyed on "a saved concept exists + ideas terminal-OK", not on one concept, so a
  split changes *what* is validated, not the stage machine), or a hard-cancel of
  superseded renders becomes worth the complexity.

### 2026-07 · End-of-feature `/document` ceremony + human-facing Overhype.me Manual
- **Decision:** Adopt an explicit, David-triggered `/document` ceremony that
  harvests a finished feature's durable learnings and routes each to its one
  canonical home. Its cross-agent contract lives in
  [`documentation-workflow.md`](./documentation-workflow.md) (Claude adds a thin
  enactment skill; Codex reads the contract directly). Introduce
  [`docs/manual/`](../manual/README.md) — a human-facing *narrative* manual (how
  the system works and *why*) that grows one chapter at a time via that ceremony
  and lives **alongside** `docs/ai-context/` (the agent-facing operational
  spec), never absorbing it. Two layers, one truth: a fact is canonical in one
  place and linked from the other; generated docs stay generated.
- **Why:** Learnings otherwise evaporate with the chat transcript, and the
  "memory lives in files" habit had no explicit end-of-feature trigger. There
  was also no human-readable account of *why* the system is built the way it is;
  the generated Admin Field Reference was a first step. The ceremony is kept
  **distinct from "remember this"** (immediate single-item persistence) so a
  small memory request doesn't trigger a heavyweight harvest.
- **Reference:** PR #180.
- **Revisit if:** the manual and `docs/ai-context/` start duplicating rather
  than linking, or a lighter trigger than a full ceremony is wanted for most
  features.

### 2026-07 · One source of truth for agent context; CLAUDE.md deduped
- **Decision:** Shared product/architecture/principle truth lives once in
  `AGENTS.md` + `docs/ai-context/` + `docs/engineering/`; `CLAUDE.md` (Claude) and
  `AGENTS.md` (Codex) are thin entry doors that route into it. No principle is
  restated as full prose in more than one place.
- **Why:** Two drifting copies is worse than one — agents were relying on private
  memory for product direction. Checked-in, split-by-concern context is shared,
  reviewable, and updated alongside code.
- **Reference:** PR #171.
- **Revisit if:** a third agent with a different convention joins and can't read
  this layout.

### 2026-07 · Retire modifier→prompt-prose injection; one owner per prompt concern
- **Decision:** Enrichment `modifiers` are **not** re-injected as fixed English
  prose into the compiled image prompt. Each prompt concern has exactly one owner:
  fact meaning → planner context; the picture → moderator Visual Concept realized
  by the planner; identity/render-mode/overlay-text → the deterministic compiler;
  suppression → moderator render policy.
- **Why:** The second injection contradicted the moderator's scene (e.g. a "keep
  surfaces free of readable text" line fighting an explicit "render this in-scene
  text" line). It was scaffolding from when the planner was weaker.
- **Reference:** PR #172.
- **Revisit if:** the planner stops reliably carrying modifier intent on its own.

### 2026-07 · Readable in-scene text is allowed when required (no blanket ban)
- **Decision:** No global "no readable text" rule. The compiler emits only a narrow
  overlay-text exclusion (no baked captions/hashtags/watermarks/real logos);
  in-world text is governed by the `supportingText` policy (`allow/forbid/require`)
  and the moderator override.
- **Why:** Many jokes need legible in-scene text (formal-logic equations, tech UI,
  the pi-PIN "four crisp digits"). A blanket ban killed those.
- **Reference:** encoded in `nanoBanana2.ts`; see
  [`visual-pipeline.md`](./visual-pipeline.md).
- **Revisit if:** in-scene text quality from the model regresses badly.

### 2026-07 · Versioned enrichment; `facts.*` is the sole active truth
- **Decision:** Stale-fact refresh runs on a **candidate** enrichment version while
  the live fact stays published; `facts.*` remains the only active truth and
  `fact_enrichment_versions` is an append-only archive. AI baseline and human
  overrides stay separate columns; **human overrides survive re-enrichment**.
- **Why:** Refreshing classification under newer prompts must never drop a
  moderator's decision or take a fact offline mid-refresh.
- **Reference:** PRs #160, #164; see
  [`taxonomy-and-enrichment.md`](./taxonomy-and-enrichment.md).
- **Revisit if:** the archive model needs to become active lineage (multi-active).

### 2026-06/07 · Frontier visual planner + moderator-authored Visual Concept
- **Decision:** The moderator-authored/-picked **Visual Concept** is the
  authoritative scene; a frontier-model planner (`gpt-5.5`) realizes it and a
  deterministic Nano Banana 2 compiler produces the engine prompt. `gpt-4o-mini` /
  `gpt-image-1` / FLUX are retired from the render path.
- **Why:** Human intent for the picture + a strong planner + a deterministic
  compiler beats letting a weaker model improvise the whole scene.
- **Reference:** PR #157; see [`visual-pipeline.md`](./visual-pipeline.md).
- **Revisit if:** a materially better/cheaper render model appears (config, not a
  rewrite — engines are code-first).

### pre-launch · Staged, cost-gated moderation
- **Decision:** No paid enrichment/render work runs at submission. Cheap human
  triage comes first; paid prep runs against an inactive **staging fact**;
  production approval flips it live.
- **Why:** Don't spend model/image money on spam/duplicate/low-quality
  submissions.
- **Reference:** [`moderation-workflow.md`](./moderation-workflow.md).
- **Revisit if:** triage volume makes the human first-pass the bottleneck.

### pre-launch · No rollout-flag gating; ship on-by-default
- **Decision:** New user-visible behavior ships on by default — no `enable_*`
  flags or admin toggles to flip during UAT. Only true kill-switches for
  externally-destructive actions are exempt.
- **Why:** Pre-launch the bar is "confidently correct," and hidden flags trip up
  acceptance testing. Post-launch we'll reintroduce staged rollouts deliberately.
- **Reference:** [`agent-working-rules.md`](./agent-working-rules.md).
- **Revisit if:** we launch (then this flips).

### standing · The deterministic net is the grammar guarantee, not the LLM
- **Decision:** The tokenizer's correctness comes from deterministic
  post-processing (`autoConjugatePersonSubjectVerbs`, branch-collapse), not the
  model prompt. Grammar fixes go in the net + tests, not the prompt.
- **Why:** A prompt can't be trusted to always conjugate correctly; the net can be
  proven with invariant tests.
- **Reference:** [`token-rendering-and-grammar.md`](./token-rendering-and-grammar.md).
- **Revisit if:** never, unless the token model changes fundamentally.
