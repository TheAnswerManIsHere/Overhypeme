/**
 * The production-mode test launcher's refusals (src/testing/productionModeGuard.ts).
 *
 * The launcher boots the real server with NODE_ENV=production and only its
 * email transport replaced. Each refusal keeps that one replacement from being
 * pointed at something real: a deployment, a Resend key, a protected
 * database, or email links that would open the live site.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  PROTECTED_DB_NAMES,
  PROTECTED_HOST_MARKERS,
  productionModeRefusals,
} from "../testing/productionModeGuard.js";

const SAFE: NodeJS.ProcessEnv = {
  NODE_ENV: "production",
  DATABASE_URL: "postgres://overhype:overhype@localhost:5432/overhype_e2e_auth",
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

  it("refuses the protected databases the test-DB guard refuses", () => {
    for (const name of ["heliumdb", "neondb", "production", "overhype_prod", "prodcopy"]) {
      assert.match(
        refusalsWith({ DATABASE_URL: `postgres://u:p@localhost:5432/${name}` }).join(),
        /protected/,
        `expected '${name}' to be refused`,
      );
    }
    assert.match(
      refusalsWith({ DATABASE_URL: "postgres://u:p@ep-x.us-east-2.aws.neon.tech/overhype_e2e_auth" }).join(),
      /neon\.tech/,
    );
    assert.match(refusalsWith({ DATABASE_URL: "not a url" }).join(), /DATABASE_URL/);
    assert.match(refusalsWith({ DATABASE_URL: "postgres://u:p@localhost:5432/" }).join(), /names no database/);
  });

  it("reports every refusal at once rather than the first", () => {
    assert.equal(
      productionModeRefusals({ NODE_ENV: "development", REPLIT_DEPLOYMENT: "1", RESEND_API_KEY: "k" }).length,
      6,
    );
  });

  it("honours the shell guard's extension lists", () => {
    assert.match(
      refusalsWith({ DATABASE_URL: "postgres://u:p@localhost/staging_copy", TEST_DB_PROTECTED_NAMES: "other, staging_copy" }).join(),
      /protected/,
    );
    assert.match(
      refusalsWith({ DATABASE_URL: "postgres://u:p@db.internal.example/overhype_e2e_auth", TEST_DB_PROTECTED_HOSTS: "internal.example" }).join(),
      /internal\.example/,
    );
  });

  it("keeps the same default lists as assert_not_production in scripts/lib/test-db.sh", () => {
    const shell = fs.readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../scripts/lib/test-db.sh"),
      "utf8",
    );
    const names = shell.match(/for p in ([a-z_ ]+?) \$\(_td_split "\$\{TEST_DB_PROTECTED_NAMES/);
    const hosts = shell.match(/for p in ([a-z_. ]+?) \$\(_td_split "\$\{TEST_DB_PROTECTED_HOSTS/);
    assert.ok(names && hosts, "the shell guard's two default lists are where this test expects them");
    assert.deepEqual(names[1].trim().split(/\s+/), PROTECTED_DB_NAMES);
    assert.deepEqual(hosts[1].trim().split(/\s+/), PROTECTED_HOST_MARKERS);
    assert.match(shell, /\*prod\*\)/, "the shell guard still refuses any name containing 'prod'");
  });
});
