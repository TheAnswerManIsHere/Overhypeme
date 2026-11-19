/**
 * @purpose Prints the Cloudflare redirect rule's expression and target for the places the site does not serve, from lib/geography.ts, so the dashboard rule is pasted from the same list the API's backstop reads (launch Phase 14, increment 3).
 * @subsystem security
 *
 * Usage: pnpm --filter @workspace/api-server run print:cloudflare-geo-rule
 */
import { cloudflareRedirectExpression, EXPLANATION_PATH } from "../src/lib/geography";

process.stdout.write(
  [
    "Expression (Edit expression, paste whole):",
    cloudflareRedirectExpression(),
    "",
    `Then: Static, URL https://overhype.me${EXPLANATION_PATH}, status 302, Preserve query string off.`,
    "",
  ].join("\n"),
);
