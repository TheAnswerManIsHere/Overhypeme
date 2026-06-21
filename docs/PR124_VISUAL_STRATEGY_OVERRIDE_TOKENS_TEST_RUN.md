# Moderator override token UX (chips · {NAME_POSSESSIVE} · rendered preview) — automated test run

Paired with **`docs/PR124_VISUAL_STRATEGY_OVERRIDE_TOKENS_UAT.md`** (the
click-through for David). Engineering safety net for Replit. **Replit owns the database
connection** — this change is pure code (no schema, no migration); don't add any
connection string from here.

## TL;DR

```
# api-zod must be built so api-server picks up the allowlist/canonicalization change
pnpm tsc -p lib/api-zod/tsconfig.json

# api-server suites (from artifacts/api-server)
node --import tsx/esm --test --test-concurrency=1 \
  src/__tests__/renderCanonical.test.ts \
  src/__tests__/visualStrategyOverride.test.ts \
  src/__tests__/nanoBanana2Compiler.test.ts \
  src/__tests__/templateGrammar.test.ts            # all green

# frontend (from artifacts/overhype-me)
npx vitest run src/components/admin                 # 18 tests, incl. the new token suite
```

## What this is

A **polish pass** on the moderator Visual Strategy Override panel (shipped in
PR #114). The token-aware rendering architecture already exists — override text
is validated by `validateTemplate`, canonicalized by `canonicalizeNameToken`,
merged into the compiler's labeled sections, and rendered per-viewer by
`renderPersonalized`. This PR closes three remaining gaps:

1. **`{NAME_POSSESSIVE}`** — a possessive-name token. Always appends `'s`
   (David's, Chris's, James's — a deliberate product choice, no `Chris'`
   branching).
2. **Token chips** — a one-click legend in the override panel that inserts a
   token at the caret of the last-focused token-capable field.
3. **Rendered fact text** — surfaces the already-computed `renderedFactText` in
   the Runtime Prompt Preview.

## Backend changes (source-of-truth sweep)

1. **`lib/api-zod/src/templateGrammar.ts`** — `NAME_POSSESSIVE` added to
   `ALLOWED_SIMPLE_TOKENS`, so `validateTemplate` (and the override save-time
   `superRefine`) accept it.
2. **`artifacts/api-server/src/lib/renderCanonical.ts`**:
   - new `possessive(name)` helper — always `name + "'s"` (empty → empty);
   - `NAME_POSSESSIVE` added to `TOKEN_MAP` (→ `Alex's`) and to the per-viewer
     `parsePronounMap` (→ `possessive(name)`);
   - both token regexes (`UNRESOLVED_FACT_TOKEN_RE`,
     `SUBJECT_IDENTITY_TOKEN_RE`) now include `NAME_POSSESSIVE`;
   - the subject-name semantic-entity guard now matches the canonical
     **possessive** rendered form too: `CANONICAL_SUBJECT_NAME_FORMS_LC` =
     `{ "alex", "alex's" }`, used by `isSubjectNameSemanticEntity`. **Exact-match
     only** — multi-word referents (`Alex Honnold`, `Alex Honnold's climb`) are
     preserved (PR #111 behavior).
3. **`lib/api-zod/src/visualStrategyOverride.ts`**:
   - `canonicalizeNameToken` now also normalizes possessive aliases
     (`{name_possessive}`/`{Name_Possessive}`/… → `{NAME_POSSESSIVE}`);
   - `canonicalizeOverrideTokens` now canonicalizes `roleBindings.entity` (it was
     already collected as rendered+validated text by `collectRenderedTexts`, but
     its aliases weren't being normalized — an inconsistency, now fixed);
   - the schema error copy mentions `{NAME_POSSESSIVE}`.

## Frontend changes

4. **`artifacts/overhype-me/src/components/admin/EnrichmentEditor.tsx`**:
   - `OVERRIDE_TOKEN_CHIPS` legend + the field-agnostic
     `insertTokenIntoTextControl(el, token)` helper (native value setter +
     bubbling `input` event so React's controlled `onChange` runs; replaces a
     selected range; restores caret in `requestAnimationFrame`);
   - chips carry `onMouseDown.preventDefault()` so a click doesn't steal focus
     from the target field; clipboard fallback when no token-capable field is
     focused (never a silent no-op / unhandled rejection);
   - only token-capable fields are marked `data-token-insert-target="true"`
     (every `StringListEditor` list, subject-realization description, both
     role-binding inputs, supporting-text + violence guidance). **Moderator
     Intent is excluded** (admin-only, never rendered);
   - helper + warning copy mention `{NAME_POSSESSIVE}`.
5. **`artifacts/overhype-me/src/components/admin/RuntimePromptPreview.tsx`** —
   renders `result.renderedFactText` as a read-only **"Rendered fact text
   (sample subject)"** block (`data-testid="rpp-rendered-fact"`) above the
   compiled prompt, with copy clarifying it reflects **fact-template** tokens
   only.

## Test assertions to confirm

- **`renderCanonical.test.ts`**
  - `renderCanonical("{NAME_POSSESSIVE}")` → `Alex's`.
  - `renderPersonalized("{NAME_POSSESSIVE}", "David Franklin", "he/him")` →
    `David Franklin's`; `"Chris"`/`"James"` → `Chris's`/`James's` (always `'s`);
    pronoun-independent.
  - `hasUnresolvedFactTokens` / `hasSubjectIdentityToken` recognize
    `{NAME_POSSESSIVE}`.
  - `isSubjectNameSemanticEntity({ surfaceText: "Alex's" })` → **true**;
    `"Alex Honnold's climb"` → **false**.
- **`visualStrategyOverride.test.ts`**
  - `{NAME_POSSESSIVE}` validates across the token-capable field categories;
    `{name_possessive}`/`{Name_Possessive}` canonicalize; `roleBindings.entity`
    aliases canonicalize; unknown tokens still fail with a clear message.
- **`nanoBanana2Compiler.test.ts`**
  - `{NAME_POSSESSIVE}` renders inside `requiredVisualDetails` (and a supporting
    text directive) → `Chris's …` with **no** residual `{NAME_POSSESSIVE}`; the
    existing `{NAME}`/pronoun override test still passes.
- **`VisualStrategyOverrideTokens.test.tsx`** (frontend)
  - `OVERRIDE_TOKEN_CHIPS` equals the intended set (drift guard);
  - helper inserts at caret + replaces a selected range;
  - chip click inserts `{NAME_POSSESSIVE}` into the focused Required Visual
    Details field and propagates upward; Moderator Intent is not a target; chip
    `mousedown` is prevented; `roleBindings.entity` canonicalizes
    `{name_possessive}` aliases.

## Not changed / out of scope

- Per-field inline rendered previews (safe to defer).
- "Semantic AI-prose suppression" (the *other* item PR #114 deferred).
- Any raw final-prompt override workflow.
- No shared exported token constant from `api-zod` yet — the chip list is
  duplicated locally and pinned by a coverage test instead (deferred to avoid
  import-cycle risk).
- No schema, migration, or stored-data change.

## Typecheck note

`pnpm tsc` in `overhype-me` / `api-server` reports **pre-existing** errors in
untouched files (`Home.tsx`, `Library.tsx`, `users.ts`, `videos.ts`) and
`TS6305` build-order errors for unbuilt sibling `dist/` (`lib/db`,
`lib/api-client-react`). None reference the files this PR touches — verify with
`pnpm tsc -p tsconfig.json --noEmit 2>&1 | grep -iE 'EnrichmentEditor|RuntimePromptPreview|renderCanonical|visualStrategyOverride|templateGrammar'`
(returns nothing).
