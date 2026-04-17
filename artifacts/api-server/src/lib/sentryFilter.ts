import type { Breadcrumb, Event } from "@sentry/node";
import { scrubObject, scrubUrl } from "@workspace/redact";

export function scrubSentryEvent(event: Event): void {
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
