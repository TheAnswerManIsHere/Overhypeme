export type StripeDashboardEntity =
  | "customers"
  | "payment_intents"
  | "subscriptions"
  | "payments"
  | "disputes";

export function stripeDashboardUrl(
  entity: StripeDashboardEntity,
  id: string,
  opts: { liveMode: boolean },
): string {
  const base = opts.liveMode
    ? "https://dashboard.stripe.com"
    : "https://dashboard.stripe.com/test";
  return `${base}/${entity}/${id}`;
}
