import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Request, Response, NextFunction } from "express";
import { requireApiKey } from "../middlewares/apiKeyAuth.js";

interface MockRes {
  statusCode: number;
  body: unknown;
  status(code: number): MockRes;
  json(payload: unknown): MockRes;
}

function makeRes(): MockRes {
  const res: MockRes = {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
  return res;
}

function makeReq(headers: Record<string, string | string[] | undefined> = {}): Request {
  return { headers } as unknown as Request;
}

function makeNext(): { calls: number; fn: NextFunction } {
  const state = { calls: 0 };
  const fn: NextFunction = () => {
    state.calls += 1;
  };
  return { get calls() { return state.calls; }, fn };
}

const ORIGINAL_KEY = process.env.ADMIN_API_KEY;

describe("requireApiKey — fail-closed when ADMIN_API_KEY is unset", () => {
  beforeEach(() => {
    delete process.env.ADMIN_API_KEY;
  });
  afterEach(() => {
    if (ORIGINAL_KEY === undefined) {
      delete process.env.ADMIN_API_KEY;
    } else {
      process.env.ADMIN_API_KEY = ORIGINAL_KEY;
    }
  });

  it("rejects with 401 even when the request supplies a header", () => {
    const req = makeReq({ "x-api-key": "anything" });
    const res = makeRes();
    const next = makeNext();
    requireApiKey(req, res as unknown as Response, next.fn);
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.body, { error: "API key auth is not configured on this server" });
    assert.equal(next.calls, 0);
  });

  it("rejects with 401 when no header is supplied either", () => {
    const req = makeReq();
    const res = makeRes();
    const next = makeNext();
    requireApiKey(req, res as unknown as Response, next.fn);
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.body, { error: "API key auth is not configured on this server" });
    assert.equal(next.calls, 0);
  });
});

describe("requireApiKey — with ADMIN_API_KEY set", () => {
  beforeEach(() => {
    process.env.ADMIN_API_KEY = "secret-key-123";
  });
  afterEach(() => {
    if (ORIGINAL_KEY === undefined) {
      delete process.env.ADMIN_API_KEY;
    } else {
      process.env.ADMIN_API_KEY = ORIGINAL_KEY;
    }
  });

  it("allows the request and calls next when the header matches exactly", () => {
    const req = makeReq({ "x-api-key": "secret-key-123" });
    const res = makeRes();
    const next = makeNext();
    requireApiKey(req, res as unknown as Response, next.fn);
    assert.equal(res.statusCode, 200);
    assert.equal(next.calls, 1);
  });

  it("rejects with 401 when the header is missing", () => {
    const req = makeReq();
    const res = makeRes();
    const next = makeNext();
    requireApiKey(req, res as unknown as Response, next.fn);
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.body, { error: "Missing or invalid X-API-Key header" });
    assert.equal(next.calls, 0);
  });

  it("rejects with 401 when the header is empty", () => {
    const req = makeReq({ "x-api-key": "" });
    const res = makeRes();
    const next = makeNext();
    requireApiKey(req, res as unknown as Response, next.fn);
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.body, { error: "Missing or invalid X-API-Key header" });
    assert.equal(next.calls, 0);
  });

  it("rejects with 401 when the header value differs", () => {
    const req = makeReq({ "x-api-key": "wrong-key" });
    const res = makeRes();
    const next = makeNext();
    requireApiKey(req, res as unknown as Response, next.fn);
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.body, { error: "Missing or invalid X-API-Key header" });
    assert.equal(next.calls, 0);
  });

  it("uses the first value when the header arrives as an array (Node's parsed form)", () => {
    const req = makeReq({ "x-api-key": ["secret-key-123", "ignored"] });
    const res = makeRes();
    const next = makeNext();
    requireApiKey(req, res as unknown as Response, next.fn);
    assert.equal(res.statusCode, 200);
    assert.equal(next.calls, 1);
  });

  it("rejects when the array form's first element is wrong", () => {
    const req = makeReq({ "x-api-key": ["wrong", "secret-key-123"] });
    const res = makeRes();
    const next = makeNext();
    requireApiKey(req, res as unknown as Response, next.fn);
    assert.equal(res.statusCode, 401);
    assert.equal(next.calls, 0);
  });

  it("comparison is case-sensitive", () => {
    const req = makeReq({ "x-api-key": "SECRET-KEY-123" });
    const res = makeRes();
    const next = makeNext();
    requireApiKey(req, res as unknown as Response, next.fn);
    assert.equal(res.statusCode, 401);
    assert.equal(next.calls, 0);
  });
});
