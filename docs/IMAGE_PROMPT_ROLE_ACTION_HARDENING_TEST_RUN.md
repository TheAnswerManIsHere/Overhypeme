# Image-prompt role/action hardening (v4) — automated test run

Paired with **`docs/IMAGE_PROMPT_ROLE_ACTION_HARDENING_UAT.md`** (the
click-through acceptance test). This doc is the engineering safety net for
Replit. **Replit owns the database connection** — apply migrations / run tests
against your own DB; this doc deliberately sets no `DATABASE_URL` or DB env.

## TL;DR

```
# libs (from repo root) — api-zod schema + validator changes
pnpm tsc -p lib/api-zod/tsconfig.json                                   # clean

# api-server (from artifacts/api-server)
pnpm run typecheck                                                      # tsc + cycles + no-console, clean
node --import tsx/esm --test src/__tests__/failureModeConstraints.test.ts          # new — all pass
node --import tsx/esm --test src/__tests__/nanoBanana2Compiler.test.ts             # 42 pass (28 prior + 14 v4)
node --import tsx/esm --test src/__tests__/imagePromptGeneration.validate.test.ts  # all pass (+ secondaryCharacters/v4)
node --import tsx/esm --test src/__tests__/imagePromptUserMessage.test.ts          # all pass (+ role/action contract)
node --import tsx/esm --test src/__tests__/imagePromptPreview.test.ts              # all pass
node --import tsx/esm --test src/__tests__/adminEngines.test.ts                    # 53 pass (non-regression)

# overhype-me (from artifacts/overhype-me)
pnpm run typecheck                                                      # clean
npx vitest run src/__tests__/RuntimePromptPreview.test.tsx              # 9 pass
```

## What v3 already solved (do NOT re-do)

The merged v3 work (PR #109) already ships: the labeled 8-section contract,
transformation-aware i2i preamble, deterministic `SUBJECT BINDING`, the
age/life-stage transform binding (adult + separate baby → one de-aged person),
anti-split constraints, intent-prose scrub, age-modifier directives, prompt
budgeting/de-dupe, the admin `RuntimePromptPreview`, and its test + UAT docs.

## What v4 adds (this PR)

A **general role/action/realization hardening increment** — the hospital-baby
fact is one proving case among several, *not* the architecture. Render-time
only: **no DB migration, no re-enrichment, no new admin UI.**

1. **`secondaryCharacters` (one small LLM-filled field)** on the visual plan:
   `{ label, visualRole }[]` — concrete visible roles for every non-subject
   person/animal/crowd. Strict-wire-schema (required, empty array allowed);
   mirrors `semanticEntitiesUsed`. The compiler reads it as `?? []` so pre-v4
   plans replayed from storage never crash. `IMAGE_PROMPT_GENERATION_VERSION`
   bumped `v3 → v4`.
2. **`REFERENCE INTERPRETATION` section** (between `SUBJECT BINDING` and
   `CORE SCENE`): a concise POSITIVE binding of the subject's role + one short
   clause per secondary character. Skipped (empty) when there's nothing
   meaningful to bind. Negatives never live here.
3. **Reusable failure-mode constraints** (`compilers/failureModeConstraints.ts`),
   folded into `STRICT CONSTRAINTS`, keyed only off normalized data we already
   store (frame + modifiers + secondary-character presence). Conservative:
   - soft role-preservation whenever secondary characters exist;
   - **strong** sole-agent line *only* on a reliable active-action frame;
   - active-action emphasis *only* on a reliable active-action frame;
   - soft focus/relationship packs for `crowd_reaction` /
     `clear_causal_relationship` / `subject_object_reversal`.
   Never a global duplicate ban; never a sole-agent claim on an aftermath /
   symbolic / reaction frame.
4. **Advisory density warnings** via the existing `diagnostics.warnings`
   channel (thin core scene, missing action verb on an active frame, empty
   subject details / environment, abstract `roleInScene` on an active frame,
   secondary character missing a concrete role). **Advisory only — never blocks
   compilation.**
5. **Generator contract + system prompt** updated to require concrete
   `roleInScene` + `secondaryCharacters`, with the softened central-action rule
   and an explicit "the baby fact is only a diagnostic, do not overfit" note.

## Failure-mode coverage matrix (what the fixtures map to)

| Category | Example | v4 | Mechanism |
|---|---|---|---|
| Age-transform + active action + secondary char | baby drove mom home | **Yes** | SUBJECT BINDING + REFERENCE INTERPRETATION + role-lock + active-action |
| Solo active action | bench-pressed the moon | **Yes** | active-action on `direct_action`; no role-lock |
| Multi-char authority | fired the referee | **Yes** | secondaryCharacters + role-preservation |
| Crowd reaction | crowd self-ovation | Partial | soft crowd pack; subject stays focal; crowd may react |
| Subject-as-object | calendar added a David Week | **Not solved** | regression: non-active frame ⇒ no active-action/role-lock |
| Nonhuman / cultural | Sharks have a David Week | **Not solved** | regression: no duplicate-David; cultural directive intact |
| Causal | sneezed, sun blinked | Partial | soft causal pack iff modifier present |
| Duplicate-subject | every mirror a different David | **Not solved** | anti-duplicate stays conditional; no global ban |

Acceptance: improve the **Yes** rows; do **not** regress the others, and do not
claim Partial/Not-solved rows are fixed.

## Schema / SQL checks

- No migration. `secondaryCharacters` is render-time plan data, not a DB column.
- Confirm the wire schema is strict: a plan **missing** `secondaryCharacters`
  fails `validateImagePromptPlan` (covered by a test), while `[]` and populated
  arrays both pass.
- Confirm `IMAGE_PROMPT_GENERATION_VERSION === "v4"`.

## What's deliberately NOT shipped (deferred)

First-class `ActionFrame` / `SettingAnchor` / `VisualEvidence` / `EntityBindings`
schema; the 8-mode subject-realization enum; taxonomy enrichment + DB backfill;
archetype strategy packs; action-object packs that need a vehicle/object-action
signal we don't store yet (e.g. detecting "the subject is driving") — those are
**not** inferred from prose. Subject-as-object, nonhuman transformation,
symbolic/absent subjects, and temporal inversion remain deferred; this PR only
guarantees it does not regress them.
