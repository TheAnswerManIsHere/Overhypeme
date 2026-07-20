/**
 * Security-header regression (C5) for lib/securityHeaders.ts.
 *
 * Asserts the env-aware + route-class-aware policy end-to-end on a bare Express
 * app (modeled on phase5.og.routes.test.ts) with env save/restore around each
 * case (modeled on siteUrl.test.ts). The middleware reads the environment at
 * call time, so each app is built after the env is set.
 *
 * Matrix: production vs Replit-dev-preview × { JSON, OG shell, public image,
 * private object }.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import express, { type Express } from "express";
import request from "supertest";

import { securityHeaders } from "../lib/securityHeaders.js";

const ENV_KEYS = ["NODE_ENV", "REPLIT_DEPLOYMENT", "REPLIT_DEV_DOMAIN"] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

type Mode = "prod" | "dev" | "prod-via-deployment";

function setEnv(mode: Mode): void {
  delete process.env.NODE_ENV;
  delete process.env.REPLIT_DEPLOYMENT;
  delete process.env.REPLIT_DEV_DOMAIN;
  if (mode === "prod") {
    process.env.NODE_ENV = "production";
  } else if (mode === "prod-via-deployment") {
    process.env.REPLIT_DEPLOYMENT = "1";
  } else {
    process.env.NODE_ENV = "development";
    process.env.REPLIT_DEV_DOMAIN = "myrepl.replit.dev";
  }
}

// Note: we deliberately do NOT call app.disable("x-powered-by") here — Express
// sets it by default, so an absent header proves helmet's hidePoweredBy removed it.
function makeApp(mode: Mode): Express {
  setEnv(mode);
  const app = express();
  app.use(...securityHeaders());
  app.get("/api/foo", (_req, res) => { res.json({ ok: true }); });
  app.get("/api/og/m/:slug", (_req, res) => { res.type("html").send("<html></html>"); });
  app.get("/api/memes/:slug/image", (_req, res) => { res.type("jpeg").send(Buffer.from("x")); });
  app.get("/api/memes/templates/:t", (_req, res) => { res.type("jpeg").send(Buffer.from("x")); });
  app.get("/api/storage/objects/:k", (_req, res) => { res.json({ ok: true }); });
  return app;
}

describe("securityHeaders — baseline (all responses)", () => {
  it("sets nosniff + referrer-policy and removes x-powered-by", async () => {
    const res = await request(makeApp("prod")).get("/api/foo");
    assert.equal(res.headers["x-content-type-options"], "nosniff");
    assert.equal(res.headers["referrer-policy"], "no-referrer");
    assert.equal(res.headers["x-powered-by"], undefined, "x-powered-by must be removed");
  });

  it("emits CSP as Report-Only, never enforcing", async () => {
    const res = await request(makeApp("prod")).get("/api/foo");
    assert.ok(res.headers["content-security-policy-report-only"], "expected report-only CSP");
    assert.equal(res.headers["content-security-policy"], undefined, "must NOT enforce CSP yet");
  });
});

describe("securityHeaders — production env", () => {
  it("JSON: strict default-src 'none' + frame-ancestors, DENY frame, HSTS", async () => {
    const res = await request(makeApp("prod")).get("/api/foo");
    const csp = res.headers["content-security-policy-report-only"];
    assert.equal(csp, "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    assert.equal(res.headers["x-frame-options"], "DENY");
    assert.match(res.headers["strict-transport-security"] ?? "", /max-age=\d+/);
    assert.doesNotMatch(res.headers["strict-transport-security"] ?? "", /includeSubDomains|preload/);
  });

  it("REPLIT_DEPLOYMENT=1 alone is treated as production (HSTS on)", async () => {
    const res = await request(makeApp("prod-via-deployment")).get("/api/foo");
    assert.ok(res.headers["strict-transport-security"], "HSTS expected when REPLIT_DEPLOYMENT=1");
    assert.equal(res.headers["x-frame-options"], "DENY");
  });

  it("OG shell: adds img-src for the card image", async () => {
    const res = await request(makeApp("prod")).get("/api/og/m/abc");
    const csp = res.headers["content-security-policy-report-only"];
    assert.match(csp, /img-src 'self' https: data:/);
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /frame-ancestors 'none'/);
  });
});

describe("securityHeaders — Replit dev preview env", () => {
  it("omits HSTS and frame headers so the webview iframe still works", async () => {
    const res = await request(makeApp("dev")).get("/api/foo");
    assert.equal(res.headers["strict-transport-security"], undefined, "no HSTS in dev");
    assert.equal(res.headers["x-frame-options"], undefined, "no X-Frame-Options in dev preview");
    const csp = res.headers["content-security-policy-report-only"];
    assert.doesNotMatch(csp, /frame-ancestors/, "no frame-ancestors in dev preview");
    assert.match(csp, /default-src 'none'/);
  });
});

describe("securityHeaders — CORP by route class", () => {
  it("public assets (OG, meme image, template) are cross-origin embeddable", async () => {
    for (const path of ["/api/og/m/abc", "/api/memes/abc/image", "/api/memes/templates/classic"]) {
      const res = await request(makeApp("prod")).get(path);
      assert.equal(res.headers["cross-origin-resource-policy"], "cross-origin", `expected cross-origin for ${path}`);
    }
  });

  it("JSON + private object routes stay same-origin (not embeddable)", async () => {
    for (const path of ["/api/foo", "/api/storage/objects/secret"]) {
      const res = await request(makeApp("prod")).get(path);
      assert.equal(res.headers["cross-origin-resource-policy"], "same-origin", `expected same-origin for ${path}`);
    }
  });
});
