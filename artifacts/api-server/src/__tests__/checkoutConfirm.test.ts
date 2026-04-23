/**
 * Tests for POST /stripe/checkout/confirm — validation gates only.
 *
 * Strategy: mount the real stripe router with a stubbed auth middleware
 * (identical to uploadMeme.test.ts). The three tests below all short-circuit
 * BEFORE any Stripe API call or DB write, so no module mocking is required.
 *
 * Happy-path scenarios (ownership check, subscription grant, lifetime grant,
 * idempotency) require a real Stripe test-mode session ID and are therefore
 * covered by the Stripe test-mode integration test suite run manually against
 * staging, not here.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express, { type Request, type Response, type NextFunction } from "express";
import stripeRouter from "../routes/stripe.js";

// ── Minimal Express app ─────────────────────────────────────────────────────

function startServer(opts: { authenticated: boolean; userId?: string }): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  return new Promise((resolve) => {
    const app = express();
    app.use(express.json());

    // Stub authentication middleware — same pattern as uploadMeme.test.ts
    app.use((req: Request, _res: Response, next: NextFunction) => {
      const r = req as unknown as Record<string, unknown>;
      r["isAuthenticated"] = () => opts.authenticated;
      if (opts.authenticated) {
        r["user"] = { id: opts.userId ?? "test-user-id" };
      }
      const noop = () => {};
      r["log"] = { error: noop, warn: noop, info: noop, debug: noop, trace: noop, fatal: noop };
      next();
    });

    app.use(stripeRouter);

    const server = app.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

function postConfirm(
  url: string,
  body: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const bodyStr = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const u = new URL(`${url}/stripe/checkout/confirm`);
    const req = http.request(
      {
        method: "POST",
        hostname: u.hostname,
        port: u.port,
        path: u.pathname,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": String(Buffer.byteLength(bodyStr)),
        },
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) as Record<string, unknown> });
          } catch {
            resolve({ status: res.statusCode ?? 0, body: { raw: data } });
          }
        });
      },
    );
    req.on("error", reject);
    req.write(bodyStr);
    req.end();
  });
}

// ── Tests ───────────────────────────────────────────────────────────────────

test("POST /stripe/checkout/confirm → 401 when not authenticated", async () => {
  const server = await startServer({ authenticated: false });
  try {
    const res = await postConfirm(server.url, { sessionId: "cs_test_abc123" });
    assert.equal(res.status, 401);
    assert.equal(typeof res.body.error, "string");
  } finally {
    await server.close();
  }
});

test("POST /stripe/checkout/confirm → 400 when sessionId is missing", async () => {
  const server = await startServer({ authenticated: true });
  try {
    const res = await postConfirm(server.url, {});
    assert.equal(res.status, 400);
    assert.match(String(res.body.error), /sessionId|Invalid/i);
  } finally {
    await server.close();
  }
});

test("POST /stripe/checkout/confirm → 400 when sessionId does not start with cs_", async () => {
  const server = await startServer({ authenticated: true });
  try {
    // Stripe payment intents start with pi_, not cs_ — should be rejected immediately
    const res = await postConfirm(server.url, { sessionId: "pi_not_a_checkout_session" });
    assert.equal(res.status, 400);
    assert.match(String(res.body.error), /sessionId|Invalid/i);
  } finally {
    await server.close();
  }
});
