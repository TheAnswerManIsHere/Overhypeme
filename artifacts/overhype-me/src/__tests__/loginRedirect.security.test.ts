/**
 * Regression: the post-login redirect target must never leave our origin.
 *
 * `?from=` is attacker-controllable, and before this suite it flowed
 * unvalidated into `window.location.href` on a successful local login —
 * a post-authentication open redirect, and script execution for a
 * `javascript:` value.
 *
 * These are deliberately component-level rather than unit tests of
 * `getSafeReturnTo`: the unit tests in `src/lib/safe-return-to.test.ts` prove
 * the validator is correct, but they would all still pass if someone unwired
 * it from `getFromParam`. This suite pins the sink itself.
 */

import { describe, it, expect, afterEach, beforeEach, beforeAll, vi } from "vitest";
import { render, fireEvent, screen, waitFor } from "@testing-library/react";
import React from "react";

vi.mock("@/components/layout/Layout", () => ({
  Layout: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
}));

vi.mock("@/components/ui/PronounEditor", () => ({
  PronounEditor: () => React.createElement("div", { "data-testid": "pronoun-editor" }),
}));

vi.mock("wouter", () => ({
  useLocation: () => ["/login", vi.fn()],
  Link: ({ children, href }: { children: React.ReactNode; href: string }) =>
    React.createElement("a", { href }, children),
}));

let capturedHref: string | undefined;
let originalLocation: Location;

/** Replace window.location with a writable stub whose `search` we control. */
function stubWindowLocation(search: string) {
  capturedHref = undefined;
  originalLocation = window.location;
  Object.defineProperty(window, "location", {
    configurable: true,
    writable: true,
    value: {
      ...originalLocation,
      search,
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

/** A successful /api/auth/local-login response. */
function stubSuccessfulLogin() {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ ok: true }),
  }));
}

async function submitLogin(search: string) {
  stubWindowLocation(search);
  stubSuccessfulLogin();
  const { default: Login } = await import("@/pages/Login");
  render(React.createElement(Login));

  // The email/password inputs have visual labels but no htmlFor/id pairing,
  // so query by placeholder rather than label.
  fireEvent.change(screen.getByPlaceholderText("your@email.com"), {
    target: { value: "someone@example.com" },
  });
  fireEvent.change(screen.getByPlaceholderText("Enter your password"), {
    target: { value: "correct-horse-battery" },
  });
  fireEvent.click(screen.getByRole("button", { name: /sign in/i }));

  await waitFor(() => expect(capturedHref).toBeDefined());
  return capturedHref;
}

describe("Login.tsx — post-login redirect target", () => {
  beforeAll(async () => {
    await import("@/pages/Login");
  }, 20000);

  beforeEach(() => {
    vi.stubGlobal("scrollTo", vi.fn());
  });

  afterEach(() => {
    restoreWindowLocation();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("honours a legitimate same-origin path", async () => {
    expect(await submitLogin("?from=/facts/123")).toBe("/facts/123");
  });

  it("falls back to / for an absolute URL on another origin", async () => {
    expect(await submitLogin("?from=https://evil.com")).toBe("/");
  });

  it("falls back to / for a protocol-relative URL", async () => {
    expect(await submitLogin("?from=//evil.com")).toBe("/");
  });

  it("never assigns a javascript: URL to location.href", async () => {
    const href = await submitLogin("?from=javascript:alert(document.domain)");
    expect(href).toBe("/");
    expect(href).not.toContain("javascript:");
  });

  it("falls back to / for a backslash-smuggled foreign host", async () => {
    expect(await submitLogin("?from=/\\evil.com")).toBe("/");
  });

  it("falls back to / when no from param is present", async () => {
    expect(await submitLogin("")).toBe("/");
  });
});
