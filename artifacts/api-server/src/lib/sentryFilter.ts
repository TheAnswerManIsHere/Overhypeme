import type { Breadcrumb, Event } from "@sentry/node";
import { scrubObject, scrubUrl } from "@workspace/redact";

/**
 * Request headers monitoring may keep: none can carry a credential. Every
 * other header is dropped, in both places the SDK copies headers to
 * (`event.request.headers`, and the request span's `http.request.header.*`
 * attributes). Closed by default, so a new secret header — the origin secret
 * Cloudflare adds (launch Phase 14, increment 3), the dev preview key, the
 * `sid` session cookie — can never leak by being forgotten (PR #1063 round 1).
 */
export const SAFE_REQUEST_HEADERS: ReadonlySet<string> = new Set([
  "accept",
  "accept-encoding",
  "accept-language",
  "content-length",
  "content-type",
  "host",
  "origin",
  "user-agent",
]);

const SPAN_HEADER_PREFIX = "http.request.header.";

/** Drops every `http.request.header.*` attribute whose header is not on the safe list. */
function scrubSpanHeaders(data: Record<string, unknown> | undefined): void {
  if (!data) return;
  for (const key of Object.keys(data)) {
    if (!key.startsWith(SPAN_HEADER_PREFIX)) continue;
    // The SDK writes `x-foo` as `x_foo`, and a cookie as `cookie.<name>`.
    const header = key.slice(SPAN_HEADER_PREFIX.length).replace(/_/g, "-");
    if (!SAFE_REQUEST_HEADERS.has(header)) delete data[key];
  }
}

export function scrubSentryEvent(event: Event): void {
  scrubSpanHeaders(event.contexts?.trace?.data as Record<string, unknown> | undefined);
  for (const span of event.spans ?? []) scrubSpanHeaders(span.data as Record<string, unknown> | undefined);
  if (event.request) {
    delete event.request.cookies;
    if (event.request.headers) {
      for (const name of Object.keys(event.request.headers)) {
        if (!SAFE_REQUEST_HEADERS.has(name.toLowerCase())) delete event.request.headers[name];
      }
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
}

export function scrubSentryBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb {
  if (breadcrumb.data?.url && typeof breadcrumb.data.url === "string") {
    breadcrumb.data.url = scrubUrl(breadcrumb.data.url);
  }
  if (breadcrumb.data?.from && typeof breadcrumb.data.from === "string") {
    breadcrumb.data.from = scrubUrl(breadcrumb.data.from);
  }
  if (breadcrumb.data?.to && typeof breadcrumb.data.to === "string") {
    breadcrumb.data.to = scrubUrl(breadcrumb.data.to);
  }
  return breadcrumb;
}
