/**
 * Boots the real API server over a restored pair for the isolated restore
 * rehearsal (Launch Phase 3, increment 5; plan §4, "The isolated
 * rehearsal"). Started only by `scripts/restore-rehearsal.ts` with a
 * constructed environment. Refuses, before the application is imported:
 *   - any variable outside RESTORE_REHEARSAL_ENV_ALLOWLIST (so no credential
 *     can reach it);
 *   - a database whose name does not start with `restore_rehearsal_` (the
 *     scratch database the rehearsal created);
 *   - a storage directory or public search path outside a `_restores/` prefix
 *     (so it can never serve, or heal an ACL on, live media).
 */
import { allowlistRefusals, RESTORE_REHEARSAL_ENV_ALLOWLIST } from "./launchEnvironment";

export function restoreRehearsalRefusals(env: NodeJS.ProcessEnv): string[] {
  const refusals = allowlistRefusals(env, RESTORE_REHEARSAL_ENV_ALLOWLIST, "restore rehearsal");
  let dbName = "";
  try {
    dbName = new URL(env.DATABASE_URL ?? "").pathname.replace(/^\//, "");
  } catch {
    // reported below
  }
  if (!dbName.startsWith("restore_rehearsal_")) refusals.push("DATABASE_URL must name a restore_rehearsal_ scratch database");
  const dirs = [env.PRIVATE_OBJECT_DIR ?? "", ...(env.PUBLIC_OBJECT_SEARCH_PATHS ?? "").split(",")].map((d) => d.trim()).filter(Boolean);
  if (dirs.length < 2) refusals.push("PRIVATE_OBJECT_DIR and PUBLIC_OBJECT_SEARCH_PATHS are required");
  for (const d of dirs) if (!d.split("/").includes("_restores")) refusals.push(`${d} is not inside a _restores/ prefix`);
  return refusals;
}

if (process.argv[1]?.endsWith("restoreRehearsalLauncher.ts")) {
  const refusals = restoreRehearsalRefusals(process.env);
  if (refusals.length > 0) {
    process.stderr.write(`[restore rehearsal launcher] refusing to start:\n${refusals.map((r) => `  - ${r}`).join("\n")}\n`);
    process.exit(1);
  }
  // Only after the refusals: this reaches the database and the application.
  await import("../index");
}
