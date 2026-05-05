import { describe, it, expect, afterEach, vi } from "vitest";
import { isMobileDevice } from "./utils";

function mockNavigator(overrides: {
  userAgent?: string;
  platform?: string;
  maxTouchPoints?: number;
}) {
  Object.defineProperty(navigator, "userAgent", {
    value: overrides.userAgent ?? "",
    configurable: true,
  });
  Object.defineProperty(navigator, "platform", {
    value: overrides.platform ?? "",
    configurable: true,
  });
  Object.defineProperty(navigator, "maxTouchPoints", {
    value: overrides.maxTouchPoints ?? 0,
    configurable: true,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("isMobileDevice()", () => {
  describe("phone user-agents (legacy regex path)", () => {
    it("returns true for an iPhone UA", () => {
      mockNavigator({
        userAgent:
          "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15",
        platform: "iPhone",
        maxTouchPoints: 5,
      });
      expect(isMobileDevice()).toBe(true);
    });

    it("returns true for an iPod UA", () => {
      mockNavigator({
        userAgent:
          "Mozilla/5.0 (iPod touch; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15",
        platform: "iPhone",
        maxTouchPoints: 5,
      });
      expect(isMobileDevice()).toBe(true);
    });

    it("returns true for a pre-iOS-13 iPad UA (contains 'iPad' in userAgent)", () => {
      mockNavigator({
        userAgent:
          "Mozilla/5.0 (iPad; CPU OS 12_0 like Mac OS X) AppleWebKit/605.1.15",
        platform: "iPad",
        maxTouchPoints: 5,
      });
      expect(isMobileDevice()).toBe(true);
    });
  });

  describe("Android tablet user-agents", () => {
    it("returns true for an Android tablet UA", () => {
      mockNavigator({
        userAgent:
          "Mozilla/5.0 (Linux; Android 12; SM-T870) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/109.0.0.0 Safari/537.36",
        platform: "Linux armv8l",
        maxTouchPoints: 5,
      });
      expect(isMobileDevice()).toBe(true);
    });

    it("returns true for a generic Android phone UA", () => {
      mockNavigator({
        userAgent:
          "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Mobile Safari/537.36",
        platform: "Linux armv8l",
        maxTouchPoints: 5,
      });
      expect(isMobileDevice()).toBe(true);
    });
  });

  describe("iPad on iOS 13+ (reports as Macintosh in Safari)", () => {
    it("returns true when platform is MacIntel and maxTouchPoints > 1", () => {
      mockNavigator({
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
        platform: "MacIntel",
        maxTouchPoints: 5,
      });
      expect(isMobileDevice()).toBe(true);
    });

    it("returns true when platform is Macintosh and maxTouchPoints > 1", () => {
      mockNavigator({
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
        platform: "Macintosh",
        maxTouchPoints: 5,
      });
      expect(isMobileDevice()).toBe(true);
    });

    it("returns true even when maxTouchPoints is exactly 2", () => {
      mockNavigator({
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15",
        platform: "MacIntel",
        maxTouchPoints: 2,
      });
      expect(isMobileDevice()).toBe(true);
    });
  });

  describe("real desktop Mac (should NOT be treated as mobile)", () => {
    it("returns false for a Mac with maxTouchPoints === 0", () => {
      mockNavigator({
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        platform: "MacIntel",
        maxTouchPoints: 0,
      });
      expect(isMobileDevice()).toBe(false);
    });

    it("returns false for a Mac with maxTouchPoints === 1 (boundary)", () => {
      mockNavigator({
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        platform: "MacIntel",
        maxTouchPoints: 1,
      });
      expect(isMobileDevice()).toBe(false);
    });
  });

  describe("desktop Windows and Linux", () => {
    it("returns false for a Windows desktop UA", () => {
      mockNavigator({
        userAgent:
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        platform: "Win32",
        maxTouchPoints: 0,
      });
      expect(isMobileDevice()).toBe(false);
    });

    it("returns false for a Linux desktop UA", () => {
      mockNavigator({
        userAgent:
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        platform: "Linux x86_64",
        maxTouchPoints: 0,
      });
      expect(isMobileDevice()).toBe(false);
    });
  });
});
