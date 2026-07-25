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

import { filterMembershipPlans, type StripePlan } from "@/lib/stripePlans";

export type { StripePlan, StripePlanPrice } from "@/lib/stripePlans";

export function findAnnualPriceId(plans: StripePlan[], currentPriceId: string | null | undefined): string | null {
  const candidates = filterMembershipPlans(plans);

  if (currentPriceId) {
    for (const product of candidates) {
      const hasCurrentPrice = product.prices.some(p => p.id === currentPriceId);
      if (hasCurrentPrice) {
        const annualPrice = product.prices.find(p => p.recurring?.interval === "year");
        if (annualPrice) return annualPrice.id;
      }
    }
  }

  for (const product of candidates) {
    for (const price of product.prices) {
      if (price.recurring?.interval === "year") return price.id;
    }
  }
  return null;
}

export function getAnnualSavingsPercent(plans: StripePlan[], currentPriceId: string | null | undefined): number | null {
  const candidates = filterMembershipPlans(plans);
  let monthlyAmount: number | null = null;
  let annualAmount: number | null = null;

  if (currentPriceId) {
    for (const product of candidates) {
      const hasCurrentPrice = product.prices.some(p => p.id === currentPriceId);
      if (hasCurrentPrice) {
        monthlyAmount = product.prices.find(p => p.recurring?.interval === "month")?.unit_amount ?? null;
        annualAmount = product.prices.find(p => p.recurring?.interval === "year")?.unit_amount ?? null;
        break;
      }
    }
  }

  if (!monthlyAmount || !annualAmount) {
    for (const product of candidates) {
      for (const price of product.prices) {
        if (price.recurring?.interval === "month") monthlyAmount = price.unit_amount;
        if (price.recurring?.interval === "year") annualAmount = price.unit_amount;
      }
    }
  }

  if (!monthlyAmount || !annualAmount) return null;
  const annualEquivMonthly = annualAmount / 12;
  return Math.round((1 - annualEquivMonthly / monthlyAmount) * 100);
}
