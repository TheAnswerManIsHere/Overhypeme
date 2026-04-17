import { vi, describe, it, expect, afterEach } from "vitest";

const { mockInit } = vi.hoisted(() => ({
  mockInit: vi.fn(),
}));

vi.mock("@sentry/react", () => ({
  init: mockInit,
  browserTracingIntegration: () => ({}),
  feedbackIntegration: () => ({}),
}));

vi.mock("@workspace/redact", () => ({
  scrubUrl: (url: string) => url,
}));

type BeforeSend = (event: Record<string, unknown>) => Record<string, unknown> | null;

async function loadSentry(dropDebugEvents: boolean) {
  vi.resetModules();
  vi.stubEnv("VITE_DROP_DEBUG_EVENTS", dropDebugEvents ? "true" : "false");
  mockInit.mockClear();
  const mod = await import("./sentry");
  const beforeSend = mockInit.mock.calls[0][0].beforeSend as BeforeSend;
  return { mod, beforeSend };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("sentry.ts beforeSend filter", () => {
  it("drops events tagged debug:sentry-test when VITE_DROP_DEBUG_EVENTS=true", async () => {
    const { mod, beforeSend } = await loadSentry(true);
    mod.markNextEventAsDebugTest();
    const result = beforeSend({ tags: {} });
    expect(result).toBeNull();
  });

  it("passes events tagged debug:sentry-test through when VITE_DROP_DEBUG_EVENTS=false", async () => {
    const { mod, beforeSend } = await loadSentry(false);
    mod.markNextEventAsDebugTest();
    const result = beforeSend({ tags: {} });
    expect(result).not.toBeNull();
    expect((result as Record<string, unknown>).tags).toMatchObject({ debug: "sentry-test" });
  });

  it("passes untagged events through regardless of VITE_DROP_DEBUG_EVENTS=true", async () => {
    const { mod: _mod, beforeSend } = await loadSentry(true);
    const event = { exception: { values: [{ type: "Error", value: "oops" }] } };
    const result = beforeSend(event);
    expect(result).not.toBeNull();
  });

  it("passes untagged events through regardless of VITE_DROP_DEBUG_EVENTS=false", async () => {
    const { mod: _mod, beforeSend } = await loadSentry(false);
    const event = { exception: { values: [{ type: "Error", value: "oops" }] } };
    const result = beforeSend(event);
    expect(result).not.toBeNull();
  });
});
