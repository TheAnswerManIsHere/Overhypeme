export type StripeDashboardEntity =
  | "customers"
  | "payment_intents"
  | "subscriptions"
  | "payments"
  | "disputes"
  | "invoices"
  | "radar_early_fraud_warnings";

export function stripeDashboardUrl(
  entity: StripeDashboardEntity,
  id: string,
  opts: { liveMode: boolean },
): string {
  const base = opts.liveMode
    ? "https://dashboard.stripe.com"
    : "https://dashboard.stripe.com/test";

  if (entity === "radar_early_fraud_warnings") {
    return `${base}/radar/early-fraud-warnings/${id}`;
  }

  return `${base}/${entity}/${id}`;
}
