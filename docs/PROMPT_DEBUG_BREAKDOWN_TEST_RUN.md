# Prompt debug breakdown + token gate — automated test run

Engineering-side checklist for Replit (the technical safety net). The
in-app walkthrough for David is in
[`PROMPT_DEBUG_BREAKDOWN_UAT.md`](./PROMPT_DEBUG_BREAKDOWN_UAT.md).

This change does three things to the **Runtime Compiled Prompt Preview**
(admin Facts page) and the compiler that feeds the image engine:

1. The Nano Banana 2 compiler now returns a **per-component breakdown**
   (`compiledPrompt.promptBreakdown`) of exactly how the final prompt was
   assembled — each section's id, label, priority, status
   (`included` / `compressed` / `dropped` / `deduped` / `empty`), and its
   text. The preview renders it under the compiled prompt. The "core
   mechanic" blob is split into separate **Visual goal** and **Visual
   approach** components so overlap between them and the LLM prose is visible.
2. A **final identity gate** in the compiler resolves any residual
   `{NAME}`/`{SUBJ}`/… tokens the LLM echoed (e.g. a semantic entity whose
   `surfaceText` is literally `{NAME}`) before the prompt reaches the engine.
   A template token can no longer leak into the engine prompt or the debug.
3. The preview now **persists to `localStorage`** (controls + last result,
   keyed per fact) so a page reload restores it without recomputing.

No schema/migration changes. No new env vars. `promptBreakdown` is additive
debug metadata on the existing `compiledPrompt` JSONB; the image engine still
reads only `imagePrompt`.

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

# Frontend component tests (breakdown render + localStorage restore).
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

Pass criterion: **16 tests pass, 0 fail** (was 14; +2 new). The two new ones:

- *resolves residual identity tokens the LLM echoed* — a `visualPlan`
  `semanticEntitiesUsed` entry with `surfaceText: "{NAME}"` plus a
  `renderedSubject: { name: "David", pronouns: "he/him" }` ⇒ the compiled
  prompt contains `"David" means …` and **no** `{NAME}`.
- *returns a per-section breakdown …* — `promptBreakdown` is present;
  `visual_goal` and `visual_approach` are distinct `included` sections; a
  key element already in the prose is `deduped` out of the gap-fill directive
  while a novel one is kept; `style` (unset) is `empty`; and concatenating the
  `included`/`compressed` section texts reproduces `imagePrompt` exactly.

The 14 pre-existing tests still pass unchanged: the compiler with **no**
`renderedSubject` (the legacy unit-test call shape) skips token rendering, so
prompts that use a literal name behave exactly as before.

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

Pass criterion: **8 tests pass, 0 fail** (was 6; +2 new):

- *renders the per-component prompt breakdown when present* — sections render
  with their labels + content; an `empty` section shows a "no content" note.
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

## What this explicitly does NOT ship

- **No change to how the prompt is assembled.** The breakdown is a read-only
  view of the existing assembly; the same sections, order, de-dupe, and budget
  logic produce the same `imagePrompt` as before (minus leaked tokens).
- **No new de-dupe between Visual goal / Visual approach / prose.** They can
  still overlap in intent (they're the same idea at different altitudes). The
  breakdown now makes that overlap visible; tightening it is a separate
  decision (flagged in the PR for David).
- **No persistence to the DB for the breakdown beyond the existing
  `compiledPrompt` JSONB.** It rides along on attempts that opt into "Save this
  as an image-prompt attempt"; it is not a new column.
- **No server-side persistence of the preview.** The reload-survival is
  client-side `localStorage`, per-fact, per-browser.
