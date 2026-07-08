---
name: Zod nested superRefine issue paths join with dots, not brackets
description: validateEnrichment-style flat error strings render an array index as ".0." not "[0]." — verify empirically before writing a path-matching regex against them.
---

# `path.join(".")` on a Zod issue path renders an array index as `.0.`, never `[0]`

When a schema with its own `superRefine` (e.g. `visualPromptStrategyOverrideSchema`)
is nested inside a parent object field (`factEnrichmentSchema`'s
`visualPromptStrategyOverride: visualPromptStrategyOverrideSchema.optional()`)
and the child's `ctx.addIssue({ path: ["roleBindings", i, "entity"] })` fires,
Zod prepends the parent field name to the issue's path automatically. The
*array index inside that path stays a bare number in the path array* — so a
naive assumption that it renders as bracket notation
(`roleBindings[0].entity`) is wrong. Verified empirically:

```js
["visualPromptStrategyOverride", "roleBindings", 0, "entity"].join(".")
// → "visualPromptStrategyOverride.roleBindings.0.entity"
```

**Durable lesson:** if you're writing a message-matching filter against a
flattened Zod error string (the `${path.join(".")}: ${message}` pattern used
by `validateEnrichment`'s `EnrichmentValidationResult.error`), don't guess the
separator/notation from how the *frontend* addresses the same field (which
may use bracket notation, e.g. `roleBindings[0].entity`, for its own
path-based collectors). Write a throwaway Node script that actually
`safeParse`s a minimal repro through the real nested schema and inspect
`result.error.issues` before hand-writing the regex — the two notations look
similar enough to typo past a review.

**Where this showed up:** `EnrichmentEditor.tsx`'s
`isFixableRoleEntityTokenIssue` (PR #206) — the Save-disable gate's narrow
exception filter needed to match `validateEnrichment`'s actual error-string
format, which uses `roleBindings.0.entity` (dots), while
`collectRenderedTextEntries`'s own path convention (a *different*, frontend
authoring-side helper) uses `roleBindings[0].entity` (brackets) for
`setRenderedTextAtPath`. Both conventions are real and correct — they're just
not the same thing, because they come from different code paths (Zod's
built-in path-array joiner vs. a hand-written path-string builder).
