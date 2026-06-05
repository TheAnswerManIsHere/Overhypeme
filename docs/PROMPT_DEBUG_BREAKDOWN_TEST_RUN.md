# Prompt debug breakdown + token gate — automated test run

Engineering-side checklist for Replit (the technical safety net). The
in-app walkthrough for David is in
[`PROMPT_DEBUG_BREAKDOWN_UAT.md`](./PROMPT_DEBUG_BREAKDOWN_UAT.md).

This change does several things to the **Runtime Compiled Prompt Preview**
(admin Facts page) and the compiler that feeds the image engine:

1. The Nano Banana 2 compiler returns a **per-component breakdown**
   (`compiledPrompt.promptBreakdown`) of exactly how the final prompt was
   assembled — each section's id, label, priority, status
   (`included` / `compressed` / `dropped` / `deduped` / `empty`), and its
   text. The preview renders it under the compiled prompt.
2. A **final identity gate** in the compiler resolves any residual
   `{NAME}`/`{SUBJ}`/… tokens the LLM echoed (e.g. a semantic entity whose
   `surfaceText` is literally `{NAME}`) before the prompt reaches the engine.
   A template token can no longer leak into the engine prompt or the debug.
3. The preview **persists to `localStorage`** (controls + last result,
   keyed per fact) so a page reload restores it without recomputing.

Prompt-quality follow-up (this round):

4. **Planner-prose sanitation.** Before assembly, the compiler strips
   prose sentences that author clauses the compiler OWNS — identity/face
   preservation, reference-image/mode language, token interpretation, and
   text/logo policy — so the LLM prose can't inject a *competing* identity or
   policy instruction into the engine prompt (the "preserve Superman's
   recognizable face" vs compiler "preserve the reference person's face"
   conflict). Stripped clauses + reasons are returned in
   `compiledPrompt.diagnostics.removedPlannerProseSentences`.
5. **Strategic-intent compaction.** `visualGoal` + `visualApproach` are folded
   into one compact required **Strategic intent** section
   (`Intent: … Stage it as: …`) instead of two large abstract mini-prompts
   ahead of the prose. (The raw goal/approach remain visible in the Visual
   plan debug JSON.)
6. **Tone-split warning (advisory).** A diagnostic flags a likely tone split
   between the approach (serious/cinematic) and the prose (playful/humorous)
   without mutating the prompt: `compiledPrompt.diagnostics.warnings`.
7. **Generator contract (safe subset).** The planner is now told to keep
   `visualGoal`/`visualApproach` terse and non-overlapping and tonally
   consistent with the prose. (See "Deliberately NOT shipped" — the stronger
   "LLM must never author identity language in the prose" rule is held pending
   a product decision, because it conflicts with a validator requirement.)

No schema/migration changes. No new env vars. `promptBreakdown` and
`diagnostics` are additive debug metadata on the existing `compiledPrompt`
JSONB; the image engine still reads only `imagePrompt`.

---

## TL;DR

```bash
# Repo-wide typecheck (build libs first; the artifacts depend on lib dist).
pnpm run typecheck:libs
( cd artifacts/api-server  && tsc -p tsconfig.json --noEmit )
( cd artifacts/overhype-me && tsc -p tsconfig.json --noEmit )

# Compiler unit tests (pure — no DB/LLM): breakdown + token gate.
node --import tsx/esm --test \
  artifacts/api-server/src/__tests__/nanoBanana2Compiler.test.ts

# Preview route integration test (real test DB, stubbed generator — no OpenAI).
node --import tsx/esm --test \
  artifacts/api-server/src/__tests__/imagePromptPreview.test.ts

# Validator + generator-message non-regression (the conflict guard).
node --import tsx/esm --test \
  artifacts/api-server/src/__tests__/imagePromptGeneration.validate.test.ts \
  artifacts/api-server/src/__tests__/imagePromptUserMessage.test.ts

# Frontend component tests (breakdown + diagnostics + localStorage restore).
cd artifacts/overhype-me && pnpm exec vitest run \
  src/__tests__/RuntimePromptPreview.test.tsx
```

All green ⇒ stop. Sections below break out anything that fails.

---

## A — Typecheck

