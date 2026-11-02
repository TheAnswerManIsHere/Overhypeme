/**
 * The one onboarding screen (launch Phase 5, increment 3, #795; plan S22).
 *
 * @purpose Proves the display-name precedence (draft, the account's own display name, the browser's name, blank; a provider first name never counts) and that the browser copy is updated only after the account re-read lands, the pronoun precedence (draft, account, device for an account with none, name suggestion, blank), the client's age arithmetic to the day, that a reload brings the saved draft back into the form, that a date under 13 shows the refusal and keeps Finish disabled, and that Finish posts every field with the challenge token.
 * @subsystem accounts-auth
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import Onboard, { ageFromParts, initialDisplayName, initialPronouns } from "./Onboard";

const setLocation = vi.fn();
const syncFromProfile = vi.fn();
let refreshLands = true;
vi.mock("wouter", () => ({ useLocation: () => ["/onboard", setLocation] }));
vi.mock("@workspace/replit-auth-web", () => ({
  useAuth: () => ({ isAuthenticated: true, isLoading: false, refreshUser: vi.fn(async () => refreshLands) }),
}));
vi.mock("@/hooks/use-person-name", () => ({
  usePersonName: () => ({ name: "Sarah", pronouns: "they/them", pronounsSupplied: false, syncFromProfile }),
}));
vi.mock("@/components/ui/Turnstile", async () => {
  const React = await import("react");
  return {
    Turnstile: React.forwardRef(function T(props: { onVerify: (t: string) => void }, _ref) {
      return <button data-testid="turnstile-pass" onClick={() => props.onVerify("tok-1")}>pass</button>;
    }),
  };
});

describe("initialDisplayName — identity-flow Phase 2's precedence", () => {
  const blank = { draft: null, displayName: null };
  it("the saved draft first, so a reload resumes an edit", () => {
    expect(initialDisplayName({ draft: { displayName: "Sarah C" }, displayName: "Sarah" }, { name: "Sal" })).toBe("Sarah C");
  });
  it("then the account's own display name", () => {
    expect(initialDisplayName({ ...blank, displayName: "Sarah" }, { name: "Sal" })).toBe("Sarah");
  });
  it("then the browser's name — a provider first name never displaces it", () => {
    // providerFirstName is not an input at all: the account's displayName is null.
    expect(initialDisplayName(blank, { name: " Sal " })).toBe("Sal");
  });
  it("else blank", () => {
    expect(initialDisplayName(blank, { name: "" })).toBe("");
  });
});

describe("initialPronouns — plan S22's precedence", () => {
  const blank = { draft: null, accountPronouns: null, name: null };
  it("the draft wins over everything", () => {
    expect(initialPronouns({ ...blank, draft: { pronouns: "xe/xem" }, accountPronouns: "he/him", name: "Sarah" }, { pronouns: "she/her", supplied: true })).toBe("xe/xem");
  });
  it("then the account's stored choice, shown for confirmation", () => {
    expect(initialPronouns({ ...blank, accountPronouns: "he/him", name: "Sarah" }, { pronouns: "she/her", supplied: true })).toBe("he/him");
  });
  it("then the device's own choice, for an account with none", () => {
    expect(initialPronouns({ ...blank, name: "Sarah" }, { pronouns: "they/them", supplied: true })).toBe("they/them");
  });
  it("a device value the visitor never supplied is not a choice", () => {
    expect(initialPronouns({ ...blank, name: "Sarah" }, { pronouns: "he/him", supplied: false })).toBe("she/her");
  });
  it("then the name suggestion, else blank and required", () => {
    expect(initialPronouns({ ...blank, name: "Sarah" }, { pronouns: "", supplied: false })).toBe("she/her");
    expect(initialPronouns({ ...blank, name: "Zxq" }, { pronouns: "", supplied: false })).toBe("");
    expect(initialPronouns(blank, { pronouns: "", supplied: false })).toBe("");
  });
});

describe("ageFromParts", () => {
  const now = new Date(Date.UTC(2026, 10, 1));
  it("counts the birthday itself, and refuses an impossible or future date", () => {
    expect(ageFromParts("2013", "11", "1", now)).toBe(13);
    expect(ageFromParts("2013", "11", "2", now)).toBe(12);
    expect(ageFromParts("2001", "2", "29", now)).toBeNull();
    expect(ageFromParts("2027", "1", "1", now)).toBeNull();
    expect(ageFromParts("2000", "", "1", now)).toBeNull();
  });
});

describe("Onboard screen", () => {
  let calls: Array<{ url: string; init?: RequestInit }> = [];
  beforeEach(() => {
    calls = [];
    setLocation.mockReset();
    syncFromProfile.mockReset();
    refreshLands = true;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith("api/auth/onboarding")) {
        return new Response(JSON.stringify({
          completed: false, emailVerified: true, marketingDefault: true, marketingWordingVersion: "v",
          accountPronouns: null, displayName: null, providerFirstName: "Google-Sarah",
          draft: { pronouns: "they/them", dobYear: "1990", dobMonth: "6", dobDay: "15" },
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ saved: true, completed: true }), { status: 200 });
    }));
  });

  it("a reload brings the draft back into the form", async () => {
    render(<Onboard />);
    expect(await screen.findByLabelText("Year")).toHaveProperty("value", "1990");
    expect((screen.getByLabelText("Month") as HTMLInputElement).value).toBe("6");
    expect((screen.getByLabelText("Day") as HTMLInputElement).value).toBe("15");
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(true);
  });

  it("a date under 13 shows the refusal and Finish stays disabled", async () => {
    render(<Onboard />);
    const year = await screen.findByLabelText("Year");
    fireEvent.change(year, { target: { value: String(new Date().getUTCFullYear() - 5) } });
    fireEvent.click(screen.getByTestId("turnstile-pass"));
    expect(screen.getByRole("alert").textContent).toContain("13 and over");
    expect((screen.getByRole("button", { name: "Finish set-up" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("Finish posts every field with the challenge token", async () => {
    render(<Onboard />);
    await screen.findByLabelText("Year");
    fireEvent.click(screen.getByTestId("turnstile-pass"));
    fireEvent.click(screen.getByRole("button", { name: "Finish set-up" }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("api/users/me/onboarding") && c.init?.method === "POST")).toBe(true));
    const post = calls.find((c) => c.url.endsWith("api/users/me/onboarding") && c.init?.method === "POST")!;
    expect(JSON.parse(String(post.init!.body))).toEqual({
      displayName: "Sarah", pronouns: "they/them", dobYear: "1990", dobMonth: "6", dobDay: "15", marketingOptIn: true, captchaToken: "tok-1",
    });
  });

  it("starts the name from the browser, not the provider's first name, and requires one", async () => {
    render(<Onboard />);
    const name = (await screen.findByRole("textbox", { name: "Your name" })) as HTMLInputElement;
    expect(name.value).toBe("Sarah");
    fireEvent.click(screen.getByTestId("turnstile-pass"));
    fireEvent.change(name, { target: { value: "" } });
    expect((screen.getByRole("button", { name: "Finish set-up" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("copies the identity to the browser only after the account re-read lands", async () => {
    render(<Onboard />);
    await screen.findByLabelText("Year");
    fireEvent.click(screen.getByTestId("turnstile-pass"));
    fireEvent.click(screen.getByRole("button", { name: "Finish set-up" }));
    await waitFor(() => expect(syncFromProfile).toHaveBeenCalledWith("Sarah", "they/them"));
  });

  it("publishes nothing to the browser when the re-read did not land", async () => {
    refreshLands = false;
    render(<Onboard />);
    await screen.findByLabelText("Year");
    fireEvent.click(screen.getByTestId("turnstile-pass"));
    fireEvent.click(screen.getByRole("button", { name: "Finish set-up" }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("api/users/me/onboarding") && c.init?.method === "POST")).toBe(true));
    await new Promise((r) => setTimeout(r, 20));
    expect(syncFromProfile).not.toHaveBeenCalled();
  });
});
