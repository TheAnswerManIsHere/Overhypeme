/**
 * Browser-storage backing for the `useFormDraft` autosave hook.
 *
 * Mirrors the house style of `components/meme-builder/state/pendingBuilderState.ts`:
 * an `isStorageAvailable()` guard, a schema-versioned + TTL'd JSON envelope, and
 * try/catch that swallows quota / private-mode / parse errors so a failed draft
 * save never breaks the form.
 *
 * The `StorageAdapter` seam is what lets a single hook serve both localStorage
 * forms (the default adapter built here) and server-backed forms — e.g. admin
 * moderation supplies its own PATCH-based adapter while reusing the same hook.
 */

export interface LoadedDraft<T> {
  value: T;
  /** Epoch ms when the draft was persisted. */
  savedAt: number;
}

/**
 * Persistence strategy for a draft. Every method may be sync or async; the hook
 * awaits each uniformly, so localStorage (sync) and server (async) share one path.
 */
export interface StorageAdapter<T> {
  /** Returns the persisted draft, or null when absent / stale / corrupt / invalid. */
  load(): LoadedDraft<T> | null | Promise<LoadedDraft<T> | null>;
  /** Persists the value; returns the `savedAt` timestamp used. */
  save(value: T): number | Promise<number>;
  /** Removes any persisted draft. */
  clear(): void | Promise<void>;
}

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24h — matches the original SubmitFact draft.
const DEFAULT_SCHEMA_VERSION = 1;

interface DraftEnvelope {
  schemaVersion: number;
  savedAt: number;
  value: unknown;
}

function isStorageAvailable(): boolean {
  try {
    return typeof window !== "undefined" && "localStorage" in window;
  } catch {
    return false;
  }
}

/**
 * Deterministic JSON: object keys are emitted in sorted order at every depth, so
 * two structurally-equal values always serialize to the same string. The hook
 * uses this to detect whether a draft actually changed — independent of React
 * object identity — so equivalent-value re-renders don't trigger redundant saves.
 *
 * (This is a snapshot for change detection, not a guarantee of semantic equality
 * across types — e.g. `undefined` keys are dropped, as with any JSON.)
 */
export function stableSerialize(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      out[key] = sortKeys(source[key]);
    }
    return out;
  }
  return value;
}

/** "Saved just now" / "Saved N min ago" / "Saved Nh ago" / "Saved a while ago". */
export function getRelativeTime(savedAt: number): string {
  const seconds = Math.floor((Date.now() - savedAt) / 1000);
  if (seconds < 30) return "Saved just now";
  if (seconds < 90) return "Saved 1 min ago";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `Saved ${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `Saved ${hours}h ago`;
  return "Saved a while ago";
}

export interface LocalStorageAdapterOptions<T> {
  /** localStorage key. Namespace per-entity to avoid collisions (e.g. `comment_draft::<id>`). */
  key: string;
  schemaVersion?: number;
  ttlMs?: number;
  /** Validates the restored value's shape; an invalid draft is pruned and treated as absent. */
  isValid?: (value: unknown) => value is T;
}

/**
 * The default backend — localStorage, encoding the (robust) fact-submission
 * behavior. Never throws: quota / private-mode / parse failures are swallowed so
 * client drafts degrade gracefully. (The server adapter, by contrast, throws so
 * the hook can surface an error.)
 */
export function createLocalStorageAdapter<T>(
  opts: LocalStorageAdapterOptions<T>,
): StorageAdapter<T> {
  const {
    key,
    schemaVersion = DEFAULT_SCHEMA_VERSION,
    ttlMs = DEFAULT_TTL_MS,
    isValid,
  } = opts;

  const clear = (): void => {
    if (!isStorageAvailable()) return;
    try {
      window.localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  };

  return {
    load(): LoadedDraft<T> | null {
      if (!isStorageAvailable()) return null;

      let raw: string | null;
      try {
        raw = window.localStorage.getItem(key);
      } catch {
        return null;
      }
      if (!raw) return null;

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        clear();
        return null;
      }

      if (!isEnvelope(parsed)) {
        clear();
        return null;
      }
      if (parsed.schemaVersion !== schemaVersion) {
        clear();
        return null;
      }
      if (Date.now() - parsed.savedAt > ttlMs) {
        clear();
        return null;
      }
      if (isValid && !isValid(parsed.value)) {
        clear();
        return null;
      }

      return { value: parsed.value as T, savedAt: parsed.savedAt };
    },

    save(value: T): number {
      const savedAt = Date.now();
      if (!isStorageAvailable()) return savedAt;
      const envelope: DraftEnvelope = { schemaVersion, savedAt, value };
      try {
        window.localStorage.setItem(key, stableSerialize(envelope));
      } catch {
        // Quota exceeded / private mode — the user just loses their draft.
      }
      return savedAt;
    },

    clear,
  };
}

function isEnvelope(v: unknown): v is DraftEnvelope {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.schemaVersion === "number" &&
    typeof o.savedAt === "number" &&
    "value" in o
  );
}
