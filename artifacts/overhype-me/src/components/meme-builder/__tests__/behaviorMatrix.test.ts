import { describe, it, expect } from "vitest";
import {
  resolveBehavior,
  enumerateMatrix,
  demoEntitlementsForTier,
  ALL_ENTRY_FLOWS,
  type BehaviorEntitlements,
} from "../behaviorMatrix";
import type { Action } from "../types";

const NONE: BehaviorEntitlements = { meme_pulid_stylize: false, meme_ai_background: false };
const ALL: BehaviorEntitlements = { meme_pulid_stylize: true, meme_ai_background: true };

describe("behaviorMatrix", () => {
  describe("invalid combinations", () => {
    it("self-upload + unregistered → invalid for every entry flow", () => {
      for (const flow of ALL_ENTRY_FLOWS) {
        const cell = resolveBehavior("self-upload", "unregistered", flow, NONE);
        expect(cell.invalid).toBe(true);
        expect(cell.upgradeTo).toBe("registered");
        expect(cell.upgradeReason).toMatch(/sign up free/i);
      }
    });

    it("stock × any tier is never invalid", () => {
      for (const flow of ALL_ENTRY_FLOWS) {
        for (const tier of ["unregistered", "registered", "legendary"] as const) {
          expect(resolveBehavior("stock", tier, flow, NONE).invalid).toBe(false);
        }
      }
    });
  });

  describe("anonymous (unregistered) stock", () => {
    it("shows download + signup CTA, no save", () => {
      const cell = resolveBehavior("stock", "unregistered", "fact-detail", NONE);
      const expected: Action[] = ["download", "signup-cta"];
      expect(cell.visibleActions).toEqual(expected);
      expect(cell.visibleActions).not.toContain("save");
      expect(cell.visibleActions).not.toContain("share");
    });
  });

  describe("registered stock", () => {
    it("unlocks save + share", () => {
      const cell = resolveBehavior("stock", "registered", "fact-detail", NONE);
      expect(cell.visibleActions).toEqual(["download", "save", "share"]);
      expect(cell.showTryAiUpsell).toBe(false);
    });
  });

  // ── The general invariant: these two flags follow the ENTITLEMENT, not the
  // tier. `showStylizeToggle`/`showTryAiUpsell` used to be `tier === "legendary"`
  // — the same shape PR #402 broke on. Proving the reported example (legendary
  // → true) is not enough; the invariant is that tier alone never decides this,
  // in either direction.

  describe("showTryAiUpsell follows meme_ai_background, not tier", () => {
    it("legendary WITH the entitlement → shown", () => {
      const cell = resolveBehavior("stock", "legendary", "fact-detail", ALL);
      expect(cell.showTryAiUpsell).toBe(true);
    });
    it("legendary WITHOUT the entitlement (revoked from the grid) → hidden", () => {
      const cell = resolveBehavior("stock", "legendary", "fact-detail", NONE);
      expect(cell.showTryAiUpsell).toBe(false);
    });
    it("registered WITH the entitlement (granted from the grid) → shown", () => {
      const cell = resolveBehavior("stock", "registered", "fact-detail", ALL);
      expect(cell.showTryAiUpsell).toBe(true);
    });
  });

  describe("showStylizeToggle follows meme_pulid_stylize, not tier", () => {
    it("legendary WITH the entitlement → shown", () => {
      const cell = resolveBehavior("self-upload", "legendary", "fact-detail", ALL);
      expect(cell.showStylizeToggle).toBe(true);
    });
    it("legendary WITHOUT the entitlement (revoked from the grid) → hidden", () => {
      const cell = resolveBehavior("self-upload", "legendary", "fact-detail", NONE);
      expect(cell.showStylizeToggle).toBe(false);
    });
    it("registered WITH the entitlement (granted from the grid) → shown", () => {
      const cell = resolveBehavior("self-upload", "registered", "fact-detail", ALL);
      expect(cell.showStylizeToggle).toBe(true);
      expect(cell.invalid).toBe(false);
    });
    it("registered WITHOUT the entitlement → hidden, still valid", () => {
      const cell = resolveBehavior("self-upload", "registered", "fact-detail", NONE);
      expect(cell.showStylizeToggle).toBe(false);
      expect(cell.invalid).toBe(false);
    });
  });

  describe("entryFlow header copy", () => {
    it("cold-permalink + stock → 'see-with-your-name'", () => {
      expect(resolveBehavior("stock", "registered", "cold-permalink", NONE).headerCopyKey).toBe("see-with-your-name");
    });
    it("cold-permalink + self-upload, no PuLID entitlement → 'see-with-your-face'", () => {
      expect(resolveBehavior("self-upload", "registered", "cold-permalink", NONE).headerCopyKey).toBe("see-with-your-face");
    });
    it("cold-permalink + self-upload, WITH PuLID entitlement → 'see-yourself-ai'", () => {
      expect(resolveBehavior("self-upload", "legendary", "cold-permalink", ALL).headerCopyKey).toBe("see-yourself-ai");
    });
    it("remix → 'make-this-your-own' regardless of mode/tier/entitlement", () => {
      expect(resolveBehavior("stock", "registered", "remix", NONE).headerCopyKey).toBe("make-this-your-own");
      expect(resolveBehavior("self-upload", "legendary", "remix", ALL).headerCopyKey).toBe("make-this-your-own");
    });
    it("fact-detail / library / creation default to 'build-your-meme'", () => {
      for (const flow of ["fact-detail", "library", "creation"] as const) {
        expect(resolveBehavior("stock", "registered", flow, NONE).headerCopyKey).toBe("build-your-meme");
      }
    });
  });

  describe("postSave", () => {
    it("registered stock cold-permalink → share", () => {
      expect(resolveBehavior("stock", "registered", "cold-permalink", NONE).postSave).toBe("share");
    });
    it("registered stock fact-detail → back-to-fact", () => {
      expect(resolveBehavior("stock", "registered", "fact-detail", NONE).postSave).toBe("back-to-fact");
    });
    it("unregistered stock → none (signup wall first)", () => {
      expect(resolveBehavior("stock", "unregistered", "fact-detail", NONE).postSave).toBe("none");
    });
  });

  describe("demoEntitlementsForTier", () => {
    it("grants both demo entitlements to legendary and neither to lower tiers", () => {
      expect(demoEntitlementsForTier("legendary")).toEqual(ALL);
      expect(demoEntitlementsForTier("registered")).toEqual(NONE);
      expect(demoEntitlementsForTier("unregistered")).toEqual(NONE);
    });
  });

  describe("matrix coverage", () => {
    it("enumerateMatrix produces 2 modes × 3 tiers × 5 flows = 30 rows", () => {
      const all = enumerateMatrix();
      expect(all).toHaveLength(2 * 3 * 5);
    });
    it("all 5 self-upload-unregistered rows are invalid", () => {
      const invalid = enumerateMatrix().filter((r) => r.cell.invalid);
      expect(invalid).toHaveLength(5);
      for (const row of invalid) {
        expect(row.mode).toBe("self-upload");
        expect(row.tier).toBe("unregistered");
      }
    });
  });
});
