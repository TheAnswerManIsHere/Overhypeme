/**
 * @purpose Proves the name tag shows only pronouns someone chose (identity-flow Phase 4, #856): signed out, only what the visitor or a share link supplied and never the rendering fallback; signed in, the account's own pronouns or none, whatever the browser copy holds.
 * @subsystem public-site
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { NameTag } from "./NameTag";

let person = { name: "", pronouns: "he/him", pronounsSupplied: false };
let auth: { user: unknown; isAuthenticated: boolean; isLoading: boolean } = { user: null, isAuthenticated: false, isLoading: false };

vi.mock("@/hooks/use-person-name", () => ({
  usePersonName: () => ({ ...person, pronounSubject: "he", pronounObject: "him", setName: vi.fn(), setPronouns: vi.fn() }),
}));
vi.mock("@workspace/replit-auth-web", () => ({ useAuth: () => auth }));
vi.mock("wouter", () => ({ useLocation: () => ["/m/abc", vi.fn()] }));

function tag() {
  render(<NameTag />);
  return screen.getByTitle(/change name|edit your profile/i);
}

beforeEach(() => {
  person = { name: "", pronouns: "he/him", pronounsSupplied: false };
  auth = { user: null, isAuthenticated: false, isLoading: false };
});

describe("NameTag, signed out", () => {
  it("with no identity shows no name and no pronouns: never the he/him fallback", () => {
    const el = tag();
    expect(el.textContent).not.toMatch(/he\/him/);
    expect(el.textContent).not.toMatch(/\(/);
  });

  it("with a name and no pronouns shows the name alone", () => {
    person = { name: "Sarah", pronouns: "he/him", pronounsSupplied: false };
    const el = tag();
    expect(el.textContent).toContain("Sarah");
    expect(el.textContent).not.toMatch(/\(/);
  });

  it("shows a supplied he/him, and a custom set in its display form", () => {
    person = { name: "Bob", pronouns: "he/him", pronounsSupplied: true };
    expect(tag().textContent).toContain("(he/him)");
  });

  it("shows a custom set in its display form", () => {
    person = { name: "Kai", pronouns: "xe|xem|xyr|xyrs|xemself|s", pronounsSupplied: true };
    expect(tag().textContent).toContain("(xe/xem)");
  });
});

describe("NameTag, signed in: the account's pronouns, or none", () => {
  function signedIn(account: { displayName?: string | null; pronouns?: string | null }) {
    auth = { user: { id: "u1", ...account }, isAuthenticated: true, isLoading: false };
  }

  it("shows the account's pronouns", () => {
    signedIn({ displayName: "Ada", pronouns: "she/her" });
    person = { name: "Ada", pronouns: "she/her", pronounsSupplied: true };
    expect(tag().textContent).toContain("(she/her)");
  });

  it("shows none for an account without pronouns, even when the browser holds supplied ones", () => {
    signedIn({ displayName: "Ada", pronouns: null });
    person = { name: "Ada", pronouns: "she/her", pronounsSupplied: true };
    expect(tag().textContent).not.toMatch(/\(/);
  });

  it("shows a nameless account's saved pronouns on a cold browser", () => {
    signedIn({ displayName: null, pronouns: "she/her" });
    person = { name: "", pronouns: "he/him", pronounsSupplied: false };
    const el = tag();
    expect(el.textContent).toContain("(she/her)");
    expect(el.textContent).not.toMatch(/he\/him/);
  });

  it("shows the account's pronouns when the browser copy disagrees", () => {
    signedIn({ displayName: "Ada", pronouns: "they/them" });
    person = { name: "Ada", pronouns: "she/her", pronounsSupplied: true };
    const el = tag();
    expect(el.textContent).toContain("(they/them)");
    expect(el.textContent).not.toContain("she/her");
  });
});
