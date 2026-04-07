import { useState, useEffect } from "react";
import { Link } from "wouter";
import { Button } from "@/components/ui/Button";
import { Star, CreditCard, Calendar, Zap, ExternalLink, AlertCircle, Receipt, ChevronDown, ChevronUp, Crown } from "lucide-react";

interface Subscription {
  id: string;
  status: string;
  current_period_end: number;
  cancel_at_period_end: boolean;
  items?: { data: Array<{ price: { id: string; unit_amount: number; recurring: { interval: string } | null } }> };
}

interface AppSubscription {
  id: number;
  userId: string;
  stripeSubscriptionId: string;
  plan: string;
  status: string;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
}

interface SubscriptionResponse {
  subscription: Subscription | null;
  appSubscription: AppSubscription | null;
  membershipTier: "free" | "premium" | "legendary";
  isLifetime: boolean;
}

interface PaymentRecord {
  id: number;
  event: string;
  plan: string | null;
  amount: number | null;
  currency: string | null;
  stripePaymentIntentId: string | null;
  stripeSubscriptionId: string | null;
  stripeInvoiceId: string | null;
  createdAt: string;
}

function eventLabel(event: string): string {
  switch (event) {
    case "subscription_activated": return "Subscription Activated";
    case "subscription_cancelled": return "Subscription Cancelled";
    case "invoice_paid": return "Payment Received";
    case "lifetime_purchase": return "Lifetime Purchase";
    default: return event.replace(/_/g, " ");
  }
}

function formatPlanName(plan: string | null): string {
  if (!plan) return "";
  return plan.charAt(0).toUpperCase() + plan.slice(1);
}

