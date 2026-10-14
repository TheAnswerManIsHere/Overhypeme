/**
 * The refusals the acceptance launcher (`./acceptanceLauncher.ts`) applies
 * before it imports the application (Launch Phase 2, increment 6, #631; plan
 * D3). Pure: reads only the environment it is given.
 *
 * An acceptance or replay run holds no credential of any kind:
 *
 * - not a production boot, not a deployment;
 * - `AI_BACKEND=recorded-double` and `STORAGE_BACKEND=local-double`;
 * - nothing outside the acceptance allowlist (`launchEnvironment.ts`), which
 *   names no credential, so a vendor key cannot be present.
 *
 * The marked-test-database rule is the launcher's, since it reads the database.
 */
import { doubleSelectionRefusals } from "../lib/doubleSelection";
import { isProductionEnv } from "../lib/env";

import { ACCEPTANCE_ENV_ALLOWLIST, allowlistRefusals } from "./launchEnvironment";

export function acceptanceLaunchRefusals(env: NodeJS.ProcessEnv): string[] {
  const refusals: string[] = [];
  if (isProductionEnv(env)) refusals.push("an acceptance run never boots in production");
  if ((env.AI_BACKEND ?? "").trim() !== "recorded-double") refusals.push("AI_BACKEND must be 'recorded-double': an acceptance run reaches no AI vendor");
  if ((env.STORAGE_BACKEND ?? "").trim() !== "local-double") refusals.push("STORAGE_BACKEND must be 'local-double' so nothing reaches the real bucket");
  refusals.push(...allowlistRefusals(env, ACCEPTANCE_ENV_ALLOWLIST, "acceptance launcher"));
  refusals.push(...doubleSelectionRefusals(env));
  return refusals;
}
