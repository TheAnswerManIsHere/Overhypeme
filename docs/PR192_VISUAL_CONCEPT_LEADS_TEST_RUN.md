# PR192 — Visual Concept leads the prompt · TEST_RUN (engineering checklist)

> **For Replit (the technical safety net).** Automated verification for the
> Nano Banana 2 compiler redesign: CORE SCENE (Visual Concept) leads the prompt,
> REFERENCE INTERPRETATION is retired, additive sections de-dupe against emitted
> text, and the key-element crutch filter runs. Companion click-through:
> `docs/PR192_VISUAL_CONCEPT_LEADS_UAT.md`.
>
> **No schema, no migration, no data change.** Compiler + tests + docs only. This
> is PR1 of the 2-PR Visual-Enrichment cleanup; PR2 (authoring auto-tokenization)
> is separate.

---

## 1. Build + typecheck

```bash
pnpm run typecheck:libs
pnpm --filter @workspace/api-server run typecheck
pnpm --filter @workspace/overhype-me run typecheck
```

Expect all clean (`tsc --build` for libs; `tsc -b` + `check:cycles` +
`check:no-console` for api-server; `tsc -b` for overhype-me). No new import
cycles, no disallowed `console.*`.

## 2. Compiler unit tests (the core proof)

Run from `artifacts/api-server/`:

```bash
BCRYPT_SALT_ROUNDS=4 TEST_DB_ALLOW_EXIT_ON_IDLE=1 node --import tsx/esm \
  --experimental-test-isolation=none --test-concurrency=1 --test \
  src/__tests__/nanoBanana2Compiler.test.ts
```

Expect **93 pass / 0 fail**. The invariants that matter for this PR (all with
negative cases, not just the finger-countdown string):

- **CORE SCENE leads** — first emitted section is `CORE SCENE:` in all three
  render modes (human i2i, nonhuman i2i, t2i); `promptBreakdown[0].id === "core_scene"`.
- **Mode-aware identity right after the scene** — human i2i emits a strong
  `IDENTITY & REFERENCE:` clause ("preserve the reference person's recognizable
  identity and likeness") as the section immediately after CORE SCENE; nonhuman
  i2i keeps "do not replace the subject with a human"; t2i emits a brief
  `RENDER TASK:` with no reference-photo/identity vocabulary.
- **No double-naming (`X is X`)** — from BOTH sources: an AI-plan `roleInScene`
  that already names the subject, AND a `{NAME}`-token-led moderator roleBinding
  ("{NAME} as the driver" → "Alex Franklin as the driver", never "Alex Franklin
  is Alex Franklin…"). A bare-predicate role still binds with "is".
- **Additive de-dupe (contiguity)** — a tight restatement of the scene drops
  ("beside a tall trophy shelf"), while a distinct detail reusing scattered scene
  words survives ("a red trophy in his hand" when the scene has "red warning
  lights" + "trophy shelf" separately).
- **Emitted-only haystack** — a concrete `subjectDetails` entry survives even
  when the non-emitted `visualApproach` mentioned it; the internal reasoning
  never leaks into the prompt.
- **Key-element crutch filter** — negatives ("no visible blood") / conditional
  softeners / failure-mode commentary ("…, not a severed finger") are dropped
  from the visible-elements list and recorded in
  `diagnostics.droppedCandidates` with reasons; a concrete referent survives.
- **Policy guardrails preserved** — STRICT CONSTRAINTS still carries the
  overlay-text exclusion + incidental-text guard (and violence/anti-split where
  relevant).
- **Budget** — a huge (AI-fallback) CORE SCENE compresses while the required
  identity + binding + STRICT CONSTRAINTS after it survive (budget reservation);
  the hard-truncate note still fires when required content alone overflows.

## 3. Adjacent suites (no cross-references broke)

```bash
BCRYPT_SALT_ROUNDS=4 TEST_DB_ALLOW_EXIT_ON_IDLE=1 node --import tsx/esm \
  --experimental-test-isolation=none --test-concurrency=1 --test \
  src/__tests__/imagePromptPreview.test.ts src/__tests__/imagePromptEngine.test.ts \
  src/__tests__/imagePromptSystemPrompt.test.ts src/__tests__/imagePromptUserMessage.test.ts \
  src/__tests__/imagePromptGeneration.validate.test.ts src/__tests__/adminEngines.test.ts \
  src/__tests__/factRenderScenarios.test.ts
```

Expect **249 pass / 0 fail** (combined with §2). Confirms the preview/runtime
parity path, the planner system-prompt/user-message, the plan validator, the
engine workbench, and the render-scenario helpers all still pass with the new
section order + labels.

## 4. Docs freshness

```bash
pnpm run check:docs                 # relative links + cited paths resolve
rg "REFERENCE INTERPRETATION" docs artifacts lib --glob '!**/dist/**'
```

Expect `check:docs` green, and the `rg` to return **no** live references
(`ADMIN_FIELD_REFERENCE.md` was regenerated from `fieldDocs`; only historical
PR docs may mention the retired name).

## 5. What's deliberately NOT in this PR

- **PR2 — authoring auto-tokenization** (plain-English → tokens on save, admin
  tokenize route, tooltips). Separate PR; this PR touches no authoring UX.
- **The planner system-prompt admin_config row is NOT migrated.** The TS default
  (`FACT_IMAGE_PROMPT_SYSTEM_DEFAULT`) was updated so fresh installs describe the
  new contract, but an existing `fact_image_prompt_system` row keeps the old
  section-name list. This is intentional and inert: the planner fills concrete
  fields and never emits section headers, and the compiler-ownership semantics
  are unchanged — so there is no behavioral drift (unlike PR #189's contradiction,
  which did need a migration). No migration is expected or needed here.
- **No render-quality claim is made by these tests.** The image-quality gate —
  does the reordered prompt render better, and does i2i likeness still hold — is
  the UAT's manual render A/B, not automated here.
