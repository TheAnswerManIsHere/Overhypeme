import { useState, useEffect } from "react";
import { Link, useLocation } from "wouter";
import { useAuth } from "@workspace/replit-auth-web";
import { Layout } from "@/components/layout/Layout";
import { Button } from "@/components/ui/Button";
import { Zap, Star, Check, Lock, ThumbsUp, Send, MessageSquare, Image, Share2, ShoppingBag, ShieldOff, Sparkles, Clapperboard, UserCircle, Crown, CalendarDays } from "lucide-react";

// Pricing framing: "cost-as-gate"
//   Free  = anything that doesn't cost us money to run for you
//   Legendary = the AI work that costs real money per generation (image + video memes of YOU)
const FREE_FEATURES = [
  { icon: <Check className="w-4 h-4" />,         text: "Browse all Facts" },
  { icon: <ThumbsUp className="w-4 h-4" />,      text: "Vote on Facts" },
  { icon: <Send className="w-4 h-4" />,          text: "Submit Facts (with CAPTCHA)" },
  { icon: <MessageSquare className="w-4 h-4" />, text: "Leave Comments (with CAPTCHA)" },
  { icon: <UserCircle className="w-4 h-4" />,    text: "Profile Photo (your face, reused everywhere)" },
  { icon: <Image className="w-4 h-4" />,         text: "Photo Memes of You (your face on meme templates)" },
  { icon: <Share2 className="w-4 h-4" />,        text: "Share Memes" },
  { icon: <ShoppingBag className="w-4 h-4" />,   text: "Purchase Meme Merch" },
];

const LEGENDARY_FEATURES = [
  { icon: <Check className="w-4 h-4" />,        text: "Everything in Free" },
  { icon: <Sparkles className="w-4 h-4" />,     text: "AI Memes of You in impossible scenarios" },
  { icon: <Clapperboard className="w-4 h-4" />, text: "AI Video Memes of You" },
  { icon: <ShieldOff className="w-4 h-4" />,    text: "No CAPTCHAs" },
  { icon: <CalendarDays className="w-4 h-4" />, text: "Fact of the Day email" },
];

interface StripePlan {
  id: string;
  name: string;
  description: string | null;
  metadata: Record<string, string>;
  prices: Array<{
    id: string;
    unit_amount: number;
    currency: string;
    recurring: { interval: string; interval_count: number } | null;
  }>;
}

/** Classify a plan by its product name */
function classifyPlan(plan: StripePlan): "monthly" | "annual" | "lifetime" | "other" {
  const n = plan.name.toLowerCase();
  if (n.includes("legendary for life") || n.includes("lifetime") || n.includes("one-time") || n.includes("forever")) return "lifetime";
  if (n.includes("annual") || n.includes("year") || n.includes("yearly")) return "annual";
  if (n.includes("month")) return "monthly";
  // Fall back to Stripe interval on the first price
  const interval = plan.prices[0]?.recurring?.interval;
  if (!interval) return "lifetime";
  if (interval === "year") return "annual";
  return "monthly";
}

interface PricingCardProps {
  label: string;
  sublabel?: string;
  price: string;
  period: string;
  savingsBadge?: string;
  priceId?: string;
  featured?: boolean;
  loading: boolean;
  onSelect: (priceId: string) => void;
}

function PricingCard({
  label, sublabel, price, period, savingsBadge, priceId, featured, loading, onSelect,
}: PricingCardProps) {
  return (
    <div className={`relative flex flex-col items-center gap-4 rounded-sm border-2 p-6 ${featured ? "border-primary shadow-[0_0_24px_rgba(249,115,22,0.22)]" : "border-border"} bg-card`}>
      {savingsBadge && (
        <div className="absolute -top-3 left-1/2 -translate-x-1/2 bg-primary text-white text-xs font-bold px-4 py-1 rounded-sm uppercase tracking-widest whitespace-nowrap">
          {savingsBadge}
        </div>
      )}
      <p className="text-xs font-display uppercase tracking-widest text-muted-foreground">{label}</p>
      {sublabel && <p className="text-[11px] text-muted-foreground/70 -mt-3">{sublabel}</p>}
      <div className="text-center">
        <span className="text-4xl font-display font-bold text-foreground">{price}</span>
        <span className="text-muted-foreground text-sm ml-1">/{period}</span>
      </div>
      <Button
        className="w-full"
        disabled={!priceId || loading}
        onClick={() => priceId && onSelect(priceId)}
      >
        {loading ? "Loading…" : "Upgrade Now"}
      </Button>
    </div>
  );
}

