# Render-policy cleanup (Phase 1) — automated test run

Paired with **`docs/RENDER_POLICY_CLEANUP_UAT.md`** (the click-through
acceptance test). This doc is the engineering safety net for Replit. **Replit
owns the database connection** — this change is render-time-only with **no DB
migration and no schema change**, so there is nothing DB-specific to set up.

## TL;DR

```
# libs (from repo root) — api-zod render-policy types
pnpm tsc -p lib/api-zod/tsconfig.json                                   # clean

# api-server (from artifacts/api-server)
pnpm run typecheck                                                      # tsc + cycles + no-console, clean
node --import tsx/esm --test src/__tests__/nanoBanana2Compiler.test.ts             # 46 pass (37 prior + 9 render-policy)
node --import tsx/esm --test src/__tests__/imagePromptGeneration.validate.test.ts  # all pass (non-regression)
node --import tsx/esm --test src/__tests__/imagePromptPreview.test.ts              # all pass (non-regression)
node --import tsx/esm --test src/__tests__/modifierDirectives.test.ts              # all pass (non-regression)
node --import tsx/esm --test src/__tests__/redundantMechanism.test.ts              # all pass (non-regression)
```

> Note: the sharded runner (`pnpm test`) passes `--test-isolation=none` to
> `node --test`. In some container node builds that flag is rejected at startup
> (`node: bad option: --test-isolation=none`) before any test loads — that is an
> environment/runner issue, not a code failure. Run the suites directly with
> `node --import tsx/esm --test <file>` (as above) on such nodes.

## What this phase changes

The deterministic Nano Banana 2 compiler baked an **over-broad "no readable
text" ban** into every prompt and had **no principled violence policy**. Phase 1
replaces both with an explicit **render-policy layer** (`renderPolicy.supportingText`
+ `renderPolicy.violence`) with product-correct global defaults. Render-time
only: **no DB migration, no re-enrichment, no new admin UI.**

1. **New render-policy types + defaults** in
   `lib/api-zod/src/imagePromptGeneration.ts`:
   - `SupportingTextRenderPolicy { mode: "allow"|"forbid"|"require"; guidance? }`
   - `ViolenceRenderPolicy { mode: "allow"|"soften"|"suppress"; intensity; guidance? }`
     (`intensity` includes `"graphic"` for FUTURE adult/NSFW modes — never
     selected by default).
   - `RenderPolicy { supportingText; violence }` + `DEFAULT_RENDER_POLICY`
     (`supportingText: allow`, `violence: allow + strong`, both with no
     `guidance` so "allow" stays silent).
   - **Optional** `renderPolicy?: RenderPolicy` added to
     `ImagePromptGenerationInput`. Optional ⇒ no call-site/test breakage; the
     compiler falls back to `DEFAULT_RENDER_POLICY`.

2. **Compiler (`compilers/nanoBanana2.ts`) consumes the policy:**
   - The hardcoded blanket *"Keep all surfaces free of readable text…"* line is
     **removed**.
   - A **narrow overlay-text exclusion** (derived from
     `MANDATORY_FORBIDDEN_TEXT_TYPES`) is always emitted: no meme caption / fact
     text / hashtags / watermarks / real logos / brand marks. This is **not** a
     readable-text ban — in-world scene text is governed separately and is
     compatible.
   - Supporting text by mode: `require` → required-text line (+ guidance);
     `forbid` → avoid-in-scene-text line; `allow` → **silent** unless the planner
     supplied `supportingTextElements` or the policy carries intentional
     `guidance`.
   - Violence by mode: `allow` → a short, self-conditioned permission line
     **only when the fact is violence-relevant** (or explicit guidance is set);
     `soften` → softening line; `suppress` → suppression line. Never emits
     `graphic` language.

3. **Precedence (no contradictory output):** explicit `soften`/`suppress` >
   per-fact softening modifiers (`avoid_gore` / `non_graphic_action` /
   `avoid_weapons_focus` / `avoid_gross_literalization`) > default `allow`. Under
   `allow`, a per-fact softening modifier **suppresses** the permission line and
   lets the existing modifier directive govern.

## Test coverage (new, in `nanoBanana2Compiler.test.ts`)

- No blanket *"free of readable text"* ban under the default policy; narrow
  overlay exclusion always present.
- `allow` (default) emits **no** in-world text line; planner
  `supportingTextElements` still render (without a contradicting blanket suffix).
- `require` emits the `SUPPORTING TEXT:` line and **renders `{NAME}` tokens** in
  guidance via `renderedSubject`.
- `forbid` emits the avoid-in-scene-text line.
- Non-violent fact → **no** violence line; violent fact (grenade / 50 bodies) →
  the self-conditioned permission line, and the violent scene survives (not
  sanitized).
- Violent fact **+ `avoid_gore`** → permission line **suppressed**, softening
  directive present (no contradiction).
- `soften` / `suppress` emit their line only when explicitly selected.

## Schema / SQL checks

- **No migration.** `renderPolicy` is render-time input, not a DB column.
- `MANDATORY_FORBIDDEN_TEXT_TYPES` is **kept** (validator rule 6 still requires
  the plan's `forbiddenTextTypes` to include all 7); its comment is re-scoped to
  "overlay/caption text, not all readable scene text".
- Confirm `validateImagePromptPlan` is unchanged in behavior (the validate suite
  passes unmodified).

## What's deliberately NOT shipped (deferred to Phase 2+)

- Per-fact moderator **override** fields/UI (`supportingTextPolicyOverride`,
  `violencePolicyOverride`) — Phase 2.
- A global admin **render-policy editor** — not in scope; defaults live in code.
- Future **child-safe** (`soften`/`mild`) and **adult/NSFW** (`graphic`) policy
  presets — the types are future-compatible but no preset is wired.
- `contentMode` (sfw/suggestive/spicy) remains orthogonal and untouched.
