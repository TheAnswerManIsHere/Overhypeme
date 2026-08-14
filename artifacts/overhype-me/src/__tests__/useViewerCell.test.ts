import { describe, it, expect } from "vitest";
import { resolveViewerCell } from "@/pages/memePage/useViewerCell";

const baseMeme = {
  createdById: "creator-id",
  imageTransform: null as string | null,
};

describe("resolveViewerCell", () => {
  it("anonymous viewer with someone else's meme → anon-other", () => {
    expect(
      resolveViewerCell({
        role: "anonymous",
        userId: null,
        meme: baseMeme,
        justCreated: false,
        canPulidStylize: false,
      }),
    ).toBe("anon-other");
  });

  it("unregistered viewer with someone else's meme → anon-other", () => {
    expect(
      resolveViewerCell({
        role: "unregistered",
        userId: null,
        meme: baseMeme,
        justCreated: false,
        canPulidStylize: false,
      }),
    ).toBe("anon-other");
  });

  it("anonymous viewer with just_created=1 and null createdById → anon-own-transient", () => {
    expect(
      resolveViewerCell({
        role: "anonymous",
        userId: null,
        meme: { createdById: null, imageTransform: null },
        justCreated: true,
        canPulidStylize: false,
      }),
    ).toBe("anon-own-transient");
  });

  it("anonymous viewer with just_created=1 but meme has a creator → anon-other", () => {
    // Creator is set means a registered user owns this meme; anon shouldn't
    // hijack the transient state.
    expect(
      resolveViewerCell({
        role: "anonymous",
        userId: null,
        meme: { createdById: "someone", imageTransform: null },
        justCreated: true,
        canPulidStylize: false,
      }),
    ).toBe("anon-other");
  });

  it("registered viewer matching createdById, no entitlement → registered-own", () => {
    expect(
      resolveViewerCell({
        role: "registered",
        userId: "creator-id",
        meme: baseMeme,
        justCreated: false,
        canPulidStylize: false,
      }),
    ).toBe("registered-own");
  });

  it("registered viewer not matching → registered-other", () => {
    expect(
      resolveViewerCell({
        role: "registered",
        userId: "another-user",
        meme: baseMeme,
        justCreated: false,
        canPulidStylize: false,
      }),
    ).toBe("registered-other");
  });

  // ── The general invariant: the "own meme" branch follows the ENTITLEMENT,
  // not the role. This used to be `role === "legendary" || role === "admin"`
  // — the same PR #402 shape that let a client-derived permission drift from
  // what the server actually grants. Proving "legendary sees the real flow"
  // is not enough; the invariant is that tier alone never decides this cell,
  // in either direction.

  it("legendary role WITH the entitlement, non-PuLID image → legendary-own-stock", () => {
    expect(
      resolveViewerCell({
        role: "legendary",
        userId: "creator-id",
        meme: { createdById: "creator-id", imageTransform: null },
        justCreated: false,
        canPulidStylize: true,
      }),
    ).toBe("legendary-own-stock");
  });

  it("legendary role WITH the entitlement, PuLID image → legendary-own-pulid", () => {
    expect(
      resolveViewerCell({
        role: "legendary",
        userId: "creator-id",
        meme: { createdById: "creator-id", imageTransform: "pulid" },
        justCreated: false,
        canPulidStylize: true,
      }),
    ).toBe("legendary-own-pulid");
  });

  it("legendary role WITHOUT the entitlement (revoked from the grid) → registered-own", () => {
    expect(
      resolveViewerCell({
        role: "legendary",
        userId: "creator-id",
        meme: baseMeme,
        justCreated: false,
        canPulidStylize: false,
      }),
    ).toBe("registered-own");
  });

  it("registered role WITH the entitlement (granted from the grid) → legendary-own-stock", () => {
    expect(
      resolveViewerCell({
        role: "registered",
        userId: "creator-id",
        meme: baseMeme,
        justCreated: false,
        canPulidStylize: true,
      }),
    ).toBe("legendary-own-stock");
  });

  it("legendary viewer not matching → legendary-other (role-derived; no capability implied)", () => {
    expect(
      resolveViewerCell({
        role: "legendary",
        userId: "another-user",
        meme: baseMeme,
        justCreated: false,
        canPulidStylize: false,
      }),
    ).toBe("legendary-other");
  });

  it("admin treated as legendary for matching, with the entitlement", () => {
    expect(
      resolveViewerCell({
        role: "admin",
        userId: "creator-id",
        meme: baseMeme,
        justCreated: false,
        canPulidStylize: true,
      }),
    ).toBe("legendary-own-stock");
  });

  it("admin without the entitlement, matching → registered-own", () => {
    expect(
      resolveViewerCell({
        role: "admin",
        userId: "creator-id",
        meme: baseMeme,
        justCreated: false,
        canPulidStylize: false,
      }),
    ).toBe("registered-own");
  });

  it("admin treated as legendary for non-matching", () => {
    expect(
      resolveViewerCell({
        role: "admin",
        userId: "someone-else",
        meme: baseMeme,
        justCreated: false,
        canPulidStylize: false,
      }),
    ).toBe("legendary-other");
  });

  it("registered viewer with userId but null createdById → registered-other", () => {
    // ID match requires both sides to be present.
    expect(
      resolveViewerCell({
        role: "registered",
        userId: "user-1",
        meme: { createdById: null, imageTransform: null },
        justCreated: false,
        canPulidStylize: false,
      }),
    ).toBe("registered-other");
  });

  it("own meme, entitled, with PuLID-fallback-text treated as non-pulid", () => {
    // Only "pulid" exactly (not the fallback-text variant) hides the upsell.
    expect(
      resolveViewerCell({
        role: "legendary",
        userId: "creator-id",
        meme: { createdById: "creator-id", imageTransform: "pulid_fallback_text" },
        justCreated: false,
        canPulidStylize: true,
      }),
    ).toBe("legendary-own-stock");
  });
});
