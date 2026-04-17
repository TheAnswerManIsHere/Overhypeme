import * as Sentry from "@sentry/node";

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

// Keys that should be redacted whether they appear in request bodies, query
// strings, or nested objects. Match is case-insensitive and substring-based so
// "passwordConfirm", "csrfToken", "userEmail", etc. are all caught.
const SENSITIVE_KEY_PATTERNS = [
  /pass(word)?/i,
  /token/i,
  /secret/i,
  /api[_-]?key/i,
  /authoriz/i,
  /session/i,
  /cookie/i,
  /email/i,
  /otp/i,
  /code/i,
  /signature/i,
];

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERNS.some((re) => re.test(key));
}

function scrubObject(value: unknown, depth = 0): unknown {
  if (depth > 6 || value == null) return value;
  if (Array.isArray(value)) return value.map((v) => scrubObject(v, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = isSensitiveKey(k) ? "[Filtered]" : scrubObject(v, depth + 1);
    }
    return out;
  }
  return value;
}

// Strip sensitive query parameters from a URL. Returns the URL with redacted
// params, or the original string if it can't be parsed.
function scrubUrl(rawUrl: string): string {
  try {
    // URL needs an absolute base when given a path-only URL.
    const base = "http://internal.invalid";
    const url = new URL(rawUrl, base);
    let mutated = false;
    for (const key of [...url.searchParams.keys()]) {
      if (isSensitiveKey(key)) {
        url.searchParams.set(key, "[Filtered]");
        mutated = true;
      }
    }
    if (!mutated) return rawUrl;
    // Preserve original form: relative if it started relative, absolute otherwise.
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
    Sentry.httpIntegration(),
    Sentry.expressIntegration(),
    Sentry.postgresIntegration(),
  ],
  beforeSend(event) {
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
