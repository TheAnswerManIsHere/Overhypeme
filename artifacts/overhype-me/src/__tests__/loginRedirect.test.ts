/**
 * Component-level smoke test: Login.tsx OAuth redirect vs popup.
 *
 * Verifies that the real handleGoogleLogin and handleAppleLogin handlers
 * inside <Login /> use window.location.href (full-page redirect) on mobile /
 * tablet devices and window.open (popup) on desktop browsers.
 *
 * Focused on the iOS 13+ iPad gap — Safari on iPadOS 13+ reports "MacIntel"
 * as platform and relies on maxTouchPoints > 1 for detection.
 */

import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { render, fireEvent, screen } from "@testing-library/react";
import React from "react";

// ── Module mocks (must appear before any dynamic import of Login) ────────────

// Layout: render children only — avoids auth + TanStack Query tree.
vi.mock("@/components/layout/Layout", () => ({
  Layout: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
}));

// PronounEditor: simple stub to avoid complex UI internals.
vi.mock("@/components/ui/PronounEditor", () => ({
  PronounEditor: () => React.createElement("div", { "data-testid": "pronoun-editor" }),
}));

// wouter: stub useLocation so it doesn't need a real router context.
vi.mock("wouter", () => ({
  useLocation: () => ["/login", vi.fn()],
  Link: ({ children, href }: { children: React.ReactNode; href: string }) =>
    React.createElement("a", { href }, children),
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

function mockNavigator(ua: string, platform: string, maxTouchPoints: number) {
  Object.defineProperty(navigator, "userAgent", { value: ua, configurable: true });
  Object.defineProperty(navigator, "platform", { value: platform, configurable: true });
  Object.defineProperty(navigator, "maxTouchPoints", { value: maxTouchPoints, configurable: true });
}

// jsdom doesn't let you assign window.location.href directly, so we replace
// the whole object with a writable one for the duration of each test.
let capturedHref: string | undefined;
let originalLocation: Location;

function stubWindowLocation() {
  capturedHref = undefined;
  originalLocation = window.location;
  Object.defineProperty(window, "location", {
    configurable: true,
    writable: true,
    value: {
      ...originalLocation,
      set href(url: string) { capturedHref = url; },
      get href() { return capturedHref ?? originalLocation.href; },
    },
  });
}

function restoreWindowLocation() {
  Object.defineProperty(window, "location", {
    configurable: true,
    writable: true,
    value: originalLocation,
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("Login.tsx — OAuth button redirect vs popup", () => {
  let openSpy: ReturnType<typeof vi.fn>;

  // Pre-warm the Login module so the cold-import cost is paid once here
  // rather than inside the first test, which risks hitting the 5 s timeout
  // on a loaded CI runner.
  beforeAll(async () => {
    await import("@/pages/Login");
  }, 20000);

  beforeEach(() => {
    openSpy = vi.fn();
    vi.stubGlobal("open", openSpy);
    stubWindowLocation();
  });

  afterEach(() => {
    restoreWindowLocation();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function renderLogin() {
    const { default: Login } = await import("@/pages/Login");
    render(React.createElement(Login));
    return {
      googleBtn: screen.getByRole("button", { name: /continue with google/i }),
      appleBtn: screen.getByRole("button", { name: /continue with apple/i }),
    };
  }

  describe("iOS 13+ iPad (Safari reports MacIntel + maxTouchPoints > 1)", () => {
    const iPadUA =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";

    it("Google button triggers a full-page redirect, not a popup", async () => {
      mockNavigator(iPadUA, "MacIntel", 5);
      const { googleBtn } = await renderLogin();
      fireEvent.click(googleBtn);
      expect(capturedHref).toMatch(/^\/api\/login\/google\?returnTo=/);
      expect(openSpy).not.toHaveBeenCalled();
    });

    it("Apple button triggers a full-page redirect, not a popup", async () => {
      mockNavigator(iPadUA, "MacIntel", 5);
      const { appleBtn } = await renderLogin();
      fireEvent.click(appleBtn);
      expect(capturedHref).toMatch(/^\/api\/login\/apple\?returnTo=/);
      expect(openSpy).not.toHaveBeenCalled();
    });

    it("redirect fires at maxTouchPoints exactly 2 (boundary)", async () => {
      mockNavigator(iPadUA, "MacIntel", 2);
      const { googleBtn } = await renderLogin();
      fireEvent.click(googleBtn);
      expect(capturedHref).toMatch(/^\/api\/login\/google/);
      expect(openSpy).not.toHaveBeenCalled();
    });

    it("does NOT redirect when maxTouchPoints === 1 (real Mac, boundary)", async () => {
      mockNavigator(iPadUA, "MacIntel", 1);
      const { googleBtn } = await renderLogin();
      fireEvent.click(googleBtn);
      expect(capturedHref).toBeUndefined();
      expect(openSpy).toHaveBeenCalledWith(
        expect.stringMatching(/\/api\/login\/google.*popup=1/),
        "_blank",
        expect.stringContaining("width="),
      );
    });
  });

  describe("Android tablet", () => {
    it("Google button triggers a full-page redirect for Android tablet UA", async () => {
      mockNavigator(
        "Mozilla/5.0 (Linux; Android 12; SM-T870) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/109.0.0.0 Safari/537.36",
        "Linux armv8l",
        5,
      );
      const { googleBtn } = await renderLogin();
      fireEvent.click(googleBtn);
      expect(capturedHref).toMatch(/^\/api\/login\/google\?returnTo=/);
      expect(openSpy).not.toHaveBeenCalled();
    });
  });

  describe("Desktop browser → popup (no redirect)", () => {
    it("Google button opens popup on macOS Chrome with maxTouchPoints 0", async () => {
      mockNavigator(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "MacIntel",
        0,
      );
      const { googleBtn } = await renderLogin();
      fireEvent.click(googleBtn);
      expect(capturedHref).toBeUndefined();
      expect(openSpy).toHaveBeenCalledWith(
        expect.stringMatching(/\/api\/login\/google.*popup=1/),
        "_blank",
        expect.stringContaining("width=600"),
      );
    });

    it("Apple button opens popup on Windows Chrome", async () => {
      mockNavigator(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Win32",
        0,
      );
      const { appleBtn } = await renderLogin();
      fireEvent.click(appleBtn);
      expect(capturedHref).toBeUndefined();
      expect(openSpy).toHaveBeenCalledWith(
        expect.stringMatching(/\/api\/login\/apple.*popup=1/),
        "_blank",
        expect.stringContaining("width=600"),
      );
    });
  });
});
