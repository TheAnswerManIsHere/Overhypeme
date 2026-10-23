/**
 * Every journey launcher boots from a constructed environment (Launch Phase 2,
 * increment 6, #631; plan D3, the gap recorded on #637).
 *
 * A launch names its allowlist; the environment it passes holds only those
 * keys, and its launcher refuses, before importing the application, when any
 * other variable is present, naming it. A vendor credential that is not on a
 * launch's list therefore cannot reach that server, so a new vendor's key is
 * excluded without anyone having to list it — the blanklist shape (unset the
 * keys you know about) is what two earlier launches got wrong.
 *
 * Pure: reads only the environment it is given.
 */

/** Variables any Node launch carries: where to find binaries and a home directory. */
const BASE = ["PATH", "HOME"] as const;

/** The AI recorder (`aiRecorderLauncher.ts`), started by the baseline runner in record mode. */
export const RECORDER_ENV_ALLOWLIST: readonly string[] = [
  ...BASE,
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

/**
 * The live check adds the vendors its journeys reach beyond the AI baseline,
 * each passed explicitly (plan D6), and the switch that turns same-run reuse off.
 */
export const LIVE_ENV_ALLOWLIST: readonly string[] = [
  ...RECORDER_ENV_ALLOWLIST,
  "AI_RECORDER_LIVE",
  "ARACHNID_SHIELD_USERNAME",
  "ARACHNID_SHIELD_PASSWORD",
];

/** The acceptance and replay server (`acceptanceLauncher.ts`): no credential of any kind. */
export const ACCEPTANCE_ENV_ALLOWLIST: readonly string[] = [
  ...BASE,
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
  "AI_DOUBLE_MISS_LOG",
  "AI_DOUBLE_CALL_LOG",
  "AI_DOUBLE_FAIL",
  "ALLOWED_ORIGINS",
];

/** Journey 1's production-mode launcher (`productionModeLauncher.ts`). */
export const PRODUCTION_MODE_ENV_ALLOWLIST: readonly string[] = [
  ...BASE,
  "DATABASE_URL",
  "NODE_ENV",
  "PORT",
  "CRON_SECRET",
  "IP_HASH_SALT",
  "SITE_BASE_URL",
  "ALLOWED_ORIGINS",
  "E2E_MAIL_SINK_DIR",
];

/** The variables in `env` that `allowlist` does not name. */
export function outsideAllowlist(env: NodeJS.ProcessEnv, allowlist: readonly string[]): string[] {
  return Object.keys(env).filter((name) => !allowlist.includes(name)).sort();
}

/** One refusal naming every stray variable, or none. */
export function allowlistRefusals(env: NodeJS.ProcessEnv, allowlist: readonly string[], launch: string): string[] {
  const stray = outsideAllowlist(env, allowlist);
  return stray.length === 0
    ? []
    : [`variables outside the ${launch}'s allowlist are set (${stray.join(", ")}); its environment is constructed, never inherited`];
}

/**
 * The environment a launch passes: exactly the given values, undefined ones
 * dropped. A key outside the allowlist is a bug in the caller, so it throws
 * rather than relying on the launcher to refuse it later.
 */
export function constructEnvironment(allowlist: readonly string[], values: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(values)) {
    if (!allowlist.includes(key)) throw new Error(`[launch] ${key} is not on this launch's allowlist`);
    if (value !== undefined) env[key] = value;
  }
  return env;
}
