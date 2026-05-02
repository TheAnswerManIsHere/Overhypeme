import * as Sentry from "@sentry/node";
import { scrubSentryEvent, scrubSentryBreadcrumb } from "./lib/sentryFilter.js";
import { installStdioGuard } from "./lib/stdioGuard.js";

// Install the stdio guard before anything else can write to process.stdout /
// process.stderr. This absorbs EIO / EPIPE / ERR_STREAM_DESTROYED on those
// streams so a torn-down parent pipe (workflow restart, terminal disconnect,
// container log-pipe overrun) does not become an uncaughtException that kills
// the process. Safe to call repeatedly — this also covers scripts under
// scripts/ that import instrument.ts directly.
installStdioGuard();

// Sentry v10 emits a console warning when expressIntegration() can't verify
// that its OTel shim patched express — this always happens in a bundled ESM
// binary because esbuild inlines all modules, so there are no separate
// require('express') calls for the shim to intercept. The warning is cosmetic:
// error capture works correctly via setupExpressErrorHandler() in app.ts. We
// suppress only this one specific message so dev logs stay clean.
const _origWarn = console.warn.bind(console);
console.warn = (...args: unknown[]) => {
  const msg = typeof args[0] === "string" ? args[0] : "";
  if (msg.includes("express is not instrumented")) return;
  _origWarn(...args);
};

const dsn = process.env.SENTRY_DSN_BACKEND;
const environment = process.env.NODE_ENV === "production" ? "production" : "development";
const release =
  process.env.REPLIT_DEPLOYMENT_ID ??
  process.env.REPLIT_GIT_COMMIT_SHA?.slice(0, 7) ??
  "dev";

Sentry.init({
  dsn,
  environment,
  release,
  tracesSampleRate: environment === "production" ? 0.1 : 1.0,
  sendDefaultPii: false,
  integrations: [
    Sentry.httpIntegration(),
    Sentry.expressIntegration(),
    Sentry.postgresIntegration(),
  ],
  beforeSend(event) {
    if (
      process.env.SENTRY_DROP_DEBUG_EVENTS === "true" &&
      event.tags?.["debug"] === "sentry-test"
    ) {
      return null;
    }
    scrubSentryEvent(event);
    return event;
  },
  beforeSendTransaction(event) {
    scrubSentryEvent(event);
    return event;
  },
  beforeBreadcrumb(breadcrumb) {
    return scrubSentryBreadcrumb(breadcrumb);
  },
});

if (!dsn) {
  console.log("[sentry] SENTRY_DSN_BACKEND not set — error reporting disabled");
}
