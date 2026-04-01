import { AdminLayout } from "@/components/admin/AdminLayout";
import { CreditCard, Zap, Star, DollarSign } from "lucide-react";

const PLANS = [
  {
    name: "Free",
    price: "$0/mo",
    features: [
      "Browse all facts",
      "Vote on facts",
      "Submit facts (with CAPTCHA)",
      "Leave comments",
    ],
    active: true,
  },
  {
    name: "Pro",
    price: "$4.99/mo",
    features: [
      "Everything in Free",
      "No CAPTCHA required",
      "Fact of the Day email",
      "Download meme packs",
      "Supporter badge",
    ],
    active: false,
    comingSoon: true,
  },
];

export default function AdminBilling() {
  return (
    <AdminLayout title="Billing">
      <div className="space-y-6">
        <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-4 flex items-start gap-3">
          <Zap className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
          <div>
            <p className="text-amber-300 font-medium text-sm">Stripe Integration Pending</p>
            <p className="text-amber-400/80 text-xs mt-1">
              Paid membership tiers will be enabled once Stripe is integrated. Configure your Stripe
              keys in environment variables to activate billing.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {PLANS.map((plan) => (
            <div
              key={plan.name}
              className={`bg-card border rounded-lg p-5 ${
                plan.active ? "border-primary" : "border-border"
              }`}
            >
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  {plan.name === "Pro" ? (
                    <Star className="w-4 h-4 text-primary" />
                  ) : (
                    <DollarSign className="w-4 h-4 text-muted-foreground" />
                  )}
                  <span className="font-display font-bold text-foreground uppercase tracking-wide">
                    {plan.name}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-lg font-bold text-foreground">{plan.price}</span>
                  {plan.comingSoon && (
                    <span className="text-xs bg-primary/20 text-primary px-2 py-0.5 rounded-sm font-medium">
                      Soon
                    </span>
                  )}
                  {plan.active && !plan.comingSoon && (
                    <span className="text-xs bg-green-500/20 text-green-400 px-2 py-0.5 rounded-sm font-medium">
                      Active
                    </span>
                  )}
                </div>
              </div>
              <ul className="space-y-1.5">
                {plan.features.map((f) => (
                  <li key={f} className="text-sm text-muted-foreground flex items-center gap-2">
                    <span className="text-primary">✓</span>
                    {f}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="bg-card border border-border rounded-lg p-5">
          <h2 className="font-display font-bold text-foreground uppercase tracking-wide mb-4 flex items-center gap-2">
            <CreditCard className="w-4 h-4 text-primary" />
            Stripe Setup Checklist
          </h2>
          <div className="space-y-3 text-sm">
            {[
              { label: "Set STRIPE_SECRET_KEY environment variable", done: false },
              { label: "Set STRIPE_PUBLISHABLE_KEY environment variable", done: false },
              { label: "Create Pro product & price in Stripe dashboard", done: false },
              { label: "Set STRIPE_PRO_PRICE_ID environment variable", done: false },
              { label: "Configure webhook endpoint /api/stripe/webhook", done: false },
              { label: "Set STRIPE_WEBHOOK_SECRET environment variable", done: false },
            ].map(({ label, done }) => (
              <div key={label} className="flex items-center gap-3">
                <span
                  className={`w-5 h-5 rounded-full border flex items-center justify-center text-xs shrink-0 ${
                    done
                      ? "border-green-500 bg-green-500/20 text-green-400"
                      : "border-border text-muted-foreground"
                  }`}
                >
                  {done ? "✓" : "○"}
                </span>
                <span className={done ? "text-foreground line-through" : "text-muted-foreground"}>
                  {label}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </AdminLayout>
  );
}
