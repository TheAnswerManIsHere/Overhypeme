import { describe, it, expect, vi, beforeEach } from "vitest";

const startTelemetry = vi.fn();
vi.mock("./telemetry", () => ({ startTelemetry: () => startTelemetry() }));

import { admitAndStart } from "./admission";

/** A fetch whose response looks as the browser would hand it over. */
function answer(status: number, body: string, opts: { redirected?: boolean; url?: string; type?: string } = {}): typeof fetch {
  return vi.fn(async () => {
    const res = new Response(body, { status, headers: { "content-type": opts.type ?? "application/json" } });
    Object.defineProperty(res, "redirected", { value: opts.redirected ?? false });
    Object.defineProperty(res, "url", { value: opts.url ?? "https://overhype.me/api/admission" });
    return res;
  }) as unknown as typeof fetch;
}

describe("admitAndStart (launch Phase 14, increment 3)", () => {
  const replace = vi.fn();
  const loc = { replace, pathname: "/facts/1" };

  beforeEach(() => vi.clearAllMocks());

  function startedNothing() {
    expect(startTelemetry).not.toHaveBeenCalled();
  }

  it("starts telemetry only on the API's explicit yes (the first page view is held by analytics, not replayed here)", async () => {
    expect(await admitAndStart(answer(200, '{"admitted":true}'), loc)).toBe("admitted");
    expect(startTelemetry).toHaveBeenCalledOnce();
    expect(replace).not.toHaveBeenCalled();
  });

  it("treats Cloudflare's redirect to the explanation page as blocked: sends the visitor there, starts nothing", async () => {
    const redirected = answer(200, "<!doctype html><title>unavailable</title>", {
      redirected: true, url: "https://overhype.me/unavailable", type: "text/html",
    });
    expect(await admitAndStart(redirected, loc)).toBe("blocked");
    expect(replace).toHaveBeenCalledWith("/unavailable");
    startedNothing();
  });

  it("treats the API's 451 as blocked", async () => {
    expect(await admitAndStart(answer(451, '{"error":"region_blocked","admitted":false}'), loc)).toBe("blocked");
    expect(replace).toHaveBeenCalledWith("/unavailable");
    startedNothing();
  });

  it("refuses any other 200: HTML, an empty object, admitted false, malformed JSON", async () => {
    for (const [body, type] of [["<!doctype html><title>app</title>", "text/html"], ["{}", undefined], ['{"admitted":false}', undefined], ['{"admitted":"true"}', undefined], ["not json", undefined]] as const) {
      expect(await admitAndStart(answer(200, body, { type }), loc), body).toBe("refused");
    }
    startedNothing();
    expect(replace).not.toHaveBeenCalled();
  });

  it("refuses a redirect that lands anywhere but the explanation page, even with an admitted body", async () => {
    const elsewhere = answer(200, '{"admitted":true}', { redirected: true, url: "https://overhype.me/somewhere" });
    expect(await admitAndStart(elsewhere, loc)).toBe("refused");
    startedNothing();
    expect(replace).not.toHaveBeenCalled();
  });

  it("starts nothing on a refusal, a server error or a network failure", async () => {
    expect(await admitAndStart(answer(403, '{"error":"not_admitted","admitted":false}'), loc)).toBe("refused");
    expect(await admitAndStart(answer(500, "{}"), loc)).toBe("refused");
    const failing = vi.fn(async () => { throw new TypeError("network"); }) as unknown as typeof fetch;
    expect(await admitAndStart(failing, loc)).toBe("refused");
    startedNothing();
  });
});
