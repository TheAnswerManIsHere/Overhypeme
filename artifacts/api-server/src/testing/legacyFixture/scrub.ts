/**
 * Scrub primitives for the legacy fixture (plan D3–D4): the run key, the
 * identity map, content-keyed prose, re-keyed hashes and synthetic values.
 *
 * Everything here is keyed by a random 32-byte run key that is generated when
 * the exporter starts and never written anywhere: the same source value maps
 * to the same synthetic value within one run and to nothing recoverable
 * outside it. That is what keeps equality relations (an override's baseline
 * comparison, two rows naming the same user, a shared object path) true on the
 * fixture without the exporter needing to know which comparisons exist.
 */
import { createHmac, randomBytes } from "node:crypto";

const FIRST_NAMES = [
  "Avery", "Blake", "Casey", "Dakota", "Emery", "Finley", "Gray", "Harper", "Indigo", "Jules",
  "Kendall", "Logan", "Morgan", "Noel", "Oakley", "Parker", "Quinn", "Reese", "Sage", "Tatum",
  "Umber", "Vale", "Wren", "Xen", "Yael", "Zion",
];
const LAST_NAMES = [
  "Ashdown", "Birchwood", "Coldwater", "Dunmore", "Elmstead", "Fairhaven", "Glenrock", "Hollowell",
  "Ironside", "Juniper", "Kestrel", "Larkspur", "Marchbank", "Northcote", "Oakhurst", "Pinecrest",
  "Quarry", "Ravenhill", "Stonebridge", "Thornfield", "Underhill", "Valemont", "Westbrook", "Yarrow",
];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SyntheticPerson {
  rank: number;
  email: string;
  firstName: string;
  lastName: string;
  displayName: string;
}

/** The canonical placeholder for a non-blank prose value: `[fixture text <8 hex>]`. */
export const PROSE_PLACEHOLDER_RE = /^\[fixture text [0-9a-f]{8}\]$|^fx[0-9a-f]+$/;

export class Scrubber {
  private readonly key: Buffer;
  private readonly people = new Map<string, SyntheticPerson>();
  private readonly labels = new Map<string, string>();

  constructor(key: Buffer = randomBytes(32)) {
    if (key.length < 32) throw new Error("[legacy-fixture] the run key must be at least 32 bytes");
    this.key = key;
  }

  /** Lowercase hex HMAC-SHA256 of `value`, domain-separated by `ns`. */
  hmac(ns: string, value: string): string {
    return createHmac("sha256", this.key).update(`${ns}\u0000${value}`).digest("hex");
  }

  /** A UUIDv4-shaped id derived from `value`; the same value always maps to the same id within a run. */
  uuid(ns: string, value: string): string {
    const h = this.hmac(ns, value);
    const variant = ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16);
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
  }

  /** The synthetic id for a user id. */
  userId(sourceId: string): string {
    return this.uuid("user", sourceId);
  }

  /**
   * Register the source's users in a stable order (by created_at, then id) so
   * each gets a synthetic person by rank. Must run before any row is scrubbed.
   */
  registerPeople(rows: Array<{ id: string; displayName: string | null; email: string | null }>): void {
    rows.forEach((row, index) => {
      const rank = index + 1;
      const first = FIRST_NAMES[index % FIRST_NAMES.length]!;
      const last = LAST_NAMES[Math.floor(index / FIRST_NAMES.length) % LAST_NAMES.length]!;
      const person: SyntheticPerson = {
        rank,
        email: `fixture-user-${rank}@example.test`,
        firstName: first,
        lastName: last,
        displayName: `${first} ${last}`,
      };
      this.people.set(row.id, person);
      // A human-readable actor label (display name, or email as a fallback) maps to the same person.
      for (const label of [row.displayName, row.email]) {
        if (label && label.trim()) this.labels.set(label.trim().toLowerCase(), person.displayName);
      }
    });
  }

  person(sourceUserId: string): SyntheticPerson | undefined {
    return this.people.get(sourceUserId);
  }

  /** A human-readable actor label: the mapped person's synthetic display name, or "Fixture Admin". */
  adminLabel(value: string | null | undefined): string | null | undefined {
    if (value == null) return value;
    if (!value.trim()) return value;
    return this.labels.get(value.trim().toLowerCase()) ?? "Fixture Admin";
  }

  /**
   * Content-keyed prose. Absent, null, empty and whitespace-only values are
   * returned exactly as stored — emptiness has meaning to the readers (plan
   * D4, Astra round 2). A non-blank value becomes `[fixture text <h>]`, or a
   * shorter `fx<h>` when the field's bound is tighter than the placeholder.
   */
  prose<T extends string | null | undefined>(value: T, maxLen?: number): T {
    if (value == null) return value;
    if (value.trim() === "") return value;
    const h = this.hmac("prose", value);
    const full = `[fixture text ${h.slice(0, 8)}]`;
    if (maxLen === undefined || full.length <= maxLen) return full as T;
    return `fx${h}`.slice(0, Math.max(1, maxLen)) as T;
  }

  /** A 64-hex re-key of a hash or other private token; equal inputs stay equal. */
  rekey(value: string | null | undefined): string | null | undefined {
    if (value == null) return value;
    return this.hmac("rekey", value);
  }

  /** An opaque id of the same family: a UUID stays a UUID, anything else becomes `fx_<hex>`. */
  opaqueId(value: string | null | undefined): string | null | undefined {
    if (value == null) return value;
    if (UUID_RE.test(value)) return this.uuid("opaque", value);
    return `fx_${this.hmac("opaque", value).slice(0, 24)}`;
  }

  /** A Stripe-shaped id: the object prefix kept (`sub_`, `cus_`, `pi_`, …), the rest synthetic. */
  stripeId(value: string | null | undefined): string | null | undefined {
    if (value == null) return value;
    const m = /^([a-z]+_)/.exec(value);
    const prefix = m ? m[1]! : "fx_";
    return `${prefix}fixture${this.hmac("stripe", value).slice(0, 16)}`;
  }
}

export const isUuid = (value: string): boolean => UUID_RE.test(value);
