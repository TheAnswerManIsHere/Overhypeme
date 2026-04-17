import { useEffect, useState } from "react";
import { AdminLayout } from "@/components/admin/AdminLayout";
import { CollapsibleSection } from "@/components/CollapsibleSection";
import { FileText, Users, TrendingUp, Shield, Zap, Settings, Bug, BarChart2 } from "lucide-react";
import { markNextEventAsDebugTest } from "@/lib/sentry";

interface Stats {
  totalFacts: number;
  totalUsers: number;
}

interface RouteVisitStat {
  routeKey: string;
  visitCount: number;
  updatedAt?: string;
}

export default function AdminDashboard() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [routeStats, setRouteStats] = useState<RouteVisitStat[] | null>(null);
  const [backendSentryStatus, setBackendSentryStatus] = useState<"idle" | "loading" | "sent" | "error">("idle");
  const [throwForBoundary, setThrowForBoundary] = useState(false);

  if (throwForBoundary) {
    markNextEventAsDebugTest();
    throw new Error("Sentry frontend test triggered by admin");
  }

  async function triggerBackendSentry() {
    setBackendSentryStatus("loading");
    try {
      const res = await fetch("/api/admin/_debug/sentry", { method: "POST", credentials: "include" });
      if (res.status === 500 || res.ok) {
        setBackendSentryStatus("sent");
      } else {
        setBackendSentryStatus("error");
      }
    } catch {
      setBackendSentryStatus("error");
    }
  }

  useEffect(() => {
    fetch("/api/admin/stats", { credentials: "include" })
      .then((r) => r.json())
      .then((data: Stats) => setStats(data))
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetch("/api/admin/route-stats", { credentials: "include" })
      .then((r) => r.json())
      .then((data: { stats: RouteVisitStat[] }) => setRouteStats(data.stats ?? []))
      .catch(() => setRouteStats([]));
  }, []);

  const cards = [
    {
      label: "Total Facts",
      value: stats?.totalFacts ?? "—",
      icon: FileText,
      color: "text-primary",
    },
    {
      label: "Total Users",
      value: stats?.totalUsers ?? "—",
      icon: Users,
      color: "text-blue-400",
    },
    {
      label: "Admin Access",
      value: "Active",
      icon: Shield,
      color: "text-green-400",
    },
    {
      label: "Platform Status",
      value: "Online",
      icon: TrendingUp,
      color: "text-orange-400",
    },
  ];

  const maxCount = routeStats && routeStats.length > 0 ? routeStats[0]!.visitCount : 1;
  const totalVisits = routeStats ? routeStats.reduce((sum, r) => sum + r.visitCount, 0) : 0;

  return (
    <AdminLayout title="Dashboard">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        {cards.map(({ label, value, icon: Icon, color }) => (
          <div
            key={label}
            className="bg-card border border-border rounded-lg p-5 flex items-center gap-4"
          >
            <div className={`p-3 rounded-lg bg-muted ${color}`}>
              <Icon className="w-5 h-5" />
            </div>
            <div>
              <p className="text-muted-foreground text-xs uppercase tracking-wide font-medium">
                {label}
              </p>
              <p className="text-2xl font-bold text-foreground">{value}</p>
            </div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
        <CollapsibleSection
          title="Top Pages"
          icon={<BarChart2 className="w-4 h-4 text-primary" />}
          description="Aggregate route visit counts across all users — update the prefetch list based on these."
          storageKey="admin_section_dashboard_top_pages"
        >
          {routeStats === null ? (
            <p className="text-xs text-muted-foreground">Loading…</p>
          ) : routeStats.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No visit data yet. Counts are flushed from browsers on each page load.
            </p>
          ) : (
            <ol className="space-y-3">
              {routeStats.map((row, i) => (
                <li key={row.routeKey} className="flex items-center gap-3 text-sm">
                  <span className="w-5 text-right text-muted-foreground text-xs shrink-0">{i + 1}</span>
                  <span className="w-20 font-mono text-foreground shrink-0">{row.routeKey}</span>
                  <div className="flex-1 bg-muted rounded-full h-2 overflow-hidden">
                    <div
                      className="bg-primary h-2 rounded-full transition-all"
                      style={{ width: `${Math.round((row.visitCount / maxCount) * 100)}%` }}
                    />
                  </div>
                  <span className="w-12 text-right tabular-nums shrink-0 text-foreground font-medium">
                    {row.visitCount.toLocaleString()}
                  </span>
                  <span className="w-10 text-right text-muted-foreground tabular-nums text-xs shrink-0">
                    {totalVisits > 0 ? `${Math.round((row.visitCount / totalVisits) * 100)}%` : "—"}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </CollapsibleSection>

        <CollapsibleSection
          title="Sentry Error Reporting Test"
          icon={<Bug className="w-4 h-4 text-red-400" />}
          description="Verify end-to-end error reporting after setting Sentry DSN secrets."
          storageKey="admin_section_dashboard_sentry"
        >
          <p className="text-xs text-muted-foreground mb-3">
            Use these buttons to confirm errors flow into the correct Sentry projects.
            Check your Sentry dashboard for the new issues after clicking.
          </p>
          <div className="flex flex-col gap-2">
            <button
              onClick={() => triggerBackendSentry()}
              disabled={backendSentryStatus === "loading"}
              className="w-full text-left px-3 py-2 rounded bg-muted border border-border text-sm hover:bg-red-950 hover:border-red-700 disabled:opacity-50 transition-colors"
            >
              {backendSentryStatus === "loading" && "Sending…"}
              {backendSentryStatus === "sent" && "Backend error sent — check Sentry (backend project)"}
              {backendSentryStatus === "error" && "Request failed — check credentials"}
              {backendSentryStatus === "idle" && "Trigger backend Sentry error (POST /api/admin/_debug/sentry)"}
            </button>
            <button
              onClick={() => setThrowForBoundary(true)}
              className="w-full text-left px-3 py-2 rounded bg-muted border border-border text-sm hover:bg-red-950 hover:border-red-700 transition-colors"
            >
              Trigger frontend Sentry error (render-throws — caught by ErrorBoundary)
            </button>
          </div>
        </CollapsibleSection>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <CollapsibleSection
          title="Quick Actions"
          icon={<Zap className="w-4 h-4 text-primary" />}
          description="Common admin tasks and shortcuts."
          storageKey="admin_section_dashboard_quick_actions"
        >
          <ul className="space-y-2 text-sm text-muted-foreground">
            <li>
              <a href="/admin/facts" className="text-primary hover:underline">
                → Import facts in bulk
              </a>
            </li>
            <li>
              <a href="/admin/users" className="text-primary hover:underline">
                → Manage users and admin roles
              </a>
            </li>
            <li>
              <a href="/admin/affiliate" className="text-primary hover:underline">
                → Affiliate click-throughs
              </a>
            </li>
            <li>
              <a href="/admin/billing" className="text-primary hover:underline">
                → Billing overview
              </a>
            </li>
          </ul>
        </CollapsibleSection>

        <CollapsibleSection
          title="Setup Notes"
          icon={<Settings className="w-4 h-4 text-primary" />}
          description="One-time configuration reminders for this deployment."
          storageKey="admin_section_dashboard_setup"
        >
          <ul className="space-y-2 text-sm text-muted-foreground">
            <li>
              Set <code className="text-primary bg-muted px-1 rounded">ADMIN_USER_IDS</code> env
              var to your Replit user ID to grant instant admin access.
            </li>
            <li>
              Set <code className="text-primary bg-muted px-1 rounded">HCAPTCHA_SECRET</code> for
              production bot protection.
            </li>
            <li>Stripe integration available in the Billing section once ready.</li>
          </ul>
        </CollapsibleSection>
      </div>
    </AdminLayout>
  );
}
