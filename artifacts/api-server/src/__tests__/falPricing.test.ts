/**
 * Integration tests for falPricing.ts (refreshPricingCache + getCachedPrice).
 *
 * These touch the real fal_pricing_cache table on the dev DB. globalThis.fetch
 * is stubbed per-test so no real HTTP call goes to api.fal.ai.
 *
 * All test endpoint IDs are prefixed with "tfppricing-" and cleaned up in
 * afterEach.
 *
 * Prefix uses `-` (not `_`) so SQL LIKE wildcards in the cleanup can't
 * accidentally match other test files' rows during parallel runs. See
 * authMiddleware.test.ts for the full convention.
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { db } from "@workspace/db";
import { falPricingCacheTable } from "@workspace/db/schema";
import { eq, like } from "drizzle-orm";

import { refreshPricingCache, getCachedPrice } from "../lib/falPricing.js";


// ── Helpers ────────────────────────────────────────────────────────────────────

const ENDPOINT_PREFIX = "tfppricing-";

function endpoint(suffix: string): string {
  return `${ENDPOINT_PREFIX}${suffix}`;
}

async function cleanupTestRows(): Promise<void> {
  // ENDPOINT_PREFIX uses `-` (not `_`) so SQL LIKE wildcards can't match other
  // test files' rows during parallel runs. See the file header comment.
  await db
    .delete(falPricingCacheTable)
    .where(like(falPricingCacheTable.endpointId, `${ENDPOINT_PREFIX}%`));
}

async function getRow(endpointId: string) {
  const [row] = await db
    .select()
    .from(falPricingCacheTable)
    .where(eq(falPricingCacheTable.endpointId, endpointId))
    .limit(1);
  return row ?? null;
}

async function seedRow(opts: {
  endpointId: string;
  unitPrice: string;
  unit?: string;
  fetchedAt?: Date;
}): Promise<void> {
  const now = new Date();
  await db.insert(falPricingCacheTable).values({
    endpointId: opts.endpointId,
    unitPrice: opts.unitPrice,
    unit: opts.unit ?? "image",
    currency: "USD",
    fetchedAt: opts.fetchedAt ?? now,
    createdAt: now,
    updatedAt: now,
  });
}

// ── Fetch stub ────────────────────────────────────────────────────────────────
// Stores a queue of canned responses; assertions for what URL was called are
// captured in `lastFetchUrl`. Each test sets up its own canned response.

type StubResponse =
  | { kind: "json"; status: number; body: unknown }
  | { kind: "throw"; error: Error };

let stubResponse: StubResponse | null = null;
let lastFetchUrl: string | null = null;
let lastFetchInit: RequestInit | undefined = undefined;
const originalFetch = globalThis.fetch;

function installFetchStub(): void {
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    lastFetchUrl = typeof input === "string" ? input : input.toString();
    lastFetchInit = init as RequestInit | undefined;
    const r = stubResponse;
    if (!r) throw new Error("falPricing test: fetch called but no stub configured");
    if (r.kind === "throw") throw r.error;
    return new Response(JSON.stringify(r.body), {
      status: r.status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}

function uninstallFetchStub(): void {
  globalThis.fetch = originalFetch;
  stubResponse = null;
  lastFetchUrl = null;
  lastFetchInit = undefined;
}

// ── Env / lifecycle ────────────────────────────────────────────────────────────

let originalApiKey: string | undefined;

before(() => {
  originalApiKey = process.env["FAL_AI_API_KEY"];
  installFetchStub();
});

after(async () => {
  if (originalApiKey === undefined) {
    delete process.env["FAL_AI_API_KEY"];
  } else {
    process.env["FAL_AI_API_KEY"] = originalApiKey;
  }
  uninstallFetchStub();
  await cleanupTestRows();
});

beforeEach(() => {
  process.env["FAL_AI_API_KEY"] = "test-key";
  stubResponse = null;
  lastFetchUrl = null;
  lastFetchInit = undefined;
});

afterEach(async () => {
  await cleanupTestRows();
});

// ── refreshPricingCache: response envelope shapes ──────────────────────────────

describe("refreshPricingCache — response envelope shapes", () => {
  it("handles the canonical { prices: [...] } envelope", async () => {
    const ep = endpoint("prices-shape");
    stubResponse = {
      kind: "json",
      status: 200,
      body: { prices: [{ endpoint_id: ep, unit_price: 0.05, unit: "image", currency: "USD" }] },
    };
    await refreshPricingCache([ep]);
    const row = await getRow(ep);
    assert.ok(row, "expected row to be inserted");
    assert.equal(parseFloat(row.unitPrice), 0.05);
    assert.equal(row.unit, "image");
    assert.equal(row.currency, "USD");
  });

  it("handles the { data: [...] } envelope", async () => {
    const ep = endpoint("data-shape");
    stubResponse = {
      kind: "json",
      status: 200,
      body: { data: [{ endpoint_id: ep, unit_price: 0.10, unit: "megapixel" }] },
    };
    await refreshPricingCache([ep]);
    const row = await getRow(ep);
    assert.ok(row);
    assert.equal(parseFloat(row.unitPrice), 0.10);
    assert.equal(row.unit, "megapixel");
  });

  it("handles a flat array envelope", async () => {
    const ep = endpoint("array-shape");
    stubResponse = {
      kind: "json",
      status: 200,
      body: [{ endpoint_id: ep, unit_price: 0.25, unit: "image" }],
    };
    await refreshPricingCache([ep]);
    const row = await getRow(ep);
    assert.ok(row);
    assert.equal(parseFloat(row.unitPrice), 0.25);
  });

  it("handles a single-object envelope with endpoint_id", async () => {
    const ep = endpoint("single-with-id");
    stubResponse = {
      kind: "json",
      status: 200,
      body: { endpoint_id: ep, unit_price: 1.5, unit: "video_token" },
    };
    await refreshPricingCache([ep]);
    const row = await getRow(ep);
    assert.ok(row);
    assert.equal(parseFloat(row.unitPrice), 1.5);
    assert.equal(row.unit, "video_token");
  });

  it("handles a flat object with unit_price but no endpoint_id (uses requested id)", async () => {
    const ep = endpoint("flat-no-id");
    stubResponse = {
      kind: "json",
      status: 200,
      body: { unit_price: 0.42, unit: "image", currency: "USD" },
    };
    await refreshPricingCache([ep]);
    const row = await getRow(ep);
    assert.ok(row);
    assert.equal(parseFloat(row.unitPrice), 0.42);
  });

  it("defaults unit to 'unknown' and currency to 'USD' when omitted", async () => {
    const ep = endpoint("default-unit-currency");
    stubResponse = {
      kind: "json",
      status: 200,
      body: { prices: [{ endpoint_id: ep, unit_price: 0.07 }] },
    };
    await refreshPricingCache([ep]);
    const row = await getRow(ep);
    assert.ok(row);
    assert.equal(row.unit, "unknown");
    assert.equal(row.currency, "USD");
  });

  it("does not insert anything for an unrecognized response shape", async () => {
    const ep = endpoint("bogus-shape");
    stubResponse = { kind: "json", status: 200, body: { something: "else" } };
    await refreshPricingCache([ep]);
    const row = await getRow(ep);
    assert.equal(row, null);
  });
});

// ── refreshPricingCache: failure modes ─────────────────────────────────────────

describe("refreshPricingCache — failure modes", () => {
  it("does not insert when no API key is configured", async () => {
    delete process.env["FAL_AI_API_KEY"];
    delete process.env["FAL_KEY"];
    const ep = endpoint("no-api-key");
    stubResponse = { kind: "json", status: 200, body: { prices: [{ endpoint_id: ep, unit_price: 0.99, unit: "image" }] } };
    await refreshPricingCache([ep]);
    const row = await getRow(ep);
    assert.equal(row, null, "row must not be inserted without API key");
  });

  it("also accepts the FAL_KEY env var as a fallback", async () => {
    delete process.env["FAL_AI_API_KEY"];
    process.env["FAL_KEY"] = "fallback-key";
    const ep = endpoint("fal-key-fallback");
    stubResponse = { kind: "json", status: 200, body: { prices: [{ endpoint_id: ep, unit_price: 0.33, unit: "image" }] } };
    try {
      await refreshPricingCache([ep]);
      const row = await getRow(ep);
      assert.ok(row, "row must be inserted using FAL_KEY");
      assert.equal(parseFloat(row.unitPrice), 0.33);
    } finally {
      delete process.env["FAL_KEY"];
    }
  });

  it("does not insert when the pricing API returns non-200", async () => {
    const ep = endpoint("non-200");
    stubResponse = { kind: "json", status: 503, body: { error: "down" } };
    await refreshPricingCache([ep]);
    const row = await getRow(ep);
    assert.equal(row, null);
  });

  it("does not insert (and does not throw) when fetch itself rejects", async () => {
    const ep = endpoint("fetch-throws");
    stubResponse = { kind: "throw", error: new Error("network down") };
    await refreshPricingCache([ep]);
    const row = await getRow(ep);
    assert.equal(row, null);
  });

  it("URL-encodes the endpoint_id query param when calling the pricing API", async () => {
    const ep = endpoint("needs/encoding");
    stubResponse = { kind: "json", status: 200, body: { prices: [{ endpoint_id: ep, unit_price: 0.01, unit: "image" }] } };
    await refreshPricingCache([ep]);
    assert.ok(lastFetchUrl, "fetch must have been called");
    assert.ok(lastFetchUrl!.includes(encodeURIComponent(ep)));
    assert.ok(!lastFetchUrl!.endsWith(ep), "URL must not contain raw unencoded slashes");
  });

  it("sends the API key in an Authorization: Key <key> header", async () => {
    const ep = endpoint("auth-header");
    stubResponse = { kind: "json", status: 200, body: { prices: [{ endpoint_id: ep, unit_price: 0.01, unit: "image" }] } };
    await refreshPricingCache([ep]);
    const headers = lastFetchInit?.headers as Record<string, string> | undefined;
    assert.equal(headers?.["Authorization"], "Key test-key");
  });
});

// ── refreshPricingCache: upsert + price change ─────────────────────────────────

describe("refreshPricingCache — upsert behavior", () => {
  it("updates an existing row instead of creating a duplicate", async () => {
    const ep = endpoint("upsert-update");
    await seedRow({ endpointId: ep, unitPrice: "0.10", unit: "image" });
    stubResponse = { kind: "json", status: 200, body: { prices: [{ endpoint_id: ep, unit_price: 0.20, unit: "image" }] } };
    await refreshPricingCache([ep]);
    const rows = await db
      .select()
      .from(falPricingCacheTable)
      .where(eq(falPricingCacheTable.endpointId, ep));
    assert.equal(rows.length, 1);
    assert.equal(parseFloat(rows[0]!.unitPrice), 0.20);
  });

  it("logs a PRICE CHANGE warning when the unit_price differs", async () => {
    const ep = endpoint("price-change");
    await seedRow({ endpointId: ep, unitPrice: "0.10", unit: "image" });
    stubResponse = { kind: "json", status: 200, body: { prices: [{ endpoint_id: ep, unit_price: 0.50, unit: "image" }] } };
    const captured: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => { captured.push(args.map(String).join(" ")); };
    try {
      await refreshPricingCache([ep]);
    } finally {
      console.warn = originalWarn;
    }
    assert.ok(
      captured.some(line => line.includes("PRICE CHANGE DETECTED") && line.includes(ep)),
      `expected a PRICE CHANGE log for ${ep}, got: ${captured.join("\n")}`,
    );
  });

  it("does NOT log a price change when the unit_price is identical", async () => {
    const ep = endpoint("no-change");
    await seedRow({ endpointId: ep, unitPrice: "0.10", unit: "image" });
    stubResponse = { kind: "json", status: 200, body: { prices: [{ endpoint_id: ep, unit_price: 0.10, unit: "image" }] } };
    const captured: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => { captured.push(args.map(String).join(" ")); };
    try {
      await refreshPricingCache([ep]);
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(
      captured.filter(line => line.includes("PRICE CHANGE DETECTED")).length,
      0,
    );
  });
});

// ── getCachedPrice ─────────────────────────────────────────────────────────────

describe("getCachedPrice", () => {
  it("returns the cached row when it is fresh (< 1 hour old)", async () => {
    const ep = endpoint("fresh");
    await seedRow({
      endpointId: ep,
      unitPrice: "0.077",
      unit: "image",
      fetchedAt: new Date(Date.now() - 5 * 60 * 1000), // 5 minutes ago
    });
    // Fetch should NOT be called for a fresh row — leave stubResponse null
    const result = await getCachedPrice(ep);
    assert.equal(result.unitPrice, 0.077);
    assert.equal(result.unit, "image");
    assert.equal(lastFetchUrl, null, "fetch must not be called for a fresh row");
  });

  it("triggers a refresh when the cached row is stale (> 1 hour old)", async () => {
    const ep = endpoint("stale");
    await seedRow({
      endpointId: ep,
      unitPrice: "0.10",
      unit: "image",
      fetchedAt: new Date(Date.now() - 2 * 60 * 60 * 1000), // 2 hours ago
    });
    stubResponse = {
      kind: "json",
      status: 200,
      body: { prices: [{ endpoint_id: ep, unit_price: 0.20, unit: "image" }] },
    };
    const result = await getCachedPrice(ep);
    assert.equal(result.unitPrice, 0.20);
    assert.ok(lastFetchUrl, "fetch must be called for a stale row");
  });

  it("triggers a refresh when no row exists yet", async () => {
    const ep = endpoint("empty");
    stubResponse = {
      kind: "json",
      status: 200,
      body: { prices: [{ endpoint_id: ep, unit_price: 0.99, unit: "image" }] },
    };
    const result = await getCachedPrice(ep);
    assert.equal(result.unitPrice, 0.99);
    assert.ok(lastFetchUrl);
  });

  it("throws a clear error when no row exists and the refresh also fails", async () => {
    const ep = endpoint("no-pricing");
    stubResponse = { kind: "json", status: 503, body: { error: "down" } };
    await assert.rejects(
      () => getCachedPrice(ep),
      /No pricing available for fal\.ai endpoint/,
    );
  });
});
