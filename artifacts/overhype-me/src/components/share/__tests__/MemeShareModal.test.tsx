/**
 * Phase-6 share modal component tests.
 *
 * Verifies the runtime-detection button-set switch (Share vs Email), the
 * fire-and-forget intent log (failures don't block the user's share), and
 * the Web Share API integration (AbortError is silent; other errors fall
 * back to a toast).
 */
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";

// vi.mock factories are hoisted above all imports, so any spies they
// reference must be created via vi.hoisted (which is also hoisted).
const { toastSpy, trackEventSpy } = vi.hoisted(() => ({
  toastSpy: vi.fn(),
  trackEventSpy: vi.fn(),
}));
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: toastSpy }),
}));
vi.mock("@/lib/analytics", () => ({
  trackEvent: trackEventSpy,
}));

import { MemeShareModal } from "@/components/share/MemeShareModal";

// ── Test fixtures ─────────────────────────────────────────────────────────
const SLUG = "abc123";
const FALLBACK = "https://example.test/m/abc123";

// ── navigator mocking helpers ─────────────────────────────────────────────
function withWebShare(impl: (data: ShareData) => Promise<void>) {
  Object.defineProperty(navigator, "share", { value: impl, configurable: true, writable: true });
}
function withoutWebShare() {
  // jsdom doesn't ship navigator.share; the property is non-optional in TS
  // lib.dom but missing at runtime. Setting to undefined matches what the
  // runtime check (`typeof navigator.share === "function"`) expects.
  Object.defineProperty(navigator, "share", { value: undefined, configurable: true, writable: true });
}

let originalClipboard: Clipboard | undefined;
function withClipboard(impl: (text: string) => Promise<void>) {
  originalClipboard = navigator.clipboard;
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: impl },
    configurable: true,
    writable: true,
  });
}
function restoreClipboard() {
  if (originalClipboard !== undefined) {
    Object.defineProperty(navigator, "clipboard", {
      value: originalClipboard,
      configurable: true,
      writable: true,
    });
  }
}

