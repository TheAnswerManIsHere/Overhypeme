import { describe, it, expect } from "vitest";
import { resolveVideoCardState } from "./useVideoCardState";

describe("resolveVideoCardState", () => {
  it("unregistered users get locked-upgrade", () => {
    expect(resolveVideoCardState({ tier: "unregistered" })).toEqual({
      kind: "locked-upgrade",
    });
  });

  it("registered (free) users get locked-upgrade", () => {
    expect(resolveVideoCardState({ tier: "registered" })).toEqual({
      kind: "locked-upgrade",
    });
  });

  it("legendary users with no budget snapshot are tappable (MBFO-2 default)", () => {
    expect(resolveVideoCardState({ tier: "legendary" })).toEqual({
      kind: "tappable",
    });
  });

  it("legendary users with an allowed budget are tappable", () => {
    expect(
      resolveVideoCardState({
        tier: "legendary",
        videoBudget: { allowed: true },
      }),
    ).toEqual({ kind: "tappable" });
  });

  it("legendary users with a denied budget get budget-reached + resetDate", () => {
    expect(
      resolveVideoCardState({
        tier: "legendary",
        videoBudget: { allowed: false, resetDate: "Jun 1" },
      }),
    ).toEqual({ kind: "budget-reached", resetDate: "Jun 1" });
  });

  it("non-legendary users always get locked-upgrade even with an allowed budget", () => {
    // Defensive: a stale budget object should never override the tier check.
    expect(
      resolveVideoCardState({
        tier: "registered",
        videoBudget: { allowed: true },
      }),
    ).toEqual({ kind: "locked-upgrade" });
  });
});
