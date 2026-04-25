import { useState, useEffect, useCallback } from "react";
import { AdminLayout } from "@/components/admin/AdminLayout";
import { CollapsibleSection } from "@/components/CollapsibleSection";
import { Button } from "@/components/ui/Button";
import {
  CreditCard, Zap, Star, CheckCircle, XCircle, AlertTriangle,
  ToggleLeft, ToggleRight, Loader2, RefreshCw, Send, Package,
  Users, Lock, ShieldCheck, Link, Copy, Cpu,
} from "lucide-react";

interface StripeConfig {
  publishableKey: string | null;
}

interface StripePlan {
  id: string;
  name: string;
  description: string | null;
  metadata: Record<string, string>;
  prices: Array<{
    id: string;
    unit_amount: number;
    currency: string;
    recurring: { interval: string; interval_count?: number } | null;
  }>;
}

interface StripeEnvStatus {
  secretKeyTest: boolean;
  secretKeyLive: boolean;
  publishableKeyTest: boolean;
  publishableKeyLive: boolean;
  webhookSecretTest: boolean;
  webhookSecretLive: boolean;
}

interface StripeSummary {
  activeSubscribers: number;
  registeredMembers: number;
  webhookSecretConfigured: boolean;
  priceIdsConfigured: boolean;
  webhookUrl: string | null;
  stripeEnv?: StripeEnvStatus;
}

interface AdminConfigRow {
  key: string;
  value: string;
  dataType: string;
  label: string;
}

function CheckRow({ done, label }: { done: boolean; label: string }) {
  return (
    <div className="flex items-center gap-3">
      <span className={`w-5 h-5 shrink-0 flex items-center justify-center rounded-full ${done ? "text-green-400" : "text-muted-foreground"}`}>
        {done ? <CheckCircle className="w-5 h-5" /> : <XCircle className="w-5 h-5" />}
      </span>
      <span className={done ? "text-foreground" : "text-muted-foreground"}>{label}</span>
    </div>
  );
}

