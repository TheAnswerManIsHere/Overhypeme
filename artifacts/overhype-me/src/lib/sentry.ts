import * as Sentry from "@sentry/react";
import { scrubUrl } from "@workspace/redact";

const dsn = import.meta.env.VITE_SENTRY_DSN as string | undefined;
const environment = import.meta.env.PROD ? "production" : "development";
// Release name is injected at build time by vite.config.ts (which derives it
// from REPLIT_DEPLOYMENT_ID / REPLIT_GIT_COMMIT_SHA). The same value is passed
// to the source-map upload plugin so events and maps land under the same
// release in Sentry — that's what makes stack traces symbolicate correctly.
const release = (import.meta.env.VITE_SENTRY_RELEASE as string | undefined) ?? "dev";

// One-shot flag: set before throwing a deliberate test error so that only
// the very next captured event is tagged and dropped. Resets after use,
// so no subsequent unrelated errors are affected.
let _debugTestPending = false;

export function markNextEventAsDebugTest(): void {
  _debugTestPending = true;
}

function scrubSentryEvent(event: Sentry.Event): void {
  if (event.request?.cookies) delete event.request.cookies;
  if (event.request?.headers) {
    delete event.request.headers.Authorization;
    delete event.request.headers.Cookie;
  }
  if (typeof event.request?.url === "string") {
    event.request.url = scrubUrl(event.request.url, window.location.origin);
  }
  if (typeof event.request?.query_string === "string") {
    event.request.query_string = scrubUrl(`?${event.request.query_string}`, window.location.origin).replace(/^\?/, "");
  }
}

Sentry.init({
  dsn,
  environment,
  release,
  tracesSampleRate: environment === "production" ? 0.1 : 1.0,
  sendDefaultPii: false,
  integrations: [
    Sentry.browserTracingIntegration(),
    Sentry.feedbackIntegration({
      colorScheme: "system",
    }),
    Sentry.replayIntegration({
      maskAllInputs: true,
      maskAllText: false,
    }),
  ],
  replaysSessionSampleRate: 0.1,
  replaysOnErrorSampleRate: 1.0,
  // Same-origin-only: propagate trace headers to relative /api/ paths only.
  // We never want to send tracing headers to third-party domains (Stripe,
  // Resend, fal.ai, etc.) — that would leak our trace IDs and trip CORS.
  tracePropagationTargets: [/^\/api\//],
  beforeSend(event) {
    if (_debugTestPending) {
      _debugTestPending = false;
      event.tags = { ...event.tags, debug: "sentry-test" };
      if (import.meta.env.VITE_DROP_DEBUG_EVENTS === "true") {
        return null;
      }
    }
    scrubSentryEvent(event);
    return event;
  },
  beforeSendTransaction(event) {
    scrubSentryEvent(event);
    return event;
  },
  beforeBreadcrumb(breadcrumb) {
    if (breadcrumb.data?.url && typeof breadcrumb.data.url === "string") {
      breadcrumb.data.url = scrubUrl(breadcrumb.data.url, window.location.origin);
    }
    if (breadcrumb.data?.from && typeof breadcrumb.data.from === "string") {
      breadcrumb.data.from = scrubUrl(breadcrumb.data.from, window.location.origin);
    }
    if (breadcrumb.data?.to && typeof breadcrumb.data.to === "string") {
      breadcrumb.data.to = scrubUrl(breadcrumb.data.to, window.location.origin);
    }
    return breadcrumb;
  },
});

if (!dsn) {
  // eslint-disable-next-line no-console
  console.log("[sentry] VITE_SENTRY_DSN not set — error reporting disabled");
}

export { Sentry };
