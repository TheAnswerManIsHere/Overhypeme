import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ADMIN_HELP_MAP, helpHrefFor } from "./helpMap";
import { HELP_DOCS, findHelpDoc } from "@/generated/help/manifest";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * The nav routes, read out of AdminLayout's source rather than imported.
 * Importing AdminLayout would pull React, wouter and the auth package into a
 * plain unit test; the point here is only "which routes exist", and reading
 * the literal keeps the two lists genuinely independent — a copy of the array
 * in this file would pass while the real nav drifted.
 */
function navRoutesFromSource(): string[] {
  const src = readFileSync(resolve(__dirname, "AdminLayout.tsx"), "utf8");
  const block = /const NAV_ITEMS = \[([\s\S]*?)\n\];/.exec(src);
  if (!block) throw new Error("Could not find NAV_ITEMS in AdminLayout.tsx");
  return [...block[1].matchAll(/href:\s*"([^"]+)"/g)].map((m) => m[1]);
}

describe("admin help map", () => {
  const navRoutes = navRoutesFromSource();

  it("found the real nav routes (guards the parser itself)", () => {
    expect(navRoutes.length).toBeGreaterThan(10);
    expect(navRoutes).toContain("/admin");
    expect(navRoutes).toContain("/admin/help");
  });

  // COMPLETENESS. A nav item added later with no entry means a `?` that
  // silently does nothing — no error, no broken link, just a control that
  // quietly stops being useful.
  it("has a help target for every admin nav route", () => {
    const missing = navRoutes
      .filter((r) => r !== "/admin/help") // Help does not point at itself.
      .filter((r) => !(r in ADMIN_HELP_MAP));
    expect(missing, `nav routes with no ADMIN_HELP_MAP entry: ${missing.join(", ")}`).toEqual([]);
  });

  it("has no entries for routes that are not in the nav", () => {
    const stale = Object.keys(ADMIN_HELP_MAP).filter((r) => !navRoutes.includes(r));
    expect(stale, `ADMIN_HELP_MAP entries for non-existent routes: ${stale.join(", ")}`).toEqual([]);
  });

  // RESOLVABILITY. This is the one that rots on its own: `pnpm run check:docs`
  // validates linked FILES but explicitly not anchors, so a heading renamed in
  // docs/manual/ leaves a `?` pointing nowhere and nobody finds out until an
  // admin clicks it.
  it("points every target at a chapter that exists", () => {
    for (const [route, target] of Object.entries(ADMIN_HELP_MAP)) {
      expect(findHelpDoc(target.chapter), `${route} -> unknown chapter "${target.chapter}"`).toBeDefined();
    }
  });

  it("points every anchored target at a section that exists in that chapter", () => {
    for (const [route, target] of Object.entries(ADMIN_HELP_MAP)) {
      if (!target.anchor) continue;
      const doc = findHelpDoc(target.chapter)!;
      const ids = doc.sections.map((s) => s.id);
      expect(ids, `${route} -> "${target.chapter}#${target.anchor}" is not a section`).toContain(target.anchor);
    }
  });

  it("builds the href a ? control actually links to", () => {
    expect(helpHrefFor("/admin/moderation")).toBe("/admin/help/3-moderation");
    expect(helpHrefFor("/admin/queue-health")).toBe(
      "/admin/help/12-background-work#worker-liveness-and-the-queue-health-surface",
    );
  });

  // An unmapped location must degrade to the help index, never to a dead URL.
  it("falls back to the help index for an unmapped location", () => {
    expect(helpHrefFor("/admin/some-future-screen")).toBe("/admin/help");
  });

  it("covers every chapter the manual actually has", () => {
    // Not a completeness requirement on the map — several chapters legitimately
    // have no admin screen — but it does prove the manifest is populated, so
    // the resolvability assertions above are checking against real data rather
    // than an empty list that would make them vacuously pass.
    expect(HELP_DOCS.length).toBeGreaterThanOrEqual(13);
    expect(HELP_DOCS[0].kind).toBe("readme");
  });
});
