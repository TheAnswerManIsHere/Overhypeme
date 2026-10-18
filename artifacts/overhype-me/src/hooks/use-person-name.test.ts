import { describe, expect, it } from "vitest";
import { clearStoredIdentity, commitLinkHalves, dropPendingForKey, profileIdentity, resolveInitialIdentity, type SafeStorage } from "./use-person-name";
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
    expect(resolveInitialIdentity(s, null, null)).toMatchObject({ name: "Ada", pronouns: "she/her", pronounsSupplied: true });
  });

  it("treats missing pronouns as not supplied, rendering with the fallback", () => {
    const s = memoryStorage({ fact_db_name: "Ada" });
    expect(resolveInitialIdentity(s, null, null)).toMatchObject({ name: "Ada", pronouns: DEFAULT_PRONOUNS, pronounsSupplied: false });
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

  it("applies a full share link to an empty browser in the identity, holding it unwritten until auth resolves", () => {
    const s = memoryStorage();
    const r = resolveInitialIdentity(s, "Grace", "she/her");
    expect(r).toEqual({ name: "Grace", pronouns: "she/her", pronounsSupplied: true, pending: { name: "Grace", pronouns: "she/her" } });
    expect(s.data).toEqual({});
    // A reload before auth resolves still carries the link, so it resolves the same way.
    expect(resolveInitialIdentity(s, "Grace", "she/her")).toEqual(r);
  });

  it("applies a half link and leaves the other half unsupplied", () => {
    const s = memoryStorage();
    const r = resolveInitialIdentity(s, null, "they/them");
    expect(r).toEqual({ name: "", pronouns: "they/them", pronounsSupplied: true, pending: { name: null, pronouns: "they/them" } });
    const n = resolveInitialIdentity(memoryStorage(), "Grace", null);
    expect(n).toEqual({ name: "Grace", pronouns: DEFAULT_PRONOUNS, pronounsSupplied: false, pending: { name: "Grace", pronouns: null } });
  });

  it("never overwrites halves the browser already holds", () => {
    const s = memoryStorage({ fact_db_name: "Ada", fact_db_pronouns: "she/her" });
    expect(resolveInitialIdentity(s, "Grace", "he/him")).toEqual({ name: "Ada", pronouns: "she/her", pronounsSupplied: true, pending: { name: null, pronouns: null } });
    expect(s.data.fact_db_name).toBe("Ada");
    expect(s.data.fact_db_pronouns).toBe("she/her");
  });

  it("fills only the empty half when the browser holds one", () => {
    const s = memoryStorage({ fact_db_name: "Ada" });
    expect(resolveInitialIdentity(s, "Grace", "they/them")).toEqual({ name: "Ada", pronouns: "they/them", pronounsSupplied: true, pending: { name: null, pronouns: "they/them" } });
    expect(s.data).toEqual({ fact_db_name: "Ada" });
  });

  it("works when storage is unavailable", () => {
    const broken: SafeStorage = { get: () => null, set: () => {}, remove: () => {} };
    expect(resolveInitialIdentity(broken, "Grace", "she/her")).toMatchObject({ name: "Grace", pronouns: "she/her", pronounsSupplied: true });
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

describe("commitLinkHalves (a signed-out visitor keeps the link's halves, #723)", () => {
  it("writes exactly the held halves once the visitor is known to be signed out", () => {
    const s = memoryStorage();
    const r = resolveInitialIdentity(s, "Grace", "they/them");
    commitLinkHalves(s, r.pending);
    expect(s.data).toEqual({ fact_db_name: "Grace", fact_db_pronouns: "they/them" });
    // After that the link's halves are the browser's own; a later load needs no parameters.
    expect(resolveInitialIdentity(s, null, null)).toEqual({ name: "Grace", pronouns: "they/them", pronounsSupplied: true, pending: { name: null, pronouns: null } });
  });

  it("never touches a half the browser already held", () => {
    const s = memoryStorage({ fact_db_name: "Ada", fact_db_pronouns: "she/her" });
    commitLinkHalves(s, resolveInitialIdentity(s, "Grace", "they/them").pending);
    expect(s.data).toEqual({ fact_db_name: "Ada", fact_db_pronouns: "she/her" });
  });

  it("writes only the half the link filled", () => {
    const s = memoryStorage({ fact_db_name: "Ada" });
    commitLinkHalves(s, resolveInitialIdentity(s, "Grace", "they/them").pending);
    expect(s.data).toEqual({ fact_db_name: "Ada", fact_db_pronouns: "they/them" });
  });

  it("never overwrites a half another tab saved while this one waited on auth", () => {
    const s = memoryStorage();
    const r = resolveInitialIdentity(s, "Grace", "they/them");
    s.data.fact_db_name = "Ada";
    s.data.fact_db_pronouns = "she/her";
    commitLinkHalves(s, r.pending);
    expect(s.data).toEqual({ fact_db_name: "Ada", fact_db_pronouns: "she/her" });
  });

  it("writes nothing when a signed-in visitor's link is dropped instead (nothing was persisted)", () => {
    const s = memoryStorage();
    resolveInitialIdentity(s, "Grace", "they/them");
    expect(s.data).toEqual({});
  });
});

describe("dropPendingForKey (another tab's write or clear settles that half, #723)", () => {
  const held = { name: "Grace", pronouns: "they/them" };
  it("drops the half whose key another tab changed, leaving the other", () => {
    expect(dropPendingForKey(held, "fact_db_name")).toEqual({ name: null, pronouns: "they/them" });
    expect(dropPendingForKey(held, "fact_db_pronouns")).toEqual({ name: "Grace", pronouns: null });
  });
  it("keeps both halves for an unrelated key or a whole-storage clear", () => {
    expect(dropPendingForKey(held, "unrelated")).toBe(held);
    expect(dropPendingForKey(held, null)).toBe(held);
  });
  it("after another tab clears the name, a signed-out resolve leaves it cleared", () => {
    const s = memoryStorage();
    const r = resolveInitialIdentity(s, "Grace", null);
    commitLinkHalves(s, dropPendingForKey(r.pending, "fact_db_name"));
    expect(s.data).toEqual({});
  });
});

describe("profileIdentity (an empty account value is never a choice, #723)", () => {
  it("leaves pronouns unsupplied when the account has none", () => {
    expect(profileIdentity("Ada", "")).toEqual({ name: "Ada", pronouns: null });
    expect(profileIdentity("Ada", "   ")).toEqual({ name: "Ada", pronouns: null });
  });
  it("keeps the account's pronouns, including he/him, as supplied", () => {
    expect(profileIdentity(" Ada ", "she/her")).toEqual({ name: "Ada", pronouns: "she/her" });
    expect(profileIdentity("Ada", "he/him")).toEqual({ name: "Ada", pronouns: "he/him" });
  });
});