`pnpm typecheck` for the artifacts requires the workspace libs to be built
first (otherwise you'll see spurious `TS6305 Output file ... has not been
built` errors that are unrelated to this change):

```bash
pnpm run typecheck:libs
( cd artifacts/api-server  && tsc -p tsconfig.json --noEmit )   # exits 0
( cd artifacts/overhype-me && tsc -p tsconfig.json --noEmit )   # exits 0
```

## B — Compiler unit tests

```bash
node --import tsx/esm --test \
  artifacts/api-server/src/__tests__/nanoBanana2Compiler.test.ts
```

Pass criterion: **18 tests pass, 0 fail**. The notable ones:

- *resolves residual identity tokens the LLM echoed* — a `visualPlan`
  `semanticEntitiesUsed` entry with `surfaceText: "{NAME}"` plus a
  `renderedSubject: { name: "David", pronouns: "he/him" }` ⇒ the compiled
  prompt contains `"David" means …` and **no** `{NAME}`.
- *returns a per-section breakdown with a compact strategic-intent section* —
  `promptBreakdown` is present; goal+approach appear as ONE `strategic_intent`
  section (`Intent: … Stage it as: …`), not separate `visual_goal`/
  `visual_approach`; a key element already in the prose is `deduped` out of the
  gap-fill directive while a novel one is kept; `style` (unset) is `empty`; and
  concatenating the `included`/`compressed` section texts reproduces
  `imagePrompt` exactly.
- *strips identity/reference/token/text-policy clauses from the prose* — a
  prose blob containing "Ensure Superman's recognizable face is preserved",
  "Use the uploaded image as the identity source", an "Interpret these terms
  exactly: {NAME}…" clause, and a text-policy line ⇒ all four appear in
  `diagnostics.removedPlannerProseSentences` with the right reasons; the
  concrete scene sentence survives; `recognizable face` appears exactly once
  (from the compiler preamble, not the prose).
- *flags a tone split …* — a serious approach + playful prose ⇒ exactly one
  `diagnostics.warnings` entry, and the playful words are **not** removed
  (advisory only).

The pre-existing tests still pass unchanged: the compiler with **no**
`renderedSubject` skips token rendering, and the prose sanitizer only removes
the four compiler-owned categories, so prompts behave exactly as before.

## C — Preview route integration test

```bash
node --import tsx/esm --test \
  artifacts/api-server/src/__tests__/imagePromptPreview.test.ts
```

Pass criterion: **12 tests pass, 0 fail** (unchanged count). The route now
passes `renderedSubject: { name: "David", pronouns: "he/him" }` into the
compiler, and the response's `compiledPrompt.promptBreakdown` is populated.
The existing `renderedFactText` assertion (`/David/`, no `{NAME}`) still holds,
and the non-mutation test (the fact's stored enrichment is untouched) still
passes.

## D — Frontend component tests

```bash
cd artifacts/overhype-me && pnpm exec vitest run \
  src/__tests__/RuntimePromptPreview.test.tsx
```

Pass criterion: **9 tests pass, 0 fail**:

- *renders the per-component prompt breakdown when present* — sections render
  with their labels + content; an `empty` section shows a "no content" note.
- *surfaces compiler diagnostics* — a tone warning renders in the amber
  warning block; removed prose clauses render struck-through with their
  human-readable reason.
- *persists the result to localStorage and restores it on remount* — after a
  generate, `localStorage["overhype:rpp:v1:99"]` exists; a fresh mount of the
  panel restores the compiled prompt **without** re-calling
  `/api/admin/image-prompt/preview`.

## E — Production render path (code-read verification, no fal spend)

The live render path (`lib/imagePromptJobs.ts`) is exercised by no automated
test that hits fal (each render costs money). Verify by reading the diff:

- `imagePromptGenerationHandler.run` resolves `renderedSubject` via the new
  `resolveAttemptIdentity(attempt)` helper (user's `displayName` + `pronouns`,
  falling back to `Alex` / `they-them`) and passes it into
  `compileForSubjectRenderMode`, so the same token gate applies to real renders.
- `resolveRenderedFactText` now takes that identity instead of doing its own
  user lookup — behavior for the legacy fallback path is unchanged.

Optional live confirmation belongs in the UAT (generate a real AI background
on a fact whose enrichment carries a `{NAME}` semantic entity; the finished
scene must show the name, never the token).

---

## Deliberately NOT shipped (pending a product decision)

- **The "LLM must never author identity-preservation language in the prose"
  generator rule, as a *hard boundary*.** The plan's strongest form would tell
  the planner to omit face/identity language from `compiledPrompt.prompt`
  entirely — but `validateImagePromptPlan` (in `@workspace/api-zod`) currently
  **requires** the prose to *contain* face-preservation language for i2i renders
  (rule 8). Telling the LLM to omit it would fail validation and thrash renders.
  This round therefore enforces the boundary **deterministically in the
  compiler** (the sanitizer strips it after validation) rather than at the
  generator. Flipping the generator contract + relaxing the validator is a
  shared-contract change held for David's call.
- **No broad semantic/fuzzy de-dupe** between Strategic intent and the prose.
  Repetition of the same concept at different altitudes is left intact by
  design; only the four compiler-owned categories are stripped.
- **No new DB column.** `promptBreakdown` + `diagnostics` ride on the existing
  `compiledPrompt` JSONB for attempts that opt into "Save this as an
  image-prompt attempt".
- **No server-side persistence of the preview.** Reload-survival is
  client-side `localStorage`, per-fact, per-browser.

## F — Validator non-regression (the conflict guard)

The compiler's prose sanitizer runs **after** `validateImagePromptPlan`, so it
cannot affect validation. Confirm the validator + generator-message suites are
still green (no contract drift from the new generator instructions):

```bash
node --import tsx/esm --test \
  artifacts/api-server/src/__tests__/imagePromptGeneration.validate.test.ts \
  artifacts/api-server/src/__tests__/imagePromptUserMessage.test.ts
```

Pass criterion: **37 tests pass, 0 fail.**
