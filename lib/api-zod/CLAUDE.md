# Working in `lib/api-zod`

## Codegen owns `src/index.ts` — verify new exports immediately

The full gotcha and procedure live in the shared source of truth:
[`known-failure-patterns.md`](../../docs/ai-context/known-failure-patterns.md)'s
"Manual `api-zod/src/index.ts` export silently reverted by codegen." Restating
it here would create the exact divergent-copy risk the migration this file is
part of exists to avoid — read it there, not a private summary of it.

`pnpm run check:codegen-drift` is the CI guard.
