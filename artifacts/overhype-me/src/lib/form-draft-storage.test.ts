import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  createLocalStorageAdapter,
  getRelativeTime,
  stableSerialize,
} from "./form-draft-storage";

interface Draft {
  text: string;
}

const KEY = "test_draft";

function isDraft(v: unknown): v is Draft {
  return !!v && typeof v === "object" && typeof (v as Draft).text === "string";
}

describe("getRelativeTime", () => {
  it("labels recent / minute / hour / stale boundaries", () => {
    const now = Date.now();
    expect(getRelativeTime(now)).toBe("Saved just now");
    expect(getRelativeTime(now - 29_000)).toBe("Saved just now");
    expect(getRelativeTime(now - 60_000)).toBe("Saved 1 min ago");
    expect(getRelativeTime(now - 5 * 60_000)).toBe("Saved 5 min ago");
    expect(getRelativeTime(now - 3 * 60 * 60_000)).toBe("Saved 3h ago");
    expect(getRelativeTime(now - 48 * 60 * 60_000)).toBe("Saved a while ago");
  });
});

describe("stableSerialize", () => {
  it("is independent of key order", () => {
    expect(stableSerialize({ b: 1, a: 2 })).toBe(stableSerialize({ a: 2, b: 1 }));
  });
  it("recurses into nested objects and arrays", () => {
    const a = { outer: { z: 1, a: 2 }, list: [{ y: 1, x: 2 }] };
    const b = { list: [{ x: 2, y: 1 }], outer: { a: 2, z: 1 } };
    expect(stableSerialize(a)).toBe(stableSerialize(b));
  });
});

describe("createLocalStorageAdapter", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.useRealTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("round-trips a value with its savedAt", () => {
    const adapter = createLocalStorageAdapter<Draft>({ key: KEY, isValid: isDraft });
    const savedAt = adapter.save({ text: "hello" });
    const loaded = adapter.load();
    expect(loaded).toEqual({ value: { text: "hello" }, savedAt });
  });

  it("returns null when the key is absent", () => {
    const adapter = createLocalStorageAdapter<Draft>({ key: KEY, isValid: isDraft });
    expect(adapter.load()).toBeNull();
  });

  it("expires and prunes drafts older than the TTL", () => {
    const adapter = createLocalStorageAdapter<Draft>({ key: KEY, ttlMs: 1000, isValid: isDraft });
    adapter.save({ text: "old" });
    // Advance wall-clock past the TTL.
    const future = Date.now() + 5000;
    vi.spyOn(Date, "now").mockReturnValue(future);
    expect(adapter.load()).toBeNull();
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });

  it("returns null and prunes on corrupt JSON", () => {
    window.localStorage.setItem(KEY, "{not json");
    const adapter = createLocalStorageAdapter<Draft>({ key: KEY, isValid: isDraft });
    expect(adapter.load()).toBeNull();
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });

  it("returns null on schema-version mismatch", () => {
    const adapter = createLocalStorageAdapter<Draft>({ key: KEY, schemaVersion: 2, isValid: isDraft });
    // Persist under v1, then read with a v2 adapter.
    createLocalStorageAdapter<Draft>({ key: KEY, schemaVersion: 1 }).save({ text: "x" });
    expect(adapter.load()).toBeNull();
  });

  it("returns null and prunes when isValid rejects the shape", () => {
    const adapter = createLocalStorageAdapter<Draft>({ key: KEY, isValid: isDraft });
    // Same envelope shape but a value that fails validation.
    createLocalStorageAdapter<{ nope: number }>({ key: KEY }).save({ nope: 1 });
    expect(adapter.load()).toBeNull();
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });

  it("clear() removes the draft", () => {
    const adapter = createLocalStorageAdapter<Draft>({ key: KEY, isValid: isDraft });
    adapter.save({ text: "x" });
    adapter.clear();
    expect(adapter.load()).toBeNull();
  });

  it("never throws when setItem fails (quota / private mode)", () => {
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    const adapter = createLocalStorageAdapter<Draft>({ key: KEY, isValid: isDraft });
    expect(() => adapter.save({ text: "x" })).not.toThrow();
    spy.mockRestore();
  });
});
