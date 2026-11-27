/**
 * wordChanges — the preview marks only the words a draft added or replaced,
 * against the wording it was based on (Issue #1341).
 */
import { describe, it, expect } from "vitest";
import { wordChanges } from "./wordChanges";

const changedText = (text: string, base: string) => wordChanges(text, base).filter((r) => r.changed).map((r) => r.text);

describe("wordChanges", () => {
  it("marks a word added at the end, and nothing else", () => {
    expect(changedText("Make sure they look awesome. Test", "Make sure they look awesome.")).toEqual(["Test"]);
  });
  it("marks a replaced word in the middle, keeping the spacing around it shared", () => {
    const runs = wordChanges("Keep the reference face sharp.", "Keep the reference person sharp.");
    expect(runs).toEqual([
      { text: "Keep the reference ", changed: false },
      { text: "face", changed: true },
      { text: " sharp.", changed: false },
    ]);
  });
  it("marks a run of added words as one stretch, spaces between them included", () => {
    expect(changedText("Use the photo, front and centre, as the face.", "Use the photo as the face.")).toEqual([", front and centre,"]);
  });
  it("marks nothing when words were only deleted", () => {
    expect(changedText("Use the face.", "Use the photo as the face.")).toEqual([]);
  });
  it("reads a segment that is only part of the piece (split by a slot value) against the whole base", () => {
    expect(changedText("Never clone ", "Do not clone {subject}.")).toEqual(["Never"]);
    expect(changedText(".", "Do not clone {subject}.")).toEqual([]);
  });
  it("reassembles the text exactly", () => {
    const text = "  Line one.\nLine  two — with a dash.  ";
    expect(wordChanges(text, "Line one. Line two.").map((r) => r.text).join("")).toBe(text);
  });
});
