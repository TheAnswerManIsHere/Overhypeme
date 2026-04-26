import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Request, Response, NextFunction } from "express";
import {
  CACHE,
  noStore,
  setNoStore,
  setPublicCache,
  checkConditional,
  setPublicCors,
} from "../lib/cacheHeaders.js";

interface MockRes {
  headers: Record<string, string>;
  statusCode: number;
  ended: boolean;
  setHeader(key: string, value: string): void;
  status(code: number): MockRes;
  end(): MockRes;
}

function makeRes(): MockRes {
  const res: MockRes = {
    headers: {},
    statusCode: 200,
    ended: false,
    setHeader(key, value) {
      this.headers[key] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    end() {
      this.ended = true;
      return this;
    },
  };
  return res;
}

function makeReq(headers: Record<string, string | undefined> = {}): { headers: Record<string, string | undefined> } {
  return { headers };
}

describe("CACHE constants", () => {
  it("defines the expected cache-control strings", () => {
    assert.equal(CACHE.NO_STORE, "no-store");
    assert.equal(CACHE.STATIC_IMMUTABLE, "public, max-age=31536000, immutable");
    assert.equal(
      CACHE.MEME_IMAGE,
      "public, max-age=86400, s-maxage=604800, stale-while-revalidate=86400",
    );
    assert.equal(CACHE.MEME_TEMPLATE, "public, max-age=86400, s-maxage=604800");
    assert.equal(CACHE.PUBLIC_OBJECT, "public, max-age=3600, s-maxage=86400");
    assert.equal(CACHE.PRIVATE_OBJECT, "private, max-age=3600");
  });
});

describe("noStore middleware", () => {
  it("sets Cache-Control: no-store and calls next exactly once with no error", () => {
    const res = makeRes();
    let nextCalls = 0;
    let nextArg: unknown = "unset";
    const next: NextFunction = (err?: unknown) => {
      nextCalls += 1;
      nextArg = err;
    };
    noStore({} as Request, res as unknown as Response, next);
    assert.equal(res.headers["Cache-Control"], "no-store");
    assert.equal(nextCalls, 1);
    assert.equal(nextArg, undefined);
  });
});

describe("setNoStore", () => {
  it("sets Cache-Control: no-store on the response", () => {
    const res = makeRes();
    setNoStore(res as unknown as Response);
    assert.equal(res.headers["Cache-Control"], "no-store");
  });
});

describe("setPublicCache", () => {
  it("sets only Cache-Control when no etagSeed is provided", () => {
    const res = makeRes();
    setPublicCache(res as unknown as Response, CACHE.MEME_IMAGE);
    assert.equal(res.headers["Cache-Control"], CACHE.MEME_IMAGE);
    assert.equal(res.headers["ETag"], undefined);
  });

  it("sets a quoted ETag when etagSeed is provided", () => {
    const res = makeRes();
    setPublicCache(res as unknown as Response, CACHE.MEME_IMAGE, "abc123");
    assert.equal(res.headers["Cache-Control"], CACHE.MEME_IMAGE);
    assert.equal(res.headers["ETag"], '"abc123"');
  });
});

describe("checkConditional", () => {
  it("returns false and does not 304 when if-none-match is missing", () => {
    const req = makeReq();
    const res = makeRes();
    const matched = checkConditional(req as unknown as Request, res as unknown as Response, "abc");
    assert.equal(matched, false);
    assert.equal(res.ended, false);
    assert.equal(res.statusCode, 200);
  });

  it("returns true and sends 304 when if-none-match matches the bare etag", () => {
    const req = makeReq({ "if-none-match": "abc" });
    const res = makeRes();
    const matched = checkConditional(req as unknown as Request, res as unknown as Response, "abc");
    assert.equal(matched, true);
    assert.equal(res.ended, true);
    assert.equal(res.statusCode, 304);
  });

  it("returns true and sends 304 when if-none-match matches the quoted form", () => {
    const req = makeReq({ "if-none-match": '"abc"' });
    const res = makeRes();
    const matched = checkConditional(req as unknown as Request, res as unknown as Response, "abc");
    assert.equal(matched, true);
    assert.equal(res.ended, true);
    assert.equal(res.statusCode, 304);
  });

  it("returns false when if-none-match holds a different value", () => {
    const req = makeReq({ "if-none-match": "different" });
    const res = makeRes();
    const matched = checkConditional(req as unknown as Request, res as unknown as Response, "abc");
    assert.equal(matched, false);
    assert.equal(res.ended, false);
    assert.equal(res.statusCode, 200);
  });
});

describe("setPublicCors", () => {
  it("sets Access-Control-Allow-Origin: * and Vary: Origin", () => {
    const res = makeRes();
    setPublicCors(res as unknown as Response);
    assert.equal(res.headers["Access-Control-Allow-Origin"], "*");
    assert.equal(res.headers["Vary"], "Origin");
  });
});
