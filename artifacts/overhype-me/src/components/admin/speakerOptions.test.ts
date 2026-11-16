import { describe, it, expect } from "vitest";
import { buildSpeakerOptions, characterDisplayName, selectedSpeakerValue } from "./speakerOptions";

describe("buildSpeakerOptions", () => {
  it("subject-only fact: just the subject and the gag's roles", () => {
    const opts = buildSpeakerOptions({ characters: [], roleBindings: [{ entity: "subject" }, { entity: "crowd" }], currentSpeakers: [] });
    expect(opts.map((o) => [o.value, o.source])).toEqual([["subject", "subject"], ["crowd", "gag"]]);
  });

  it("a pet reads as the subject's own; a non-relation reads as itself", () => {
    expect(characterDisplayName({ label: "dog", ofSubject: true })).toBe("Alex's dog");
    expect(characterDisplayName({ label: "the referee", ofSubject: false })).toBe("the referee");
  });

  it("de-duplicates case-insensitively across sources, the fact list winning", () => {
    const opts = buildSpeakerOptions({
      characters: [{ label: "mom", kind: "person", ofSubject: true }],
      roleBindings: [{ entity: "Mom" }],
      currentSpeakers: ["MOM", "subject"],
    });
    expect(opts.map((o) => o.source)).toEqual(["subject", "fact"]);
    expect(selectedSpeakerValue(opts, "MOM")).toBe("mom");
  });
});
