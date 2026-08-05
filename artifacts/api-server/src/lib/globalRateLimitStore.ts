/**
 * A `Store` for `express-rate-limit` that mirrors the package's own built-in
 * `MemoryStore` (same two-map current/previous rotation, same `unref()`'d
 * interval) but adds a hard cap on the total number of tracked keys.
 *
 * `MemoryStore` bounds *retention time* (a key survives at most two windows
 * after its last hit) but not *peak cardinality* — a flood of distinct keys
 * (e.g. one request each from many distinct IPs/IPv6 /56s) grows both maps
 * without limit, which turns a traffic flood into an OOM crash. This store
 * caps `current.size + previous.size` combined (not per-map — `previous` can
 * hold a full window's worth of keys at the same time as `current`, so a
 * per-map cap would silently admit ~2x the intended budget) and evicts the
 * oldest-by-insertion key once the cap is reached, always draining `previous`
 * before `current` since every `previous` entry is older than every `current`
 * entry by construction.
 *
 * Eviction fails safe: an evicted key's counter resets, giving that caller a
 * looser limit for one window. It can never produce a wrongful 429.
 */
import type { Options, ClientRateLimitInfo, Store } from "express-rate-limit";

interface Client {
  totalHits: number;
  resetTime: Date;
}

/**
 * Total across BOTH maps combined. ~150-200 bytes/entry (Map overhead + key
 * string + {totalHits, resetTime}) puts the cap's worst-case heap cost at
 * ~15-20MB — a fixed, computable bound. The traffic-side question (how many
 * distinct keys a real instance sees per window) cannot be measured from this
 * environment; this is a placeholder pending production instrumentation of
 * peak `current.size + previous.size`, not a figure derived from observed
 * traffic. Revisit once that measurement exists.
 */
export const MAX_TRACKED_KEYS = 100_000;

export class BoundedMemoryStore implements Store {
  localKeys = true;

  private previous = new Map<string, Client>();
  private current = new Map<string, Client>();
  private windowMs = 0;
  private interval: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly maxTrackedKeys: number = MAX_TRACKED_KEYS) {}

  init(options: Options): void {
    this.windowMs = options.windowMs;
    if (this.interval) clearInterval(this.interval);
    this.interval = setInterval(() => this.clearExpired(), this.windowMs);
    this.interval.unref?.();
  }

  async get(key: string): Promise<ClientRateLimitInfo | undefined> {
    return this.current.get(key) ?? this.previous.get(key);
  }

  async increment(key: string): Promise<ClientRateLimitInfo> {
    const client = this.getOrCreateClient(key);
    const now = Date.now();
    if (client.resetTime.getTime() <= now) {
      this.resetClient(client, now);
    }
    client.totalHits++;
    return client;
  }

  async decrement(key: string): Promise<void> {
    const client = this.getOrCreateClient(key);
    if (client.totalHits > 0) client.totalHits--;
  }

  async resetKey(key: string): Promise<void> {
    this.current.delete(key);
    this.previous.delete(key);
  }

  async resetAll(): Promise<void> {
    this.current.clear();
    this.previous.clear();
  }

  shutdown(): void {
    if (this.interval) clearInterval(this.interval);
    void this.resetAll();
  }

  /** Peak cardinality right now — exposed for tests, not part of the `Store` contract. */
  get trackedKeyCount(): number {
    return this.current.size + this.previous.size;
  }

  private resetClient(client: Client, now = Date.now()): Client {
    client.totalHits = 0;
    client.resetTime.setTime(now + this.windowMs);
    return client;
  }

  private getOrCreateClient(key: string): Client {
    const existing = this.current.get(key);
    if (existing) return existing;

    let client: Client;
    const fromPrevious = this.previous.get(key);
    if (fromPrevious) {
      // Promoting an entry from previous->current doesn't change total
      // cardinality, so no eviction check here.
      client = fromPrevious;
      this.previous.delete(key);
    } else {
      client = { totalHits: 0, resetTime: new Date() };
      this.resetClient(client);
      this.evictIfAtCapacity();
    }
    this.current.set(key, client);
    return client;
  }

  private evictIfAtCapacity(): void {
    while (this.current.size + this.previous.size >= this.maxTrackedKeys) {
      const victim = this.previous.size > 0 ? this.previous : this.current;
      const oldestKey = victim.keys().next().value;
      if (oldestKey === undefined) break;
      victim.delete(oldestKey);
    }
  }

  /** Move current clients to previous, start a fresh current map. Runs every `windowMs`. */
  private clearExpired(): void {
    this.previous = this.current;
    this.current = new Map();
  }
}
