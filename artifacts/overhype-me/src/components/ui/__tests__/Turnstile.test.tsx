import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, waitFor, act } from "@testing-library/react";
import { createRef } from "react";
import { Turnstile, type TurnstileHandle, __resetTurnstileLoaderForTests, TURNSTILE_SITE_KEY } from "../Turnstile";

type RenderOptions = Record<string, unknown> & { callback: (t: string) => void; "expired-callback": () => void };

function installFakeTurnstile() {
  const api = {
    render: vi.fn((_el: HTMLElement, _opts: RenderOptions) => "widget-1"),
    reset: vi.fn(),
    remove: vi.fn(),
  };
  window.turnstile = api;
  return api;
}

describe("Turnstile", () => {
  beforeEach(() => {
    __resetTurnstileLoaderForTests();
    delete window.turnstile;
    document.head.querySelectorAll("script[src*='challenges.cloudflare.com']").forEach((s) => s.remove());
  });

  it("injects Cloudflare's script once, in explicit-render mode, however many widgets mount", async () => {
    render(<><Turnstile onVerify={() => {}} /><Turnstile onVerify={() => {}} /></>);
    const scripts = document.head.querySelectorAll("script[src*='challenges.cloudflare.com']");
    expect(scripts).toHaveLength(1);
    expect((scripts[0] as HTMLScriptElement).src).toBe("https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit");
  });

  it("renders with the site key and reports the token, then clears it on expiry", async () => {
    const api = installFakeTurnstile();
    const onVerify = vi.fn();
    const onExpire = vi.fn();
    render(<Turnstile onVerify={onVerify} onExpire={onExpire} size="compact" />);
    await waitFor(() => expect(api.render).toHaveBeenCalledTimes(1));
    const opts = api.render.mock.calls[0][1];
    expect(opts.sitekey).toBe(TURNSTILE_SITE_KEY);
    expect(opts.size).toBe("compact");
    act(() => opts.callback("tok-abc"));
    expect(onVerify).toHaveBeenCalledWith("tok-abc");
    act(() => opts["expired-callback"]());
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it("reset() asks Cloudflare for a fresh token on the same widget, and unmount removes it", async () => {
    const api = installFakeTurnstile();
    const ref = createRef<TurnstileHandle>();
    const { unmount } = render(<Turnstile ref={ref} onVerify={() => {}} />);
    await waitFor(() => expect(api.render).toHaveBeenCalled());
    ref.current?.reset();
    expect(api.reset).toHaveBeenCalledWith("widget-1");
    unmount();
    expect(api.remove).toHaveBeenCalledWith("widget-1");
  });

  it("falls back to Cloudflare's always-pass test key when none is configured", () => {
    expect(TURNSTILE_SITE_KEY).toBe(import.meta.env.VITE_TURNSTILE_SITE_KEY || "1x00000000000000000000AA");
  });
});
