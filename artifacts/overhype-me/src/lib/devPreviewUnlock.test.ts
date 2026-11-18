import { describe, it, expect } from "vitest";
import { takeKeyFromAddress, DEV_PREVIEW_KEY_STORAGE } from "./devPreviewUnlock";

describe("takeKeyFromAddress (launch Phase 14, increment 3)", () => {
  it("stores the key and returns the address without it, keeping everything else", () => {
    const stored: Record<string, string> = {};
    const out = takeKeyFromAddress("https://x.replit.dev/facts/1?devPreviewKey=k3y&tab=2#top", {
      setItem: (k, v) => { stored[k] = v; },
    });
    expect(out).toEqual({ key: "k3y", cleaned: "/facts/1?tab=2#top" });
    expect(stored[DEV_PREVIEW_KEY_STORAGE]).toBe("k3y");
  });

  it("does nothing when the address carries no key", () => {
    const stored: Record<string, string> = {};
    expect(takeKeyFromAddress("https://x.replit.dev/?tab=2", { setItem: (k, v) => { stored[k] = v; } })).toBeNull();
    expect(stored).toEqual({});
  });
});
