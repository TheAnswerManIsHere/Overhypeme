import * as Sentry from "@sentry/node";
import { scrubObject, scrubUrl } from "@workspace/redact";

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
    if (event.request) {
      delete event.request.cookies;
      if (event.request.headers) {
        delete event.request.headers.authorization;
        delete event.request.headers.cookie;
        delete event.request.headers["x-api-key"];
      }
      if (typeof event.request.url === "string") {
        event.request.url = scrubUrl(event.request.url);
      }
      if (typeof event.request.query_string === "string") {
        event.request.query_string = scrubUrl(`?${event.request.query_string}`).replace(/^\?/, "");
      }
      if (event.request.data && typeof event.request.data === "object") {
        event.request.data = scrubObject(event.request.data) as typeof event.request.data;
      }
    }
    return event;
  },
});

if (!dsn) {
  console.log("[sentry] SENTRY_DSN_BACKEND not set — error reporting disabled");
}
