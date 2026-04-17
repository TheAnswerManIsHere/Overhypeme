import * as Sentry from "@sentry/react";

const dsn = import.meta.env.VITE_SENTRY_DSN as string | undefined;
const environment = import.meta.env.PROD ? "production" : "development";
const release = (import.meta.env.VITE_SENTRY_RELEASE as string | undefined) ?? "dev";

const SENSITIVE_KEY_PATTERNS = [
  /pass(word)?/i, /token/i, /secret/i, /api[_-]?key/i,
  /authoriz/i, /session/i, /cookie/i, /email/i, /otp/i, /code/i, /signature/i,
];
const isSensitiveKey = (k: string) => SENSITIVE_KEY_PATTERNS.some((re) => re.test(k));

function scrubUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl, window.location.origin);
    let mutated = false;
    for (const key of [...url.searchParams.keys()]) {
      if (isSensitiveKey(key)) { url.searchParams.set(key, "[Filtered]"); mutated = true; }
    }
    if (!mutated) return rawUrl;
    if (rawUrl.startsWith("/")) return `${url.pathname}${url.search}${url.hash}`;
    return url.toString();
  } catch {
    return rawUrl;
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
  ],
  // Same-origin-only: propagate trace headers to relative /api/ paths only.
  // We never want to send tracing headers to third-party domains (Stripe,
  // Resend, fal.ai, etc.) — that would leak our trace IDs and trip CORS.
  tracePropagationTargets: [/^\/api\//],
  beforeSend(event) {
    if (event.request?.cookies) delete event.request.cookies;
    if (event.request?.headers) {
      delete event.request.headers.Authorization;
      delete event.request.headers.Cookie;
    }
    if (typeof event.request?.url === "string") {
      event.request.url = scrubUrl(event.request.url);
    }
    if (typeof event.request?.query_string === "string") {
      event.request.query_string = scrubUrl(`?${event.request.query_string}`).replace(/^\?/, "");
    }
    return event;
  },
});

if (!dsn) {
  // eslint-disable-next-line no-console
  console.log("[sentry] VITE_SENTRY_DSN not set — error reporting disabled");
}

export { Sentry };
