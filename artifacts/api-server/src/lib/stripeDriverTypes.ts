/** The driver contract, separate from selection so neither driver imports the selector. */
import type { StripeApi, StripeSyncInstance } from "./stripeApi.js";

/** Which configuration setting carries each value, for operator-facing messages. */
export interface StripeSettingNames {
  secret: string;
  publishable: string;
  account: string;
  /** The webhook signing secret's setting. */
  webhookSecret: string;
  /** The setting naming the operator-provisioned webhook endpoint's id. */
  webhookEndpoint: string;
}

/** Boolean presence only — a value is never echoed. Shape matches the setup snapshot. */
export interface StripeCredentialPresence {
  secretKeyTest: boolean;
  secretKeyLive: boolean;
  publishableKeyTest: boolean;
  publishableKeyLive: boolean;
  webhookSecretTest: boolean;
  webhookSecretLive: boolean;
  webhookEndpointTest: boolean;
  webhookEndpointLive: boolean;
}

export interface StripeDriver {
  readonly kind: "real" | "fake";
  settingNames(liveMode: boolean): StripeSettingNames;
  /** The secret for a mode when one is configured; never throws. */
  configuredSecretKey(liveMode: boolean): string | undefined;
  /** Both keys for a mode. Throws an operator-readable error when either is absent. */
  credentials(liveMode: boolean): { secretKey: string; publishableKey: string };
  /**
   * The webhook signing secret for a mode, or null when none is configured —
   * and then every delivery is refused. There is no fallback to the library's
   * managed-webhook row (launch Phase 15, increment 4).
   */
  webhookSecret(liveMode: boolean): string | null;
  /** The id of the endpoint the operator provisioned for a mode, or null when none is named. */
  webhookEndpointId(liveMode: boolean): string | null;
  /** The account id this environment declares a mode's credentials may touch. */
  expectedAccountId(liveMode: boolean): string | undefined;
  createClient(secretKey: string): StripeApi;
  buildSync(params: { liveMode: boolean; secretKey: string; webhookSecret: string | null }): Promise<StripeSyncInstance>;
  credentialPresence(): StripeCredentialPresence;
}
