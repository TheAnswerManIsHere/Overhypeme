/**
 * @purpose Guard for plan PLAN_PHOTO_IS_YOUR_PICTURE.md: the generated-avatar system stays removed. No product source in the browser app, the API server or the shared contract may mention a DiceBear icon, an avatar style or source, the custom_avatar feature, or the Avatar/Photo switch, so a missed reference cannot quietly bring back a robot picture. Only migrations, their tests and the retired ledger may name them.
 * @subsystem accounts-auth
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../../../../..");
const TREES = [
  "artifacts/overhype-me/src",
  "artifacts/overhype-me/e2e",
  "artifacts/api-server/src",
  "lib/api-zod/src",
  "lib/api-client-react/src",
  "lib/db/src",
];
const FORBIDDEN = /dicebear|avatarStyle|avatar_style|avatarSource|avatar_source|custom_avatar|Use custom photo|Custom photo avatars/;
/** Files allowed to name the retired system: the guard itself, the migration's test, and assertions that it is gone. */
const ALLOWED = new Set([
  "artifacts/overhype-me/src/lib/__tests__/avatarSystemRetired.test.ts",
  "artifacts/api-server/src/__tests__/migration0163.retireAvatarSystem.test.ts",
  "artifacts/api-server/src/__tests__/routes.users.test.ts",
  "artifacts/overhype-me/e2e/photoUpload.spec.ts",
  "artifacts/overhype-me/e2e/adminPermissions.spec.ts",
  // The upgrade rehearsal's declaration that migration 0163 deleted the feature's
  // rows on purpose (Issue #1302), and that declaration's test.
  "artifacts/api-server/src/lib/retirementLosses.ts",
  "artifacts/api-server/src/__tests__/retirementLosses.test.ts",
]);

function* files(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* files(full);
    else if (/\.(ts|tsx|mts|mjs|js)$/.test(entry.name)) yield full;
  }
}

describe("the avatar system stays removed", () => {
  it("no product source names it", () => {
    const hits: string[] = [];
    for (const tree of TREES) {
      for (const file of files(path.join(ROOT, tree))) {
        const rel = path.relative(ROOT, file);
        if (ALLOWED.has(rel)) continue;
        const text = fs.readFileSync(file, "utf8");
        const m = FORBIDDEN.exec(text);
        if (m) hits.push(`${rel}: ${m[0]}`);
      }
    }
    expect(hits).toEqual([]);
  });
});
