/**
 * The published deployment's front door (launch Phase 14, increment 3, plan
 * S-e): a request without the secret only Cloudflare adds is refused; on one
 * with it, Cloudflare's location headers are read and a blocked place is
 * refused; the health check is exempt; nothing is gated outside the
 * deployment, and location headers are never believed without the secret.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import express from "express";
import request from "supertest";

import { originGuard } from "../middlewares/originGuard.js";
import { BLOCKED_COUNTRIES, cloudflareRedirectExpression, isBlockedLocation } from "../lib/geography.js";

const SECRET = "origin-secret-for-tests-0123456789";
const deployed = { REPLIT_DEPLOYMENT: "1", ORIGIN_SECRET: SECRET };

function appWith(env: NodeJS.ProcessEnv) {
  const app = express();
  app.use(originGuard(env));
  app.get("/api/healthz", (_req, res) => res.json({ status: "ok" }));
  app.get("/api/admission", (_req, res) => res.json({ admitted: true }));
  app.post("/api/stripe/webhook", (_req, res) => res.json({ received: true }));
  return app;
}

describe("originGuard", () => {
  it("refuses a request that did not come through Cloudflare", async () => {
    const res = await request(appWith(deployed)).get("/api/admission");
    assert.equal(res.status, 403);
    assert.deepEqual(res.body, { error: "not_admitted", admitted: false });
    assert.equal(res.headers["cache-control"], "no-store");
  });

  it("refuses a wrong secret, including one of another length", async () => {
    const app = appWith(deployed);
    assert.equal((await request(app).get("/api/admission").set("x-overhype-origin", SECRET.replace("o", "O"))).status, 403);
    assert.equal((await request(app).get("/api/admission").set("x-overhype-origin", "short")).status, 403);
  });

  it("admits a request carrying the secret, the webhook included", async () => {
    const app = appWith(deployed);
    assert.equal((await request(app).get("/api/admission").set("x-overhype-origin", SECRET)).status, 200);
    assert.equal((await request(app).post("/api/stripe/webhook").set("x-overhype-origin", SECRET)).status, 200);
  });

  it("refuses a blocked country or Ukrainian region on an admitted request", async () => {
    const app = appWith(deployed);
    const via = (country: string, region?: string) => {
      const r = request(app).get("/api/admission").set("x-overhype-origin", SECRET).set("cf-ipcountry", country);
      return region ? r.set("cf-region-code", region) : r;
    };
    assert.equal((await via("DE")).status, 451);
    assert.equal((await via("GB")).status, 451);
    assert.equal((await via("IR")).status, 451);
    assert.equal((await via("UA", "43")).status, 451);
    assert.equal((await via("UA", "30")).status, 200);
    assert.equal((await via("US", "CA")).status, 200);
  });

  it("ignores spoofed location headers on a request without the secret: refused as not admitted, never as a place", async () => {
    const res = await request(appWith(deployed)).get("/api/admission").set("cf-ipcountry", "US");
    assert.equal(res.status, 403);
    assert.equal(res.body.error, "not_admitted");
  });

  it("refuses everything but the health check when no secret is configured", async () => {
    const app = appWith({ REPLIT_DEPLOYMENT: "1" });
    assert.equal((await request(app).get("/api/admission").set("x-overhype-origin", "")).status, 403);
    assert.equal((await request(app).get("/api/admission").set("x-overhype-origin", "anything")).status, 403);
    assert.equal((await request(app).get("/api/healthz")).status, 200);
  });

  it("exempts the platform health check", async () => {
    assert.equal((await request(appWith(deployed)).get("/api/healthz")).status, 200);
  });

  it("is inactive outside the deployment, NODE_ENV=production included", async () => {
    assert.equal((await request(appWith({ NODE_ENV: "production", ORIGIN_SECRET: SECRET })).get("/api/admission")).status, 200);
    assert.equal((await request(appWith({})).get("/api/admission").set("cf-ipcountry", "DE")).status, 200);
  });
});

describe("geography", () => {
  it("names the EEA, the UK and OFAC's countries, and not the US or Syria", () => {
    for (const c of ["FR", "IE", "NO", "IS", "LI", "GB", "CU", "IR", "KP", "RE"]) assert.ok(BLOCKED_COUNTRIES.has(c), c);
    for (const c of ["US", "CA", "SY", "CH", "UA", "RU"]) assert.ok(!BLOCKED_COUNTRIES.has(c), c);
    assert.equal(BLOCKED_COUNTRIES.size, 27 + 7 + 4 + 3);
  });

  it("refuses only the four Ukrainian regions, and reads codes case-insensitively", () => {
    for (const r of ["43", "40", "14", "09"]) assert.equal(isBlockedLocation("UA", r), true, r);
    assert.equal(isBlockedLocation("UA", "30"), false);
    assert.equal(isBlockedLocation("ua", "43"), true);
    assert.equal(isBlockedLocation("de", undefined), true);
    assert.equal(isBlockedLocation(undefined, undefined), false);
  });

  it("prints a redirect expression that carries every code and spares the explanation page", () => {
    const expr = cloudflareRedirectExpression();
    for (const c of BLOCKED_COUNTRIES) assert.ok(expr.includes(`"${c}"`), c);
    assert.match(expr, /ip\.src\.country eq "UA" and ip\.src\.region_code in \{"43" "40" "14" "09"\}/);
    assert.match(expr, /and not starts_with\(http\.request\.uri\.path, "\/unavailable"\)$/);
    assert.ok(expr.length < 4000, "Cloudflare's expression limit");
  });
});
