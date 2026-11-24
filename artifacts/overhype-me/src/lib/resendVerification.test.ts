/**
 * #1109 D8: a resend button says the email was sent only when it was; a
 * read-only refusal says the site is under maintenance.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { resendVerification, RESEND_SENT_MESSAGE } from "./resendVerification";
import { READ_ONLY_REFUSED_FULL } from "./readOnlyNotice";

const reply = (status: number, body: unknown) =>
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })));

afterEach(() => vi.unstubAllGlobals());

describe("resendVerification", () => {
  it("confirms only when the server sent it", async () => {
    reply(200, {});
    expect(await resendVerification()).toEqual({ sent: true, message: RESEND_SENT_MESSAGE });
  });
  it("says the site is under maintenance when refused for read-only mode", async () => {
    reply(503, { code: "READ_ONLY_MODE", error: "paused" });
    expect(await resendVerification()).toEqual({ sent: false, message: READ_ONLY_REFUSED_FULL });
  });
  it("passes on any other refusal's own reason, never claiming it was sent", async () => {
    reply(429, { error: "Too many requests" });
    expect(await resendVerification()).toEqual({ sent: false, message: "Too many requests" });
  });
  it("never claims a send when the server answers that the address is already verified (#884)", async () => {
    reply(200, { status: "verified", message: "Your email is already verified." });
    expect(await resendVerification({ ifNoneOut: true })).toEqual({ sent: false, verified: true, message: "Your email is already verified." });
  });
});