export default function AdminBilling() {
  const [liveMode, setLiveMode] = useState<boolean | null>(null);
  const [toggleLoading, setToggleLoading] = useState(false);
  const [stripeConfig, setStripeConfig] = useState<StripeConfig | null>(null);
  const [configLoading, setConfigLoading] = useState(true);
  const [plans, setPlans] = useState<StripePlan[]>([]);
  const [plansLoading, setPlansLoading] = useState(true);
  const [summary, setSummary] = useState<StripeSummary | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(true);
  const [testEventUserId, setTestEventUserId] = useState("");
  const [testEventLoading, setTestEventLoading] = useState(false);
  const [testEventResult, setTestEventResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // fal.ai Active Endpoints config
  const [falEndpoints, setFalEndpoints] = useState<string>("");
  const [falEndpointsOriginal, setFalEndpointsOriginal] = useState<string>("");
  const [falEndpointsSaving, setFalEndpointsSaving] = useState(false);
  const [falEndpointsSaved, setFalEndpointsSaved] = useState(false);
  const [falEndpointsError, setFalEndpointsError] = useState<string | null>(null);

  // Pricing cache refresh interval
  const [pricingInterval, setPricingInterval] = useState<string>("");
  const [pricingIntervalOriginal, setPricingIntervalOriginal] = useState<string>("");
  const [pricingIntervalSaving, setPricingIntervalSaving] = useState(false);
  const [pricingIntervalSaved, setPricingIntervalSaved] = useState(false);
  const [pricingIntervalError, setPricingIntervalError] = useState<string | null>(null);

  const fetchAll = useCallback(async () => {
    setConfigLoading(true);
    setPlansLoading(true);
    setSummaryLoading(true);

    const [configRes, plansRes, summaryRes, adminConfigRes] = await Promise.allSettled([
      fetch("/api/stripe/config").then(r => r.json()) as Promise<StripeConfig>,
      fetch("/api/stripe/plans").then(r => r.json()) as Promise<{ plans: StripePlan[] }>,
      fetch("/api/admin/stripe/summary", { credentials: "include" }).then(r => r.json()) as Promise<StripeSummary>,
      fetch("/api/admin/config", { credentials: "include" }).then(r => r.json()) as Promise<AdminConfigRow[]>,
    ]);

    if (configRes.status === "fulfilled") {
      setStripeConfig(configRes.value);
      setConfigLoading(false);
    } else {
      setConfigLoading(false);
    }

    if (plansRes.status === "fulfilled") {
      setPlans(plansRes.value.plans ?? []);
      setPlansLoading(false);
    } else {
      setPlansLoading(false);
    }

    if (summaryRes.status === "fulfilled") {
      setSummary(summaryRes.value);
      setSummaryLoading(false);
    } else {
      setSummaryLoading(false);
    }

    if (adminConfigRes.status === "fulfilled") {
      const value = adminConfigRes.value;
      const rows = Array.isArray(value) ? (value as AdminConfigRow[]) : [];
      const liveModeRow = rows.find(r => r.key === "stripe_live_mode");
      setLiveMode(liveModeRow?.value === "true");
      const falRow = rows.find(r => r.key === "fal_active_endpoints");
      const falVal = falRow?.value ?? "";
      setFalEndpoints(falVal);
      setFalEndpointsOriginal(falVal);

      const piRow = rows.find(r => r.key === "pricing_refresh_interval_ms");
      const piVal = piRow?.value ?? "";
      setPricingInterval(piVal);
      setPricingIntervalOriginal(piVal);
    }
  }, []);

  useEffect(() => {
    void fetchAll();
  }, [fetchAll]);

  async function toggleLiveMode() {
    if (liveMode === null) return;
    const newMode = !liveMode;
    setToggleLoading(true);
    setError(null);
    try {
      const resp = await fetch("/api/admin/config/stripe_live_mode", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ value: newMode ? "true" : "false" }),
      });
      if (!resp.ok) throw new Error("Failed to update");
      setLiveMode(newMode);
      setStripeConfig(null);
      setConfigLoading(true);
      const cfgRes = await fetch("/api/stripe/config").then(r => r.json()) as StripeConfig;
      setStripeConfig(cfgRes);
      setConfigLoading(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to toggle mode");
    } finally {
      setToggleLoading(false);
    }
  }

  async function sendTestEvent() {
    if (!testEventUserId.trim()) return;
    setTestEventLoading(true);
    setTestEventResult(null);
    try {
      const resp = await fetch("/api/admin/stripe/test-event", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ userId: testEventUserId.trim() }),
      });
      const data = (await resp.json()) as { success?: boolean; message?: string; error?: string };
      setTestEventResult({ ok: data.success === true, message: data.message ?? data.error ?? "Unknown result" });
    } catch {
      setTestEventResult({ ok: false, message: "Network error" });
    } finally {
      setTestEventLoading(false);
    }
  }

  async function saveFalEndpoints() {
    if (falEndpoints === falEndpointsOriginal) return;
    // validate JSON array
    try {
      const parsed = JSON.parse(falEndpoints);
      if (!Array.isArray(parsed)) throw new Error("Must be a JSON array");
    } catch (e) {
      setFalEndpointsError(e instanceof Error ? e.message : "Invalid JSON");
      return;
    }
    setFalEndpointsSaving(true);
    setFalEndpointsError(null);
    try {
      const resp = await fetch("/api/admin/config/fal_active_endpoints", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ value: falEndpoints }),
      });
      if (!resp.ok) throw new Error("Failed to save");
      setFalEndpointsOriginal(falEndpoints);
      setFalEndpointsSaved(true);
      setTimeout(() => setFalEndpointsSaved(false), 2500);
    } catch (e) {
      setFalEndpointsError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setFalEndpointsSaving(false);
    }
  }

  async function savePricingInterval() {
    if (pricingInterval === pricingIntervalOriginal) return;
    const ms = parseInt(pricingInterval, 10);
    if (isNaN(ms) || ms < 0) {
      setPricingIntervalError("Must be a non-negative integer (milliseconds)");
      return;
    }
    setPricingIntervalSaving(true);
    setPricingIntervalError(null);
    try {
      const resp = await fetch("/api/admin/config/pricing_refresh_interval_ms", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ value: String(ms) }),
      });
      if (!resp.ok) throw new Error("Failed to save");
      setPricingIntervalOriginal(String(ms));
      setPricingIntervalSaved(true);
      setTimeout(() => setPricingIntervalSaved(false), 2500);
    } catch (e) {
      setPricingIntervalError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setPricingIntervalSaving(false);
    }
  }

  function copyWebhookUrl() {
    const url = summary?.webhookUrl;
    if (!url) return;
    void navigator.clipboard.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  const pubKey = stripeConfig?.publishableKey;
  const isConnected = !!pubKey;
  const keyPrefix = pubKey ? pubKey.slice(0, 12) + "..." : null;
  const keyIsLive = pubKey?.startsWith("pk_live_") ?? false;
  const keyIsTest = pubKey?.startsWith("pk_test_") ?? false;

  const hasProducts = plans.length > 0;
  const hasWebhookSecret = summary?.webhookSecretConfigured ?? false;
  const hasPriceIds = summary?.priceIdsConfigured ?? false;

  const allPrices = plans.flatMap(p => p.prices);
  const monthlyPrice = allPrices.find(p => p.recurring?.interval === "month");
  const annualPrice = allPrices.find(p => p.recurring?.interval === "year");
  const lifetimePrice = allPrices.find(p => !p.recurring);

  return (
    <AdminLayout title="Billing">
      <div className="space-y-6">
        {error && (
          <div className="bg-destructive/10 border border-destructive/30 text-destructive rounded-lg p-3 text-sm flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            {error}
          </div>
        )}

        {/* Mode Toggle — pinned global control, not collapsible */}
        <div className={`bg-card border rounded-lg p-5 ${liveMode ? "border-amber-500/50" : "border-border"}`}>
          <div className="flex items-center justify-between flex-wrap gap-4">
            <div className="flex items-center gap-3">
              {liveMode ? (
                <Zap className="w-5 h-5 text-amber-400" />
              ) : (
                <Zap className="w-5 h-5 text-blue-400" />
              )}
              <div>
                <p className="font-display font-bold text-foreground uppercase tracking-wide flex items-center gap-2">
                  Stripe Mode
                  <span className={`text-xs px-2 py-0.5 rounded-sm font-medium ${liveMode ? "bg-amber-500/20 text-amber-400" : "bg-blue-500/20 text-blue-400"}`}>
                    {liveMode === null ? "Loading..." : liveMode ? "LIVE" : "TEST"}
                  </span>
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {liveMode
                    ? "Live mode active — real charges will be processed"
                    : "Test mode — no real charges, use Stripe test cards"}
                </p>
              </div>
            </div>
            <Button
              variant="outline"
              size="sm"
              className={`gap-2 ${liveMode ? "border-amber-500/50 text-amber-400 hover:bg-amber-500/10" : "border-blue-500/30 text-blue-400 hover:bg-blue-500/10"}`}
              onClick={toggleLiveMode}
              disabled={toggleLoading || liveMode === null}
            >
              {toggleLoading ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : liveMode ? (
                <ToggleRight className="w-4 h-4" />
              ) : (
                <ToggleLeft className="w-4 h-4" />
              )}
              Switch to {liveMode ? "Test" : "Live"} Mode
            </Button>
          </div>
          {liveMode && (
            <div className="mt-4 bg-amber-500/10 border border-amber-500/30 rounded-sm p-3 flex items-start gap-2 text-xs text-amber-400">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <span><strong>Live mode is active.</strong> Customers using checkout will be charged with real payment methods. Make sure your products and prices are correctly configured before accepting live payments.</span>
            </div>
          )}
        </div>

        {/* Stripe Connection */}
        <CollapsibleSection
          title="Stripe Connection"
          icon={<CreditCard className="w-4 h-4 text-primary" />}
          description="Verify Stripe credentials are reachable and correctly configured."
          storageKey="admin_section_billing_connection"
        >
          <div className="flex items-center justify-between mb-2">
            <span />
            <Button variant="outline" size="sm" className="h-7 px-2 text-xs gap-1" onClick={fetchAll}>
              <RefreshCw className="w-3 h-3" />
              Refresh
            </Button>
          </div>
          {configLoading ? (
            <div className="animate-pulse h-8 bg-secondary rounded-sm" />
          ) : isConnected ? (
            <div className="flex items-center gap-3">
              <CheckCircle className="w-5 h-5 text-green-400 shrink-0" />
              <div>
                <p className="text-sm font-medium text-green-400">Connected to Stripe</p>
                {keyPrefix && (
                  <p className="text-xs text-muted-foreground font-mono mt-0.5">
                    {keyPrefix}
                    {keyIsLive && <span className="ml-2 text-amber-400">(live key)</span>}
                    {keyIsTest && <span className="ml-2 text-blue-400">(test key)</span>}
                  </p>
                )}
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="flex items-center gap-3">
                <XCircle className="w-5 h-5 text-destructive shrink-0" />
                <p className="text-sm font-medium text-destructive">Stripe not connected</p>
              </div>
              <div className="bg-muted/50 border border-border rounded-sm p-4 space-y-2 text-sm text-muted-foreground">
                <p className="font-medium text-foreground">To connect Stripe, set all six per-mode secrets in Replit Secrets:</p>
                <p>
                  Each mode reads from exactly one variable — no legacy or fallback values are accepted.
                  Once all six are set, flipping the Stripe mode toggle above is a one-click switch.
                </p>
                <ul className="list-disc list-inside ml-1 mt-1 space-y-0.5 text-xs">
                  <li>
                    <code className="bg-secondary px-1 rounded">STRIPE_SECRET_KEY_TEST</code>,{" "}
                    <code className="bg-secondary px-1 rounded">STRIPE_PUBLISHABLE_KEY_TEST</code>,{" "}
                    <code className="bg-secondary px-1 rounded">STRIPE_WEBHOOK_SECRET_TEST</code>
                  </li>
                  <li>
                    <code className="bg-secondary px-1 rounded">STRIPE_SECRET_KEY_LIVE</code>,{" "}
                    <code className="bg-secondary px-1 rounded">STRIPE_PUBLISHABLE_KEY_LIVE</code>,{" "}
                    <code className="bg-secondary px-1 rounded">STRIPE_WEBHOOK_SECRET_LIVE</code>
                  </li>
                </ul>
              </div>
            </div>
          )}
        </CollapsibleSection>

        {/* Subscriber Summary */}
        <div className="grid grid-cols-2 gap-4">
          <div className="bg-card border border-border rounded-lg p-5">
            <div className="flex items-center gap-2 mb-1">
              <Users className="w-4 h-4 text-primary" />
              <span className="text-xs text-muted-foreground uppercase tracking-wide">Active Subscribers</span>
            </div>
            {summaryLoading ? (
              <div className="animate-pulse h-8 bg-secondary rounded-sm mt-1" />
            ) : (
              <p className="text-3xl font-bold font-display text-foreground">{summary?.activeSubscribers ?? 0}</p>
            )}
          </div>
          <div className="bg-card border border-border rounded-lg p-5">
            <div className="flex items-center gap-2 mb-1">
              <Star className="w-4 h-4 text-primary" />
              <span className="text-xs text-muted-foreground uppercase tracking-wide">Registered (Free)</span>
            </div>
            {summaryLoading ? (
              <div className="animate-pulse h-8 bg-secondary rounded-sm mt-1" />
            ) : (
              <p className="text-3xl font-bold font-display text-foreground">{summary?.registeredMembers ?? 0}</p>
            )}
          </div>
        </div>

        {/* Plans */}
        <CollapsibleSection
          title="Plans from Stripe"
          icon={<Package className="w-4 h-4 text-primary" />}
          description="Membership products and prices fetched from Stripe."
          storageKey="admin_section_billing_plans"
        >
          {plansLoading ? (
            <div className="animate-pulse space-y-3">
              <div className="h-10 bg-secondary rounded-sm" />
              <div className="h-10 bg-secondary rounded-sm" />
            </div>
          ) : plans.length === 0 ? (
            <div className="text-sm text-muted-foreground flex items-center gap-2 py-2">
              <AlertTriangle className="w-4 h-4 text-amber-400" />
              No products found in Stripe. Create products with <code className="text-xs bg-secondary px-1 py-0.5 rounded">metadata.membership=true</code> in the Stripe dashboard.
            </div>
          ) : (
            <div className="space-y-4">
              {plans.map(plan => (
                <div key={plan.id} className="border border-border rounded-sm p-4">
                  <p className="font-bold text-foreground flex items-center gap-2">
                    <Star className="w-4 h-4 text-primary" />
                    {plan.name}
                    {plan.metadata?.membership === "true" && (
                      <span className="text-xs bg-green-500/20 text-green-400 px-2 py-0.5 rounded-sm">membership tagged</span>
                    )}
                  </p>
                  {plan.description && <p className="text-xs text-muted-foreground mt-1">{plan.description}</p>}
                  {plan.prices.length > 0 && (
                    <div className="mt-3 space-y-1">
                      {plan.prices.map(price => {
                        const amt = `$${(price.unit_amount / 100).toFixed(2)}`;
                        const interval = price.recurring ? `/${price.recurring.interval}` : " one-time";
                        return (
                          <div key={price.id} className="flex items-center gap-3 text-sm">
                            <span className="font-medium text-foreground">{amt}{interval}</span>
                            <span className="text-xs text-muted-foreground font-mono">{price.id}</span>
                            {!price.recurring && <span className="text-xs bg-amber-500/20 text-amber-400 px-1.5 py-0.5 rounded-sm">legendary for life</span>}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </CollapsibleSection>

        {/* Setup Checklist */}
        <CollapsibleSection
          title="Setup Checklist"
          icon={<ShieldCheck className="w-4 h-4 text-primary" />}
          description="Live status of Stripe integration requirements."
          storageKey="admin_section_billing_checklist"
        >
          <div className="space-y-3 text-sm">
            <CheckRow done={isConnected} label="Stripe credentials reachable (publishable key found)" />
            <CheckRow done={hasProducts} label="Stripe products configured in dashboard" />
            <CheckRow
              done={!!(monthlyPrice || annualPrice || lifetimePrice)}
              label="Membership prices available (monthly, annual, or legendary for life)"
            />
            <CheckRow done={hasWebhookSecret} label="Webhook signing secret available (one of the per-mode env vars below)" />
            <CheckRow done={hasPriceIds || hasProducts} label="Membership price IDs configured (env or product metadata)" />
          </div>

          {summary?.stripeEnv && (
            <div className="mt-5 pt-5 border-t border-border space-y-3">
              <p className="text-xs uppercase tracking-wide text-muted-foreground font-medium">
                Per-mode environment variables
              </p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-2 text-sm">
                <CheckRow done={summary.stripeEnv.secretKeyTest} label="STRIPE_SECRET_KEY_TEST" />
                <CheckRow done={summary.stripeEnv.secretKeyLive} label="STRIPE_SECRET_KEY_LIVE" />
                <CheckRow done={summary.stripeEnv.publishableKeyTest} label="STRIPE_PUBLISHABLE_KEY_TEST" />
                <CheckRow done={summary.stripeEnv.publishableKeyLive} label="STRIPE_PUBLISHABLE_KEY_LIVE" />
                <CheckRow done={summary.stripeEnv.webhookSecretTest} label="STRIPE_WEBHOOK_SECRET_TEST" />
                <CheckRow done={summary.stripeEnv.webhookSecretLive} label="STRIPE_WEBHOOK_SECRET_LIVE" />
              </div>
            </div>
          )}
        </CollapsibleSection>

        {/* Webhook Endpoint URL */}
        <CollapsibleSection
          title="Webhook Endpoint URL"
          icon={<Link className="w-4 h-4 text-primary" />}
          description="The URL to register in Stripe's dashboard so it can deliver events to this app."
          storageKey="admin_section_billing_webhook_url"
        >
          {summaryLoading ? (
            <div className="animate-pulse h-10 bg-secondary rounded-sm" />
          ) : summary?.webhookUrl ? (
            <div className="space-y-4">
              <div className="flex items-center gap-2 flex-wrap">
                <code className="flex-1 min-w-0 text-xs font-mono bg-secondary border border-border rounded-sm px-3 py-2 text-foreground break-all">
                  {summary.webhookUrl}
                </code>
                <Button
                  variant="outline"
                  size="sm"
                  className="shrink-0 gap-2"
                  onClick={copyWebhookUrl}
                >
                  {copied ? <CheckCircle className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4" />}
                  {copied ? "Copied!" : "Copy"}
                </Button>
              </div>
              <div className="bg-amber-500/10 border border-amber-500/30 rounded-sm p-3 text-xs text-amber-400 space-y-1.5">
                <p className="font-semibold flex items-center gap-1.5">
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                  Action required: update your Stripe dashboard
                </p>
                <ol className="list-decimal list-inside space-y-1 ml-1">
                  <li>Go to <strong>Stripe Dashboard → Developers → Webhooks</strong></li>
                  <li>Find your existing webhook endpoint (or click <strong>Add endpoint</strong>)</li>
                  <li>Set the endpoint URL to the value above</li>
                  <li>Ensure the following events are selected: <code className="bg-black/20 px-1 rounded">checkout.session.completed</code>, <code className="bg-black/20 px-1 rounded">customer.subscription.*</code>, <code className="bg-black/20 px-1 rounded">invoice.paid</code>, <code className="bg-black/20 px-1 rounded">invoice.payment_failed</code>, <code className="bg-black/20 px-1 rounded">payment_intent.succeeded</code></li>
                  <li>
                    Copy the <strong>Signing secret</strong> and save it as the matching per-mode env var:{" "}
                    <code className="bg-black/20 px-1 rounded">STRIPE_WEBHOOK_SECRET_TEST</code> for test-mode endpoints,{" "}
                    <code className="bg-black/20 px-1 rounded">STRIPE_WEBHOOK_SECRET_LIVE</code> for live-mode endpoints. Repeat for the other mode so flipping the live-mode toggle stays one-click.
                  </li>
                </ol>
              </div>
            </div>
          ) : (
            <div className="text-sm text-muted-foreground flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
              Could not determine the canonical site URL, so we can't display the webhook URL here. The webhook is still wired up correctly in the running server.
            </div>
          )}
        </CollapsibleSection>

        {/* Test Event (test mode only) */}
        {liveMode === false && (
          <CollapsibleSection
            title="Send Test Webhook Event"
            icon={<Send className="w-4 h-4 text-blue-400" />}
            description="Simulate a checkout.session.completed event without a real Stripe checkout."
            storageKey="admin_section_billing_test_event"
          >
            <div className="flex items-center gap-2 mb-2">
              <span className="text-xs bg-blue-500/20 text-blue-400 px-2 py-0.5 rounded-sm">TEST MODE ONLY</span>
            </div>
            <p className="text-xs text-muted-foreground">
              Simulates a <code className="bg-secondary px-1 rounded">checkout.session.completed</code> event for a user to test the full webhook domain handler without a real Stripe checkout.
            </p>
            <div className="flex items-center gap-3 flex-wrap">
              <input
                type="text"
                value={testEventUserId}
                onChange={e => setTestEventUserId(e.target.value)}
                placeholder="User ID"
                className="flex-1 min-w-48 h-9 px-3 rounded-sm bg-secondary border border-border text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary"
              />
              <Button
                size="sm"
                onClick={sendTestEvent}
                disabled={testEventLoading || !testEventUserId.trim()}
                className="gap-2"
              >
                {testEventLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                Send
              </Button>
            </div>
            {testEventResult && (
              <div className={`text-xs p-3 rounded-sm border flex items-start gap-2 ${testEventResult.ok ? "bg-green-500/10 border-green-500/30 text-green-400" : "bg-destructive/10 border-destructive/30 text-destructive"}`}>
                {testEventResult.ok ? <CheckCircle className="w-4 h-4 shrink-0" /> : <XCircle className="w-4 h-4 shrink-0" />}
                {testEventResult.message}
              </div>
            )}
          </CollapsibleSection>
        )}

        {/* fal.ai Active Endpoints */}
        <CollapsibleSection
          title="fal.ai Active Endpoint IDs"
          icon={<Cpu className="w-4 h-4 text-primary" />}
          description="JSON array of fal.ai endpoint IDs whose pricing is pre-cached at startup and refreshed hourly."
          storageKey="admin_section_billing_fal_endpoints"
        >
          <p className="text-xs text-muted-foreground mb-3">
            Enter a valid JSON array of endpoint ID strings, e.g.{" "}
            <code className="bg-secondary px-1 rounded">["fal-ai/flux-pro/v1.1", "fal-ai/kling-video/v2.1/pro/image-to-video"]</code>
          </p>
          <textarea
            value={falEndpoints}
            onChange={e => { setFalEndpoints(e.target.value); setFalEndpointsError(null); setFalEndpointsSaved(false); }}
            rows={6}
            spellCheck={false}
            className="w-full bg-background border border-border rounded px-3 py-2 text-xs font-mono text-foreground focus:outline-none focus:ring-1 focus:ring-primary resize-y"
          />
          {falEndpointsError && (
            <p className="text-xs text-destructive flex items-center gap-1.5 mt-1">
              <XCircle className="w-3.5 h-3.5 shrink-0" />{falEndpointsError}
            </p>
          )}
          <div className="flex items-center gap-3 mt-2">
            <button
              onClick={() => void saveFalEndpoints()}
              disabled={falEndpointsSaving || falEndpoints === falEndpointsOriginal}
              className="px-3 py-1.5 rounded text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex items-center gap-1.5"
            >
              {falEndpointsSaving ? (
                <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Saving…</>
              ) : falEndpointsSaved ? (
                <><CheckCircle className="w-3.5 h-3.5" /> Saved</>
              ) : (
                "Save"
              )}
            </button>
            {falEndpoints !== falEndpointsOriginal && (
              <button
                onClick={() => { setFalEndpoints(falEndpointsOriginal); setFalEndpointsError(null); }}
                className="text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                Discard changes
              </button>
            )}
          </div>

          <div className="border-t border-border mt-5 pt-5">
            <p className="text-sm font-medium text-foreground mb-0.5">Pricing Cache Refresh Interval (ms)</p>
            <p className="text-xs text-muted-foreground mb-3">
              How often to re-fetch fal.ai pricing from the API. Default: 3600000 (1 hour).
            </p>
            <div className="flex items-center gap-3 flex-wrap">
              <input
                type="number"
                min={0}
                step={1000}
                value={pricingInterval}
                onChange={e => { setPricingInterval(e.target.value); setPricingIntervalError(null); setPricingIntervalSaved(false); }}
                className="w-48 bg-background border border-border rounded px-3 py-1.5 text-sm font-mono text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
              />
              <button
                onClick={() => void savePricingInterval()}
                disabled={pricingIntervalSaving || pricingInterval === pricingIntervalOriginal}
                className="px-3 py-1.5 rounded text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex items-center gap-1.5"
              >
                {pricingIntervalSaving ? (
                  <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Saving…</>
                ) : pricingIntervalSaved ? (
                  <><CheckCircle className="w-3.5 h-3.5" /> Saved</>
                ) : (
                  "Save"
                )}
              </button>
              {pricingInterval !== pricingIntervalOriginal && (
                <button
                  onClick={() => { setPricingInterval(pricingIntervalOriginal); setPricingIntervalError(null); }}
                  className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  Discard
                </button>
              )}
            </div>
            {pricingIntervalError && (
              <p className="text-xs text-destructive flex items-center gap-1.5 mt-1.5">
                <XCircle className="w-3.5 h-3.5 shrink-0" />{pricingIntervalError}
              </p>
            )}
          </div>
        </CollapsibleSection>

        {/* Price Reference */}
        {(monthlyPrice || annualPrice || lifetimePrice) && (
          <CollapsibleSection
            title="Active Price Mapping"
            icon={<Lock className="w-4 h-4 text-primary" />}
            description="Currently resolved monthly, annual, and legendary for life price IDs."
            storageKey="admin_section_billing_price_mapping"
          >
            <div className="space-y-2 text-sm">
              {monthlyPrice && (
                <div className="flex items-center justify-between gap-4">
                  <span className="text-muted-foreground">Monthly</span>
                  <span className="font-mono text-xs text-foreground">{monthlyPrice.id}</span>
                  <span className="font-bold text-foreground">${(monthlyPrice.unit_amount / 100).toFixed(2)}/mo</span>
                </div>
              )}
              {annualPrice && (
                <div className="flex items-center justify-between gap-4">
                  <span className="text-muted-foreground">Annual</span>
                  <span className="font-mono text-xs text-foreground">{annualPrice.id}</span>
                  <span className="font-bold text-foreground">${(annualPrice.unit_amount / 100).toFixed(2)}/yr</span>
                </div>
              )}
              {lifetimePrice && (
                <div className="flex items-center justify-between gap-4">
                  <span className="text-muted-foreground">Legendary for Life</span>
                  <span className="font-mono text-xs text-foreground">{lifetimePrice.id}</span>
                  <span className="font-bold text-foreground">${(lifetimePrice.unit_amount / 100).toFixed(2)} once</span>
                </div>
              )}
            </div>
          </CollapsibleSection>
        )}
      </div>
    </AdminLayout>
  );
}
