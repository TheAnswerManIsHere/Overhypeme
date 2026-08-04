import { describe, it, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createApp } from "../app.js";
import { globalLimiterLogLevel } from "../lib/rateLimit.js";
import { BoundedMemoryStore } from "../lib/globalRateLimitStore.js";
import type { Options } from "express-rate-limit";
import { logger } from "../lib/logger.js";

const allowedOrigin = "https://app.example.com";

// A non-exempt, router-unmatched path. Deliberately avoids /api/health and
// /api/health/queues for the high-volume tests (real DB queries) — those are
// covered explicitly below, once, to prove they ARE metered.
const PROBE_PATH = "/api/__ratelimit_probe__";

function appWithLimit(limit: number, windowMs = 60_000) {
  return createApp({ limiterOverrides: { limit, windowMs } });
}

describe("global rate limiter", () => {
  describe("ceiling boundary", () => {
    it("allows exactly the limit and blocks the next request", async () => {
      const app = appWithLimit(3);
      for (let i = 0; i < 3; i++) {
        const res = await request(app).get(PROBE_PATH);
        assert.notEqual(res.status, 429, `request ${i + 1} should not be blocked`);
      }
      const blocked = await request(app).get(PROBE_PATH);
      assert.equal(blocked.status, 429);
      assert.deepEqual(blocked.body, { error: "Too many requests. Please slow down." });
      assert.equal(blocked.headers["cache-control"], "no-store");
      assert.ok(blocked.headers["ratelimit-limit"], "expects standard RateLimit-* headers");
      assert.equal(blocked.headers["x-ratelimit-limit"], undefined, "no legacy headers");
    });

    it("does not leak state into a default-ceiling app created afterward", async () => {
      // Runs after the low-limit case above on purpose (order matters here,
      // not test isolation framework magic): proves createApp()/
      // createGlobalLimiter() are true per-call factories, not a reset seam
      // over shared module state.
      const app = createApp();
      for (let i = 0; i < 10; i++) {
        const res = await request(app).get(PROBE_PATH);
        assert.notEqual(res.status, 429, `request ${i + 1} against the default ceiling should not be blocked`);
      }
    });
  });

  describe("exemptions", () => {
    it("never meters GET or HEAD /api/healthz even past the ceiling", async () => {
      const app = appWithLimit(1);
      for (let i = 0; i < 5; i++) {
        const getRes = await request(app).get("/api/healthz");
        assert.notEqual(getRes.status, 429);
        const headRes = await request(app).head("/api/healthz");
        assert.notEqual(headRes.status, 429);
      }
    });

    it("exempts case- and trailing-slash-variant spellings identically", async () => {
      const app = appWithLimit(1);
      for (const path of ["/api/healthz", "/api/healthz/", "/API/HEALTHZ", "/API/HealthZ/"]) {
        const res = await request(app).get(path);
        assert.notEqual(res.status, 429, `${path} should be exempt`);
      }
    });

    it("does not exempt a wrong-method request to an exempt path", async () => {
      const app = appWithLimit(2);
      // POST /api/healthz has no route handler and is NOT exempt (only
      // GET/HEAD are), so it must still be metered like any other traffic.
      for (let i = 0; i < 2; i++) {
        await request(app).post("/api/healthz");
      }
      const blocked = await request(app).post("/api/healthz");
      assert.equal(blocked.status, 429);
    });

    it("meters /api/health and /api/health/queues — they are NOT exempt", async () => {
      const app = appWithLimit(2);
      await request(app).get("/api/health");
      await request(app).get("/api/health/queues");
      const blocked = await request(app).get("/api/health");
      assert.equal(blocked.status, 429);
    });

    it("meters OG and meme-asset requests — public-asset status does not imply limiter-exempt", async () => {
      const app = appWithLimit(2);
      await request(app).get("/api/og/some-fact-slug");
      await request(app).get("/api/memes/random-slug-1/image");
      const blocked = await request(app).get("/api/memes/random-slug-2/image");
      assert.equal(blocked.status, 429);
    });
  });

  describe("healthz early registration", () => {
    it("returns the exact same response as healthzHandler produces directly", async () => {
      const app = createApp();
      const res = await request(app).get("/api/healthz");
      assert.equal(res.status, 200);

      const { healthzHandler } = await import("../routes/health.js");
      let captured: unknown;
      const fakeRes = {
        json(body: unknown) {
          captured = body;
        },
      };
      healthzHandler({} as never, fakeRes as never);

      assert.deepEqual(res.body, captured);
    });
  });

  describe("CORS and preflight", () => {
    beforeEach(() => {
      // createApp() reads ALLOWED_ORIGINS fresh on each call, so pin it
      // explicitly here rather than relying on another test's assignment —
      // this describe block's "accepted origin" cases are only meaningful
      // if the origin is actually allowed at the moment the app is built.
      process.env.ALLOWED_ORIGINS = allowedOrigin;
    });

    it("never meters an accepted-origin preflight — cors() answers it directly", async () => {
      const app = appWithLimit(1);
      for (let i = 0; i < 5; i++) {
        const res = await request(app)
          .options(PROBE_PATH)
          .set("Origin", allowedOrigin)
          .set("Access-Control-Request-Method", "GET");
        assert.notEqual(res.status, 429);
      }
    });

    it("meters a rejected-origin preflight — cors() falls through instead of answering", async () => {
      const app = appWithLimit(1);
      const first = await request(app)
        .options(PROBE_PATH)
        .set("Origin", "https://evil.example.com")
        .set("Access-Control-Request-Method", "GET");
      assert.notEqual(first.status, 429);
      const blocked = await request(app)
        .options(PROBE_PATH)
        .set("Origin", "https://evil.example.com")
        .set("Access-Control-Request-Method", "GET");
      assert.equal(blocked.status, 429);
    });

    it("meters an absent-origin request like any other traffic", async () => {
      const app = appWithLimit(1);
      await request(app).get(PROBE_PATH);
      const blocked = await request(app).get(PROBE_PATH);
      assert.equal(blocked.status, 429);
    });

    it("carries correct CORS headers on a 429 from an allowed origin", async () => {
      const app = appWithLimit(1);
      await request(app).get(PROBE_PATH).set("Origin", allowedOrigin);
      const blocked = await request(app).get(PROBE_PATH).set("Origin", allowedOrigin);
      assert.equal(blocked.status, 429);
      assert.equal(blocked.headers["access-control-allow-origin"], allowedOrigin);
    });
  });

  describe("keying", () => {
    it("shares a bucket for the same CF-Connecting-IP and separates distinct ones", async () => {
      const app = appWithLimit(2);
      const ipA = "203.0.113.10";
      const ipB = "203.0.113.11";

      const a1 = await request(app).get(PROBE_PATH).set("CF-Connecting-IP", ipA);
      const a2 = await request(app).get(PROBE_PATH).set("CF-Connecting-IP", ipA);
      assert.notEqual(a1.status, 429);
      assert.notEqual(a2.status, 429);
      const aBlocked = await request(app).get(PROBE_PATH).set("CF-Connecting-IP", ipA);
      assert.equal(aBlocked.status, 429, "ipA should now be at its own ceiling");

      const b1 = await request(app).get(PROBE_PATH).set("CF-Connecting-IP", ipB);
      assert.notEqual(b1.status, 429, "a distinct IP must have its own bucket");
    });

    it("normalizes IPv6 addresses in the same /56 to one bucket, per ipKeyGenerator", async () => {
      const app = appWithLimit(1);
      // Same /56 (2001:db8:abcd::/56) but distinct full addresses.
      const first = await request(app).get(PROBE_PATH).set("CF-Connecting-IP", "2001:db8:abcd:0000::1");
      assert.notEqual(first.status, 429);
      const sameSubnet = await request(app).get(PROBE_PATH).set("CF-Connecting-IP", "2001:db8:abcd:00ff::2");
      assert.equal(sameSubnet.status, 429, "addresses in the same /56 must share a bucket");

      const differentSubnet = await request(app).get(PROBE_PATH).set("CF-Connecting-IP", "2001:db8:ffff::1");
      assert.notEqual(differentSubnet.status, 429, "a different /56 must have its own bucket");
    });
  });

  describe("log volume", () => {
    it("throttles its own blocked-request log line to at most one per burst", async (t) => {
      // The throttle (lib/rateLimit.ts's logBlockedThrottled) is deliberately
      // process-wide, so an earlier test's blocked request in this same file
      // can leave it primed and silence this test's own burst. Mock Date so
      // this test controls the throttle window itself instead of depending on
      // real wall-clock spacing from whatever ran before it.
      t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
      t.mock.timers.tick(2_000); // clear any throttle window left by a prior test

      const app = appWithLimit(2);
      const warnSpy = mock.method(logger, "warn", () => {});
      try {
        // 10 requests well past the ceiling, fired back-to-back at the same
        // (mocked) instant — all land inside the 1s throttle window.
        for (let i = 0; i < 10; i++) {
          await request(app).get(PROBE_PATH);
        }
        const blockedLogCalls = warnSpy.mock.calls.filter((c) =>
          typeof c.arguments[1] === "string" && c.arguments[1].includes("global rate limit exceeded"),
        );
        assert.equal(blockedLogCalls.length, 1, "expected exactly one throttled log line for the whole burst");
      } finally {
        warnSpy.mock.restore();
      }
    });

    it("silences pino-http's per-response completion log for a global-limiter 429, but not other responses", () => {
      // Unit-level check of the pure classification function pino-http's
      // customLogLevel delegates to (see rateLimit.ts) — this is what
      // actually bounds pino-http's OWN log line, independent of
      // logBlockedThrottled above. Exercised directly rather than through
      // pino-http's internal per-request child logger, which isn't a stable
      // interception point.
      const blockedByGlobalLimiter = {
        statusCode: 429,
        getHeader: (name: string) => (name === "RateLimit-Limit" ? "12000" : undefined),
      };
      assert.equal(globalLimiterLogLevel(blockedByGlobalLimiter), "silent");

      const blockedByNarrowLimiter = {
        statusCode: 429,
        getHeader: () => undefined,
      };
      assert.equal(globalLimiterLogLevel(blockedByNarrowLimiter), "info");

      const ok = { statusCode: 200, getHeader: () => undefined };
      assert.equal(globalLimiterLogLevel(ok), "info");
    });
  });

  describe("store peak cardinality", () => {
    // `init()` is what gives the store its windowMs. A store that never got it
    // has windowMs = 0, which makes EVERY increment look expired and reset the
    // counter to 1 — so a counter assertion against an un-init'd store passes
    // whether or not eviction works at all. These tests therefore always init.
    function initStore(store: BoundedMemoryStore, windowMs = 60_000): void {
      // init only reads windowMs; the rest of Options is irrelevant here.
      store.init({ windowMs } as unknown as Options);
    }

    it("never exceeds the configured cap", async () => {
      const CAP = 20;
      const store = new BoundedMemoryStore(CAP);
      initStore(store);

      for (let i = 0; i < CAP * 3; i++) {
        await store.increment(`key-${i}`);
        assert.ok(
          store.trackedKeyCount <= CAP,
          `peak cardinality ${store.trackedKeyCount} exceeded cap ${CAP} at key ${i}`,
        );
      }
      assert.equal(store.trackedKeyCount, CAP);
    });

    it("drains `previous` before `current`, so eviction takes the genuinely oldest keys", async (t) => {
      // The cap spans BOTH maps and eviction must drain `previous` first — the
      // round-16 plan finding. Reaching that branch needs a window rotation,
      // which only happens on the init() interval, so drive it with fake timers
      // rather than leaving the branch untested (it never fires otherwise: with
      // no rotation `previous` stays empty and eviction only ever hits
      // `current`).
      t.mock.timers.enable({ apis: ["setInterval", "Date"], now: Date.now() });
      const CAP = 10;
      const store = new BoundedMemoryStore(CAP);
      initStore(store);

      for (let i = 0; i < CAP; i++) await store.increment(`old-${i}`);
      assert.equal(store.trackedKeyCount, CAP);

      // Rotate: current -> previous, current = {}. Nothing is dropped yet.
      t.mock.timers.tick(60_000);
      assert.equal(store.trackedKeyCount, CAP, "rotation moves keys between maps, it does not drop them");

      const NEW_KEYS = 5;
      for (let i = 0; i < NEW_KEYS; i++) await store.increment(`new-${i}`);
      assert.equal(store.trackedKeyCount, CAP, "the cap must hold across both maps combined, not per-map");

      // The oldest `previous` entries went first; the newest keys are untouched.
      for (let i = 0; i < NEW_KEYS; i++) {
        assert.equal(await store.get(`old-${i}`), undefined, `old-${i} should have been evicted first`);
      }
      for (let i = NEW_KEYS; i < CAP; i++) {
        assert.ok(await store.get(`old-${i}`), `old-${i} should still be tracked`);
      }
      for (let i = 0; i < NEW_KEYS; i++) {
        assert.ok(await store.get(`new-${i}`), `new-${i} must never be evicted ahead of an older key`);
      }
    });

    it("never evicts under normal (non-flooding) traffic", async () => {
      const store = new BoundedMemoryStore(100_000);
      initStore(store);
      for (let i = 0; i < 50; i++) {
        await store.increment(`normal-key-${i}`);
      }
      assert.equal(store.trackedKeyCount, 50);
    });

    it("resets an evicted key's counter (fails safe, never a wrongful 429)", async () => {
      const store = new BoundedMemoryStore(3);
      initStore(store);

      await store.increment("victim");
      const victimCount = (await store.increment("victim")).totalHits;
      // Guards the whole assertion below: if the store were not accumulating
      // (the un-init'd windowMs = 0 case), the post-eviction "=== 1" check
      // would hold no matter what eviction did.
      assert.equal(victimCount, 2, "sanity: an initialized store accumulates hits across requests");

      // Three more distinct keys under a cap of 3 evicts `victim`, the oldest.
      await store.increment("filler-1");
      await store.increment("filler-2");
      await store.increment("filler-3");
      assert.equal(await store.get("victim"), undefined, "victim should have been evicted");

      const afterEviction = (await store.increment("victim")).totalHits;
      assert.equal(afterEviction, 1, "an evicted key starts over — a looser limit for a window, never a wrongful 429");
    });
  });

  describe("polling capacity", () => {
    it("the documented concurrent-poller load receives zero 429s under the default ceiling", async () => {
      const app = createApp();
      // Two 500ms pollers at ~120 req/min each for 50 concurrent jobs would be
      // 12,000/min — this test proves a much smaller, fast-to-run slice (200
      // requests from one shared IP) never trips the default 12,000/min
      // ceiling, without spending a full simulated minute in CI.
      for (let i = 0; i < 200; i++) {
        const res = await request(app).get("/api/memes/video-jobs/00000000-0000-0000-0000-000000000000");
        assert.notEqual(res.status, 429, `poll ${i + 1} should not be rate-limited under the default ceiling`);
      }
    });
  });
});
