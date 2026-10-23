import { describe, it, expect } from "vitest";
import {
  ALL_ENTRY_FLOWS,
  ALL_MODES,
  ALL_TIERS,
  resolveBehavior,
} from "../behaviorMatrix";
import {
  resolveBackgroundUrl,
  toServerImageSource,
  type BuilderImageSource,
  type BuilderViewerCtx,
} from "../integration/sourceKinds";

/**
 * Regression net for task #495.
 *
 * Walks every (entryFlow × tier × source-kind) cell the universal builder
 * supports and asserts the contract that prevents the black-canvas bug:
 *   (a) the live-preview hook returns a non-null background URL whenever the
 *       picker has a default selection, and
 *   (b) on save, the resulting `imageSource` payload is the shape
 *       `composeMeme` expects (`type: "upload"` with an `/objects/`-prefixed
 *       uploadKey; the stock variant went with Pexels, launch Phase 4,
 *       removal 6).
 *
 * If a future change adds a new source kind, picker, or matrix cell without
 * wiring it through `sourceKinds.ts`, this test fails before the bug ships.
 */

// Task #507 dropped the `primaryImageObjectPath` plumbing — the profile photo
// now travels through the standard library source kind tagged is_profile.
const VIEWER: BuilderViewerCtx = {};

interface SourceCase {
  name: string;
  source: BuilderImageSource;
  /** Which sourceArea (from BehaviorCell) this case is valid for. */
  sourceArea: "my-image";
}

const SOURCE_CASES: SourceCase[] = [
  {
    name: "library (profile photo or any other library entry)",
    source: { kind: "library", objectPath: "/objects/uploads/lib.jpg" },
    sourceArea: "my-image",
  },
  {
    name: "fresh",
    source: { kind: "fresh", objectPath: "/objects/uploads/fresh.jpg" },
    sourceArea: "my-image",
  },
];

interface MatrixRow {
  mode: (typeof ALL_MODES)[number];
  tier: (typeof ALL_TIERS)[number];
  entryFlow: (typeof ALL_ENTRY_FLOWS)[number];
  source: SourceCase;
}

function expandMatrix(): MatrixRow[] {
  const rows: MatrixRow[] = [];
  for (const mode of ALL_MODES) {
    for (const tier of ALL_TIERS) {
      for (const entryFlow of ALL_ENTRY_FLOWS) {
        const cell = resolveBehavior(mode, tier, entryFlow);
        if (cell.invalid) continue; // tier-locked panels never render a picker
        for (const source of SOURCE_CASES) {
          if (source.sourceArea !== cell.sourceArea) continue;
          rows.push({ mode, tier, entryFlow, source });
        }
      }
    }
  }
  return rows;
}

const MATRIX = expandMatrix();

describe("builder contract: every (entryFlow × tier × source-kind) cell hydrates correctly", () => {
  it("the matrix is non-empty (sanity check)", () => {
    expect(MATRIX.length).toBeGreaterThan(0);
  });

  it.each(MATRIX)(
    "[$mode/$tier/$entryFlow] $source.name → preview URL is non-null",
    ({ source }) => {
      const url = resolveBackgroundUrl(source.source, VIEWER);
      expect(url).not.toBeNull();
      expect(typeof url).toBe("string");
      expect(url!.length).toBeGreaterThan(0);
    },
  );

  it.each(MATRIX)(
    "[$mode/$tier/$entryFlow] $source.name → server payload is composeMeme-compatible",
    ({ source }) => {
      const server = toServerImageSource(source.source, VIEWER);
      expect(server).not.toBeNull();
      expect(server!.type).toBe("upload");
      expect(server!.uploadKey).toMatch(/^\/objects\//);
    },
  );
});
