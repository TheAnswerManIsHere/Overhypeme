import { describe, expect, it } from "vitest";
import { suspensionResultMessage } from "./suspension-notice";

describe("suspensionResultMessage (Issue #1110)", () => {
  it("says the email is queued, never that it was delivered", () => {
    expect(suspensionResultMessage("suspend", { alreadySuspended: false, notice: { status: "queued" } }))
      .toBe("Suspended. They were signed out everywhere and can't sign in until you unsuspend them. The email to them is queued.");
    expect(suspensionResultMessage("unsuspend", { wasSuspended: true, notice: { status: "queued" } }))
      .toBe("Unsuspended. They can sign in again. The email to them is queued.");
  });

  it("says why nothing was queued, and that the change still happened", () => {
    expect(suspensionResultMessage("suspend", { alreadySuspended: false, notice: { status: "not_queued", why: "no_address" } }))
      .toMatch(/^Suspended\..*No email was queued: the account has no email address\.$/);
    expect(suspensionResultMessage("unsuspend", { wasSuspended: true, notice: { status: "not_queued", why: "email_unavailable" } }))
      .toMatch(/^Unsuspended\..*No email was queued: email isn't set up on this server\.$/);
    expect(suspensionResultMessage("suspend", { alreadySuspended: false, notice: { status: "not_queued", why: "failed" } }))
      .toMatch(/No email was queued: queueing it failed — see the server log\.$/);
  });

  it("a repeated request says nothing changed and no new email went", () => {
    expect(suspensionResultMessage("suspend", { alreadySuspended: true, notice: { status: "not_owed" } })).toBe("Already suspended — no new email.");
    expect(suspensionResultMessage("unsuspend", { wasSuspended: false, notice: { status: "not_owed" } })).toBe("Wasn't suspended — no new email.");
  });
});
