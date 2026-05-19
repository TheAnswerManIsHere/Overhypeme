import { describe, it, expect } from "vitest";
import {
  currentSource,
  resolveBackgroundUrl,
  selfUploadObjectPath,
  toServerImageSource,
} from "../integration/sourceKinds";
import type { BuilderInternalState } from "../state/useBuilderState";

// Task #507: `viewer` is now empty — the profile photo travels through the
// standard `kind:"library"` source kind. The empty object is kept as the
// argument to preserve the helper signatures (in case future plumbing needs
// to re-introduce viewer-derived state).
const VIEWER = {};

function state(overrides: Partial<BuilderInternalState> = {}): BuilderInternalState {
  return {
    name: "",
    pronouns: "they/them",
    stockImageId: null,
    stockImageUrl: null,
    myImage: null,
    stylizeWithAi: false,
    textOptions: {},
    aspectRatio: "landscape",
    ...overrides,
  };
}

describe("currentSource", () => {
  it("returns null when nothing is selected in stock mode", () => {
    expect(currentSource(state(), "stock")).toBeNull();
  });

  it("returns a stock source carrying the URL when a stock photo is selected", () => {
    const src = currentSource(
      state({ stockImageId: "9001", stockImageUrl: "https://images.pexels.com/9001.jpg" }),
      "stock",
    );
    expect(src).toEqual({
      kind: "stock",
      stockImageId: "9001",
      stockImageUrl: "https://images.pexels.com/9001.jpg",
    });
  });

  it("returns null when nothing is selected in self-upload mode", () => {
    expect(currentSource(state(), "self-upload")).toBeNull();
  });

  it("returns the myImage selection in self-upload mode", () => {
    const myImage = { kind: "library" as const, objectPath: "/objects/uploads/x.jpg" };
    expect(currentSource(state({ myImage }), "self-upload")).toBe(myImage);
  });
});

describe("resolveBackgroundUrl", () => {
  it("returns null when no source is selected", () => {
    expect(resolveBackgroundUrl(null, VIEWER)).toBeNull();
  });

  it("returns the stock URL straight through", () => {
    expect(
      resolveBackgroundUrl(
        { kind: "stock", stockImageId: "1", stockImageUrl: "https://example.com/x.jpg" },
        VIEWER,
      ),
    ).toBe("https://example.com/x.jpg");
  });

  it("returns null for stock when the URL has not yet hydrated", () => {
    expect(
      resolveBackgroundUrl({ kind: "stock", stockImageId: "1", stockImageUrl: null }, VIEWER),
    ).toBeNull();
  });

  it.each(["library", "fresh", "ai-styling"] as const)(
    "resolves %s through the storage delivery route",
    (kind) => {
      expect(
        resolveBackgroundUrl({ kind, objectPath: "/objects/uploads/foo.png" }, VIEWER),
      ).toBe("/api/storage/objects/uploads/foo.png");
    },
  );
});

describe("toServerImageSource", () => {
  it("returns null when no source is selected", () => {
    expect(toServerImageSource(null, VIEWER)).toBeNull();
  });

  it("maps stock to a stock-typed payload with a numeric pexelsPhotoId", () => {
    expect(
      toServerImageSource(
        { kind: "stock", stockImageId: "12345", stockImageUrl: "https://x" },
        VIEWER,
      ),
    ).toEqual({ type: "stock", pexelsPhotoId: 12345 });
  });

  it.each(["library", "fresh", "ai-styling"] as const)(
    "maps %s to an upload payload",
    (kind) => {
      expect(
        toServerImageSource({ kind, objectPath: "/objects/uploads/y.png" }, VIEWER),
      ).toEqual({ type: "upload", uploadKey: "/objects/uploads/y.png" });
    },
  );
});

describe("selfUploadObjectPath", () => {
  it.each(["library", "fresh", "ai-styling"] as const)(
    "returns the carried objectPath for %s",
    (kind) => {
      expect(
        selfUploadObjectPath({ kind, objectPath: "/objects/uploads/z.png" }, VIEWER),
      ).toBe("/objects/uploads/z.png");
    },
  );
});

describe("regression: every source kind has a non-null preview AND a valid server payload", () => {
  // The contract task #495 locks in: whenever a picker has a default
  // selection, the live-preview hook returns a non-null URL, and on save the
  // resulting imageSource is one composeMeme can resolve. Task #507 dropped
  // the `primary` kind — the profile photo now appears as a tagged library
  // entry and rides the standard `library` branch.
  const cases = [
    { name: "stock", source: { kind: "stock" as const, stockImageId: "10", stockImageUrl: "https://x" } },
    { name: "library", source: { kind: "library" as const, objectPath: "/objects/a.jpg" } },
    { name: "fresh", source: { kind: "fresh" as const, objectPath: "/objects/b.jpg" } },
    { name: "ai-styling", source: { kind: "ai-styling" as const, objectPath: "/objects/c.jpg" } },
  ];

  it.each(cases)("$name produces a non-null preview URL", ({ source }) => {
    expect(resolveBackgroundUrl(source, VIEWER)).not.toBeNull();
  });

  it.each(cases)("$name produces a server-bound imageSource", ({ source }) => {
    const server = toServerImageSource(source, VIEWER);
    expect(server).not.toBeNull();
    if (server!.type === "upload") {
      expect(server!.uploadKey).toMatch(/^\/objects\//);
    } else {
      expect(server!.type).toBe("stock");
      expect(typeof server!.pexelsPhotoId).toBe("number");
      expect(Number.isFinite(server!.pexelsPhotoId)).toBe(true);
    }
  });
});
