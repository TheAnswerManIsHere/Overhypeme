import { describe, it, expect } from "vitest";
import {
  PRONOUN_PRESETS,
  DEFAULT_PRONOUNS,
  EMPTY_CUSTOM,
  serializeCustom,
  parseCustom,
  isCustomPronouns,
  displayPronouns,
  type CustomPronounSet,
} from "./pronouns";

describe("constants", () => {
  it("PRONOUN_PRESETS is the three canonical pairs", () => {
    expect(PRONOUN_PRESETS).toEqual(["he/him", "she/her", "they/them"]);
  });

  it("DEFAULT_PRONOUNS is 'he/him'", () => {
    expect(DEFAULT_PRONOUNS).toBe("he/him");
  });

  it("EMPTY_CUSTOM has every field blank and plural=false", () => {
    expect(EMPTY_CUSTOM).toEqual({
      subj: "", obj: "", poss: "", possPro: "", refl: "", plural: false,
    });
  });
});

describe("serializeCustom", () => {
  const xe: CustomPronounSet = {
    subj: "xe", obj: "xem", poss: "xyr", possPro: "xyrs", refl: "xemself", plural: false,
  };

  it("joins five forms with pipes and a singular flag suffix", () => {
    expect(serializeCustom(xe)).toBe("xe|xem|xyr|xyrs|xemself|s");
  });

  it("uses 'p' as the suffix when plural is true", () => {
    expect(serializeCustom({ ...xe, plural: true })).toBe("xe|xem|xyr|xyrs|xemself|p");
  });

  it("preserves empty fields rather than dropping them", () => {
    expect(serializeCustom(EMPTY_CUSTOM)).toBe("|||||s");
  });
});

describe("parseCustom", () => {
  it("returns null for an empty string", () => {
    expect(parseCustom("")).toBe(null);
  });

  it("returns null for a string without any pipe", () => {
    expect(parseCustom("he/him")).toBe(null);
  });

  it("returns null for a string with too few pipe-segments", () => {
    expect(parseCustom("xe|xem|xyr|xyrs")).toBe(null);
  });

  it("parses a fully-populated singular custom string", () => {
    expect(parseCustom("xe|xem|xyr|xyrs|xemself|s")).toEqual({
      subj: "xe", obj: "xem", poss: "xyr", possPro: "xyrs", refl: "xemself", plural: false,
    });
  });

  it("recognises 'p' as plural and any other tail as singular", () => {
    expect(parseCustom("they|them|their|theirs|themself|p")?.plural).toBe(true);
    expect(parseCustom("they|them|their|theirs|themself|s")?.plural).toBe(false);
    expect(parseCustom("they|them|their|theirs|themself|x")?.plural).toBe(false);
  });

  it("tolerates trailing extra segments by ignoring them", () => {
    expect(parseCustom("xe|xem|xyr|xyrs|xemself|s|extra|stuff")).toEqual({
      subj: "xe", obj: "xem", poss: "xyr", possPro: "xyrs", refl: "xemself", plural: false,
    });
  });

  it("round-trips with serializeCustom", () => {
    const set: CustomPronounSet = {
      subj: "fae", obj: "faer", poss: "faer", possPro: "faers", refl: "faerself", plural: true,
    };
    expect(parseCustom(serializeCustom(set))).toEqual(set);
  });
});

describe("isCustomPronouns", () => {
  it("returns false for a preset pair", () => {
    expect(isCustomPronouns("he/him")).toBe(false);
    expect(isCustomPronouns("she/her")).toBe(false);
    expect(isCustomPronouns("they/them")).toBe(false);
  });

  it("returns true for any string containing a pipe", () => {
    expect(isCustomPronouns("xe|xem|xyr|xyrs|xemself|s")).toBe(true);
  });

  it("returns false for an empty string", () => {
    expect(isCustomPronouns("")).toBe(false);
  });
});

describe("displayPronouns", () => {
  it("returns an empty string for null or undefined", () => {
    expect(displayPronouns(null)).toBe("");
    expect(displayPronouns(undefined)).toBe("");
    expect(displayPronouns("")).toBe("");
  });

  it("returns the input unchanged for a preset pair", () => {
    expect(displayPronouns("he/him")).toBe("he/him");
    expect(displayPronouns("they/them")).toBe("they/them");
  });

  it("formats a custom string as 'subj/obj'", () => {
    expect(displayPronouns("xe|xem|xyr|xyrs|xemself|s")).toBe("xe/xem");
  });

  it("falls back to the raw value when the custom string is malformed", () => {
    expect(displayPronouns("xe|xem")).toBe("xe|xem");
  });
});
