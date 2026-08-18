import { describe, it, expect } from "vitest";
import { resolveVideoCardState } from "./useVideoCardState";

describe("resolveVideoCardState", () => {
  it("not entitled → locked-upgrade", () => {
    expect(resolveVideoCardState({ canVideoGeneration: false })).toEqual({
      kind: "locked-upgrade",
    });
  });

  it("entitled, no budget snapshot → tappable (MBFO-2 default)", () => {
    expect(resolveVideoCardState({ canVideoGeneration: true })).toEqual({
      kind: "tappable",
    });
  });

  it("entitled with an allowed budget are tappable", () => {
    expect(
      resolveVideoCardState({
        canVideoGeneration: true,
        videoBudget: { allowed: true },
      }),
    ).toEqual({ kind: "tappable" });
  });

  it("entitled with a denied budget get budget-reached + resetDate", () => {
    expect(
      resolveVideoCardState({
        canVideoGeneration: true,
        videoBudget: { allowed: false, resetDate: "Jun 1" },
      }),
    ).toEqual({ kind: "budget-reached", resetDate: "Jun 1" });
  });

  it("not entitled always gets locked-upgrade even with an allowed budget", () => {
    // Defensive: a stale budget object should never override the entitlement.
    expect(
      resolveVideoCardState({
        canVideoGeneration: false,
        videoBudget: { allowed: true },
      }),
    ).toEqual({ kind: "locked-upgrade" });
  });

  // ── The general invariant: this used to be `tier !== "legendary"` — the
  // same PR #402 shape. A grid grant to a lower tier, or a revocation from
  // legendary, has to move this card; tier alone never should.
  it("granted to a non-legendary tier via the grid → tappable", () => {
    expect(resolveVideoCardState({ canVideoGeneration: true })).toEqual({
      kind: "tappable",
    });
  });

  it("revoked from legendary via the grid → locked-upgrade", () => {
    expect(resolveVideoCardState({ canVideoGeneration: false })).toEqual({
      kind: "locked-upgrade",
    });
  });
});
