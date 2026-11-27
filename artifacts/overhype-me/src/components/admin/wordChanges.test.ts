/**
 * wordChanges — the preview marks only the words a draft added or replaced,
 * against the wording it was based on (Issue #1341).
 */
import { describe, it, expect } from "vitest";
import { pieceMarker, wordChanges } from "./wordChanges";

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
  it("reassembles the text exactly", () => {
    const text = "  Line one.\nLine  two — with a dash.  ";
    expect(wordChanges(text, "Line one. Line two.").map((r) => r.text).join("")).toBe(text);
  });
});

/** The changed text of each segment, marked in order by one piece's marker. */
const marked = (draft: string, base: string, segments: string[]) => {
  const mark = pieceMarker(draft, base);
  return segments.map((g) => mark(g).filter((r) => r.changed).map((r) => r.text));
};

describe("pieceMarker (a piece the server cut at its slots; PR #1342, Codex 4715586277)", () => {
  const overlay = "Do not bake overlay or caption text into the image: no {forbidden}.";
  it("marks words added after a slot that already sit before it (Codex's example)", () => {
    expect(marked(`${overlay.slice(0, -1)} caption text.`, overlay, ["Do not bake overlay or caption text into the image: no ", " caption text."]))
      .toEqual([[], ["caption text"]]);
  });
  it("marks words added before a slot that also sit after it, and no untouched word", () => {
    const base = "Leave negative space at the {side} of the frame for the caption.";
    expect(marked("Leave negative space for the caption at the {side} of the frame for the caption.", base, ["Leave negative space for the caption at the ", " of the frame for the caption."]))
      .toEqual([["for the caption"], []]);
  });
  it("marks the middle stretch of a two-slot piece against its own place", () => {
    const base = "A speech balloon pointing to {who}, containing exactly: {text}";
    expect(marked("A speech balloon pointing to {who}, with one clean outline, containing exactly: {text}", base, ["A speech balloon pointing to ", ", with one clean outline, containing exactly: "]))
      .toEqual([[], ["with one clean outline,"]]);
  });
  it("marks each copy of a piece that appears twice", () => {
    const base = "A balloon for {who}.";
    expect(marked("A big balloon for {who}.", base, ["A big balloon for ", ".", "A big balloon for ", "."]))
      .toEqual([["big"], [], ["big"], []]);
  });
  it("marks only the moved words when two slots swap places", () => {
    // The longer unchanged run ("pointing to {who}") is kept; the clause that moved is what is marked.
    expect(marked("containing {text}, pointing to {who}", "pointing to {who}, containing {text}", ["containing ", ", pointing to "]))
      .toEqual([["containing "], [","]]);
  });
  it("falls back to comparing a segment alone when it is not a stretch of the draft", () => {
    expect(marked("Do not clone {subject}.", "Do not clone {subject}.", ["Never clone "])).toEqual([["Never"]]);
  });
});
