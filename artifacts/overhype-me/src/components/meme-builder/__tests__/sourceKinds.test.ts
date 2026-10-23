import { describe, it, expect } from "vitest";
import {
  currentSource,
  resolveBackgroundUrl,
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
    myImage: null,
    textOptions: {},
    aspectRatio: "landscape",
    ...overrides,
  };
}

describe("currentSource", () => {
  it("returns null when nothing is selected", () => {
    expect(currentSource(state())).toBeNull();
  });

  it("returns the myImage selection", () => {
    const myImage = { kind: "library" as const, objectPath: "/objects/uploads/x.jpg" };
    expect(currentSource(state({ myImage }))).toBe(myImage);
  });
});

describe("resolveBackgroundUrl", () => {
  it("returns null when no source is selected", () => {
    expect(resolveBackgroundUrl(null, VIEWER)).toBeNull();
  });

  it.each(["library", "fresh"] as const)(
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

  it.each(["library", "fresh"] as const)(
    "maps %s to an upload payload",
    (kind) => {
      expect(
        toServerImageSource({ kind, objectPath: "/objects/uploads/y.png" }, VIEWER),
      ).toEqual({ type: "upload", uploadKey: "/objects/uploads/y.png" });
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
    { name: "library", source: { kind: "library" as const, objectPath: "/objects/a.jpg" } },
    { name: "fresh", source: { kind: "fresh" as const, objectPath: "/objects/b.jpg" } },
  ];

  it.each(cases)("$name produces a non-null preview URL", ({ source }) => {
    expect(resolveBackgroundUrl(source, VIEWER)).not.toBeNull();
  });

  it.each(cases)("$name produces a server-bound imageSource", ({ source }) => {
    const server = toServerImageSource(source, VIEWER);
    expect(server).not.toBeNull();
    expect(server!.type).toBe("upload");
    expect(server!.uploadKey).toMatch(/^\/objects\//);
  });
});
