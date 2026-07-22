# PR223 — Render identity/style reproducibility · TEST_RUN (engineering)

Technical safety-net checklist for Replit. This PR freezes the render
**identity** and **look-style** at attempt-construction time (instead of the
async worker re-deriving them LIVE), and reduces the identity fed into the image
prompt to a short prompt-safe name. No schema migration.

Replit owns the database connection — do **not** add `DATABASE_URL` / test-DB
env setup here. Where the DB is referenced below, apply the repo's normal
migration/test flow against Replit's own database.

## Build / typecheck / lint gates

```bash
pnpm install --frozen-lockfile
pnpm run typecheck:libs
pnpm --filter @workspace/api-server run typecheck
pnpm --filter @workspace/overhype-me run typecheck
node scripts/check-docs-accuracy.mjs
```

Expected: all clean. `check-docs-accuracy` → "all relative links resolve and all
cited repo paths exist." No `check:no-console` / `check:cycles` violations
(these run inside the api-server typecheck script).

## Automated tests

Full sharded suite (per-DB runner):

```bash
pnpm --filter @workspace/api-server test
```

Expected: **all shards pass, 0 fail.** (A logged
`OPENAI_API_KEY must be set…` line from the fact-image pipeline is a
non-failing warning inside a test, not a failure — the shard still reports
`result=pass`.)

Targeted new/affected files (single-file runner, faster to iterate):

```bash
pnpm --filter @workspace/api-server exec tsx --test \
  src/__tests__/resolvedIdentityForms.test.ts \
  src/__tests__/promptIdentity.test.ts \
  src/__tests__/styleResolution.test.ts \
  src/__tests__/prepareAttemptInputs.test.ts \
  src/__tests__/memesGenerateGeneric.test.ts \
  src/__tests__/routes.memes.test.ts \
  src/__tests__/imagePromptJobs.test.ts
```

What these lock in:

- **`resolvedIdentityForms.test.ts`** — one shared `{NAME}`/`{SUBJ}`/… resolution
  contract. Grammatical number is **singular UNLESS the subject pronoun is
  literally `they`** (a neopronoun like `xe`/`ze` → singular). The near-miss case
  is explicit — this is the historical rule, guard it.
- **`promptIdentity.test.ts`** — the prompt-safe name reduction: prefer
  `firstName`; else the FIRST whitespace token of `displayName` (never a raw
  slice of the whole string); else the canonical fallback. Grapheme-safe ≤
  `RENDERED_IDENTITY_NAME_MAX` clusters (no split combining marks / surrogate
  pairs). Pronoun clamping preserves the string byte-for-byte when no side needs
  clamping.
- **`styleResolution.test.ts`** — `resolveRenderStyle` returns a typed
  `default` / `selected` / `invalid` result. Invalid reasons: `not_found`,
  `inactive`, `empty_suffix` (mode-specific column blank), `copy_too_long`,
  `copy_invalid` (embedded newline/control char). An over-budget custom suffix
  **never** silently masquerades as "default".
- **`prepareAttemptInputs.test.ts`** — the load-bearing invariants:
  (1) the fact text is rendered from the **SAME** reduced identity the snapshot
  carries (a `David Franklin` user → snapshot name `David` AND fact text
  `David …`, not `David Franklin …`); (2) an invalid style is a typed
  `style_invalid` domain error, not a silent "no style"; (3) the helper writes
  **no** attempt row and enqueues **no** job.

## Manual DB / behavior checks

1. **Frozen snapshots land on new attempts.** Trigger a render on each user path
   and inspect the newest `image_prompt_attempts` row:
   - `POST /memes/ai/:factId/generate-v2` (with a reference upload)
   - `POST /memes/ai/:factId/generate` (no reference → generic t2i branch)

   In each row, `render_controls` JSONB should now carry **both**:
   - `promptIdentity` → `{ version: 1, name: <reduced>, pronouns, source: "user" }`
     (or `"canonical_fallback"` for an anonymous render), and
   - `resolvedRenderStyle` → `{ version: 1, selection: "default" | "selected", … }`.

   And `rendered_fact_text` must use the **reduced** name (matches
   `promptIdentity.name`), not the full display name.

2. **Worker consumes the frozen snapshot, not a live query.** Let one of those
   attempts run to `prompt_ready` and confirm `compiled_prompt` resolves its
   identity tokens to the reduced name (same as the frozen `promptIdentity`).

3. **Invalid style is rejected up front, not silently dropped.** Deactivate a
   look-style (`look_styles.is_active = false`) and POST a generate with that
   `lookStyleId`. Expect **HTTP 400** `{ error: "style_invalid", reason:
   "inactive" }` — the attempt is NOT enqueued. (Previously the worker silently
   rendered with no style.)

4. **Caption is unaffected.** Confirm the composited meme **caption** still shows
   the FULL stored display name — reduction is scoped to the image-prompt
   pipeline only (`createMemeRecord` / `memeComposite` compute the caption
   independently). This is the safety check that name reduction is safe.

## What is deliberately NOT shipped here

- **Moderation scenario-batch + eval-run renders are unchanged.** They use fixed
  sample identities (already frozen via `reviewRenderSubject` + frozen
  `renderedFactText`) and no live style, so they were already reproducible.
  Their sample fixture names are intentionally **not** reduced (short fixtures,
  no budget pressure, and reducing them would churn moderation idempotency
  hashing / preview display for no correctness gain).
- **No render-time budget gate.** `projectWorstCaseRenderedLength` /
  `PROMPT_IDENTITY_TOKEN_MAX` remain authoring-time only; wiring a render-time
  budget check is a later slice.
- **No schema migration** — snapshots ride in the existing `render_controls`
  JSONB; the worker validates them at read time (`isValidPromptIdentitySnapshot`
  / `isValidRenderStyleSnapshot`) and falls back to the legacy live paths for
  pre-existing rows.

## Delete me

This TEST_RUN is transient — delete it once Replit has run the checklist. The
`PR223_RENDER_REPRODUCIBILITY_UAT.md` sibling is the durable half.
