/**
 * Every admin mutation of a fact or a review writes the admin-action record
 * (plan docs/plans/PLAN_FACT_LIFECYCLE_REBUILD.md 1I: "every mutation this plan
 * introduces writes to it as it is built"). This reads the route files and
 * finds every admin POST/PUT/PATCH/DELETE on a fact, a review, a gag or a
 * Taxonomy Health action; each handler either calls recordAdminAction(s) or is
 * named below with the reason it records nothing. A new route fails here until
 * it does one or the other.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROUTES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../routes");
const FILES = ["reviews.ts", "admin.ts", "gags.ts", "adminTaxonomyHealth.ts", "adminReferenceResearch.ts"];
const IN_SCOPE = /^\/admin\/(reviews|facts|taxonomy-health\/actions|references)\b/;

/** Route → why it writes no record. */
const EXEMPT: Record<string, string> = {
  "POST /admin/reviews/:id/approve-for-production": "delegates to approveForProduction, which records in its transaction",
  "POST /admin/reviews/:id/approve": "the same approveForProduction, under its old name",
  "PATCH /admin/reviews/:id": "a draft autosave of the review's note and reason; the decision that uses them records",
  "POST /admin/facts/import": "queueTextsForTriage records one import per review it creates, in its transaction",
  "POST /admin/facts/import-csv": "queueTextsForTriage records one import per review it creates, in its transaction",
  "POST /admin/facts/:factId/gags/cast": "reads who is in a draft's scene and stores nothing",
  "POST /admin/facts/backfill-ai-memes": "a system maintenance run over every fact, not an action on one",
  "POST /admin/facts/backfill-embeddings": "a system maintenance run over every fact, not an action on one",
  "POST /admin/facts/backfill-enrichment": "a system maintenance run over every fact, not an action on one",
  "POST /admin/taxonomy-health/actions/fill-characters": "a mechanical repair over every fact; leaves with Taxonomy Health in Phase 2",
  "POST /admin/taxonomy-health/actions/repair-projections": "a mechanical repair over every fact; leaves with Taxonomy Health in Phase 2",
  "POST /admin/taxonomy-health/actions/mark-major-update": "changes the engine revision, not a fact",
  "POST /admin/references/research": "researches text it is given and changes no fact",
};

interface Handler { key: string; body: string }

function handlers(file: string): Handler[] {
  const src = readFileSync(path.join(ROUTES, file), "utf8");
  const out: Handler[] = [];
  const re = /router\.(post|put|patch|delete)\(\s*"([^"]+)"/g;
  const starts: Array<{ at: number; key: string }> = [];
  for (let m = re.exec(src); m; m = re.exec(src)) starts.push({ at: m.index, key: `${m[1]!.toUpperCase()} ${m[2]}` });
  starts.forEach((s, i) => {
    // A handler runs to the next mutating route (or the end of the file).
    const end = i + 1 < starts.length ? starts[i + 1]!.at : src.length;
    out.push({ key: s.key, body: src.slice(s.at, end) });
  });
  return out.filter((h) => IN_SCOPE.test(h.key.split(" ")[1]!));
}

describe("admin-action record coverage", () => {
  const all = FILES.flatMap(handlers);

  it("finds the routes it guards", () => {
    assert.ok(all.length >= 25, `found only ${all.length} routes; the parser has fallen behind the route files`);
  });

  it("every admin mutation of a fact or a review records, or says why not", () => {
    const missing = all.filter((h) => !/recordAdminActions?\(/.test(h.body) && !(h.key in EXEMPT)).map((h) => h.key);
    assert.deepEqual(missing, []);
  });

  it("names no exempt route that no longer exists or now records", () => {
    const keys = new Set(all.map((h) => h.key));
    const stale = Object.keys(EXEMPT).filter((k) => !keys.has(k) || /recordAdminActions?\(/.test(all.find((h) => h.key === k)!.body));
    assert.deepEqual(stale, []);
  });
});
