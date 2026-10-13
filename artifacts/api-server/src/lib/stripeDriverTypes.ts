/** The driver contract, separate from selection so neither driver imports the selector. */
import type { StripeApi, StripeSyncInstance } from "./stripeApi.js";

/** Which configuration setting carries each value, for operator-facing messages. */
export interface StripeSettingNames {
  secret: string;
  publishable: string;
  account: string;
}

/** Boolean presence only — a value is never echoed. Shape matches the setup snapshot. */
export interface StripeCredentialPresence {
  secretKeyTest: boolean;
  secretKeyLive: boolean;
  publishableKeyTest: boolean;
  publishableKeyLive: boolean;
  webhookSecretTest: boolean;
  webhookSecretLive: boolean;
}

export interface StripeDriver {
  readonly kind: "real" | "fake";
  settingNames(liveMode: boolean): StripeSettingNames;
  /** The secret for a mode when one is configured; never throws. */
  configuredSecretKey(liveMode: boolean): string | undefined;
  /** Both keys for a mode. Throws an operator-readable error when either is absent. */
  credentials(liveMode: boolean): { secretKey: string; publishableKey: string };
  /** The webhook signing secret for a mode, or null to use the managed-webhook secret. */
  webhookSecret(liveMode: boolean): string | null;
  /** The account id this environment declares a mode's credentials may touch. */
  expectedAccountId(liveMode: boolean): string | undefined;
  createClient(secretKey: string): StripeApi;
  buildSync(params: { liveMode: boolean; secretKey: string; webhookSecret: string | null }): Promise<StripeSyncInstance>;
  credentialPresence(): StripeCredentialPresence;
}