// ── fetch mock ────────────────────────────────────────────────────────────
let fetchSpy: ReturnType<typeof vi.fn>;
function mockFetch(handler: (url: string, init?: RequestInit) => unknown) {
  fetchSpy = vi.fn(async (url: string, init?: RequestInit) => {
    const result = await handler(url, init);
    if (result instanceof Response) return result;
    return new Response(JSON.stringify(result ?? {}), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchSpy);
}

beforeEach(() => {
  toastSpy.mockReset();
  trackEventSpy.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  withoutWebShare();
  restoreClipboard();
});

// ── Helpers ───────────────────────────────────────────────────────────────
async function renderOpen(props: Partial<React.ComponentProps<typeof MemeShareModal>> = {}) {
  const onClose = vi.fn();
  const utils = render(
    <MemeShareModal
      open
      onClose={onClose}
      slug={SLUG}
      fallbackPermalink={FALLBACK}
      {...props}
    />,
  );
  // The Web-Share-support probe runs in a useEffect — flush it before assertions.
  await act(async () => { await Promise.resolve(); });
  return { ...utils, onClose };
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("MemeShareModal — button-set detection", () => {
  it("renders Share / Twitter / Copy Link when navigator.share is supported", async () => {
    withWebShare(async () => undefined);
    mockFetch(() => ({}));
    await renderOpen();
    expect(screen.getByTestId("share-modal-web-share")).toBeTruthy();
    expect(screen.queryByTestId("share-modal-email")).toBeNull();
    expect(screen.getByTestId("share-modal-twitter")).toBeTruthy();
    expect(screen.getByTestId("share-modal-copy-link")).toBeTruthy();
  });

  it("renders Email / Twitter / Copy Link when navigator.share is NOT supported", async () => {
    withoutWebShare();
    mockFetch(() => ({}));
    await renderOpen();
    expect(screen.getByTestId("share-modal-email")).toBeTruthy();
    expect(screen.queryByTestId("share-modal-web-share")).toBeNull();
    expect(screen.getByTestId("share-modal-twitter")).toBeTruthy();
    expect(screen.getByTestId("share-modal-copy-link")).toBeTruthy();
  });
});

describe("MemeShareModal — Web Share button", () => {
  it("invokes navigator.share with server-provided copy and logs intent", async () => {
    const shareSpy = vi.fn(async () => undefined);
    withWebShare(shareSpy);
    mockFetch((url) => {
      if (url.includes("/api/share-copy/")) {
        return { platform: "web_share", url: FALLBACK, title: "Alice on overhype.me", text: "did a thing" };
      }
      return {}; // intent-log POST
    });

    const { onClose } = await renderOpen();
    await act(async () => {
      fireEvent.click(screen.getByTestId("share-modal-web-share"));
    });
    await waitFor(() => expect(shareSpy).toHaveBeenCalled());

    expect(shareSpy).toHaveBeenCalledWith({
      title: "Alice on overhype.me",
      text: "did a thing",
      url: FALLBACK,
    });
    expect(trackEventSpy).toHaveBeenCalledWith("share_intent", { meme_id: SLUG, platform: "web_share" });
    expect(onClose).toHaveBeenCalled();
    // The intent POST is fire-and-forget; assert one was issued.
    const intentCall = fetchSpy.mock.calls.find(([u]) => u === "/api/share-intents");
    expect(intentCall).toBeTruthy();
  });

  it("is silent when the user dismisses the share sheet (AbortError)", async () => {
    const abort = Object.assign(new Error("dismissed"), { name: "AbortError" });
    withWebShare(async () => { throw abort; });
    mockFetch(() => ({}));

    await renderOpen();
    await act(async () => {
      fireEvent.click(screen.getByTestId("share-modal-web-share"));
    });
    await waitFor(() => expect(toastSpy).not.toHaveBeenCalled());
  });

  it("falls back to a generic toast on non-Abort errors", async () => {
    withWebShare(async () => { throw new Error("permission denied"); });
    mockFetch(() => ({}));

    await renderOpen();
    await act(async () => {
      fireEvent.click(screen.getByTestId("share-modal-web-share"));
    });
    await waitFor(() => expect(toastSpy).toHaveBeenCalled());
    const payload = toastSpy.mock.calls[0]?.[0] as { variant?: string };
    expect(payload?.variant).toBe("destructive");
  });
});

describe("MemeShareModal — Twitter button", () => {
  it("opens the server-built intent URL in a new tab and logs intent", async () => {
    withWebShare(async () => undefined);
    const openSpy = vi.fn();
    vi.stubGlobal("open", openSpy);

    const intentUrl = `https://twitter.com/intent/tweet?text=hi&url=${encodeURIComponent(FALLBACK)}&hashtags=overhype`;
    mockFetch((url) => {
      if (url.includes("/api/share-copy/")) {
        return { platform: "twitter", url: FALLBACK, text: "hi", hashtags: ["overhype"], intentUrl };
      }
      return {};
    });

    const { onClose } = await renderOpen();
    await act(async () => {
      fireEvent.click(screen.getByTestId("share-modal-twitter"));
    });
    await waitFor(() => expect(openSpy).toHaveBeenCalled());

    expect(openSpy).toHaveBeenCalledWith(intentUrl, "_blank", "noopener,noreferrer");
    expect(onClose).toHaveBeenCalled();
    expect(trackEventSpy).toHaveBeenCalledWith("share_intent", { meme_id: SLUG, platform: "twitter" });
  });

  it("falls back to a minimal Twitter intent URL when the server fetch fails", async () => {
    withWebShare(async () => undefined);
    const openSpy = vi.fn();
    vi.stubGlobal("open", openSpy);

    mockFetch((url) => {
      if (url.includes("/api/share-copy/")) {
        return new Response("server error", { status: 500 });
      }
      return {};
    });

    await renderOpen();
    await act(async () => {
      fireEvent.click(screen.getByTestId("share-modal-twitter"));
    });
    await waitFor(() => expect(openSpy).toHaveBeenCalled());

    const calledUrl = openSpy.mock.calls[0]?.[0] as string;
    expect(calledUrl).toContain("https://twitter.com/intent/tweet");
    expect(calledUrl).toContain(encodeURIComponent(FALLBACK));
  });
});

describe("MemeShareModal — Copy Link button", () => {
  it("writes the permalink to clipboard and shows a toast", async () => {
    withWebShare(async () => undefined);
    const writeSpy = vi.fn(async () => undefined);
    withClipboard(writeSpy);
    mockFetch((url) => {
      if (url.includes("/api/share-copy/")) {
        return { platform: "copy_link", url: FALLBACK };
      }
      return {};
    });

    const { onClose } = await renderOpen();
    await act(async () => {
      fireEvent.click(screen.getByTestId("share-modal-copy-link"));
    });
    await waitFor(() => expect(writeSpy).toHaveBeenCalledWith(FALLBACK));

    expect(toastSpy).toHaveBeenCalled();
    const payload = toastSpy.mock.calls[0]?.[0] as { title?: string };
    expect(payload?.title).toMatch(/copied/i);
    expect(onClose).toHaveBeenCalled();
    expect(trackEventSpy).toHaveBeenCalledWith("share_intent", { meme_id: SLUG, platform: "copy_link" });
  });
});

describe("MemeShareModal — fire-and-forget intent logging", () => {
  it("does NOT block the share action when /api/share-intents fails", async () => {
    const shareSpy = vi.fn(async () => undefined);
    withWebShare(shareSpy);
    mockFetch((url) => {
      if (url === "/api/share-intents") {
        return new Response("server down", { status: 500 });
      }
      if (url.includes("/api/share-copy/")) {
        return { platform: "web_share", url: FALLBACK, title: "x", text: "y" };
      }
      return {};
    });

    const { onClose } = await renderOpen();
    await act(async () => {
      fireEvent.click(screen.getByTestId("share-modal-web-share"));
    });
    // The Web Share invocation must still happen and the modal must still close.
    await waitFor(() => expect(shareSpy).toHaveBeenCalled());
    expect(onClose).toHaveBeenCalled();
  });
});
