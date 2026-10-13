/**
 * The one selection rule for every deploy-selectable double (Launch Phase 2,
 * #631; plan: "one selection rule for every double, so there is one thing to
 * audit").
 *
 * - A double is chosen only by an explicit environment value naming it.
 *   Nothing is inferred from a key prefix, a hostname or a connection string.
 * - Unset (or empty) means the real backend.
 * - An unrecognised value refuses to boot, everywhere.
 * - Any double named in a production boot (`REPLIT_DEPLOYMENT=1` or
 *   `NODE_ENV=production`) refuses to boot.
 *
 * Each increment that adds a double adds its row to `SELECTORS` and a test
 * that a production boot naming it exits before listening
 * (`__tests__/doubleSelection.test.ts`). `lib/bootChecks.ts` runs the refusal
 * before any other module loads; `selectedBackend` re-applies it at the point
 * of use, so a script or test that never booted the server gets the same rule.
 *
 * Imports only `./env`, which imports nothing: `bootChecks.ts` imports this
 * before anything that reaches the database (held by a test).
 */
import { isProductionEnv } from "./env";

interface Selector {
  /** The value meaning "the real backend", accepted as well as unset. */
  real: string;
  /** Values naming a double. */
  doubles: readonly string[];
  /** Settings a double needs, checked at boot so a misconfiguration fails before listening. */
  requires?: (env: NodeJS.ProcessEnv) => string[];
}

/** Every Stripe credential variable, by name — the fake refuses to start if any is set. */
const STRIPE_CREDENTIAL_VARS = [
  "STRIPE_SECRET_KEY_TEST",
  "STRIPE_SECRET_KEY_LIVE",
  "STRIPE_PUBLISHABLE_KEY_TEST",
  "STRIPE_PUBLISHABLE_KEY_LIVE",
  "STRIPE_WEBHOOK_SECRET_TEST",
  "STRIPE_WEBHOOK_SECRET_LIVE",
] as const;

export const SELECTORS = {
  /** Object storage: the Replit sidecar's GCS bucket, or a local directory (`lib/localObjectStorage.ts`). */
  STORAGE_BACKEND: {
    real: "replit",
    doubles: ["local-double"],
    requires: (env) =>
      (env.STORAGE_DOUBLE_DIR ?? "").startsWith("/")
        ? []
        : ["STORAGE_DOUBLE_DIR must be an absolute directory for the local storage double"],
  },
  /**
   * Stripe: the real SDK and the environment's credentials, or the in-process
   * fake (`lib/stripeFakeDriver.ts`, #566). The fake refuses to start beside any
   * real Stripe credential: a key that leaks into a fake run stops the boot
   * rather than sitting unused, so "the fake never reads a credential" holds
   * because none is present to read. Which DATABASE the fake may use is checked
   * separately, against the database's own settings
   * (`lib/stripeDatabasePartition.ts`), because that needs a connection.
   */
  STRIPE_BACKEND: {
    real: "stripe",
    doubles: ["fake-double"],
    requires: (env) =>
      STRIPE_CREDENTIAL_VARS.filter((name) => (env[name] ?? "") !== "").map(
        (name) => `${name} is set, and the fake Stripe driver refuses to start beside a real Stripe credential`,
      ),
  },
} as const satisfies Record<string, Selector>;

export type SelectorName = keyof typeof SELECTORS;

const rawValue = (env: NodeJS.ProcessEnv, name: SelectorName): string => (env[name] ?? "").trim();

/** Why this environment must not use `name`'s selection, if it must not. */
function refusalsFor(name: SelectorName, env: NodeJS.ProcessEnv): string[] {
  const selector: Selector = SELECTORS[name];
  const value = rawValue(env, name);
  if (value === "" || value === selector.real) return [];
  if (!selector.doubles.includes(value)) {
    return [
      `${name}=${JSON.stringify(value)} is not recognised (expected unset, "${selector.real}", or ${selector.doubles.map((d) => `"${d}"`).join(", ")})`,
    ];
  }
  if (isProductionEnv(env)) return [`${name}=${value} names a test double, which a production boot refuses`];
  return selector.requires?.(env) ?? [];
}

/** Every reason this environment must not boot, across all selectors. */
export function doubleSelectionRefusals(env: NodeJS.ProcessEnv = process.env): string[] {
  return (Object.keys(SELECTORS) as SelectorName[]).flatMap((name) => refusalsFor(name, env));
}

/** Throws, listing every refusal, when this environment must not boot. */
export function assertDoubleSelection(env: NodeJS.ProcessEnv = process.env): void {
  const refusals = doubleSelectionRefusals(env);
  if (refusals.length > 0) {
    throw new Error(`[doubles] refusing to start:\n${refusals.map((r) => `  - ${r}`).join("\n")}`);
  }
}

/** The backend this process uses for `name`, after the same refusals boot applies to it. */
export function selectedBackend(name: SelectorName, env: NodeJS.ProcessEnv = process.env): string {
  const refusals = refusalsFor(name, env);
  if (refusals.length > 0) {
    throw new Error(`[doubles] refusing:\n${refusals.map((r) => `  - ${r}`).join("\n")}`);
  }
  return rawValue(env, name) || SELECTORS[name].real;
}
