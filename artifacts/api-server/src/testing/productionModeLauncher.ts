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
 *   NODE_ENV=production PORT=8081 DATABASE_URL=… IP_HASH_SALT=… CRON_SECRET=… \
 *   SITE_BASE_URL=http://localhost:5174 ALLOWED_ORIGINS=http://localhost:5174 \
 *   E2E_MAIL_SINK_DIR=/tmp/overhype-mail pnpm exec tsx src/testing/productionModeLauncher.ts
 */
import { productionModeRefusals } from "./productionModeGuard";

const refusals = productionModeRefusals(process.env);
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
