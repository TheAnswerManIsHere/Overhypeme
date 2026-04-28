/**
 * Tests for the invoice receipt endpoint (Task #305).
 *
 * Two test layers:
 *  1. HTTP integration tests — mount the real stripe router via Express and
 *     verify the request-validation gate (auth check, invoiceId format).
 *     These fire BEFORE any Stripe API call, so no module mocking is needed.
 *
 *  2. handleReceiptRequest unit tests — exercise the full ownership-check →
 *     redirect pipeline using fake ReceiptDeps. No live network calls.
 *
 * Together the four required scenarios are covered:
 *  - 401 for unauthenticated requests (HTTP gate layer)
 *  - 400 for an invalid invoice ID (HTTP gate layer)
 *  - 403 when the invoice belongs to a different customer (unit layer)
 *  - 302 redirect to hosted_invoice_url on the happy path (unit layer)
 */

import { describe, it, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express, { type Request, type Response, type NextFunction } from "express";

import { handleReceiptRequest, type ReceiptDeps } from "../lib/receiptHandler.js";
import stripeRouter from "../routes/stripe.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function startServer(opts: {
  authenticated: boolean;
  userId?: string;
}): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      const r = req as unknown as Record<string, unknown>;
      r["isAuthenticated"] = () => opts.authenticated;
      if (opts.authenticated) r["user"] = { id: opts.userId ?? "user-1" };
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

function getReceipt(
  url: string,
  invoiceId: string,
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(`${url}/stripe/invoice/${invoiceId}/receipt`);
    http.get(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname,
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (data += c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers as Record<string, string | string[] | undefined>,
            body: data,
          }),
        );
      },
    ).on("error", reject);
  });
}

// ── Fake ReceiptDeps factory ──────────────────────────────────────────────────

type FakeDepsOpts = {
  stripeCustomerId?: string | null;
  invoiceCustomer?: string | null;
  hostedInvoiceUrl?: string | null;
  userExists?: boolean;
};

function makeFakeDeps(opts: FakeDepsOpts = {}): ReceiptDeps {
  const {
    stripeCustomerId = "cus_owner",
    invoiceCustomer = "cus_owner",
    hostedInvoiceUrl = "https://invoice.stripe.com/i/acct/test_happy",
    userExists = true,
  } = opts;

  return {
    getUserById: async (_id) =>
      userExists ? { stripeCustomerId } : null,
    retrieveInvoice: async (_invoiceId) => ({
      customer: invoiceCustomer,
      hosted_invoice_url: hostedInvoiceUrl,
    }),
  };
}

// ── HTTP gate tests (fire before any Stripe API call) ────────────────────────

test("GET /stripe/invoice/:invoiceId/receipt → 401 when not authenticated", async () => {
  const server = await startServer({ authenticated: false });
  try {
    const res = await getReceipt(server.url, "in_somevalid123");
    assert.equal(res.status, 401, "expected 401 Unauthorized");
    const parsed = JSON.parse(res.body) as { error: string };
    assert.equal(typeof parsed.error, "string");
  } finally {
    await server.close();
  }
});

test("GET /stripe/invoice/:invoiceId/receipt → 400 for invoice ID without 'in_' prefix", async () => {
  const server = await startServer({ authenticated: true });
  try {
    const res = await getReceipt(server.url, "pi_not_an_invoice");
    assert.equal(res.status, 400, "expected 400 for wrong-prefix invoice ID");
    const parsed = JSON.parse(res.body) as { error: string };
    assert.equal(typeof parsed.error, "string");
  } finally {
    await server.close();
  }
});

// ── handleReceiptRequest unit tests ──────────────────────────────────────────

describe("handleReceiptRequest", () => {
  it("returns 403 when the invoice belongs to a different Stripe customer", async () => {
    const deps = makeFakeDeps({
      stripeCustomerId: "cus_owner",
      invoiceCustomer: "cus_someone_else",
    });
    const result = await handleReceiptRequest("user-1", "in_other", deps);

    assert.equal(result.type, "error");
    if (result.type === "error") {
      assert.equal(result.status, 403, "expected 403 Forbidden when invoice owner mismatches");
    }
  });

  it("returns a 302 redirect to hosted_invoice_url on the happy path", async () => {
    const expectedUrl = "https://invoice.stripe.com/i/acct/test_happy";
    const deps = makeFakeDeps({
      stripeCustomerId: "cus_owner",
      invoiceCustomer: "cus_owner",
      hostedInvoiceUrl: expectedUrl,
    });
    const result = await handleReceiptRequest("user-1", "in_valid", deps);

    assert.equal(result.type, "redirect");
    if (result.type === "redirect") {
      assert.equal(result.url, expectedUrl, "redirect URL should match hosted_invoice_url");
    }
  });

  it("returns 403 when the user has no Stripe customer ID (no billing account)", async () => {
    const deps = makeFakeDeps({ stripeCustomerId: null });
    const result = await handleReceiptRequest("user-1", "in_valid", deps);

    assert.equal(result.type, "error");
    if (result.type === "error") {
      assert.equal(result.status, 403);
    }
  });

  it("returns 404 when the invoice has no hosted_invoice_url", async () => {
    const deps = makeFakeDeps({
      stripeCustomerId: "cus_owner",
      invoiceCustomer: "cus_owner",
      hostedInvoiceUrl: null,
    });
    const result = await handleReceiptRequest("user-1", "in_nopdf", deps);

    assert.equal(result.type, "error");
    if (result.type === "error") {
      assert.equal(result.status, 404);
    }
  });
});
