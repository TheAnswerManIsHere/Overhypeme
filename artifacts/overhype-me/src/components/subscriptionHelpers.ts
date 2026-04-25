export function eventLabel(event: string): string {
  switch (event) {
    case "subscription_activated": return "Subscription Activated";
    case "subscription_cancelled": return "Subscription Cancelled";
    case "invoice_paid": return "Payment Received";
    case "lifetime_purchase": return "Legendary for Life Purchase";
    case "refund": return "Refund";
    case "dispute_opened": return "Dispute Opened";
    case "dispute_won": return "Dispute Won";
    case "dispute_lost": return "Dispute Lost";
    case "dispute_closed": return "Dispute Closed";
    default: return event.replace(/_/g, " ");
  }
}

export type EventTone = "charge" | "refund" | "dispute" | "dispute-won";

export function eventTone(event: string): EventTone {
  switch (event) {
    case "refund":
      return "refund";
    case "dispute_opened":
    case "dispute_lost":
    case "dispute_closed":
      return "dispute";
    case "dispute_won":
      return "dispute-won";
    default:
      return "charge";
  }
}

export function formatAmount(amount: number, currency: string): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: currency.toUpperCase() }).format(amount / 100);
}
