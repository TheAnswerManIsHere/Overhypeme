import { useState, useEffect, useCallback } from "react";
import { Link } from "wouter";
import { Button } from "@/components/ui/Button";
import { Star, CreditCard, Calendar, Zap, ExternalLink, AlertCircle, AlertTriangle, Receipt, ChevronDown, ChevronUp, Crown, RefreshCw, ArrowUpCircle, XCircle } from "lucide-react";

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
  membershipTier: "unregistered" | "registered" | "legendary";
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

interface PlanPrice {
  id: string;
  unit_amount: number;
  currency: string;
  recurring: { interval: string; interval_count?: number } | null;
}

interface PlanProduct {
  id: string;
  name: string;
  description: string | null;
  metadata: Record<string, string>;
  prices: PlanPrice[];
}

interface ProrationPreview {
  amountDue: number;
  currency: string;
  lines: Array<{ description: string | null; amount: number }>;
}

function eventLabel(event: string): string {
  switch (event) {
    case "subscription_activated": return "Subscription Activated";
    case "subscription_cancelled": return "Subscription Cancelled";
    case "invoice_paid": return "Payment Received";
    case "lifetime_purchase": return "Legendary for Life Purchase";
    default: return event.replace(/_/g, " ");
  }
}

function formatPlanName(plan: string | null): string {
  if (!plan) return "";
  return plan.charAt(0).toUpperCase() + plan.slice(1);
}

function formatAmount(amount: number, currency: string): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: currency.toUpperCase() }).format(amount / 100);
}

interface ConfirmDialogProps {
  title: string;
  children: React.ReactNode;
  confirmLabel: string;
  isDestructive?: boolean;
  loading: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

function ConfirmDialog({ title, children, confirmLabel, isDestructive = false, loading, onConfirm, onCancel }: ConfirmDialogProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="bg-card border-2 border-border rounded-sm p-6 max-w-md w-full space-y-4 shadow-xl">
        <h3 className="font-display text-lg uppercase tracking-wide text-foreground">{title}</h3>
        <div className="text-sm text-muted-foreground space-y-2">{children}</div>
        <div className="flex gap-3 pt-2">
          <Button
            variant="outline"
            size="sm"
            onClick={onConfirm}
            disabled={loading}
            className={isDestructive ? "border-destructive text-destructive hover:bg-destructive/10" : "border-primary text-primary hover:bg-primary/10"}
          >
            {loading ? "Processing..." : confirmLabel}
          </Button>
          <Button variant="outline" size="sm" onClick={onCancel} disabled={loading}>
            Go Back
          </Button>
        </div>
      </div>
    </div>
  );
}

