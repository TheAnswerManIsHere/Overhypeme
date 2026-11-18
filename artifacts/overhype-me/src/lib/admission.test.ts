import { describe, it, expect, vi, beforeEach } from "vitest";

const startMonitoring = vi.fn();
const trackPageView = vi.fn();
vi.mock("./sentry", () => ({ startMonitoring: () => startMonitoring() }));
vi.mock("./analytics", () => ({ trackPageView: (...a: unknown[]) => trackPageView(...a) }));

import { admitAndStart } from "./admission";

function answer(status: number): typeof fetch {
  return vi.fn(async () => new Response("{}", { status })) as unknown as typeof fetch;
}

describe("admitAndStart (launch Phase 14, increment 3)", () => {
  const startAnalytics = vi.fn();
  const startAds = vi.fn();
  const replace = vi.fn();
  const loc = { replace, pathname: "/facts/1" };

  beforeEach(() => {
    vi.clearAllMocks();
    window.__ohStartAnalytics = startAnalytics;
    window.__ohStartAds = startAds;
  });

  it("starts monitoring, analytics and ads only on a 200, and records the first page view", async () => {
    expect(await admitAndStart(answer(200), loc)).toBe("admitted");
    expect(startMonitoring).toHaveBeenCalledOnce();
    expect(startAnalytics).toHaveBeenCalledOnce();
    expect(startAds).toHaveBeenCalledOnce();
    expect(trackPageView).toHaveBeenCalledWith("/facts/1", expect.any(String));
    expect(replace).not.toHaveBeenCalled();
  });

  it("sends a visitor from a place the site does not serve to the explanation page, starting nothing", async () => {
    expect(await admitAndStart(answer(451), loc)).toBe("blocked");
    expect(replace).toHaveBeenCalledWith("/unavailable");
    expect(startMonitoring).not.toHaveBeenCalled();
    expect(startAnalytics).not.toHaveBeenCalled();
    expect(startAds).not.toHaveBeenCalled();
  });

  it("starts nothing on a refusal, a server error or a network failure", async () => {
    expect(await admitAndStart(answer(403), loc)).toBe("refused");
    expect(await admitAndStart(answer(500), loc)).toBe("refused");
    const failing = vi.fn(async () => { throw new TypeError("network"); }) as unknown as typeof fetch;
    expect(await admitAndStart(failing, loc)).toBe("refused");
    expect(startMonitoring).not.toHaveBeenCalled();
    expect(startAnalytics).not.toHaveBeenCalled();
    expect(startAds).not.toHaveBeenCalled();
    expect(trackPageView).not.toHaveBeenCalled();
  });
});
