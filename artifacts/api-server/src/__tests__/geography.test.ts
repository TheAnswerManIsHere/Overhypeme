/**
 * The one list of refused places (lib/geography.ts) and the Cloudflare rule
 * printed from it. David pastes whatever the command prints, so these are the
 * checks that a slip in the list — a dropped country, a broken rule — fails
 * here rather than in the dashboard. (PR #1063's build report, disagreement 1:
 * the cut removed the only checks of this list along with the origin guard.)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  BLOCKED_COUNTRIES,
  BLOCKED_UA_REGIONS,
  EXPLANATION_PATH,
  cloudflareRedirectExpression,
} from "../lib/geography.js";

const EU27 = [
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE",
  "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE",
];

describe("the list of refused places", () => {
  it("refuses every EU member state, the rest of the EEA, the UK and OFAC's sanctioned countries", () => {
    assert.equal(EU27.length, 27);
    for (const code of [...EU27, "IS", "LI", "NO", "GB", "CU", "IR", "KP"]) {
      assert.equal(BLOCKED_COUNTRIES.has(code), true, code);
    }
  });

  it("refuses the EU territories Cloudflare reports under their own codes", () => {
    for (const code of ["AX", "GF", "GP", "MF", "MQ", "RE", "YT"]) {
      assert.equal(BLOCKED_COUNTRIES.has(code), true, code);
    }
  });

  it("serves the US, Syria, Ukraine as a whole, Switzerland and Russia", () => {
    for (const code of ["US", "SY", "UA", "CH", "RU", "CA"]) {
      assert.equal(BLOCKED_COUNTRIES.has(code), false, code);
    }
  });

  it("refuses exactly the four Ukrainian regions: Crimea, Sevastopol, Donetsk, Luhansk", () => {
    assert.deepEqual([...BLOCKED_UA_REGIONS].sort(), ["09", "14", "40", "43"]);
  });
});

describe("the printed Cloudflare rule", () => {
  const rule = cloudflareRedirectExpression();

  it("names every refused country and region", () => {
    for (const code of BLOCKED_COUNTRIES) assert.ok(rule.includes(`"${code}"`), code);
    for (const region of BLOCKED_UA_REGIONS) assert.ok(rule.includes(`"${region}"`), region);
    assert.ok(rule.includes('ip.src.country eq "UA"'));
  });

  it("spares the explanation page, so a refused visitor is not redirected in a loop", () => {
    assert.equal(EXPLANATION_PATH, "/unavailable");
    assert.ok(rule.includes(`and not starts_with(http.request.uri.path, "${EXPLANATION_PATH}")`));
  });

  it("is balanced and stays under 4,000 characters, inside Cloudflare's expression limit", () => {
    assert.equal(rule.split("(").length, rule.split(")").length);
    assert.equal(rule.split("{").length, rule.split("}").length);
    assert.ok(rule.length < 4000, `${rule.length} characters`);
  });
});
