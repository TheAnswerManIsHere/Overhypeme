import { useState } from "react";
import { Crown, Calendar, AlertTriangle, Receipt, ChevronDown, ChevronUp, ExternalLink } from "lucide-react";
import { eventLabel, eventTone, formatAmount, type EventTone } from "@/components/subscriptionHelpers";
import { StripeLink } from "@/components/StripeLink";

function eventBadgeClass(tone: EventTone): string {
  switch (tone) {
    case "refund":
      return "bg-blue-500/15 text-blue-500 dark:text-blue-400 border border-blue-500/30";
    case "dispute":
      return "bg-amber-500/15 text-amber-600 dark:text-amber-400 border border-amber-500/30";
    case "dispute-won":
      return "bg-green-500/15 text-green-600 dark:text-green-400 border border-green-500/30";
    default:
      return "";
  }
}

function amountIsNegative(event: string): boolean {
  return event === "refund" || event === "dispute_lost";
}

function amountClass(event: string): string {
  if (amountIsNegative(event)) return "text-red-500 dark:text-red-400";
  return "text-foreground";
}

function formatSignedAmount(event: string, amount: number, currency: string): string {
  const formatted = formatAmount(amount, currency);
  return amountIsNegative(event) ? `-${formatted}` : formatted;
}

export interface SubscriptionInfoRecord {
  id: number;
  event: string;
  plan: string | null;
  amount: number | null;
  currency: string | null;
  createdAt: string;
  stripePaymentIntentId?: string | null;
  stripeInvoiceId?: string | null;
  stripeDisputeId?: string | null;
  performedByAdminId?: string | null;
  performedByAdminDisplayName?: string | null;
  performedByAdminEmail?: string | null;
}

export interface SubscriptionInfoData {
  isLifetime: boolean;
  cancelAtPeriodEnd: boolean;
  periodEnd: string | null;
  status: string | null;
  plan: string | null;
  history: SubscriptionInfoRecord[];
}

interface SubscriptionInfoProps {
  data: SubscriptionInfoData;
  variant: "full" | "compact";
  liveMode?: boolean;
  reactivateButton?: React.ReactNode;
  hideHistory?: boolean;
}


