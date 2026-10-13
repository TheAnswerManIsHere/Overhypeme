/**
 * The refusals the AI recorder launcher (`./aiRecorderLauncher.ts`) applies
 * before it imports the application. Pure: reads only the environment it is
 * given, so it is unit-tested without booting anything.
 *
 * The launcher boots the real API server to record the AI baseline (Launch Phase 2,
 * increment 4, #631; design D6). Started only by `scripts/record-ai-baseline.ts`,
 * which hands it an explicitly constructed environment; never in CI.
 *
 * Every refusal here runs before the application is imported, so a wrong
 * environment can neither reach the database graph nor a vendor:
 *
 * - not a production boot, not a deployment;
 * - `AI_BACKEND=recorder` (the selection rule then demands both vendor keys);
 * - the local storage double, so no object reaches the real bucket;
 * - an absolute recordings directory and a positive spending allowance;
 * - nothing outside a named allowlist, so no credential for any vendor
 *   outside the AI baseline.
 *
 * The marked-test-database rule is the launcher's, since it reads the database.
 */
import { doubleSelectionRefusals } from "../lib/doubleSelection";
import { isProductionEnv } from "../lib/env";

/**
 * Every variable the recording server may receive. `scripts/record-ai-baseline.ts`
 * constructs exactly this environment; anything else — a credential for a
 * vendor outside the AI baseline above all — is refused, so a new vendor's key
 * is excluded without anyone having to list it.
 */
export const RECORDER_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "DATABASE_URL",
  "NODE_ENV",
  "PORT",
  "ENABLE_DEV_ADMIN_LOGIN",
  "CRON_SECRET",
  "STORAGE_BACKEND",
  "STORAGE_DOUBLE_DIR",
  "PRIVATE_OBJECT_DIR",
  "PUBLIC_OBJECT_SEARCH_PATHS",
  "AI_BACKEND",
  "AI_RECORDINGS_DIR",
  "AI_RECORDER_ALLOWANCE_USD",
  "AI_RECORDER_LEDGER",
  "FAL_AI_API_KEY",
  "FAL_KEY",
  "OPENAI_API_KEY",
];

export function recorderLaunchRefusals(env: NodeJS.ProcessEnv): string[] {
  const refusals: string[] = [];
  if (isProductionEnv(env)) refusals.push("a production boot never records");
  if ((env.AI_BACKEND ?? "").trim() !== "recorder") refusals.push("AI_BACKEND must be 'recorder'");
  if ((env.STORAGE_BACKEND ?? "").trim() !== "local-double") refusals.push("STORAGE_BACKEND must be 'local-double' so nothing reaches the real bucket");
  if (!(env.AI_RECORDINGS_DIR ?? "").startsWith("/")) refusals.push("AI_RECORDINGS_DIR must be an absolute directory");
  if (!(Number(env.AI_RECORDER_ALLOWANCE_USD) > 0)) refusals.push("AI_RECORDER_ALLOWANCE_USD must be a positive dollar amount");
  const unexpected = Object.keys(env).filter((name) => !RECORDER_ENV_ALLOWLIST.includes(name));
  if (unexpected.length > 0) {
    refusals.push(`variables outside the recorder's allowlist are set (${unexpected.join(", ")}); its environment is constructed, never inherited`);
  }
  refusals.push(...doubleSelectionRefusals(env));
  return refusals;
}
