import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { getSiteBaseUrl } from "../lib/siteUrl.js";

// Save and restore env vars around every test so they don't bleed between cases.
type SavedEnv = Record<string, string | undefined>;

const KEYS = ["SITE_BASE_URL", "REPLIT_DEPLOYMENT", "NODE_ENV", "REPLIT_DEV_DOMAIN"] as const;

describe("getSiteBaseUrl", () => {
  // IMPORTANT: keep beforeEach/afterEach inside this describe(). With
  // --test-isolation=none the api-server suite shares one root TAP test
  // across files, so top-level beforeEach hooks fire on every other file's
  // tests too. A previous version of this file registered them at module
  // scope, which deleted SITE_BASE_URL out from under
  // adminNotify.abandonedEmail.test.ts whenever the two ended up in the
  // same shard. Scoping them to this describe() keeps the env mutations
  // local to this suite.
  let saved: SavedEnv;

  beforeEach(() => {
    saved = {};
    for (const k of KEYS) saved[k] = process.env[k];
    for (const k of KEYS) delete process.env[k];
  });

  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("returns https://overhype.me when no env vars are set", () => {
    assert.equal(getSiteBaseUrl(), "https://overhype.me");
  });

  it("returns SITE_BASE_URL verbatim when set (no trailing slash)", () => {
    process.env.SITE_BASE_URL = "https://staging.example.com";
    assert.equal(getSiteBaseUrl(), "https://staging.example.com");
  });

  it("strips trailing slash from SITE_BASE_URL", () => {
    process.env.SITE_BASE_URL = "https://staging.example.com/";
    assert.equal(getSiteBaseUrl(), "https://staging.example.com");
  });

  it("SITE_BASE_URL wins over REPLIT_DEPLOYMENT=1", () => {
    process.env.SITE_BASE_URL = "https://override.example.com";
    process.env.REPLIT_DEPLOYMENT = "1";
    assert.equal(getSiteBaseUrl(), "https://override.example.com");
  });

  it("SITE_BASE_URL wins over REPLIT_DEV_DOMAIN", () => {
    process.env.SITE_BASE_URL = "https://override.example.com";
    process.env.REPLIT_DEV_DOMAIN = "dev.replit.app";
    assert.equal(getSiteBaseUrl(), "https://override.example.com");
  });

  it("returns https://overhype.me when REPLIT_DEPLOYMENT=1", () => {
    process.env.REPLIT_DEPLOYMENT = "1";
    assert.equal(getSiteBaseUrl(), "https://overhype.me");
  });

  it("returns https://overhype.me when NODE_ENV=production", () => {
    process.env.NODE_ENV = "production";
    assert.equal(getSiteBaseUrl(), "https://overhype.me");
  });

  it("production flag wins over REPLIT_DEV_DOMAIN", () => {
    process.env.REPLIT_DEPLOYMENT = "1";
    process.env.REPLIT_DEV_DOMAIN = "dev.replit.app";
    assert.equal(getSiteBaseUrl(), "https://overhype.me");
  });

  it("returns https://<domain> when only REPLIT_DEV_DOMAIN is set", () => {
    process.env.REPLIT_DEV_DOMAIN = "my-project.dev.replit.app";
    assert.equal(getSiteBaseUrl(), "https://my-project.dev.replit.app");
  });

  it("falls back to https://overhype.me when NODE_ENV=test (not production)", () => {
    process.env.NODE_ENV = "test";
    assert.equal(getSiteBaseUrl(), "https://overhype.me");
  });
});
