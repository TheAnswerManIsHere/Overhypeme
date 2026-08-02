#!/usr/bin/env node
/**
 * Verifies the client and server `getSafeReturnTo` copies agree on every case
 * in a shared vector table.
 *
 * Two implementations of one security-sensitive predicate exist because they
 * sit in different packages (`artifacts/api-server/src/lib/safeReturnTo.ts`,
 * `artifacts/overhype-me/src/lib/safe-return-to.ts`) with no workspace
 * boundary that lets one import the other. PR #292 round 2 (Codex) found the
 * same normalization defect in both copies at once — this script is the
 * mechanical guard against a future correction landing on only one of them.
 *
 * Run with: pnpm run check:return-to-parity (wired into the Build workflow).
 */
import { getSafeReturnTo as clientGetSafeReturnTo } from "../artifacts/overhype-me/src/lib/safe-return-to.ts";
import { getSafeReturnTo as serverGetSafeReturnTo } from "../artifacts/api-server/src/lib/safeReturnTo.ts";

// The client returns null on rejection, the server returns "/" — a
// deliberate, documented difference (see the client's own docstring).
// Normalize before comparing so the parity check isn't tripped by that.
function normalize(result) {
  return result === null ? "/" : result;
}

const VECTORS = [
  "/facts/123",
  "/profile",
  "/",
  "/facts/123?tab=memes",
  "/facts/123#comments",
  "/f?a=1#b",
  null,
  undefined,
  "",
  "https://evil.com",
  "http://evil.com/path",
  "//evil.com",
  "//evil.com/facts/1",
  "javascript:alert(1)",
  "JavaScript:alert(1)",
  "data:text/html,<script>alert(1)</script>",
  "vbscript:msgbox(1)",
  "/\\evil.com",
  "/\\/evil.com",
  "/\t/evil.com",
  "/\n/evil.com",
  "/\r/evil.com",
  "/\t\\evil.com",
  "/\tevil.com",
  "facts/123",
  "evil.com",
  " /facts/123",
  "/a/..//evil.com",
  "/..//evil.com",
  "/a/../..//evil.com",
  "/a/b/../..//evil.com",
  "/a/../evil.com",
  "/facts/../profile",
  "/a/%2e%2e//evil.com",
  "/a/.%2e//evil.com",
  "/a/%2e.//evil.com",
  "/a/%2e%2e/evil.com",
];

let mismatches = 0;
for (const value of VECTORS) {
  const client = normalize(clientGetSafeReturnTo(value));
  const server = serverGetSafeReturnTo(value);
  if (client !== server) {
    mismatches++;
    console.error(
      `MISMATCH for ${JSON.stringify(value)}: client=${JSON.stringify(client)} server=${JSON.stringify(server)}`,
    );
  }
}

if (mismatches > 0) {
  console.error(`\n✗ ${mismatches}/${VECTORS.length} vectors disagree between client and server.`);
  process.exit(1);
}

console.log(`✓ return-to parity: ${VECTORS.length} vectors, client and server agree on every one.`);
