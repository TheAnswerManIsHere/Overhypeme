import { vi, describe, it, expect, afterEach } from "vitest";

const { mockInit, mockReplayIntegration } = vi.hoisted(() => ({
  mockInit: vi.fn(),
  mockReplayIntegration: vi.fn((opts?: unknown) => ({ name: "Replay", _opts: opts })),
}));

vi.mock("@sentry/react", () => ({
  init: mockInit,
  browserTracingIntegration: () => ({ name: "BrowserTracing" }),
  feedbackIntegration: () => ({ name: "Feedback" }),
  replayIntegration: mockReplayIntegration,
}));

vi.mock("@workspace/redact", async (importOriginal) => {
  return importOriginal<typeof import("@workspace/redact")>();
});

type SentryHooks = {
  integrations: { name: string }[];
  replaysSessionSampleRate: number;
  replaysOnErrorSampleRate: number;
  sendDefaultPii: boolean;
  beforeSend: (event: Record<string, unknown>) => Record<string, unknown> | null;
  beforeSendTransaction: (event: Record<string, unknown>) => Record<string, unknown> | null;
  beforeBreadcrumb: (crumb: Record<string, unknown>) => Record<string, unknown>;
};

async function loadSentry(dropDebugEvents: boolean): Promise<{ mod: typeof import("./sentry"); hooks: SentryHooks }> {
  vi.resetModules();
  vi.stubEnv("VITE_DROP_DEBUG_EVENTS", dropDebugEvents ? "true" : "false");
  mockInit.mockClear();
  mockReplayIntegration.mockClear();
  const mod = await import("./sentry");
  const initArg = mockInit.mock.calls[0][0] as SentryHooks;
  return { mod, hooks: initArg };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("sentry.ts init options", () => {
  it("includes replayIntegration in the integrations array", async () => {
    const { hooks } = await loadSentry(false);
    const names = hooks.integrations.map((i) => i.name);
    expect(names).toContain("Replay");
  });

  it("sets replaysSessionSampleRate to 0.1", async () => {
    const { hooks } = await loadSentry(false);
    expect(hooks.replaysSessionSampleRate).toBe(0.1);
  });

  it("sets replaysOnErrorSampleRate to 1.0", async () => {
    const { hooks } = await loadSentry(false);
    expect(hooks.replaysOnErrorSampleRate).toBe(1.0);
  });

  it("keeps sendDefaultPii as false", async () => {
    const { hooks } = await loadSentry(false);
    expect(hooks.sendDefaultPii).toBe(false);
  });

  it("configures replayIntegration with maskAllInputs: true to protect PII", async () => {
    await loadSentry(false);
    expect(mockReplayIntegration).toHaveBeenCalledOnce();
    expect(mockReplayIntegration).toHaveBeenCalledWith(
      expect.objectContaining({ maskAllInputs: true })
    );
  });

  it("configures replayIntegration with maskAllText: false to preserve replay utility", async () => {
    await loadSentry(false);
    expect(mockReplayIntegration).toHaveBeenCalledWith(
      expect.objectContaining({ maskAllText: false })
    );
  });
});

describe("sentry.ts beforeSend filter", () => {
  it("drops events tagged debug:sentry-test when VITE_DROP_DEBUG_EVENTS=true", async () => {
    const { mod, hooks } = await loadSentry(true);
    mod.markNextEventAsDebugTest();
    const result = hooks.beforeSend({ tags: {} });
    expect(result).toBeNull();
  });

  it("passes events tagged debug:sentry-test through when VITE_DROP_DEBUG_EVENTS=false", async () => {
    const { mod, hooks } = await loadSentry(false);
    mod.markNextEventAsDebugTest();
    const result = hooks.beforeSend({ tags: {} });
    expect(result).not.toBeNull();
    expect((result as Record<string, unknown>).tags).toMatchObject({ debug: "sentry-test" });
  });

  it("passes untagged events through regardless of VITE_DROP_DEBUG_EVENTS=true", async () => {
    const { hooks } = await loadSentry(true);
    const event = { exception: { values: [{ type: "Error", value: "oops" }] } };
    const result = hooks.beforeSend(event);
    expect(result).not.toBeNull();
  });

  it("passes untagged events through regardless of VITE_DROP_DEBUG_EVENTS=false", async () => {
    const { hooks } = await loadSentry(false);
    const event = { exception: { values: [{ type: "Error", value: "oops" }] } };
    const result = hooks.beforeSend(event);
    expect(result).not.toBeNull();
  });

  it("scrubs token from request.url in beforeSend", async () => {
    const { hooks } = await loadSentry(false);
    const event = { request: { url: "https://example.com/api?token=secret&page=1" } };
    const result = hooks.beforeSend(event) as Record<string, { url: string }>;
    expect(result?.request?.url).not.toContain("secret");
    expect(result?.request?.url).toContain("page=1");
  });

  it("scrubs code from request.query_string in beforeSend", async () => {
    const { hooks } = await loadSentry(false);
    const event = { request: { query_string: "code=oauth-val&redirect=%2Fhome" } };
    const result = hooks.beforeSend(event) as Record<string, { query_string: string }>;
    expect(result?.request?.query_string).not.toContain("oauth-val");
    expect(result?.request?.query_string).toContain("redirect=");
  });

  it("removes cookies from request in beforeSend", async () => {
    const { hooks } = await loadSentry(false);
    const event = { request: { cookies: { session: "sess-id" }, url: "/api" } };
    const result = hooks.beforeSend(event) as Record<string, Record<string, unknown>>;
    expect(result?.request?.cookies).toBeUndefined();
  });
});

describe("sentry.ts beforeSendTransaction filter", () => {
  it("scrubs token from request.url in beforeSendTransaction", async () => {
    const { hooks } = await loadSentry(false);
    const event = { request: { url: "https://example.com/track?token=tx-secret&view=home" } };
    const result = hooks.beforeSendTransaction(event) as Record<string, { url: string }>;
    expect(result?.request?.url).not.toContain("tx-secret");
    expect(result?.request?.url).toContain("view=home");
  });

  it("removes Authorization header in beforeSendTransaction", async () => {
    const { hooks } = await loadSentry(false);
    const event = {
      request: { headers: { Authorization: "Bearer tok", "content-type": "application/json" } },
    };
    const result = hooks.beforeSendTransaction(event) as Record<string, { headers: Record<string, string> }>;
    expect(result?.request?.headers?.Authorization).toBeUndefined();
    expect(result?.request?.headers?.["content-type"]).toBe("application/json");
  });

  it("passes transaction events with no sensitive data through unchanged", async () => {
    const { hooks } = await loadSentry(false);
    const event = { request: { url: "https://example.com/facts?page=2" } };
    const result = hooks.beforeSendTransaction(event) as Record<string, { url: string }>;
    expect(result?.request?.url).toBe("https://example.com/facts?page=2");
  });
});

describe("sentry.ts beforeBreadcrumb filter", () => {
  it("scrubs token from breadcrumb data.url", async () => {
    const { hooks } = await loadSentry(false);
    const crumb = { type: "http", data: { url: "https://example.com/api?token=bread-tok&ok=1" } };
    const result = hooks.beforeBreadcrumb(crumb) as Record<string, { url: string }>;
    expect(result?.data?.url).not.toContain("bread-tok");
    expect(result?.data?.url).toContain("ok=1");
  });

  it("scrubs code from breadcrumb data.from in navigation breadcrumbs", async () => {
    const { hooks } = await loadSentry(false);
    const crumb = {
      type: "navigation",
      data: { from: "/callback?code=nav-secret&state=s", to: "/dashboard" },
    };
    const result = hooks.beforeBreadcrumb(crumb) as Record<string, { from: string; to: string }>;
    expect(result?.data?.from).not.toContain("nav-secret");
    expect(result?.data?.to).toBe("/dashboard");
  });

  it("scrubs token from breadcrumb data.to in navigation breadcrumbs", async () => {
    const { hooks } = await loadSentry(false);
    const crumb = {
      type: "navigation",
      data: { from: "/home", to: "/verify?token=magic-link" },
    };
    const result = hooks.beforeBreadcrumb(crumb) as Record<string, { from: string; to: string }>;
    expect(result?.data?.to).not.toContain("magic-link");
    expect(result?.data?.from).toBe("/home");
  });

  it("leaves breadcrumbs with no sensitive params unchanged", async () => {
    const { hooks } = await loadSentry(false);
    const crumb = { type: "http", data: { url: "https://example.com/facts?page=3" } };
    const result = hooks.beforeBreadcrumb(crumb) as Record<string, { url: string }>;
    expect(result?.data?.url).toBe("https://example.com/facts?page=3");
  });

  it("does not throw on breadcrumbs with no data", async () => {
    const { hooks } = await loadSentry(false);
    const crumb = { message: "user clicked button" };
    expect(() => hooks.beforeBreadcrumb(crumb)).not.toThrow();
  });
});
