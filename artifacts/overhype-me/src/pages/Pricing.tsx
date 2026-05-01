import { useState, useEffect } from "react";
import { Link, useLocation } from "wouter";
import { useAuth } from "@workspace/replit-auth-web";
import { Layout } from "@/components/layout/Layout";
import { Button } from "@/components/ui/Button";
import { Zap, Star, Check, Lock, ThumbsUp, Send, MessageSquare, Image, Share2, ShoppingBag, ShieldOff, ImagePlus, Video, Clapperboard, UserCircle, Crown, CalendarDays } from "lucide-react";

const FREE_FEATURES = [
  { icon: <Check className="w-4 h-4" />,        text: "Browse all Facts" },
  { icon: <ThumbsUp className="w-4 h-4" />,     text: "Vote on Facts" },
  { icon: <Send className="w-4 h-4" />,         text: "Submit Facts (with CAPTCHA)" },
  { icon: <MessageSquare className="w-4 h-4" />, text: "Leave Comments (with CAPTCHA)" },
  { icon: <Image className="w-4 h-4" />,        text: "Generate Generic Image Memes" },
  { icon: <Share2 className="w-4 h-4" />,       text: "Share Memes" },
  { icon: <ShoppingBag className="w-4 h-4" />,  text: "Purchase Meme Merch" },
];

const LEGENDARY_FEATURES = [
  { icon: <Check className="w-4 h-4" />,          text: "Everything in Free" },
  { icon: <ShieldOff className="w-4 h-4" />,      text: "No CAPTCHAs" },
  { icon: <CalendarDays className="w-4 h-4" />,   text: "Fact of the Day" },
  { icon: <ImagePlus className="w-4 h-4" />,      text: "Generate Custom Image Memes" },
  { icon: <Video className="w-4 h-4" />,          text: "Generate Generic Video Memes" },
  { icon: <Clapperboard className="w-4 h-4" />,   text: "Generate Custom Video Memes" },
  { icon: <UserCircle className="w-4 h-4" />,     text: "Custom Profile Image" },
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
      <div className="max-w-5xl mx-auto px-4 py-16 md:py-24">

        {/* Hero */}
        <div className="text-center mb-16">
          <div className="flex items-center justify-center gap-2 mb-4">
            <Zap className="w-8 h-8 text-primary" />
            <h1 className="text-4xl md:text-5xl font-display uppercase tracking-widest text-foreground">Go Legendary</h1>
          </div>
          <p className="text-xl text-muted-foreground max-w-xl mx-auto">
            Unlock the full experience. Because average is for other people.
          </p>
        </div>

        {/* Tier comparison */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-8 mb-16">
          {/* Free */}
          <div className="bg-card border-2 border-border rounded-sm p-8">
            <div className="flex items-center gap-3 mb-6">
              <div className="w-10 h-10 rounded-sm bg-secondary flex items-center justify-center">
                <Lock className="w-5 h-5 text-muted-foreground" />
              </div>
              <div>
                <h2 className="text-xl font-display uppercase tracking-wide text-foreground">Free</h2>
                <p className="text-2xl font-bold text-foreground">$0<span className="text-sm text-muted-foreground font-normal">/forever</span></p>
              </div>
            </div>
            <ul className="space-y-3">
              {FREE_FEATURES.map(f => (
                <li key={f.text} className="flex items-center gap-3 text-muted-foreground">
                  <span className="text-primary shrink-0">{f.icon}</span>
                  {f.text}
                </li>
              ))}
            </ul>
          </div>

          {/* Legendary */}
          <div className="bg-card border-2 border-primary rounded-sm p-8 shadow-[0_0_30px_rgba(249,115,22,0.15)] relative overflow-hidden">
            <div className="absolute top-0 right-0 w-24 h-24 bg-primary/10 rounded-bl-full -mr-12 -mt-12 pointer-events-none" />
            <div className="flex items-center gap-3 mb-6">
              <div className="w-10 h-10 rounded-sm bg-primary/20 flex items-center justify-center">
                <Star className="w-5 h-5 text-primary" />
              </div>
              <div>
                <h2 className="text-xl font-display uppercase tracking-wide text-primary">Legendary</h2>
                <p className="text-2xl font-bold text-foreground">
                  {monthlyPrice
                    ? fmt(monthlyPrice.unit_amount)
                    : annualPerMonth !== null
                      ? `$${annualPerMonth.toFixed(2)}`
                      : "$3.99"}
                  <span className="text-sm text-muted-foreground font-normal">/month</span>
                </p>
              </div>
            </div>
            <ul className="space-y-3 mb-6">
              {LEGENDARY_FEATURES.map(f => (
                <li key={f.text} className="flex items-center gap-3 text-foreground">
                  <span className="text-primary shrink-0">{f.icon}</span>
                  {f.text}
                </li>
              ))}
            </ul>
          </div>
        </div>

        {/* Plan picker */}
        <h3 className="text-2xl font-display uppercase tracking-widest text-center mb-8 text-foreground">Choose Your Plan</h3>

        {error && (
          <div className="bg-destructive/20 border border-destructive/40 text-destructive rounded-sm p-4 mb-6 text-center text-sm">
            {error}
          </div>
        )}

        {plansLoading ? (
          <div className="text-center text-muted-foreground py-12">Loading plans…</div>
        ) : (
          <div className={`grid gap-6 mb-12 ${[monthlyPlan, annualPlan, lifetimePlan].filter(Boolean).length === 1 ? "max-w-xs mx-auto" : [monthlyPlan, annualPlan, lifetimePlan].filter(Boolean).length === 2 ? "grid-cols-1 md:grid-cols-2 max-w-2xl mx-auto" : "grid-cols-1 md:grid-cols-3"}`}>
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

        <div className="text-center">
          <p className="text-muted-foreground text-sm mb-2">Already a member?</p>
          <Link href="/profile">
            <Button variant="outline">View my subscription</Button>
          </Link>
        </div>

        {/* Fact of the Day callout */}
        <div className="mt-16 bg-card border-2 border-border rounded-sm p-8 text-center">
          <Zap className="w-8 h-8 text-primary mx-auto mb-4" />
          <h3 className="text-xl font-display uppercase tracking-wide text-foreground mb-3">What is Fact of the Day?</h3>
          <p className="text-muted-foreground max-w-lg mx-auto">
            Every morning, Legendary members receive a daily email featuring a randomly selected top-rated fact — personalized with your name. Start your day right.
          </p>
        </div>
      </div>
    </Layout>
  );
}
