# Working in `lib/api-zod`

## Codegen owns `src/index.ts` — verify new exports immediately

- **`lib/api-zod` exports: verify against codegen immediately, not later.**
  `lib/api-spec/patch-generated.mjs` owns `lib/api-zod/src/index.ts` and
  rewrites it from a hardcoded line list on every codegen run — a hand-added
  `export * from "./newModule"` survives typecheck and targeted tests but gets
  silently wiped the next time anything runs
  `pnpm --filter @workspace/api-spec run codegen` (which `pretest` does),
  surfacing later as a broad, unrelated-looking wave of test failures (see
  [`known-failure-patterns.md`](../../docs/ai-context/known-failure-patterns.md)'s
  "Manual `api-zod/src/index.ts` export silently reverted by codegen" — I've
  now hit this twice, most recently on PR #228). So: the moment I add a new
  file under `lib/api-zod/src/` or a new export to an existing one, I add the
  line to `patch-generated.mjs`'s `apiZodIndexLines` **and** run codegen once
  right then to confirm `git diff --exit-code lib/api-zod/src/index.ts` is
  clean — before writing a single consumer of that export, not deferred to
  "when I run the full suite later." (`pnpm run check:codegen-drift` runs this
  exact check; CI runs the same script, so local and merge-gate can't drift.)

