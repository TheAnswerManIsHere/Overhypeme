import { describe, it, expect } from "vitest";
import { resolveViewerCell, type Role } from "@/pages/memePage/useViewerCell";

const baseMeme = { createdById: "creator-id" };

describe("resolveViewerCell", () => {
  it("anonymous viewer with someone else's meme → anon-other", () => {
    expect(
      resolveViewerCell({ role: "anonymous", userId: null, meme: baseMeme, justCreated: false }),
    ).toBe("anon-other");
  });

  it("unregistered viewer with someone else's meme → anon-other", () => {
    expect(
      resolveViewerCell({ role: "unregistered", userId: null, meme: baseMeme, justCreated: false }),
    ).toBe("anon-other");
  });

  it("anonymous viewer with just_created=1 and null createdById → anon-own-transient", () => {
    expect(
      resolveViewerCell({ role: "anonymous", userId: null, meme: { createdById: null }, justCreated: true }),
    ).toBe("anon-own-transient");
  });

  it("anonymous viewer with just_created=1 but meme has a creator → anon-other", () => {
    // Creator is set means a registered user owns this meme; anon shouldn't
    // hijack the transient state.
    expect(
      resolveViewerCell({ role: "anonymous", userId: null, meme: { createdById: "someone" }, justCreated: true }),
    ).toBe("anon-other");
  });

  // ── Every signed-in owner gets the one "own" cell. It used to split three
  // ways on the PuLID entitlement and on whether the meme was PuLID-made;
  // PuLID went in launch Phase 4, removal 3, and the role never decided it.
  for (const role of ["registered", "legendary", "admin"] as Role[]) {
    it(`${role} viewer matching createdById → own`, () => {
      expect(
        resolveViewerCell({ role, userId: "creator-id", meme: baseMeme, justCreated: false }),
      ).toBe("own");
    });
  }

  it("registered viewer not matching → registered-other", () => {
    expect(
      resolveViewerCell({ role: "registered", userId: "another-user", meme: baseMeme, justCreated: false }),
    ).toBe("registered-other");
  });

  it("legendary viewer not matching → legendary-other (role-derived; no capability implied)", () => {
    expect(
      resolveViewerCell({ role: "legendary", userId: "another-user", meme: baseMeme, justCreated: false }),
    ).toBe("legendary-other");
  });

  it("admin treated as legendary for non-matching", () => {
    expect(
      resolveViewerCell({ role: "admin", userId: "someone-else", meme: baseMeme, justCreated: false }),
    ).toBe("legendary-other");
  });

  it("registered viewer with userId but null createdById → registered-other", () => {
    // ID match requires both sides to be present.
    expect(
      resolveViewerCell({ role: "registered", userId: "user-1", meme: { createdById: null }, justCreated: false }),
    ).toBe("registered-other");
  });
});
