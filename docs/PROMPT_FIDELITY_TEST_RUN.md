# Render-prompt fidelity — engineering test run (Replit)

Owned by Replit AI (the technical safety net). The in-app acceptance pass
for David is in [`PROMPT_FIDELITY_UAT.md`](./PROMPT_FIDELITY_UAT.md); the
two cross-link. Run everything here against the repo's normal workspace.

**You own the database connection.** Where this doc says "apply
migrations" or "confirm the column exists," use your own DB — do not add
`DATABASE_URL` exports or test-DB config; any value written here would be
wrong for your environment.

---

## What this PR changes (why these checks exist)

The render pipeline produced rich reasoning (engine-neutral `visualPlan`,
semantic/cultural enrichment, modifiers) but the engine only ever saw the
LLM's free-text `compiledPrompt.prompt`. This PR makes the deterministic
compiler **assemble** the final prompt from the structured plan + runtime
inputs, and fixes the upstream inputs that fed it:

- Compiler composes the prompt from the plan (key elements, composition,
  supporting-text rule, semantic + cultural directives, fact modifiers),
  de-duped against the prose and budgeted — the LLM prose is one
  high-priority input, not the source of truth.
- Production now uses **rendered** fact text (no `{NAME}`/`{SUBJ}` leak),
  frozen on the attempt row, plus the **enrichment snapshot** (reproducible).
- Dead `negativePrompt` removed (engine has no negative param); exclusions
  move into positive prompt language, enforced by a validator rule.
- Cultural-reference research context now reaches the generator; material
  references must be echoed back (`culturalReferencesUsed`) and become
  explicit engine directives.
- Renders at **2K**; the lineage row records **real** output dimensions.
- `generate-v2` verifies upload ownership, distrusts client analysis,
  rejects impossible render modes, and blocks `poor` subject↔fact pairings.

## Migration

- New migration `0070_image_prompt_attempts_rendered_fact_text.sql` adds a
  nullable `rendered_fact_text text` column to `image_prompt_attempts`,
  journaled in `lib/db/migrations/meta/_journal.json` (idx 70).
- Apply migrations, then confirm the column exists on
  `image_prompt_attempts` and is nullable.
- Generation schema version bumped: `IMAGE_PROMPT_GENERATION_VERSION = "v2"`
  (visualPlan gained `culturalReferencesUsed`). Strict wire schema updated;
  all fixtures/stubs/system-prompt JSON shape updated to match.

## Build + typecheck

```bash
# composite lib declarations first (api-server consumes their .d.ts)
npx tsc --build
# api-server typecheck (includes cycle + no-console checks)
cd artifacts/api-server && npm run typecheck
```

Expected: both clean. (If api-server reports missing `@workspace/*`
exports, the lib `.d.ts` are stale — re-run `npx tsc --build` first.)

## Automated tests

Run from `artifacts/api-server`:

```bash
node --import tsx/esm --test \
  src/__tests__/imagePromptGeneration.validate.test.ts \
  src/__tests__/nanoBanana2Compiler.test.ts \
  src/__tests__/modifierDirectives.test.ts \
  src/__tests__/imagePromptUserMessage.test.ts \
  src/__tests__/renderCanonical.test.ts \
  src/__tests__/imagePromptPreview.test.ts
```

Expected: **93 pass, 0 fail** (32 + 14 + 4 + 5 + 26 + 12). Coverage:

- **Compiler** — preamble + identity guards de-duped once; missing key
  elements injected, present ones not duplicated; composition + caption
  negative space; supporting-text content+placement vs. no-readable-text;
  semantic + cultural + modifier directives; required content survives an
  over-long prose; `engineNotes` records budget drops; `negativePrompt`
  never set.
- **Validator** — rule 15 (material cultural-reference echo, ambiguous not
  forced) and rule 16 (empty `negativePrompt` for nano_banana_2), plus the
  existing 25.
- **Modifier map** — high-impact modifiers map to directives; policy-adjacent
  ones phrased as presentation; unknowns ignored; stable order.
- **Generator user message** — rendered fact text verbatim + token-free;
  empty-negativePrompt instruction; compact research context (confidence,
  truncated notes, ≤3 warnings) present when researched, absent otherwise;
  taxonomy presented as fixed.
- **renderCanonical** — `hasUnresolvedFactTokens` flags identity tokens +
  `{a|b}` pairs but not legitimate braces.
- **Preview integration** — admin runtime preview still compiles end-to-end
  through the real compiler.

## Manual / behavioral checks (no UI needed)

These exercise paths best confirmed against a running server + DB:

1. **Rendered text frozen.** Call `POST /memes/ai/:factId/generate-v2` as a
   legendary user on a fact whose template has `{NAME}`. Confirm the new
   attempt row's `rendered_fact_text` is populated and token-free. A
   template that fails to resolve returns `422 fact_template_unresolved`.
2. **Snapshot used, not live enrichment.** The `image_prompt_generation`
   handler validates `fact_enrichment_snapshot` (not `facts.enrichment`);
   changing the fact's enrichment after enqueue must not change the render.
3. **Ownership + anti-spoof.** `generate-v2` with an `uploadedObjectPath`
   owned by another user → `403 upload_not_owned`; unknown path →
   `404 upload_not_found`. A client `sourceImageAnalysis` whose
   `sourceImageSha256` / `analyzerVersion` doesn't match the upload is
   ignored and re-derived server-side.
4. **Impossible render modes rejected.** `human_identity_i2i` without a
   usable face → `400 human_i2i_requires_usable_face`; `nonhuman_subject_i2i`
   without a usable subject → `400 nonhuman_i2i_requires_usable_subject`;
   any i2i without an upload → `400 i2i_requires_uploaded_object_path`.
5. **Poor compatibility blocks.** When the plan rates `subjectFactCompatibility`
   = `poor`, the prompt job records `error="subject_fact_compatibility_poor"`,
   does **not** enqueue `image_generation`, and the poll route returns
   `status:"blocked"` with `blockReason` + `subjectFactCompatibility`.
6. **2K + real dimensions.** A completed render submits `resolution:"2K"`
   (logged at submit) and the `upload_image_metadata` lineage row records the
   measured width/height/byte size (no longer hardcoded 1024²).
7. **i2i missing reference.** An i2i attempt with no `referenceImageUrl`
   fails fast with `i2i_missing_reference_url` (not the opaque late
   `MissingRequiredParamError`).

## Cost / latency note

2K raises per-image cost (~1.5× of 1K on these engines), latency, and stored
file size. This is deliberate for meme-background quality. There is **no
Phase 2 budget gate yet** — that's a separate follow-up; this PR does not add
one (and per pre-launch policy does not gate the change behind a flag).

## Deliberately NOT shipped

- A Phase 2 cost/budget gate or admin-configurable resolution.
- Generic-t2i unification under the Phase 2 pipeline.
- A full prompt-section trace UI in admin (only `engineNotes` diagnostics).
- Retro-updating customized `admin_config` system-prompt rows
  (`seedImagePromptConfig` uses `ON CONFLICT DO NOTHING`; the generator's
  **user message** is authoritative for existing installs).
