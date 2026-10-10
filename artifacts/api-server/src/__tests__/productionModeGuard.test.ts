/**
 * The production-mode test launcher's refusals (src/testing/productionModeGuard.ts).
 *
 * The launcher boots the real server with NODE_ENV=production and only its
 * email transport replaced. Each refusal keeps that one replacement from being
 * pointed at something real: a deployment, a Resend key, or email links that
 * would open the live site. Its database rule is the test-database marker,
 * tested in lib/db (testDatabaseMarker.test.ts).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { productionModeRefusals } from "../testing/productionModeGuard.js";

const SAFE: NodeJS.ProcessEnv = {
  NODE_ENV: "production",
  E2E_MAIL_SINK_DIR: "/tmp/overhype-mail",
  SITE_BASE_URL: "http://localhost:5174",
};

function refusalsWith(overrides: NodeJS.ProcessEnv): string[] {
  return productionModeRefusals({ ...SAFE, ...overrides });
}

describe("productionModeRefusals", () => {
  it("accepts a production-mode boot against a local test database", () => {
    assert.deepEqual(productionModeRefusals(SAFE), []);
  });

  it("refuses anything but a production-mode boot", () => {
    assert.equal(refusalsWith({ NODE_ENV: "development" }).length, 1);
    assert.equal(refusalsWith({ NODE_ENV: undefined }).length, 1);
    assert.deepEqual(refusalsWith({ NODE_ENV: "Production" }), []);
  });

  it("refuses a real deployment", () => {
    assert.match(refusalsWith({ REPLIT_DEPLOYMENT: "1" }).join(), /real deployment/);
  });

  it("refuses when any Resend key is present, and ignores an empty one", () => {
    for (const name of ["RESEND_API_KEY", "RESEND_API_KEY_PROD", "RESEND_API_KEY_DEV"]) {
      assert.match(refusalsWith({ [name]: "re_live_x" }).join(), new RegExp(name));
    }
    assert.deepEqual(refusalsWith({ RESEND_API_KEY: "  " }), []);
  });

  it("requires an absolute mail-sink directory", () => {
    assert.match(refusalsWith({ E2E_MAIL_SINK_DIR: undefined }).join(), /E2E_MAIL_SINK_DIR/);
    assert.match(refusalsWith({ E2E_MAIL_SINK_DIR: "relative/dir" }).join(), /E2E_MAIL_SINK_DIR/);
  });

  it("requires email links to open a local frontend", () => {
    assert.match(refusalsWith({ SITE_BASE_URL: undefined }).join(), /SITE_BASE_URL/);
    assert.match(refusalsWith({ SITE_BASE_URL: "https://overhype.me" }).join(), /overhype\.me/);
    assert.deepEqual(refusalsWith({ SITE_BASE_URL: "http://127.0.0.1:5174" }), []);
  });

  it("reports every refusal at once rather than the first", () => {
    assert.equal(
      productionModeRefusals({ NODE_ENV: "development", REPLIT_DEPLOYMENT: "1", RESEND_API_KEY: "k" }).length,
      5,
    );
  });
});