export function SubscriptionInfo({ data, variant, liveMode = false, reactivateButton, hideHistory = false }: SubscriptionInfoProps) {
  const [showHistory, setShowHistory] = useState(false);
  const { isLifetime, cancelAtPeriodEnd, periodEnd, status, plan, history } = data;

  if (variant === "compact") {
    const hasSubscriptionInfo = status !== null || isLifetime;
    return (
      <div className="flex flex-col gap-1.5">
        {/* Status badge row — only render when there is actual subscription info */}
        {hasSubscriptionInfo && (
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className={`text-xs px-1.5 py-0.5 rounded-sm font-medium uppercase tracking-wide ${
                status === "active" ? "bg-green-500/15 text-green-400" : "bg-muted text-muted-foreground"
              }`}>
                {isLifetime ? "legendary for life" : cancelAtPeriodEnd ? "cancelling" : status}
              </span>
              {plan && <span className="text-xs text-muted-foreground capitalize">{plan}</span>}
            </div>
            {cancelAtPeriodEnd && !isLifetime && (
              <div className="flex items-center gap-1 text-orange-400">
                <AlertTriangle className="w-3 h-3" />
                <span className="text-xs">Cancelling</span>
              </div>
            )}
          </div>
        )}

        {/* Renewal / end date */}
        {hasSubscriptionInfo && !isLifetime && periodEnd && (
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Calendar className="w-3 h-3 text-primary" />
            {cancelAtPeriodEnd ? "Ends" : "Renews"}{" "}
            <strong className="text-foreground">{periodEnd}</strong>
          </div>
        )}

        {isLifetime && (
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Crown className="w-3 h-3 text-amber-400" />
            <span className="text-amber-400 font-medium">Access never expires</span>
          </div>
        )}

        {/* Collapsible billing history */}
        {!hideHistory && history.length > 0 && (
          <div className={`${hasSubscriptionInfo ? "border-t border-border pt-3 mt-1" : ""}`}>
            <button
              onClick={() => setShowHistory((v) => !v)}
              className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground hover:text-foreground transition-colors w-full text-left"
            >
              <Receipt className="w-3.5 h-3.5 text-primary" />
              Payment History ({history.length})
              {showHistory ? <ChevronUp className="w-3.5 h-3.5 ml-auto" /> : <ChevronDown className="w-3.5 h-3.5 ml-auto" />}
            </button>
            {showHistory && (
              <div className="mt-2 flex flex-col gap-1">
                {history.map((rec) => {
                  const tone = eventTone(rec.event);
                  const badgeClass = eventBadgeClass(tone);
                  return (
                    <div key={rec.id} className="flex items-center justify-between px-2.5 py-2 bg-muted/40 rounded-sm border border-border/50">
                      <div>
                        <p className="text-xs font-medium text-foreground flex items-center gap-1.5 flex-wrap">
                          {badgeClass ? (
                            <span className={`px-1.5 py-0.5 rounded-sm text-[10px] font-bold uppercase tracking-wide ${badgeClass}`}>
                              {eventLabel(rec.event)}
                            </span>
                          ) : (
                            <span>{eventLabel(rec.event)}</span>
                          )}
                          {rec.plan ? <span className="text-primary uppercase text-[10px]">{rec.plan}</span> : null}
                        </p>
                        <p className="text-[10px] text-muted-foreground mt-0.5">
                          {new Date(rec.createdAt).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" })}
                        </p>
                        {rec.performedByAdminId && (
                          <p className="text-[10px] text-muted-foreground mt-0.5">
                            by {rec.performedByAdminDisplayName ?? rec.performedByAdminEmail ?? rec.performedByAdminId}
                          </p>
                        )}
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0 ml-2">
                        {rec.amount != null && rec.amount > 0 && rec.currency && (
                          <span className={`text-xs font-bold ${amountClass(rec.event)}`}>
                            {formatSignedAmount(rec.event, rec.amount, rec.currency)}
                          </span>
                        )}
                        {rec.stripeDisputeId && (
                          <StripeLink entity="disputes" id={rec.stripeDisputeId} liveMode={liveMode} />
                        )}
                        {rec.stripePaymentIntentId && (
                          <StripeLink entity="payments" id={rec.stripePaymentIntentId} liveMode={liveMode} />
                        )}
                        {rec.stripeInvoiceId && (
                          <a
                            href={`/api/stripe/invoice/${rec.stripeInvoiceId}/receipt`}
                            target="_blank"
                            rel="noopener noreferrer"
                            title="View receipt"
                            className="text-muted-foreground hover:text-primary transition-colors"
                          >
                            <ExternalLink className="w-3 h-3" />
                          </a>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  const hasSubscriptionInfo = status !== null || isLifetime;

  return (
    <div className="flex flex-col gap-4">
      {/* Status banner — only when subscription info is available */}
      {hasSubscriptionInfo && (
        <div className={`flex items-center gap-3 p-4 rounded-sm border ${
          status === "active" || isLifetime
            ? "bg-amber-500/10 border-amber-500/30"
            : "bg-primary/10 border-primary/30"
        }`}>
          <Crown className={`w-6 h-6 shrink-0 ${isLifetime ? "text-amber-400" : "text-primary"}`} />
          <div>
            <p className="font-bold text-foreground flex items-center gap-2">
              Legendary Member
              <span className={`text-xs px-2 py-0.5 rounded-sm uppercase tracking-wide ${
                cancelAtPeriodEnd && !isLifetime
                  ? "bg-orange-500/20 text-orange-400"
                  : "bg-amber-500/20 text-amber-400"
              }`}>
                {isLifetime ? "legendary for life" : cancelAtPeriodEnd ? "cancelling" : "legendary"}
              </span>
            </p>
            <p className="text-sm text-muted-foreground">
              {plan ? plan.charAt(0).toUpperCase() + plan.slice(1) : "Legendary"}{" "}
              {isLifetime ? "— access never expires" : "subscription"}
            </p>
          </div>
        </div>
      )}

      {/* Lifetime note */}
      {isLifetime && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Crown className="w-4 h-4 text-amber-400" />
          <span className="text-amber-400 font-medium">Legendary for Life — access never expires</span>
        </div>
      )}

      {/* Renewal date (active, not cancelling) */}
      {hasSubscriptionInfo && !isLifetime && periodEnd && !cancelAtPeriodEnd && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Calendar className="w-4 h-4 text-primary" />
          <span>Renews on <strong className="text-foreground">{periodEnd}</strong></span>
        </div>
      )}

      {/* Cancellation notice */}
      {!isLifetime && cancelAtPeriodEnd && periodEnd && (
        <div className="flex flex-col gap-3 p-4 rounded-sm border border-orange-500/40 bg-orange-500/10">
          <div className="flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-orange-400 shrink-0 mt-0.5" />
            <div className="flex flex-col gap-1">
              <p className="font-semibold text-foreground text-sm">Subscription cancelled</p>
              <p className="text-sm text-muted-foreground">
                Your Legendary access remains active until <strong className="text-foreground">{periodEnd}</strong>.
                After that date, your account will revert to the free plan and you'll lose access to Legendary features.
              </p>
            </div>
          </div>
          {reactivateButton}
        </div>
      )}

      {/* Collapsible billing history */}
      {!hideHistory && history.length > 0 && (
        <div className="border-t border-border pt-5">
          <button
            onClick={() => setShowHistory(!showHistory)}
            className="flex items-center gap-2 text-sm font-bold text-muted-foreground hover:text-foreground transition-colors w-full text-left"
          >
            <Receipt className="w-4 h-4 text-primary" />
            Payment History ({history.length})
            {showHistory ? <ChevronUp className="w-4 h-4 ml-auto" /> : <ChevronDown className="w-4 h-4 ml-auto" />}
          </button>

          {showHistory && (
            <div className="mt-4 space-y-2">
              {history.map((record) => {
                const tone = eventTone(record.event);
                const badgeClass = eventBadgeClass(tone);
                return (
                  <div key={record.id} className="flex items-center justify-between p-3 bg-secondary/50 rounded-sm border border-border/50 text-sm">
                    <div>
                      <div className="flex items-center gap-2 flex-wrap">
                        {badgeClass ? (
                          <span className={`px-1.5 py-0.5 rounded-sm text-[10px] font-bold uppercase tracking-wide ${badgeClass}`}>
                            {eventLabel(record.event)}
                          </span>
                        ) : (
                          <span className="font-medium text-foreground">{eventLabel(record.event)}</span>
                        )}
                      </div>
                      <div className="flex items-center gap-2 mt-1">
                        {record.plan && (
                          <span className="text-xs text-primary uppercase">
                            {record.plan.charAt(0).toUpperCase() + record.plan.slice(1)}
                          </span>
                        )}
                        <span className="text-xs text-muted-foreground">
                          {new Date(record.createdAt).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" })}
                        </span>
                      </div>
                      {record.performedByAdminId && (
                        <p className="text-xs text-muted-foreground mt-0.5">
                          by {record.performedByAdminDisplayName ?? record.performedByAdminEmail ?? record.performedByAdminId}
                        </p>
                      )}
                    </div>
                    <div className="flex items-center gap-2 shrink-0 ml-2">
                      {record.amount != null && record.amount > 0 && record.currency && (
                        <span className={`font-bold ${amountClass(record.event)}`}>
                          {formatSignedAmount(record.event, record.amount, record.currency)}
                        </span>
                      )}
                      {record.stripeDisputeId && (
                        <StripeLink entity="disputes" id={record.stripeDisputeId} liveMode={liveMode} className="text-muted-foreground hover:text-primary transition-colors" />
                      )}
                      {record.stripePaymentIntentId && (
                        <StripeLink entity="payments" id={record.stripePaymentIntentId} liveMode={liveMode} className="text-muted-foreground hover:text-primary transition-colors" />
                      )}
                      {record.stripeInvoiceId && (
                        <a
                          href={`/api/stripe/invoice/${record.stripeInvoiceId}/receipt`}
                          target="_blank"
                          rel="noopener noreferrer"
                          title="View receipt"
                          className="text-muted-foreground hover:text-primary transition-colors"
                        >
                          <ExternalLink className="w-3.5 h-3.5" />
                        </a>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
