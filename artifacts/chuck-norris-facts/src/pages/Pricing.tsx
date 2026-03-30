import { useState, useEffect } from "react";
import { Link, useLocation } from "wouter";
import { useAuth } from "@workspace/replit-auth-web";
import { Layout } from "@/components/layout/Layout";
import { Button } from "@/components/ui/Button";
import { Zap, Star, Check, Lock, Mail, Image, Shield, MessageSquare } from "lucide-react";

const FREE_FEATURES = [
  { icon: <Check className="w-4 h-4" />, text: "Browse all facts" },
  { icon: <Check className="w-4 h-4" />, text: "Vote on facts" },
  { icon: <Check className="w-4 h-4" />, text: "Submit facts (with CAPTCHA)" },
  { icon: <Check className="w-4 h-4" />, text: "Leave comments" },
  { icon: <Check className="w-4 h-4" />, text: "Generate memes" },
];

const PREMIUM_FEATURES = [
  { icon: <Check className="w-4 h-4" />, text: "Everything in Free" },
  { icon: <Mail className="w-4 h-4" />, text: "Daily Fact of the Day email" },
  { icon: <Image className="w-4 h-4" />, text: "Download HD meme packs" },
  { icon: <Shield className="w-4 h-4" />, text: "No CAPTCHA required" },
  { icon: <MessageSquare className="w-4 h-4" />, text: "Priority comment visibility" },
  { icon: <Star className="w-4 h-4" />, text: "Supporter badge on profile" },
];

interface PricingCardProps {
  priceId?: string;
  label: string;
  amount: number;
  period: string;
  savings?: string;
  onSelect: (priceId: string) => void;
  loading: boolean;
}

function PricingCard({ priceId, label, amount, period, savings, onSelect, loading }: PricingCardProps) {
  const dollars = (amount / 100).toFixed(2);
  return (
    <div className={`bg-card border-2 rounded-sm p-6 flex flex-col items-center gap-4 relative ${savings ? "border-primary shadow-[0_0_20px_rgba(249,115,22,0.2)]" : "border-border"}`}>
      {savings && (
        <div className="absolute -top-3 left-1/2 -translate-x-1/2 bg-primary text-white text-xs font-bold px-4 py-1 rounded-sm uppercase tracking-widest">
          Best Value
        </div>
      )}
      <p className="text-xs font-display uppercase tracking-widest text-muted-foreground">{label}</p>
      <div className="text-center">
        <span className="text-4xl font-display font-bold text-foreground">${dollars}</span>
        <span className="text-muted-foreground text-sm ml-1">/{period}</span>
      </div>
      {savings && <p className="text-xs text-primary font-bold uppercase">{savings}</p>}
      <Button
        className="w-full"
        disabled={!priceId || loading}
        onClick={() => priceId && onSelect(priceId)}
      >
        {loading ? "Loading..." : "Upgrade Now"}
      </Button>
    </div>
  );
}