export function SubscriptionPanel() {
  const [subData, setSubData] = useState<SubscriptionResponse | null | undefined>(undefined);
  const [history, setHistory] = useState<PaymentRecord[]>([]);
  const [plans, setPlans] = useState<PlanProduct[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [portalLoading, setPortalLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Cancel dialog state
  const [showCancelDialog, setShowCancelDialog] = useState(false);
  const [cancelLoading, setCancelLoading] = useState(false);

  // Reactivate state
  const [reactivateLoading, setReactivateLoading] = useState(false);

  // Plan switch dialog state
  const [showSwitchDialog, setShowSwitchDialog] = useState(false);
  const [switchLoading, setSwitchLoading] = useState(false);
  const [prorationPreview, setProrationPreview] = useState<ProrationPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [targetAnnualPriceId, setTargetAnnualPriceId] = useState<string | null>(null);

  const fetchSubData = useCallback(() => {
    fetch("/api/stripe/subscription", { credentials: "include" })
      .then(r => r.json())
      .then((d: SubscriptionResponse) => setSubData(d))
      .catch(() => setSubData(null));
  }, []);

  useEffect(() => {
    fetchSubData();
    fetch("/api/stripe/payment-history", { credentials: "include" })
      .then(r => r.json())
      .then((d: { history: PaymentRecord[] }) => setHistory(d.history ?? []))
      .catch(() => {});
    fetch("/api/stripe/plans", { credentials: "include" })
      .then(r => r.json())
      .then((d: { plans: PlanProduct[] }) => setPlans(d.plans ?? []))
      .catch(() => {});

    const params = new URLSearchParams(window.location.search);
    if (params.get("from_portal") === "1") {
      window.history.replaceState({}, "", window.location.pathname);
      const delays = [2000, 4000, 7000, 12000];
      const timers = delays.map((ms) => setTimeout(fetchSubData, ms));
      return () => timers.forEach(clearTimeout);
    }
  }, [fetchSubData]);

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

  async function handleCancel() {
    setCancelLoading(true);
    setError(null);
    try {
      const resp = await fetch("/api/stripe/subscription/cancel", {
        method: "POST",
        credentials: "include",
      });
      const data = (await resp.json()) as { subscription?: unknown; error?: string };
      if (data.error) {
        setError(data.error);
      } else {
        setShowCancelDialog(false);
        fetchSubData();
      }
    } catch {
      setError("Network error");
    } finally {
      setCancelLoading(false);
    }
  }

  async function handleReactivate() {
    setReactivateLoading(true);
    setError(null);
    try {
      const resp = await fetch("/api/stripe/subscription/reactivate", {
        method: "POST",
        credentials: "include",
      });
      const data = (await resp.json()) as { subscription?: unknown; error?: string };
      if (data.error) {
        setError(data.error);
      } else {
        fetchSubData();
      }
    } catch {
      setError("Network error");
    } finally {
      setReactivateLoading(false);
    }
  }

  async function openSwitchDialog() {
    setError(null);
    setProrationPreview(null);

    // Find annual price from plans
    const annualPriceId = findAnnualPriceId();
    if (!annualPriceId) {
      setError("Annual plan not available");
      return;
    }
    setTargetAnnualPriceId(annualPriceId);
    setShowSwitchDialog(true);
    setPreviewLoading(true);
    try {
      const resp = await fetch(`/api/stripe/subscription/switch-preview?targetPriceId=${encodeURIComponent(annualPriceId)}`, {
        credentials: "include",
      });
      const data = (await resp.json()) as ProrationPreview & { error?: string };
      if (data.error) {
        setError(data.error);
        setShowSwitchDialog(false);
      } else {
        setProrationPreview(data);
      }
    } catch {
      setError("Failed to load proration preview");
      setShowSwitchDialog(false);
    } finally {
      setPreviewLoading(false);
    }
  }

  async function handleSwitchPlan() {
    if (!targetAnnualPriceId) return;
    setSwitchLoading(true);
    setError(null);
    try {
      const resp = await fetch("/api/stripe/subscription/switch-plan", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetPriceId: targetAnnualPriceId }),
      });
      const data = (await resp.json()) as { subscription?: unknown; error?: string };
      if (data.error) {
        setError(data.error);
      } else {
        setShowSwitchDialog(false);
        fetchSubData();
      }
    } catch {
      setError("Network error");
    } finally {
      setSwitchLoading(false);
    }
  }

  function findAnnualPriceId(): string | null {
    const currentPriceId = sub?.items?.data?.[0]?.price?.id;

    // Find the product containing the current monthly price, then return its annual price
    if (currentPriceId) {
      for (const product of plans) {
        const hasCurrentPrice = product.prices.some(p => p.id === currentPriceId);
        if (hasCurrentPrice) {
          const annualPrice = product.prices.find(p => p.recurring?.interval === "year");
          if (annualPrice) return annualPrice.id;
        }
      }
    }

    // Fallback: if current price not found in plans (e.g., synced from webhook but not in plans list),
    // return the first annual price across all plans
    for (const product of plans) {
      for (const price of product.prices) {
        if (price.recurring?.interval === "year") return price.id;
      }
    }
    return null;
  }

  function getAnnualSavingsPercent(): number | null {
    const currentPriceId = sub?.items?.data?.[0]?.price?.id;
    let monthlyAmount: number | null = null;
    let annualAmount: number | null = null;

    // Find amounts from the same product as current subscription
    if (currentPriceId) {
      for (const product of plans) {
        const hasCurrentPrice = product.prices.some(p => p.id === currentPriceId);
        if (hasCurrentPrice) {
          monthlyAmount = product.prices.find(p => p.recurring?.interval === "month")?.unit_amount ?? null;
          annualAmount = product.prices.find(p => p.recurring?.interval === "year")?.unit_amount ?? null;
          break;
        }
      }
    }

    // Fallback to global search
    if (!monthlyAmount || !annualAmount) {
      for (const product of plans) {
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

  const sub = subData?.subscription ?? null;
  const appSub = subData?.appSubscription ?? null;
  const membershipTier = subData?.membershipTier ?? "unregistered";
  const isLifetime = subData?.isLifetime ?? false;
  const isLegendary = membershipTier === "legendary";
  // isPremium: only actual paid/lifetime members — NOT free "registered" accounts
  const isPremium = isLegendary || isLifetime;

  const periodEnd = sub?.current_period_end
    ? new Date(sub.current_period_end * 1000).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })
    : appSub?.currentPeriodEnd
    ? new Date(appSub.currentPeriodEnd).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })
    : null;

  const cancelAtPeriodEnd = sub?.cancel_at_period_end ?? appSub?.cancelAtPeriodEnd ?? false;

  const price = sub?.items?.data?.[0]?.price;
  const planLabel = isLifetime
    ? "Legendary for Life"
    : appSub?.plan === "annual" ? "Annual"
    : appSub?.plan === "monthly" ? "Monthly"
    : price?.recurring?.interval === "year" ? "Annual"
    : price?.recurring?.interval === "month" ? "Monthly"
    : "Legendary";

  // isMonthly: active recurring monthly legendary subscriber (not lifetime)
  const isMonthly = isLegendary && !isLifetime && (appSub?.plan === "monthly" || price?.recurring?.interval === "month");
  const annualPriceAvailable = findAnnualPriceId() !== null;
  const savingsPercent = getAnnualSavingsPercent();

  // Show the portal button for any paid member or anyone with payment history
  const showPortalButton = history.length > 0 || isPremium;

  // Show cancel/reactivate controls for active recurring legendary subscribers (not lifetime)
  const showSubscriptionControls = isLegendary && !isLifetime && !!sub;

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
        <div className="flex flex-col gap-4 p-4 bg-secondary/50 rounded-sm border border-border">
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
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
          {history.length > 0 && (
            <Button variant="outline" size="sm" onClick={openPortal} disabled={portalLoading} className="gap-2 self-start">
              <ExternalLink className="w-4 h-4" />
              {portalLoading ? "Opening..." : "View Charge History"}
            </Button>
          )}
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
                {isLegendary || isLifetime ? "Legendary Member" : "Member"}
                <span className={`text-xs px-2 py-0.5 rounded-sm uppercase tracking-wide ${
                  cancelAtPeriodEnd && !isLifetime
                    ? "bg-orange-500/20 text-orange-400"
                    : isLegendary
                    ? "bg-amber-500/20 text-amber-400"
                    : "bg-primary/20 text-primary"
                }`}>
                  {isLifetime ? "legendary for life" : cancelAtPeriodEnd ? "cancelling" : isLegendary ? "legendary" : sub?.status ?? "active"}
                </span>
              </p>
              <p className="text-sm text-muted-foreground">
                {planLabel} {isLifetime ? "— access never expires" : "subscription"}
              </p>
            </div>
          </div>

          {isLifetime && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Crown className="w-4 h-4 text-amber-400" />
              <span className="text-amber-400 font-medium">Legendary for Life — access never expires</span>
            </div>
          )}

          {!isLifetime && periodEnd && !cancelAtPeriodEnd && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Calendar className="w-4 h-4 text-primary" />
              <span>Renews on <strong className="text-foreground">{periodEnd}</strong></span>
            </div>
          )}

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
              <Button
                variant="outline"
                size="sm"
                onClick={handleReactivate}
                disabled={reactivateLoading}
                className="gap-2 self-start border-orange-500/40 text-orange-400 hover:bg-orange-500/10 hover:border-orange-500/60"
              >
                <RefreshCw className="w-4 h-4" />
                {reactivateLoading ? "Reactivating..." : "Reactivate Subscription"}
              </Button>
            </div>
          )}

          {price && !isLifetime && (
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

          {/* Subscription action controls — only for active recurring subscribers */}
          {showSubscriptionControls && !cancelAtPeriodEnd && (
            <div className="flex flex-col gap-3 pt-1">
              {/* Monthly-to-annual switch */}
              {isMonthly && annualPriceAvailable && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={openSwitchDialog}
                  className="gap-2 self-start border-primary/40 text-primary hover:bg-primary/10"
                >
                  <ArrowUpCircle className="w-4 h-4" />
                  Switch to Annual{savingsPercent ? ` — save ${savingsPercent}%` : ""}
                </Button>
              )}

              <Button
                variant="outline"
                size="sm"
                onClick={() => { setError(null); setShowCancelDialog(true); }}
                className="gap-2 self-start border-destructive/40 text-destructive hover:bg-destructive/10"
              >
                <XCircle className="w-4 h-4" />
                Cancel Subscription
              </Button>
            </div>
          )}

          {/* Portal link as secondary option */}
          {showPortalButton && (
            <Button variant="outline" size="sm" onClick={openPortal} disabled={portalLoading} className="gap-2">
              <ExternalLink className="w-4 h-4" />
              {portalLoading ? "Opening..." : "Manage billing & receipts"}
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

      {/* Cancel Confirmation Dialog */}
      {showCancelDialog && periodEnd && (
        <ConfirmDialog
          title="Cancel Subscription"
          confirmLabel="Yes, Cancel"
          isDestructive={true}
          loading={cancelLoading}
          onConfirm={handleCancel}
          onCancel={() => setShowCancelDialog(false)}
        >
          <p>
            Your subscription will remain active until <strong className="text-foreground">{periodEnd}</strong>.
            After that date, you will lose access to premium features.
          </p>
          <p>You can reactivate at any time before that date.</p>
        </ConfirmDialog>
      )}

      {/* Plan Switch Dialog */}
      {showSwitchDialog && (
        <ConfirmDialog
          title="Switch to Annual Billing"
          confirmLabel="Confirm Switch"
          loading={switchLoading || previewLoading}
          onConfirm={handleSwitchPlan}
          onCancel={() => { setShowSwitchDialog(false); setProrationPreview(null); }}
        >
          {previewLoading && <p className="animate-pulse">Loading proration preview...</p>}
          {prorationPreview && !previewLoading && (
            <div className="space-y-3">
              <p>You will be switched to annual billing immediately. Here is the cost breakdown:</p>
              <div className="bg-secondary/50 rounded-sm border border-border p-3 space-y-1.5">
                {prorationPreview.lines.map((line, i) => (
                  <div key={i} className="flex justify-between text-xs gap-4">
                    <span className="text-muted-foreground">{line.description ?? "Adjustment"}</span>
                    <span className={`font-medium shrink-0 ${line.amount < 0 ? "text-green-500" : "text-foreground"}`}>
                      {line.amount < 0 ? "-" : ""}{formatAmount(Math.abs(line.amount), prorationPreview.currency)}
                    </span>
                  </div>
                ))}
                <div className="flex justify-between text-sm font-bold border-t border-border/50 pt-1.5 mt-1">
                  <span>Due now</span>
                  <span className={prorationPreview.amountDue < 0 ? "text-green-500" : "text-foreground"}>
                    {prorationPreview.amountDue < 0 ? "Credit: " : ""}{formatAmount(Math.abs(prorationPreview.amountDue), prorationPreview.currency)}
                  </span>
                </div>
              </div>
            </div>
          )}
        </ConfirmDialog>
      )}
    </div>
  );
}
