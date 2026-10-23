import { describe, it, expect } from "vitest";
import {
  resolveBehavior,
  enumerateMatrix,
  ALL_ENTRY_FLOWS,
} from "../behaviorMatrix";
import type { Action } from "../types";

describe("behaviorMatrix", () => {
  describe("invalid combinations", () => {
    it("self-upload + unregistered → invalid for every entry flow (stock photos went with Pexels, so there is no open source left)", () => {
      for (const flow of ALL_ENTRY_FLOWS) {
        const cell = resolveBehavior("self-upload", "unregistered", flow);
        expect(cell.invalid).toBe(true);
        expect(cell.upgradeTo).toBe("registered");
        expect(cell.upgradeReason).toMatch(/sign up free/i);
      }
    });

    it("self-upload × registered/legendary is never invalid", () => {
      for (const flow of ALL_ENTRY_FLOWS) {
        for (const tier of ["registered", "legendary"] as const) {
          expect(resolveBehavior("self-upload", tier, flow).invalid).toBe(false);
        }
      }
    });
  });

  describe("registered self-upload", () => {
    it("unlocks download + save + share, and the source area is always the photo picker", () => {
      const cell = resolveBehavior("self-upload", "registered", "fact-detail");
      const expected: Action[] = ["download", "save", "share"];
      expect(cell.visibleActions).toEqual(expected);
      expect(cell.sourceArea).toBe("my-image");
    });
  });

  describe("entryFlow header copy", () => {
    it("cold-permalink → 'see-with-your-face', for every signed-in tier", () => {
      expect(resolveBehavior("self-upload", "registered", "cold-permalink").headerCopyKey).toBe("see-with-your-face");
    });
    it("a legendary viewer gets no AI header: 'see-yourself-ai' went with PuLID (launch Phase 4, removal 3)", () => {
      expect(resolveBehavior("self-upload", "legendary", "cold-permalink").headerCopyKey).toBe("see-with-your-face");
    });
    it("remix → 'make-this-your-own' regardless of tier", () => {
      expect(resolveBehavior("self-upload", "registered", "remix").headerCopyKey).toBe("make-this-your-own");
      expect(resolveBehavior("self-upload", "legendary", "remix").headerCopyKey).toBe("make-this-your-own");
    });
    it("fact-detail / library / creation default to 'build-your-meme'", () => {
      for (const flow of ["fact-detail", "library", "creation"] as const) {
        expect(resolveBehavior("self-upload", "registered", flow).headerCopyKey).toBe("build-your-meme");
      }
    });
  });

  describe("postSave", () => {
    it("registered cold-permalink → share", () => {
      expect(resolveBehavior("self-upload", "registered", "cold-permalink").postSave).toBe("share");
    });
    it("registered fact-detail → back-to-fact", () => {
      expect(resolveBehavior("self-upload", "registered", "fact-detail").postSave).toBe("back-to-fact");
    });
    it("unregistered → none (signup wall first)", () => {
      expect(resolveBehavior("self-upload", "unregistered", "fact-detail").postSave).toBe("none");
    });
  });

  describe("matrix coverage", () => {
    it("enumerateMatrix produces 1 mode × 3 tiers × 5 flows = 15 rows", () => {
      const all = enumerateMatrix();
      expect(all).toHaveLength(1 * 3 * 5);
    });
    it("all 5 unregistered rows are invalid", () => {
      const invalid = enumerateMatrix().filter((r) => r.cell.invalid);
      expect(invalid).toHaveLength(5);
      for (const row of invalid) {
        expect(row.mode).toBe("self-upload");
        expect(row.tier).toBe("unregistered");
      }
    });
  });
});
