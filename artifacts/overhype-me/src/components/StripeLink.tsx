import { ExternalLink } from "lucide-react";
import { stripeDashboardUrl, type StripeDashboardEntity } from "@/lib/stripeDashboardUrl";

interface StripeLinkProps {
  entity: StripeDashboardEntity;
  id: string;
  liveMode: boolean;
  label?: string;
  className?: string;
}

const ENTITY_LABELS: Record<StripeDashboardEntity, string> = {
  customers: "customer",
  payment_intents: "payment",
  payments: "payment",
  subscriptions: "subscription",
  disputes: "dispute",
  invoices: "invoice",
  radar_early_fraud_warnings: "fraud warning",
};

export function StripeLink({ entity, id, liveMode, label, className }: StripeLinkProps) {
  const href = stripeDashboardUrl(entity, id, { liveMode });
  const entityLabel = ENTITY_LABELS[entity];
  const title = `Open ${entityLabel} in Stripe`;

  if (label) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        title={title}
        className={className ?? "flex items-center gap-1.5 text-primary hover:underline"}
      >
        {label}
        <ExternalLink className="w-3 h-3 shrink-0" />
      </a>
    );
  }

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title={title}
      className={className ?? "text-muted-foreground hover:text-primary transition-colors"}
    >
      <ExternalLink className="w-3 h-3" />
    </a>
  );
}
