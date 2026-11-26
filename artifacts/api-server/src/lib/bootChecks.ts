/**
 * Configuration assertions that must run before ANY other module is evaluated.
 *
 * **Why this is a side-effecting import rather than a function call in
 * `index.ts`.** ES module imports are all evaluated before the first statement
 * of the importing module runs, so a call placed at the top of `index.ts` runs
 * *after* every module it imports — including `@workspace/db`. That was not a
 * theoretical ordering: until #486, `lib/db/src/migrate.ts` carried a CLI block
 * guarded by `process.argv[1] === fileURLToPath(import.meta.url)`, which is TRUE
 * inside the production bundle (both sides resolve to `dist/index.mjs`), so it
 * opened a pool and ran migrations during module evaluation. A boot check
 * written as a statement in `index.ts` was reached only after all of that —
 * verified by running the built bundle with an unreachable database, which
 * exited on ECONNREFUSED from `migrate.ts` and never reached the statement.
 * #486 moved that block to `migrate-cli.ts`, which is never bundled, but any
 * module in the database graph may still do work as it loads.
 *
 * Being imported first is therefore load-bearing, not stylistic. `index.ts`
 * imports this immediately after `./instrument` — which must stay first so
 * Sentry can patch modules as they load — and before anything else.
 *
 * Keep this module's import graph minimal: only `./ipSalt`, which reaches
 * `node:crypto`, `./env` and `./logger`, `./doubleSelection`, which imports
 * nothing, and `@workspace/db/connection`, which imports nothing. Adding an import that
 * transitively reaches the database would reintroduce exactly the ordering
 * problem described above.
 */

import { assertIpSaltConfigured } from "./ipSalt";
import { assertDoubleSelection } from "./doubleSelection";
import { establishAppDatabaseUrl } from "@workspace/db/connection";

// Throws in production when IP_HASH_SALT is missing or too short; a no-op in
// dev, test and Replit preview.
assertIpSaltConfigured();

// Refuses an unrecognised double selector anywhere, and any double in a
// production boot (lib/doubleSelection.ts) — before the server can listen.
assertDoubleSelection();

// Chooses the application's database login before the database graph loads: in a
// published deployment APP_DATABASE_URL (overhype_app) is required, and the owner's
// credential is then removed from process.env (Launch Phase 15, 5b;
// @workspace/db/connection). Refuses an unsafe shape here, with its reason, rather
// than as a stack trace from the pool's import.
establishAppDatabaseUrl();
