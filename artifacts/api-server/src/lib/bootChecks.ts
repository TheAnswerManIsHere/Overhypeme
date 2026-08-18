/**
 * Configuration assertions that must run before ANY other module is evaluated.
 *
 * **Why this is a side-effecting import rather than a function call in
 * `index.ts`.** ES module imports are all evaluated before the first statement
 * of the importing module runs, so a call placed at the top of `index.ts` runs
 * *after* every module it imports — including `@workspace/db`. That is not a
 * theoretical ordering: in the production bundle, `lib/db/src/migrate.ts` is
 * folded into `dist/index.mjs`, and its `process.argv[1] === fileURLToPath(
 * import.meta.url)` CLI guard is TRUE there (both sides resolve to the bundle),
 * so it opens a pool and runs migrations during module evaluation. A boot check
 * written as a statement in `index.ts` is reached only after all of that has
 * already happened — verified by running the built bundle with an unreachable
 * database, which exits on ECONNREFUSED from `migrate.ts` and never reaches the
 * statement. (That CLI guard misfiring in the bundle is a separate pre-existing
 * bug, tracked apart from this module.)
 *
 * Being imported first is therefore load-bearing, not stylistic. `index.ts`
 * imports this immediately after `./instrument` — which must stay first so
 * Sentry can patch modules as they load — and before anything else.
 *
 * Keep this module's import graph minimal: only `./ipSalt`, which reaches
 * `node:crypto`, `./env` and `./logger` and nothing else. Adding an import that
 * transitively reaches the database would reintroduce exactly the ordering
 * problem described above.
 */

import { assertIpSaltConfigured } from "./ipSalt";

// Throws in production when IP_HASH_SALT is missing or too short; a no-op in
// dev, test and Replit preview.
assertIpSaltConfigured();
