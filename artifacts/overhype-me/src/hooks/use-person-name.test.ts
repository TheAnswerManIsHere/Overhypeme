import { describe, expect, it } from "vitest";
import { clearStoredIdentity, resolveInitialIdentity, type SafeStorage } from "./use-person-name";
import { DEFAULT_PRONOUNS } from "@/lib/pronouns";

function memoryStorage(init: Record<string, string> = {}): SafeStorage & { data: Record<string, string> } {
  const data = { ...init };
  return {
    data,
    get: (k) => (k in data ? data[k] : null),
    set: (k, v) => { data[k] = v; },
    remove: (k) => { delete data[k]; },
  };
}

describe("resolveInitialIdentity", () => {
  it("reads a stored name and pronouns as supplied", () => {
    const s = memoryStorage({ fact_db_name: "Ada", fact_db_pronouns: "she/her" });
    expect(resolveInitialIdentity(s, null, null)).toEqual({ name: "Ada", pronouns: "she/her", pronounsSupplied: true });
  });

  it("treats missing pronouns as not supplied, rendering with the fallback", () => {
    const s = memoryStorage({ fact_db_name: "Ada" });
    expect(resolveInitialIdentity(s, null, null)).toEqual({ name: "Ada", pronouns: DEFAULT_PRONOUNS, pronounsSupplied: false });
  });

  it("migrates the legacy subject/object keys into a supplied value", () => {
    const s = memoryStorage({ fact_db_pronoun_subject: "they", fact_db_pronoun_object: "them" });
    const r = resolveInitialIdentity(s, null, null);
    expect(r.pronouns).toBe("they/them");
    expect(r.pronounsSupplied).toBe(true);
    expect(s.data.fact_db_pronouns).toBe("they/them");
  });

  it("keeps a custom pipe-delimited pronoun set as stored", () => {
    const custom = "xe|xem|xyr|xyrs|xemself|s";
    const s = memoryStorage({ fact_db_name: "Ada", fact_db_pronouns: custom });
    expect(resolveInitialIdentity(s, null, null).pronouns).toBe(custom);
  });

  it("drops the legacy default persona unless the visitor chose it", () => {
    const s = memoryStorage({ fact_db_name: "David Franklin" });
    expect(resolveInitialIdentity(s, null, null).name).toBe("");
    expect(s.data.fact_db_name).toBeUndefined();
    const chosen = memoryStorage({ fact_db_name: "David Franklin", fact_db_name_explicit: "1" });
    expect(resolveInitialIdentity(chosen, null, null).name).toBe("David Franklin");
  });

  it("applies a full share link to an empty browser and persists exactly that", () => {
    const s = memoryStorage();
    const r = resolveInitialIdentity(s, "Grace", "she/her");
    expect(r).toEqual({ name: "Grace", pronouns: "she/her", pronounsSupplied: true });
    expect(s.data).toEqual({ fact_db_name: "Grace", fact_db_pronouns: "she/her" });
    // A reload with no parameters resolves to the same identity.
    expect(resolveInitialIdentity(s, null, null)).toEqual(r);
  });

  it("applies a half link and leaves the other half unsupplied", () => {
    const s = memoryStorage();
    const r = resolveInitialIdentity(s, null, "they/them");
    expect(r).toEqual({ name: "", pronouns: "they/them", pronounsSupplied: true });
    const n = resolveInitialIdentity(memoryStorage(), "Grace", null);
    expect(n).toEqual({ name: "Grace", pronouns: DEFAULT_PRONOUNS, pronounsSupplied: false });
  });

  it("never overwrites halves the browser already holds", () => {
    const s = memoryStorage({ fact_db_name: "Ada", fact_db_pronouns: "she/her" });
    expect(resolveInitialIdentity(s, "Grace", "he/him")).toEqual({ name: "Ada", pronouns: "she/her", pronounsSupplied: true });
    expect(s.data.fact_db_name).toBe("Ada");
    expect(s.data.fact_db_pronouns).toBe("she/her");
  });

  it("fills only the empty half when the browser holds one", () => {
    const s = memoryStorage({ fact_db_name: "Ada" });
    expect(resolveInitialIdentity(s, "Grace", "they/them")).toEqual({ name: "Ada", pronouns: "they/them", pronounsSupplied: true });
    expect(s.data.fact_db_pronouns).toBe("they/them");
  });

  it("works when storage is unavailable", () => {
    const broken: SafeStorage = { get: () => null, set: () => {}, remove: () => {} };
    expect(resolveInitialIdentity(broken, "Grace", "she/her")).toEqual({ name: "Grace", pronouns: "she/her", pronounsSupplied: true });
  });
});

describe("clearStoredIdentity", () => {
  it("removes every identity key, legacy keys included, and nothing else", () => {
    const s = memoryStorage({
      fact_db_name: "Ada", fact_db_pronouns: "she/her", fact_db_name_explicit: "1",
      fact_db_pronoun_subject: "she", fact_db_pronoun_object: "her",
      fact_db_first_name: "A", fact_db_last_name: "L", unrelated: "keep",
    });
    clearStoredIdentity(s);
    expect(s.data).toEqual({ unrelated: "keep" });
  });
});