export default function Pricing() {
  const [, setLocation] = useLocation();
  const { isAuthenticated } = useAuth();
  const [loadingPriceId, setLoadingPriceId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [plans, setPlans] = useState<Array<{
    id: string; name: string; description: string | null;
    prices: Array<{ id: string; unit_amount: number; currency: string; recurring: { interval: string } | null }>;
  }>>([]);

  useEffect(() => {
    fetch("/api/stripe/plans")
      .then(r => r.json())
      .then((d: { plans: typeof plans }) => setPlans(d.plans ?? []))
      .catch(() => {});
  }, []);

  async function handleSelect(priceId: string) {
    if (!isAuthenticated) { setLocation("/login"); return; }
    setLoadingPriceId(priceId);
    setError(null);
    try {
      const resp = await fetch("/api/stripe/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ priceId }),
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

  const premiumProduct = plans[0];
  const prices = premiumProduct?.prices ?? [];
  const monthly = prices.find(p => p.recurring?.interval === "month");
  const annual = prices.find(p => p.recurring?.interval === "year");
  const lifetime = prices.find(p => p.recurring === null);

  return (
    <Layout>
      <div className="max-w-5xl mx-auto px-4 py-16 md:py-24">
        <div className="text-center mb-16">
          <div className="flex items-center justify-center gap-2 mb-4">
            <Zap className="w-8 h-8 text-primary" />
            <h1 className="text-4xl md:text-5xl font-display uppercase tracking-widest text-foreground">Go Premium</h1>
          </div>
          <p className="text-xl text-muted-foreground max-w-xl mx-auto">
            Unlock the full Chuck Norris experience. Because average is for other people.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-8 mb-16">
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

          <div className="bg-card border-2 border-primary rounded-sm p-8 shadow-[0_0_30px_rgba(249,115,22,0.15)] relative overflow-hidden">
            <div className="absolute top-0 right-0 w-24 h-24 bg-primary/10 rounded-bl-full -mr-12 -mt-12 pointer-events-none" />
            <div className="flex items-center gap-3 mb-6">
              <div className="w-10 h-10 rounded-sm bg-primary/20 flex items-center justify-center">
                <Star className="w-5 h-5 text-primary" />
              </div>
              <div>
                <h2 className="text-xl font-display uppercase tracking-wide text-primary">Premium</h2>
                <p className="text-2xl font-bold text-foreground">
                  {monthly ? `$${(monthly.unit_amount / 100).toFixed(2)}` : "$4.99"}
                  <span className="text-sm text-muted-foreground font-normal">/month</span>
                </p>
              </div>
            </div>
            <ul className="space-y-3 mb-6">
              {PREMIUM_FEATURES.map(f => (
                <li key={f.text} className="flex items-center gap-3 text-foreground">
                  <span className="text-primary shrink-0">{f.icon}</span>
                  {f.text}
                </li>
              ))}
            </ul>
          </div>
        </div>

        <h3 className="text-2xl font-display uppercase tracking-widest text-center mb-8 text-foreground">Choose Your Plan</h3>

        {error && (
          <div className="bg-destructive/20 border border-destructive/40 text-destructive rounded-sm p-4 mb-6 text-center text-sm">
            {error}
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-12">
          <PricingCard
            label="Monthly"
            priceId={monthly?.id}
            amount={monthly?.unit_amount ?? 499}
            period="month"
            onSelect={handleSelect}
            loading={loadingPriceId === monthly?.id}
          />
          <PricingCard
            label="Annual"
            priceId={annual?.id}
            amount={annual?.unit_amount ?? 4999}
            period="year"
            savings={annual ? `Save ${Math.round(100 - (annual.unit_amount / (monthly ? monthly.unit_amount * 12 : 5988)) * 100)}%` : "Save ~17%"}
            onSelect={handleSelect}
            loading={loadingPriceId === annual?.id}
          />
          <PricingCard
            label="Lifetime"
            priceId={lifetime?.id}
            amount={lifetime?.unit_amount ?? 9900}
            period="one-time"
            savings="Pay once, forever"
            onSelect={handleSelect}
            loading={loadingPriceId === lifetime?.id}
          />
        </div>

        <div className="text-center">
          <p className="text-muted-foreground text-sm mb-2">Already a member?</p>
          <Link href="/profile">
            <Button variant="outline">View my subscription</Button>
          </Link>
        </div>

        <div className="mt-16 bg-card border-2 border-border rounded-sm p-8 text-center">
          <Zap className="w-8 h-8 text-primary mx-auto mb-4" />
          <h3 className="text-xl font-display uppercase tracking-wide text-foreground mb-3">What is Fact of the Day?</h3>
          <p className="text-muted-foreground max-w-lg mx-auto">
            Every morning, premium members receive a daily email featuring a randomly selected top-rated Chuck Norris fact. Start your day right.
          </p>
        </div>
      </div>
    </Layout>
  );
}
