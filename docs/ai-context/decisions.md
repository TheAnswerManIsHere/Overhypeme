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
