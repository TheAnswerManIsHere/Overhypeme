/**
 * Guard (#686): the AI image generation surfaces must route every server error
 * string through `generationErrorMessage` before it reaches the screen.
 *
 * Those endpoints answer with a mix of sentences and machine codes
 * (`style_invalid`, `generate_v2_failed`, …). Both surfaces below used to
 * render `body.error ?? "…"` directly, so a refused generation showed the user
 * a raw identifier. The picker has no component test, so this pins the shape
 * structurally: a raw `<x>.error ??` fallback in these files is the defect.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Vitest runs with the package root as cwd (see factTextHighlighting.guard).
const SRC = join(process.cwd(), "src");

const SURFACES = ["components/SourceImageConfirmModal.tsx", "components/AiBgPicker.tsx"];

/** A server error string used as display text with only a `??` fallback. */
const RAW_ERROR_FALLBACK = /\b(?:body|status|s)\.error\s*\?\?/;

describe("generation error text guard (#686)", () => {
  for (const file of SURFACES) {
    it(`${file} never renders a server error string raw`, () => {
      const src = readFileSync(join(SRC, file), "utf8");
      const offenders = src
        .split("\n")
        .map((line, i) => ({ line: line.trim(), n: i + 1 }))
        .filter(({ line }) => RAW_ERROR_FALLBACK.test(line));
      expect(offenders, offenders.map((o) => `${file}:${o.n}  ${o.line}`).join("\n")).toEqual([]);
      expect(src).toContain("generationErrorMessage(");
    });
  }
});
