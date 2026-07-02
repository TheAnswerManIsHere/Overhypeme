/**
 * Regenerate `docs/ADMIN_FIELD_REFERENCE.md` from the field-documentation
 * registry. Deterministic (see renderMarkdown.ts) — running twice produces no
 * diff. A staleness test fails CI when the committed doc is out of date.
 *
 * Usage:  pnpm --filter @workspace/overhype-me run generate:field-docs
 */

import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { renderAdminFieldReference } from "../src/components/admin/fieldDocs/renderMarkdown";

const __dirname = dirname(fileURLToPath(import.meta.url));
const outPath = resolve(__dirname, "..", "..", "..", "docs", "ADMIN_FIELD_REFERENCE.md");

const next = renderAdminFieldReference();
const prev = existsSync(outPath) ? readFileSync(outPath, "utf8") : null;

if (prev === next) {
  console.log(`generate:field-docs: ${outPath} already up to date (${next.length} bytes)`);
} else {
  writeFileSync(outPath, next, "utf8");
  console.log(`generate:field-docs: wrote ${outPath} (${next.length} bytes${prev == null ? ", new file" : ""})`);
}
