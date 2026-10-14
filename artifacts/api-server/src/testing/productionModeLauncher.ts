/**
 * Boots the real API server in production mode with one thing replaced: the
 * email transport, which writes each message to a directory instead of
 * sending it through Resend.
 *
 * This is the test-harness half of the Phase 2 selection rule (launch plan,
 * `docs/ai-context/launch-definition.md` and #631): a deployment-selectable
 * double is chosen at boot by configuration, but this substitution is not
 * selectable at all — it exists only because this file imports the app and
 * installs it. The deployment entrypoint (`index.ts`, the only esbuild entry)
 * never imports this directory, which `__tests__/testHarnessIsolation.test.ts`
 * enforces.
 *
 * The replacement sits below the email queue: registration enqueues the
 * verification email as an async job, the worker claims it and the job handler
 * runs exactly as in production, and only the final send lands in the sink.
 *
 *   env -i PATH="$PATH" HOME="$HOME" NODE_ENV=production PORT=8081 DATABASE_URL=… \
 *   IP_HASH_SALT=… CRON_SECRET=… SITE_BASE_URL=http://localhost:5174 \
 *   ALLOWED_ORIGINS=http://localhost:5174 E2E_MAIL_SINK_DIR=/tmp/overhype-mail \
 *   node --import tsx/esm src/testing/productionModeLauncher.ts
 *
 * `env -i` and `node` rather than `pnpm exec`: pnpm adds its own variables, and
 * the launcher refuses anything outside `PRODUCTION_MODE_ENV_ALLOWLIST`.
 */
import { testDatabaseRefusal } from "@workspace/db/test-database";

import { allowlistRefusals, PRODUCTION_MODE_ENV_ALLOWLIST } from "./launchEnvironment";
import { productionModeRefusals } from "./productionModeGuard";

// The environment is constructed from a named list (Phase 2, increment 6, plan
// D3): any other variable, a vendor key above all, is refused here, beside the
// guard's own refusals, which keep the Resend rule and its specific message.
const databaseRefusal = await testDatabaseRefusal(process.env);
const refusals = [
  ...productionModeRefusals(process.env),
  ...allowlistRefusals(process.env, PRODUCTION_MODE_ENV_ALLOWLIST, "production-mode launcher"),
  ...(databaseRefusal ? [databaseRefusal] : []),
];
if (refusals.length > 0) {
  process.stderr.write(
    `[production-mode launcher] refusing to start:\n${refusals.map((r) => `  - ${r}`).join("\n")}\n`,
  );
  process.exit(1);
}

// Only after the refusals: these imports reach the database module graph.
const { installEmailTransportForTestHarness } = await import("../lib/email");
const { createMailSink } = await import("./mailSink");
installEmailTransportForTestHarness(createMailSink(process.env.E2E_MAIL_SINK_DIR!));

await import("../index");