export function SubscriptionPanel() {
  const [subData, setSubData] = useState<SubscriptionResponse | null | undefined>(undefined);
  const [history, setHistory] = useState<PaymentRecord[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [portalLoading, setPortalLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/stripe/subscription", { credentials: "include" })
      .then(r => r.json())
      .then((d: SubscriptionResponse) => setSubData(d))
      .catch(() => setSubData(null));
    fetch("/api/stripe/payment-history", { credentials: "include" })
      .then(r => r.json())
      .then((d: { history: PaymentRecord[] }) => setHistory(d.history ?? []))
      .catch(() => {});
  }, []);

  async function openPortal() {
    setPortalLoading(true);
    setError(null);
    try {
      const resp = await fetch("/api/stripe/portal", {
        method: "POST",
        credentials: "include",
      });
      const data = (await resp.json()) as { url?: string; error?: string };
      if (data.url) window.location.href = data.url;
      else setError(data.error ?? "Failed to open portal");
    } catch {
      setError("Network error");
    } finally {
      setPortalLoading(false);
    }
  }

  const sub = subData?.subscription ?? null;
  const appSub = subData?.appSubscription ?? null;
  const membershipTier = subData?.membershipTier ?? "free";
  const isLifetime = subData?.isLifetime ?? false;
  const isLegendary = membershipTier === "legendary";
  const isPremium = membershipTier === "premium" || isLegendary;

  const periodEnd = sub?.current_period_end
    ? new Date(sub.current_period_end * 1000).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })
    : appSub?.currentPeriodEnd
    ? new Date(appSub.currentPeriodEnd).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })
    : null;

  const cancelAtPeriodEnd = sub?.cancel_at_period_end ?? appSub?.cancelAtPeriodEnd ?? false;

  const price = sub?.items?.data?.[0]?.price;
  const planLabel = isLegendary
    ? "Legendary"
    : isLifetime
    ? "Lifetime"
    : appSub?.plan === "annual" ? "Annual"
    : appSub?.plan === "monthly" ? "Monthly"
    : price?.recurring?.interval === "year" ? "Annual"
    : price?.recurring?.interval === "month" ? "Monthly"
    : "Legendary";

  const showPortalButton = !isLegendary && !isLifetime && !!sub;

  return (
    <div className="bg-card border-2 border-border rounded-sm p-6 mb-8">
      <div className="flex items-center gap-2 mb-5">
        <Star className="w-5 h-5 text-primary" />
        <h2 className="font-display text-xl uppercase tracking-wide text-foreground">Membership</h2>
      </div>

      {subData === undefined && (
        <div className="animate-pulse h-20 bg-secondary rounded-sm" />
      )}

      {subData !== undefined && !isPremium && (
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 p-4 bg-secondary/50 rounded-sm border border-border">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-sm bg-secondary flex items-center justify-center">
              <Zap className="w-5 h-5 text-muted-foreground" />
            </div>
            <div>
              <p className="font-bold text-foreground">Free Plan</p>
              <p className="text-sm text-muted-foreground">Upgrade to unlock daily emails, HD memes & more</p>
            </div>
          </div>
          <Link href="/pricing">
            <Button size="sm">Go Legendary</Button>
          </Link>
        </div>
      )}

      {subData !== undefined && isPremium && (
        <div className="space-y-4">
          <div className={`flex items-center gap-3 p-4 rounded-sm border ${isLegendary ? "bg-amber-500/10 border-amber-500/30" : "bg-primary/10 border-primary/30"}`}>
            {isLegendary ? (
              <Crown className="w-6 h-6 text-amber-400 shrink-0" />
            ) : (
              <Star className="w-6 h-6 text-primary shrink-0" />
            )}
            <div>
              <p className="font-bold text-foreground flex items-center gap-2">
                {isLegendary ? "Legendary Member" : "Premium Member"}
                <span className={`text-xs px-2 py-0.5 rounded-sm uppercase tracking-wide ${isLegendary ? "bg-amber-500/20 text-amber-400" : "bg-primary/20 text-primary"}`}>
                  {isLegendary ? "legendary" : isLifetime ? "lifetime" : sub?.status ?? "active"}
                </span>
              </p>
              <p className="text-sm text-muted-foreground">
                {planLabel} {(isLifetime || isLegendary) ? "— one-time purchase, never expires" : "subscription"}
              </p>
            </div>
          </div>

          {(isLifetime || isLegendary) && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Crown className="w-4 h-4 text-amber-400" />
              <span className="text-amber-400 font-medium">Lifetime access — never expires</span>
            </div>
          )}

          {!isLifetime && !isLegendary && periodEnd && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Calendar className="w-4 h-4 text-primary" />
              {cancelAtPeriodEnd
                ? <span>Cancels on <strong className="text-foreground">{periodEnd}</strong></span>
                : <span>Renews on <strong className="text-foreground">{periodEnd}</strong></span>
              }
            </div>
          )}

          {price && !isLifetime && !isLegendary && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <CreditCard className="w-4 h-4 text-primary" />
              <span>${(price.unit_amount / 100).toFixed(2)}{price.recurring ? `/${price.recurring.interval}` : " one-time"}</span>
            </div>
          )}

          {error && (
            <div className="flex items-center gap-2 text-sm text-destructive bg-destructive/10 border border-destructive/30 rounded-sm p-3">
              <AlertCircle className="w-4 h-4 shrink-0" />
              {error}
            </div>
          )}

          {showPortalButton && (
            <Button variant="outline" size="sm" onClick={openPortal} disabled={portalLoading} className="gap-2">
              <ExternalLink className="w-4 h-4" />
              {portalLoading ? "Opening..." : "Manage Subscription"}
            </Button>
          )}
        </div>
      )}

      {/* Payment History */}
      {history.length > 0 && (
        <div className="mt-6 border-t border-border pt-5">
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
              {history.map(record => (
                <div key={record.id} className="flex items-center justify-between p-3 bg-secondary/50 rounded-sm border border-border/50 text-sm">
                  <div>
                    <p className="font-medium text-foreground">{eventLabel(record.event)}</p>
                    <div className="flex items-center gap-2 mt-0.5">
                      {record.plan && <span className="text-xs text-primary uppercase">{formatPlanName(record.plan)}</span>}
                      <span className="text-xs text-muted-foreground">
                        {new Date(record.createdAt).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" })}
                      </span>
                    </div>
                  </div>
                  {record.amount != null && record.amount > 0 && (
                    <span className="font-bold text-foreground">
                      ${(record.amount / 100).toFixed(2)} {record.currency?.toUpperCase()}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