export default function Pricing() {
  const [, setLocation] = useLocation();
  const { isAuthenticated } = useAuth();
  const [loadingPriceId, setLoadingPriceId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [plans, setPlans] = useState<StripePlan[]>([]);
  const [plansLoading, setPlansLoading] = useState(true);
  const [checkoutRequestIds, setCheckoutRequestIds] = useState<Record<string, string>>({});

  useEffect(() => {
    fetch("/api/stripe/plans")
      .then(r => r.json())
      .then((d: { plans: StripePlan[] }) => {
        setPlans(d.plans ?? []);
        setPlansLoading(false);
      })
      .catch(() => setPlansLoading(false));
  }, []);

  async function handleSelect(priceId: string) {
    if (!isAuthenticated) { setLocation("/login"); return; }
    setLoadingPriceId(priceId);
    setError(null);
    try {
      const clientRequestId = checkoutRequestIds[priceId] ?? crypto.randomUUID();
      if (!checkoutRequestIds[priceId]) {
        setCheckoutRequestIds((prev) => ({ ...prev, [priceId]: clientRequestId }));
      }
      const resp = await fetch("/api/stripe/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ priceId, clientRequestId }),
      });
      const data = (await resp.json()) as { url?: string; error?: string };
      if (data.url) {
        window.location.href = data.url;
      } else {
        setError(data.error ?? "Something went wrong");
      }
    } catch {
      setError("Network error — please try again");
    } finally {
      setLoadingPriceId(null);
    }
  }

  // Classify plans from Stripe
  const monthlyPlan = plans.find(p => classifyPlan(p) === "monthly");
  const annualPlan  = plans.find(p => classifyPlan(p) === "annual");
  const lifetimePlan = plans.find(p => classifyPlan(p) === "lifetime");

  const monthlyPrice = monthlyPlan?.prices[0];
  const annualPrice  = annualPlan?.prices[0];
  const lifetimePrice = lifetimePlan?.prices[0];

  // Effective monthly cost for savings badge
  const monthlyPerMonth = monthlyPrice ? monthlyPrice.unit_amount / 100 : null;
  // Annual is billed yearly — treat unit_amount as the annual total
  const annualPerYear = annualPrice ? annualPrice.unit_amount / 100 : null;
  const annualPerMonth = annualPerYear !== null ? annualPerYear / 12 : null;

  const savingsPct =
    monthlyPerMonth && annualPerMonth
      ? Math.round((1 - annualPerMonth / monthlyPerMonth) * 100)
      : null;

  function fmt(cents: number) {
    return `$${(cents / 100).toFixed(2)}`;
  }

  return (
    <Layout>

      {/* ── DESKTOP: Two-column upsell layout ──────────────────────── */}
      <div className="hidden md:grid" style={{ gridTemplateColumns: "1fr 1fr", minHeight: "calc(100vh - 64px)" }}>
        {/* Left: pitch + AI vibes */}
        <div className="bg-background border-r border-border flex flex-col justify-center px-16 py-20">
          <div className="flex items-center gap-2 mb-4">
            <Crown className="w-5 h-5 text-primary" />
            <span className="text-[11px] font-bold tracking-[0.2em] text-primary uppercase font-display">Legendary</span>
          </div>
          <h1 className="font-display font-bold text-[54px] uppercase tracking-tight leading-[0.95] mb-4">
            See yourself as the<br /><span className="text-primary">actual subject.</span>
          </h1>
          <p className="text-[15px] text-muted-foreground mb-4 leading-relaxed max-w-sm">
            AI generates a scene where you literally star in the fact. Not just your name — you, dramatized.
          </p>
          <p className="text-[12px] text-muted-foreground/80 mb-10 leading-relaxed max-w-sm italic">
            Free covers everything that doesn't cost us money. Legendary covers the AI image &amp; video generations of you — that part has a real per-render cost.
          </p>

          {/* AI vibe cards */}
          <div className="grid grid-cols-3 gap-3">
            {[
              { label: "Cosmic", emoji: "🌌", sub: "Universal scale" },
              { label: "Galactic", emoji: "⚡", sub: "Epic energy" },
              { label: "Mythic", emoji: "👑", sub: "Legendary status" },
            ].map(v => (
              <div key={v.label} className="rounded-[16px] bg-card border border-border p-4 text-center shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]">
                <div className="text-2xl mb-2">{v.emoji}</div>
                <div className="font-display font-bold text-[12px] uppercase tracking-[0.1em] text-foreground">{v.label}</div>
                <div className="text-[10px] text-muted-foreground mt-0.5">{v.sub}</div>
              </div>
            ))}
          </div>

          <p className="text-[12px] text-muted-foreground mt-8 flex items-center gap-2">
            <Lock className="w-3.5 h-3.5" />
            Billed securely via Stripe · Cancel anytime
          </p>
        </div>

        {/* Right: plan picker */}
        <div className="bg-card flex flex-col justify-center px-16 py-20">
          <div className="text-[12px] font-bold tracking-[0.22em] text-primary uppercase font-display mb-2">Choose your plan</div>
          <h2 className="font-display font-bold text-[32px] uppercase tracking-tight leading-tight mb-8">Turn it up to 11.</h2>

          {error && (
            <div className="bg-destructive/20 border border-destructive/40 text-destructive rounded-[12px] p-3 mb-4 text-sm text-center">
              {error}
            </div>
          )}

          {plansLoading ? (
            <div className="space-y-3">
              {[1, 2].map(i => <div key={i} className="h-20 rounded-[16px] bg-secondary animate-pulse" />)}
            </div>
          ) : (
            <div className="space-y-3 mb-6">
              {monthlyPlan && monthlyPrice && (
                <button
                  onClick={() => handleSelect(monthlyPrice.id)}
                  disabled={loadingPriceId === monthlyPrice.id}
                  className="w-full flex items-center justify-between p-5 rounded-[16px] bg-background border border-border hover:border-primary/60 transition-colors text-left disabled:opacity-50"
                >
                  <div>
                    <div className="font-display font-bold text-[15px] uppercase tracking-tight">Monthly</div>
                    <div className="text-[12px] text-muted-foreground mt-0.5">Cancel any time</div>
                  </div>
                  <div className="text-right">
                    <div className="font-display font-bold text-[20px]">{fmt(monthlyPrice.unit_amount)}</div>
                    <div className="text-[11px] text-muted-foreground">/month</div>
                  </div>
                </button>
              )}
              {lifetimePlan && lifetimePrice && (
                <button
                  onClick={() => handleSelect(lifetimePrice.id)}
                  disabled={loadingPriceId === lifetimePrice.id}
                  className="w-full flex items-center justify-between p-5 rounded-[16px] bg-primary text-white shadow-[0_8px_24px_rgba(249,115,22,0.35)] hover:bg-primary/90 transition-colors text-left disabled:opacity-50"
                >
                  <div>
                    <div className="font-display font-bold text-[15px] uppercase tracking-tight">Forever</div>
                    <div className="text-[12px] opacity-85 mt-0.5">Pay once · access forever</div>
                  </div>
                  <div className="text-right">
                    <div className="font-display font-bold text-[20px]">{fmt(lifetimePrice.unit_amount)}</div>
                    <div className="text-[11px] opacity-85">one-time</div>
                  </div>
                </button>
              )}
              {annualPlan && annualPrice && (
                <button
                  onClick={() => handleSelect(annualPrice.id)}
                  disabled={loadingPriceId === annualPrice.id}
                  className="w-full flex items-center justify-between p-5 rounded-[16px] bg-background border border-border hover:border-primary/60 transition-colors text-left disabled:opacity-50"
                >
                  <div>
                    <div className="font-display font-bold text-[15px] uppercase tracking-tight flex items-center gap-2">
                      Annual
                      {savingsPct && savingsPct > 0 && (
                        <span className="text-[10px] bg-primary text-white px-2 py-0.5 rounded-full font-bold">Save {savingsPct}%</span>
                      )}
                    </div>
                    <div className="text-[12px] text-muted-foreground mt-0.5">
                      {annualPerMonth !== null ? `$${annualPerMonth.toFixed(2)}/mo` : ""} · billed yearly
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="font-display font-bold text-[20px]">{fmt(annualPrice.unit_amount)}</div>
                    <div className="text-[11px] text-muted-foreground">/year</div>
                  </div>
                </button>
              )}
              {!monthlyPlan && !annualPlan && !lifetimePlan && (
                <p className="text-center text-muted-foreground py-8">No plans available right now.</p>
              )}
            </div>
          )}

          <ul className="space-y-2.5 mb-8">
            {LEGENDARY_FEATURES.map(f => (
              <li key={f.text} className="flex items-center gap-2.5 text-[13px] text-muted-foreground">
                <span className="text-primary flex-shrink-0">{f.icon}</span>
                {f.text}
              </li>
            ))}
          </ul>

          <p className="text-[11px] text-muted-foreground text-center">
            Already a member?{" "}
            <Link href="/profile" className="underline underline-offset-2 hover:text-foreground transition-colors">View subscription</Link>
          </p>
        </div>
      </div>

      {/* ── MOBILE: Stacked layout — tuned to fit one thumb-reachable scroll.
            pb-24 reserves room for the sticky upgrade CTA pinned to the
            bottom of the viewport so the primary action is always reachable. */}
      <div className="md:hidden max-w-5xl mx-auto px-4 py-6 pb-24">

        {/* Hero */}
        <div className="text-center mb-5">
          <div className="flex items-center justify-center gap-2 mb-2">
            <Zap className="w-6 h-6 text-primary" />
            <h1 className="text-2xl font-display uppercase tracking-widest text-foreground">Go Legendary</h1>
          </div>
          <p className="text-sm text-muted-foreground max-w-xl mx-auto leading-snug">
            AI memes &amp; AI video memes <span className="text-foreground font-semibold">of you</span>.
          </p>
          <p className="text-[11px] text-muted-foreground/80 max-w-xs mx-auto mt-2 italic leading-snug">
            Free covers everything that doesn't cost us money. Legendary covers the AI generations of you.
          </p>
        </div>

        {/* Tier comparison — compact */}
        <div className="grid grid-cols-1 gap-3 mb-5">
          {/* Free */}
          <div className="bg-card border-2 border-border rounded-sm p-4">
            <div className="flex items-center gap-2 mb-3">
              <div className="w-8 h-8 rounded-sm bg-secondary flex items-center justify-center">
                <Lock className="w-4 h-4 text-muted-foreground" />
              </div>
              <div>
                <h2 className="text-base font-display uppercase tracking-wide text-foreground leading-tight">Free</h2>
                <p className="text-base font-bold text-foreground leading-none">$0<span className="text-xs text-muted-foreground font-normal">/forever</span></p>
              </div>
            </div>
            <ul className="space-y-1.5">
              {FREE_FEATURES.map(f => (
                <li key={f.text} className="flex items-center gap-2 text-muted-foreground text-xs">
                  <span className="text-primary shrink-0">{f.icon}</span>
                  {f.text}
                </li>
              ))}
            </ul>
          </div>

          {/* Legendary */}
          <div className="bg-card border-2 border-primary rounded-sm p-4 shadow-[0_0_30px_rgba(249,115,22,0.15)] relative overflow-hidden">
            <div className="absolute top-0 right-0 w-20 h-20 bg-primary/10 rounded-bl-full -mr-10 -mt-10 pointer-events-none" />
            <div className="flex items-center gap-2 mb-3">
              <div className="w-8 h-8 rounded-sm bg-primary/20 flex items-center justify-center">
                <Star className="w-4 h-4 text-primary" />
              </div>
              <div>
                <h2 className="text-base font-display uppercase tracking-wide text-primary leading-tight">Legendary</h2>
                <p className="text-base font-bold text-foreground leading-none">
                  {monthlyPrice
                    ? fmt(monthlyPrice.unit_amount)
                    : annualPerMonth !== null
                      ? `$${annualPerMonth.toFixed(2)}`
                      : "$3.99"}
                  <span className="text-xs text-muted-foreground font-normal">/month</span>
                </p>
              </div>
            </div>
            <ul className="space-y-1.5">
              {LEGENDARY_FEATURES.map(f => (
                <li key={f.text} className="flex items-center gap-2 text-foreground text-xs">
                  <span className="text-primary shrink-0">{f.icon}</span>
                  {f.text}
                </li>
              ))}
            </ul>
          </div>
        </div>

        {/* Plan picker */}
        <h3 className="text-sm font-display uppercase tracking-widest text-center mb-3 text-foreground">Choose Your Plan</h3>

        {error && (
          <div className="bg-destructive/20 border border-destructive/40 text-destructive rounded-sm p-2 mb-3 text-center text-xs">
            {error}
          </div>
        )}

        {plansLoading ? (
          <div className="text-center text-muted-foreground py-6 text-sm">Loading plans…</div>
        ) : (
          <div className={`grid gap-2 mb-4 ${[monthlyPlan, annualPlan, lifetimePlan].filter(Boolean).length === 1 ? "max-w-xs mx-auto" : [monthlyPlan, annualPlan, lifetimePlan].filter(Boolean).length === 2 ? "grid-cols-1 md:grid-cols-2 max-w-2xl mx-auto" : "grid-cols-1 md:grid-cols-3"}`}>
            {monthlyPlan && monthlyPrice && (
              <PricingCard
                label="Monthly"
                price={fmt(monthlyPrice.unit_amount)}
                period="month"
                priceId={monthlyPrice.id}
                loading={loadingPriceId === monthlyPrice.id}
                onSelect={handleSelect}
              />
            )}
            {annualPlan && annualPrice && (
              <PricingCard
                label="Annual"
                sublabel={annualPerMonth !== null ? `$${annualPerMonth.toFixed(2)}/mo — billed yearly` : undefined}
                price={fmt(annualPrice.unit_amount)}
                period="year"
                savingsBadge={savingsPct && savingsPct > 0 ? `Save ${savingsPct}%` : "Best Value"}
                featured
                priceId={annualPrice.id}
                loading={loadingPriceId === annualPrice.id}
                onSelect={handleSelect}
              />
            )}
            {lifetimePlan && lifetimePrice && (
              <PricingCard
                label="Legendary for Life"
                price={fmt(lifetimePrice.unit_amount)}
                period="one-time"
                savingsBadge="Pay once, access forever"
                priceId={lifetimePrice.id}
                loading={loadingPriceId === lifetimePrice.id}
                onSelect={handleSelect}
              />
            )}
            {/* Fallback if Stripe returned no plans */}
            {!monthlyPlan && !annualPlan && !lifetimePlan && (
              <div className="col-span-3 text-center text-muted-foreground py-8">
                No plans available right now — please check back soon.
              </div>
            )}
          </div>
        )}

        <p className="text-center text-[11px] text-muted-foreground">
          Already a member?{" "}
          <Link href="/profile" className="underline underline-offset-2 hover:text-foreground transition-colors">View subscription</Link>
        </p>
      </div>

      {/* ── MOBILE: persistent thumb-reachable upgrade CTA ──────────
          Pinned to the bottom of the viewport so the primary action
          (start the cheapest checkout) is always one tap away no
          matter how far the user scrolls. */}
      {(() => {
        const ctaPrice = monthlyPrice ?? annualPrice ?? lifetimePrice;
        if (!ctaPrice) return null;
        const ctaLabel = monthlyPrice
          ? `${fmt(monthlyPrice.unit_amount)}/mo`
          : annualPrice
            ? `${fmt(annualPrice.unit_amount)}/yr`
            : `${fmt(ctaPrice.unit_amount)} once`;
        return (
          <div className="md:hidden fixed bottom-0 inset-x-0 z-40 bg-card/95 backdrop-blur border-t-2 border-primary/40 px-4 py-3 shadow-[0_-8px_24px_rgba(0,0,0,0.35)]">
            <Button
              onClick={() => handleSelect(ctaPrice.id)}
              disabled={loadingPriceId === ctaPrice.id}
              className="w-full gap-2"
            >
              <Crown className="w-4 h-4" />
              {loadingPriceId === ctaPrice.id ? "Loading…" : <>Go Legendary <span className="opacity-80 font-normal">· {ctaLabel}</span></>}
            </Button>
          </div>
        );
      })()}
    </Layout>
  );
}
