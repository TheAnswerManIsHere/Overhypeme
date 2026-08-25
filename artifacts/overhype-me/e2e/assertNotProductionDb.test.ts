/**
 * The guard that stands between a Playwright spec and a live database.
 *
 * It exists because these specs run destructive SQL, and it is tested because
 * the first version was bypassable: it read `URL.hostname` and `URL.pathname`,
 * while libpq lets a connection URI override both from its query string.
 * Every row below that carries a `?` is that class. (Codex, #563 round 2.)
 */

import { describe, expect, it } from "vitest";

import { productionDbRefusal } from "./assertNotProductionDb";

const REFUSE: Array<[string, string | undefined, NodeJS.ProcessEnv?]> = [
  ["production, by name", "postgres://u:p@ep-x.neon.tech/neondb"],
  ["dev, by name", "postgres://u:p@helium/heliumdb"],
  ["any Neon-hosted database", "postgres://u:p@ep-y.neon.tech/foo"],
  ["a name containing prod", "postgres://u:p@h/app_production_x"],
  ["no DATABASE_URL at all", undefined],
  ["an unparseable URL", "not a url"],
  ["NODE_ENV=production", "postgres://u:p@h/overhype_test", { NODE_ENV: "production" }],
  // Query-string overrides: safe-looking authority and path, live effective target.
  ["?host= and ?dbname= together", "postgresql://localhost/overhype_test?host=prod.neon.tech&dbname=neondb"],
  ["?dbname= pointing at production", "postgres://u:p@localhost/overhype_test?dbname=neondb"],
  ["?dbname= pointing at dev", "postgres://u:p@localhost/overhype_test?dbname=heliumdb"],
  ["?host= pointing at the provider", "postgres://u:p@localhost/overhype_test?host=ep-z.neon.tech"],
  ["?dbname= containing prod", "postgres://u:p@localhost/overhype_test?dbname=my_prod_db"],
  ["?hostaddr=, which cannot be matched by name", "postgres://u:p@localhost/overhype_test?hostaddr=1.2.3.4"],
  ["?service=, resolved from a file we cannot read", "postgres://u:p@localhost/overhype_test?service=prod"],
  ["a repeated ?dbname=, where libpq takes the last", "postgres://u:p@localhost/x?dbname=overhype_test&dbname=neondb"],
];

const ALLOW: Array<[string, string]> = [
  ["the CI test database", "postgres://o:o@localhost:5432/overhype_test"],
  ["the Replit test database", "postgres://u:p@helium/heliumdb_test"],
  ["a per-worker clone", "postgres://u:p@helium/heliumdb_w_3"],
  ["a test database with sslmode", "postgres://u:p@localhost/overhype_test?sslmode=require"],
  ["?dbname= redirecting TO the test database", "postgres://u:p@localhost/whatever?dbname=overhype_test"],
];

describe("productionDbRefusal", () => {
  it.each(REFUSE)("refuses %s", (_label, url, env) => {
    expect(productionDbRefusal(url, { ...(env ?? {}) } as NodeJS.ProcessEnv)).toEqual(expect.any(String));
  });

  it.each(ALLOW)("allows %s", (_label, url) => {
    expect(productionDbRefusal(url, {} as NodeJS.ProcessEnv)).toBeNull();
  });

  it("names the effective database, not the one in the path", () => {
    const refusal = productionDbRefusal(
      "postgres://u:p@localhost/overhype_test?dbname=neondb",
      {} as NodeJS.ProcessEnv,
    );
    expect(refusal).toContain("neondb");
    expect(refusal).not.toContain("overhype_test");
  });
});
