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
 * - nothing outside a named allowlist (`launchEnvironment.ts`), so no credential
 *   for any vendor outside the AI baseline, or outside the live check's list
 *   when `AI_RECORDER_LIVE=1`.
 *
 * The marked-test-database rule is the launcher's, since it reads the database.
 */
import { doubleSelectionRefusals } from "../lib/doubleSelection";
import { isProductionEnv } from "../lib/env";

import { allowlistRefusals, LIVE_ENV_ALLOWLIST, RECORDER_ENV_ALLOWLIST } from "./launchEnvironment";

export { LIVE_ENV_ALLOWLIST, RECORDER_ENV_ALLOWLIST } from "./launchEnvironment";

export function recorderLaunchRefusals(env: NodeJS.ProcessEnv): string[] {
  const refusals: string[] = [];
  if (isProductionEnv(env)) refusals.push("a production boot never records");
  if ((env.AI_BACKEND ?? "").trim() !== "recorder") refusals.push("AI_BACKEND must be 'recorder'");
  if ((env.STORAGE_BACKEND ?? "").trim() !== "local-double") refusals.push("STORAGE_BACKEND must be 'local-double' so nothing reaches the real bucket");
  if (!(env.AI_RECORDINGS_DIR ?? "").startsWith("/")) refusals.push("AI_RECORDINGS_DIR must be an absolute directory");
  if (!(Number(env.AI_RECORDER_ALLOWANCE_USD) > 0)) refusals.push("AI_RECORDER_ALLOWANCE_USD must be a positive dollar amount");
  // The live check (plan D6) is the recorder with reuse off and a few more vendors, each passed explicitly.
  const live = env.AI_RECORDER_LIVE === "1";
  refusals.push(...allowlistRefusals(env, live ? LIVE_ENV_ALLOWLIST : RECORDER_ENV_ALLOWLIST, live ? "live check" : "recorder"));
  refusals.push(...doubleSelectionRefusals(env));
  return refusals;
}
