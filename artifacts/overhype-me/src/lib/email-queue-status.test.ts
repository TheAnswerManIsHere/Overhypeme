import { describe, expect, it } from "vitest";
import { emailQueueStatusLabel, isSkippedRow } from "./email-queue-status";

describe("emailQueueStatusLabel (Issue #1212)", () => {
  it("names a skip for a suspended recipient, never 'done'", () => {
    expect(emailQueueStatusLabel({ status: "done", skipReason: "recipient_suspended" })).toBe("Skipped — recipient suspended");
    expect(isSkippedRow({ status: "done", skipReason: "recipient_suspended" })).toBe(true);
  });
  it("names any other skip as a skip", () => {
    expect(emailQueueStatusLabel({ status: "done", skipReason: "other" })).toBe("Skipped");
  });
  it("leaves every other row's status as it was", () => {
    expect(emailQueueStatusLabel({ status: "done", skipReason: null })).toBe("done");
    expect(emailQueueStatusLabel({ status: "failed" })).toBe("failed");
    expect(isSkippedRow({ status: "done", skipReason: null })).toBe(false);
  });
});
