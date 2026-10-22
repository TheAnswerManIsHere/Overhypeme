import { describe, it, expect } from "vitest";
import {
  resolveBehavior,
  enumerateMatrix,
  ALL_ENTRY_FLOWS,
} from "../behaviorMatrix";
import type { Action } from "../types";

describe("behaviorMatrix", () => {
  describe("invalid combinations", () => {
    it("self-upload + unregistered → invalid for every entry flow", () => {
      for (const flow of ALL_ENTRY_FLOWS) {
        const cell = resolveBehavior("self-upload", "unregistered", flow);
        expect(cell.invalid).toBe(true);
        expect(cell.upgradeTo).toBe("registered");
        expect(cell.upgradeReason).toMatch(/sign up free/i);
      }
    });

    it("stock × any tier is never invalid", () => {
      for (const flow of ALL_ENTRY_FLOWS) {
        for (const tier of ["unregistered", "registered", "legendary"] as const) {
          expect(resolveBehavior("stock", tier, flow).invalid).toBe(false);
        }
      }
    });
  });

  describe("anonymous (unregistered) stock", () => {
    it("shows download + signup CTA, no save", () => {
      const cell = resolveBehavior("stock", "unregistered", "fact-detail");
      const expected: Action[] = ["download", "signup-cta"];
      expect(cell.visibleActions).toEqual(expected);
      expect(cell.visibleActions).not.toContain("save");
      expect(cell.visibleActions).not.toContain("share");
    });
  });

  describe("registered stock", () => {
    it("unlocks save + share", () => {
      const cell = resolveBehavior("stock", "registered", "fact-detail");
      expect(cell.visibleActions).toEqual(["download", "save", "share"]);
    });
  });

  describe("entryFlow header copy", () => {
    it("cold-permalink + stock → 'see-with-your-name'", () => {
      expect(resolveBehavior("stock", "registered", "cold-permalink").headerCopyKey).toBe("see-with-your-name");
    });
    it("cold-permalink + self-upload → 'see-with-your-face', for every tier", () => {
      expect(resolveBehavior("self-upload", "registered", "cold-permalink").headerCopyKey).toBe("see-with-your-face");
    });
    it("a legendary viewer gets no AI header: 'see-yourself-ai' went with PuLID (launch Phase 4, removal 3)", () => {
      expect(resolveBehavior("self-upload", "legendary", "cold-permalink").headerCopyKey).toBe("see-with-your-face");
    });
    it("remix → 'make-this-your-own' regardless of mode/tier", () => {
      expect(resolveBehavior("stock", "registered", "remix").headerCopyKey).toBe("make-this-your-own");
      expect(resolveBehavior("self-upload", "legendary", "remix").headerCopyKey).toBe("make-this-your-own");
    });
    it("fact-detail / library / creation default to 'build-your-meme'", () => {
      for (const flow of ["fact-detail", "library", "creation"] as const) {
        expect(resolveBehavior("stock", "registered", flow).headerCopyKey).toBe("build-your-meme");
      }
    });
  });

  describe("postSave", () => {
    it("registered stock cold-permalink → share", () => {
      expect(resolveBehavior("stock", "registered", "cold-permalink").postSave).toBe("share");
    });
    it("registered stock fact-detail → back-to-fact", () => {
      expect(resolveBehavior("stock", "registered", "fact-detail").postSave).toBe("back-to-fact");
    });
    it("unregistered stock → none (signup wall first)", () => {
      expect(resolveBehavior("stock", "unregistered", "fact-detail").postSave).toBe("none");
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
