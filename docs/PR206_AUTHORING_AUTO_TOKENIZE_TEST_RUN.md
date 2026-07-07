# PR206 — Auto-tokenize admin Visual-Concept authoring · TEST_RUN

> Engineering/automated checklist for Replit (the technical safety net).
> Companion click-through doc: `docs/PR206_AUTHORING_AUTO_TOKENIZE_UAT.md`.
> This doc is transient — delete it once it's been run and confirmed passing.

## What changed (for context, not to re-derive)

- New shared tokenizer core `tokenizePlainTextToTemplate` in
  `artifacts/api-server/src/lib/factTokenizer.ts` — extracted verbatim from
  `/ai/tokenize-fact`'s inline logic, now shared with a new admin-only batch
  route `POST /api/ai/tokenize-enrichment`.
- Path-aware VSO collector/writeback helpers added to
  `lib/api-zod/src/visualStrategyOverride.ts`
  (`collectRenderedTextEntries`, `isVisualStrategyRenderedTextPath`,
  `getVisualStrategyRenderedTextKind`, `setRenderedTextAtPath`,
  `normalizeRoleEntity`), replacing a private string-only collector.
- New schema-level `superRefine` backstop rejecting a `{…}` personalization
  token in `roleBindings[i].entity`.
- `useDraftForm.ts` gained `saveValue(next)` (fixes a real stale-ref bug) and
  made `setValue` update its ref synchronously.
- `useFactEnrichmentEditing.ts` gained `tokenizeAndSaveVisualOverride`,
  `vsoTokenizing`, `vsoTokenizeErrors` — the one save path every VSO surface
  now calls.
- `EnrichmentEditor.tsx` gained a narrow Save-disable exception
  (`isFixableRoleEntityTokenIssue`) and `disabled`/`fieldErrors` props on
  `VisualStrategyOverridePanel`; the role `entity` input is no longer a
  token-chip target and no longer canonicalizes typed tokens.
- No schema/data migration — `visualPromptStrategyOverride` is unchanged
  shape; only new validation on top of it.

## No database changes

There is no migration in this PR. Nothing to apply, nothing to check
against the schema. Skip straight to the test commands.

## Commands to run

From the repo root:

```
pnpm run typecheck
```
Expect: clean (0 errors) across `typecheck:libs`, `api-server`,
`overhype-me`, and `scripts`.

```
pnpm --filter @workspace/api-server test
```
Expect: **1041 tests passing, 0 failures** (sharded run — the total is the
sum across shards; watch for `# fail 0` on every shard and
`[test-db] ... result=pass` at the end). This includes:
- `factTokenizer.test.ts` — core parity with the old inline tokenize logic,
  `skipLlm` truth table, `isAlreadyTokenizedNoPlainName` /
  `hasNoLikelySubjectReference` truth tables (brace-masking, word-boundary,
  <3-char-name exclusion), the `visual_strategy` subject-names user-message
  hint (JSON-encoded, never raw-interpolated).
- `visualStrategyOverride.test.ts` — `collectRenderedTextEntries` path/kind
  list, `setRenderedTextAtPath`'s index-tolerant no-op contract,
  `normalizeRoleEntity` cases, and the schema's rejection of a `{NAME}`
  token in `roleBindings[].entity` with the exact machine-recognizable
  message the frontend gate depends on.
- `routes.ai.test.ts` — the new `/ai/tokenize-enrichment` route: 401/403
  admin gate, no captcha, 400-before-any-LLM-call on an oversized batch, an
  unknown path, and a path/kind mismatch (an entity path lying about its
  own kind); empty-value passthrough; skip-LLM computation; entity
  rejection; grammar-error surfacing; result-order preservation under
  bounded concurrency. Uses the injectable `__setTokenizeCoreForTest` seam —
  **no live OpenAI key needed for these to pass.**

```
cd artifacts/overhype-me && npx vitest run
```
Expect: **790 tests passing, 0 failures across 72 files.** Notably:
- `useDraftForm.test.tsx` — the stale-ref regression test
  (`setValue(next)` + `save()` back-to-back no longer commits the pre-edit
  value), `saveValue(next)`'s atomic adopt-before-commit behavior, and
  reconciliation against a fake server-canonical return value.
- `useFactEnrichmentEditing.test.tsx` — the full
  `tokenizeAndSaveVisualOverride` behavior: diffs only changed entries,
  hits the batch route then the correct PATCH endpoint (both fact and
  review-candidate targets), a same-click Save persists the *tokenized*
  value (not stale plain English), a hashtag-only edit still persists
  through the VSO save path, mixed hashtag+VSO edits persist both, an
  error blocks the PATCH and leaves the draft dirty, and a stale tokenize
  response from an abandoned target can't corrupt the now-active one.
- `EnrichmentEditor.test.tsx` — `isFixableRoleEntityTokenIssue` against the
  *real* `validateEnrichment` error-string format (one positive + three
  negative cases, plus a check that a broad `visualPromptStrategyOverride:`
  prefix does NOT match).
- `VisualStrategyOverrideTokens.test.tsx` / `VisualConceptCard.test.tsx` —
  the entity field is no longer a chip target and no longer canonicalizes a
  typed token; `disabled`/tokenize-error rendering on both VSO surfaces.

```
pnpm run check:docs
```
Expect: clean. `docs/ADMIN_FIELD_REFERENCE.md` was regenerated in this PR
from the updated `fieldDocs/visualStrategy.ts` — confirm the diff there is
prose-only (tooltip wording), no field/key additions or removals.

## Gotchas

- The api-server test suite **must** run via
  `pnpm --filter @workspace/api-server test` (the sharded runner with its
  own isolated DB clones), not a bare `node --test`. A handful of unrelated,
  pre-existing tests (`asyncJobs worker`, `CSRF + Origin protection`,
  `deliverFromOutbox`) fail when run outside the sharded harness due to
  shared global state — that's a pre-existing test-isolation quirk, not
  something this PR introduced or touches.
- `/ai/tokenize-enrichment` genuinely calls the tokenizer model on a real
  admin request (unlike its route tests, which fake the core). If you
  manually poke it with curl, expect a live OpenAI round trip.

## What's deliberately not shipped

- A scene-aware tokenizer prompt specialized for Visual Strategy prose (the
  fact-shaped prompt is reused, with a subject-names hint appended).
- A hard server-side block on a second *named* character appearing in
  prose fields (mitigated by the authoring rule + tooltips, not enforced).
- Any backfill/migration of existing VSO content — old fields keep whatever
  tokens or plain text they already had until next edited and saved.
