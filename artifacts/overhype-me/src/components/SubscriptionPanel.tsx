import { useState, useEffect, useCallback } from "react";
import { Link, useLocation } from "wouter";
import { Button } from "@/components/ui/Button";
import { SubscriptionInfo } from "@/components/SubscriptionInfo";
import { formatAmount } from "@/components/subscriptionHelpers";
import { Star, CreditCard, Zap, ExternalLink, AlertCircle, RefreshCw, ArrowUpCircle, XCircle, CheckCircle2 } from "lucide-react";

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

export function SubscriptionPanel({ refetchTrigger }: { refetchTrigger?: unknown } = {}) {
  const [currentPath, setLocation] = useLocation();
  const [subData, setSubData] = useState<SubscriptionResponse | null | undefined>(undefined);
  const [history, setHistory] = useState<PaymentRecord[]>([]);
  const [plans, setPlans] = useState<PlanProduct[]>([]);
  const [portalLoading, setPortalLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Cancel dialog state
  const [showCancelDialog, setShowCancelDialog] = useState(false);
  const [cancelLoading, setCancelLoading] = useState(false);
  const [cancelSuccessMessage, setCancelSuccessMessage] = useState<string | null>(null);

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
      setLocation(currentPath, { replace: true });
      const delays = [2000, 4000, 7000, 12000];
      const timers = delays.map((ms) => setTimeout(fetchSubData, ms));
      return () => timers.forEach(clearTimeout);
    }
    return;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchSubData]);

  // When the parent confirms a checkout (e.g. Legendary for Life), refetch everything.
  useEffect(() => {
    if (!refetchTrigger) return;
    fetchSubData();
    fetch("/api/stripe/payment-history", { credentials: "include" })
      .then(r => r.json())
      .then((d: { history: PaymentRecord[] }) => setHistory(d.history ?? []))
      .catch(() => {});
  }, [refetchTrigger, fetchSubData]);

  async function openPortal() {
    setPortalLoading(true);
    setError(null);
    try {
      const resp = await fetch("/api/stripe/portal", {
        method: "POST",
        credentials: "include",
      });
      const data = (await resp.json()) as { url?: string; error?: string };
      if (data.url) window.open(data.url, "_blank", "noopener,noreferrer");
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
        // Optimistically flip cancelAtPeriodEnd so the button hides immediately
        // without waiting for the Stripe webhook to update the sync table.
        setSubData(prev => {
          if (!prev) return prev;
          return {
            ...prev,
            subscription: prev.subscription ? { ...prev.subscription, cancel_at_period_end: true } : prev.subscription,
            appSubscription: prev.appSubscription ? { ...prev.appSubscription, cancelAtPeriodEnd: true } : prev.appSubscription,
          };
        });
        setShowCancelDialog(false);
        setCancelSuccessMessage("Your subscription has been cancelled. You'll keep access until the end of the billing period.");
        // Background refetch to sync full server state
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
    setCancelSuccessMessage(null);
    try {
      const resp = await fetch("/api/stripe/subscription/reactivate", {
        method: "POST",
        credentials: "include",
      });
      const data = (await resp.json()) as { subscription?: unknown; error?: string };
      if (data.error) {
        setError(data.error);
      } else {
        // Optimistically flip cancelAtPeriodEnd back to false so the reactivate
        // button disappears immediately without waiting for the Stripe webhook.
        setSubData(prev => {
          if (!prev) return prev;
          return {
            ...prev,
            subscription: prev.subscription ? { ...prev.subscription, cancel_at_period_end: false } : prev.subscription,
            appSubscription: prev.appSubscription ? { ...prev.appSubscription, cancelAtPeriodEnd: false } : prev.appSubscription,
          };
        });
        setCancelSuccessMessage("Your subscription has been reactivated and will renew as normal.");
        // Background refetch to sync full server state
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
        // Delayed refetches to catch webhook-driven DB updates
        const delays = [2000, 5000, 10000];
        delays.forEach((ms) => setTimeout(fetchSubData, ms));
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

  // Prefer the app DB (appSub.cancelAtPeriodEnd) over the Stripe sync table
  // (sub.cancel_at_period_end) because the app DB is updated synchronously by
  // our cancel/reactivate endpoints, while the sync table lags until the webhook
  // arrives. Using || was wrong: after reactivate, sync table still has true while
  // app DB has false — true || false = true kept the UI stuck in "cancelling".
  const cancelAtPeriodEnd = appSub != null
    ? appSub.cancelAtPeriodEnd
    : !!(sub?.cancel_at_period_end);

  const price = sub?.items?.data?.[0]?.price;
  const planLabel = isLifetime
    ? "Legendary for Life"
    : price?.recurring?.interval === "year" ? "Annual"
    : price?.recurring?.interval === "month" ? "Monthly"
    : appSub?.plan === "annual" ? "Annual"
    : appSub?.plan === "monthly" ? "Monthly"
    : "Legendary";

  // isMonthly: active recurring monthly legendary subscriber (not lifetime).
  // Live Stripe price data takes precedence over the DB-cached plan to avoid
  // showing "Switch to Annual" immediately after an upgrade (before webhook fires).
  const isMonthly = isLegendary && !isLifetime && (
    price?.recurring?.interval === "month" ||
    (!price?.recurring && appSub?.plan === "monthly")
  );
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
          <SubscriptionInfo
            variant="full"
            hideHistory
            data={{
              isLifetime,
              cancelAtPeriodEnd,
              periodEnd,
              status: sub?.status ?? appSub?.status ?? (isLegendary ? "active" : null),
              plan: planLabel,
              history,
            }}
            reactivateButton={
              !isLifetime && cancelAtPeriodEnd && periodEnd ? (
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
              ) : undefined
            }
          />

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

          {cancelSuccessMessage && (
            <div className="flex items-center gap-2 text-sm text-green-400 bg-green-500/10 border border-green-500/30 rounded-sm p-3">
              <CheckCircle2 className="w-4 h-4 shrink-0" />
              {cancelSuccessMessage}
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
                onClick={() => { setError(null); setCancelSuccessMessage(null); setShowCancelDialog(true); }}
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

          {/* Payment history — rendered last, matching original placement */}
          {history.length > 0 && (
            <SubscriptionInfo
              variant="full"
              data={{
                isLifetime: false,
                cancelAtPeriodEnd: false,
                periodEnd: null,
                status: null,
                plan: null,
                history,
              }}
            />
          )}
        </div>
      )}

      {/* Payment history for non-premium users — always shown when available */}
      {subData !== undefined && !isPremium && history.length > 0 && (
        <SubscriptionInfo
          variant="full"
          data={{
            isLifetime: false,
            cancelAtPeriodEnd: false,
            periodEnd: null,
            status: null,
            plan: null,
            history,
          }}
        />
      )}

      {/* Cancel Confirmation Dialog */}
      {showCancelDialog && (
        <ConfirmDialog
          title="Cancel Subscription"
          confirmLabel="Yes, Cancel"
          isDestructive={true}
          loading={cancelLoading}
          onConfirm={handleCancel}
          onCancel={() => setShowCancelDialog(false)}
        >
          {periodEnd ? (
            <>
              <p>
                Your subscription will remain active until <strong className="text-foreground">{periodEnd}</strong>.
                After that date, you will lose access to premium features.
              </p>
              <p>You can reactivate at any time before that date.</p>
            </>
          ) : (
            <>
              <p>
                Your subscription will be cancelled at the end of the current billing period.
                You will lose access to premium features after that date.
              </p>
              <p>You can reactivate at any time before the period ends.</p>
            </>
          )}
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
