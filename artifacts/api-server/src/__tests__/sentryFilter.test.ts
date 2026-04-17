import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Event, Breadcrumb } from "@sentry/node";
import { scrubSentryEvent, scrubSentryBreadcrumb } from "../lib/sentryFilter.js";

describe("scrubSentryEvent – request.url", () => {
  it("replaces a token query param in request.url with [Filtered]", () => {
    const event: Event = {
      request: { url: "https://api.example.com/auth/callback?token=abc123&redirect=%2Fdashboard" },
    };
    scrubSentryEvent(event);
    assert.ok(event.request?.url?.includes("token=%5BFiltered%5D"), "token must be filtered");
    assert.ok(event.request?.url?.includes("redirect="), "redirect must be preserved");
    assert.ok(!event.request?.url?.includes("abc123"), "token value must not appear");
  });

  it("replaces a code query param in request.url with [Filtered]", () => {
    const event: Event = {
      request: { url: "https://api.example.com/oauth?code=oauth-code-xyz&state=st" },
    };
    scrubSentryEvent(event);
    assert.ok(!event.request?.url?.includes("oauth-code-xyz"), "code value must not appear");
    assert.ok(event.request?.url?.includes("state=st"), "state must be preserved");
  });

  it("replaces an email query param in request.url with [Filtered]", () => {
    const event: Event = {
      request: { url: "https://api.example.com/verify?email=alice%40example.com&step=1" },
    };
    scrubSentryEvent(event);
    assert.ok(!event.request?.url?.includes("alice"), "email value must not appear");
    assert.ok(event.request?.url?.includes("step=1"), "step must be preserved");
  });

  it("leaves request.url untouched when no sensitive params are present", () => {
    const url = "https://api.example.com/facts?page=2&sort=desc";
    const event: Event = { request: { url } };
    scrubSentryEvent(event);
    assert.equal(event.request?.url, url);
  });
});

describe("scrubSentryEvent – request.query_string", () => {
  it("replaces a token in query_string with [Filtered]", () => {
    const event: Event = {
      request: { query_string: "token=secret-tok&page=3" },
    };
    scrubSentryEvent(event);
    assert.ok(!(event.request?.query_string as string)?.includes("secret-tok"), "token value must not appear");
    assert.ok(
      (event.request?.query_string as string).includes("page=3"),
      "page must be preserved",
    );
  });

  it("replaces a password in query_string with [Filtered]", () => {
    const event: Event = {
      request: { query_string: "password=hunter2&user=alice" },
    };
    scrubSentryEvent(event);
    assert.ok(!(event.request?.query_string as string)?.includes("hunter2"), "password value must not appear");
    assert.ok(
      (event.request?.query_string as string).includes("user=alice"),
      "user must be preserved",
    );
  });
});

describe("scrubSentryEvent – header scrubbing", () => {
  it("deletes the authorization header", () => {
    const event: Event = {
      request: {
        headers: { authorization: "Bearer secret", "content-type": "application/json" },
      },
    };
    scrubSentryEvent(event);
    assert.equal(event.request?.headers?.authorization, undefined);
    assert.equal(event.request?.headers?.["content-type"], "application/json");
  });

  it("deletes the x-api-key header", () => {
    const event: Event = {
      request: { headers: { "x-api-key": "key-abc", host: "api.example.com" } },
    };
    scrubSentryEvent(event);
    assert.equal(event.request?.headers?.["x-api-key"], undefined);
    assert.equal(event.request?.headers?.host, "api.example.com");
  });

  it("deletes cookies from the request", () => {
    const event: Event = {
      request: { cookies: { session: "sess-id" } as Record<string, string> },
    };
    scrubSentryEvent(event);
    assert.equal(event.request?.cookies, undefined);
  });
});

describe("scrubSentryEvent – request.data body scrubbing", () => {
  it("redacts password fields in request.data", () => {
    const event: Event = {
      request: { data: { username: "alice", password: "s3cr3t" } },
    };
    scrubSentryEvent(event);
    const data = event.request?.data as Record<string, unknown>;
    assert.equal(data.password, "[Filtered]");
    assert.equal(data.username, "alice");
  });
});

describe("scrubSentryEvent – no request", () => {
  it("does not throw when event has no request object", () => {
    const event: Event = { message: "boom" };
    assert.doesNotThrow(() => scrubSentryEvent(event));
  });
});

describe("scrubSentryBreadcrumb – url field", () => {
  it("replaces token in breadcrumb data.url with [Filtered]", () => {
    const breadcrumb: Breadcrumb = {
      type: "http",
      data: { url: "https://api.example.com/auth?token=tok123&ok=1", method: "GET" },
    };
    scrubSentryBreadcrumb(breadcrumb);
    assert.ok(!breadcrumb.data?.url?.includes("tok123"), "token value must not appear");
    assert.ok(breadcrumb.data?.url?.includes("ok=1"), "non-sensitive param must be preserved");
  });

  it("leaves breadcrumb data.url untouched when no sensitive params", () => {
    const url = "https://api.example.com/facts?page=1";
    const breadcrumb: Breadcrumb = { type: "http", data: { url } };
    scrubSentryBreadcrumb(breadcrumb);
    assert.equal(breadcrumb.data?.url, url);
  });
});

describe("scrubSentryBreadcrumb – from/to navigation fields", () => {
  it("replaces code param in navigation data.from with [Filtered]", () => {
    const breadcrumb: Breadcrumb = {
      type: "navigation",
      data: {
        from: "/callback?code=oauth-secret&state=s",
        to: "/dashboard",
      },
    };
    scrubSentryBreadcrumb(breadcrumb);
    assert.ok(!breadcrumb.data?.from?.includes("oauth-secret"), "code value must not appear in from");
    assert.equal(breadcrumb.data?.to, "/dashboard");
  });

  it("replaces token param in navigation data.to with [Filtered]", () => {
    const breadcrumb: Breadcrumb = {
      type: "navigation",
      data: {
        from: "/home",
        to: "/verify?token=magic-link",
      },
    };
    scrubSentryBreadcrumb(breadcrumb);
    assert.ok(!breadcrumb.data?.to?.includes("magic-link"), "token value must not appear in to");
    assert.equal(breadcrumb.data?.from, "/home");
  });
});

describe("scrubSentryBreadcrumb – no data", () => {
  it("does not throw when breadcrumb has no data", () => {
    const breadcrumb: Breadcrumb = { message: "user clicked button" };
    assert.doesNotThrow(() => scrubSentryBreadcrumb(breadcrumb));
  });
});
