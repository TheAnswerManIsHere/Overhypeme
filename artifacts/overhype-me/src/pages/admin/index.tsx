import { useEffect, useState } from "react";
import { AdminLayout } from "@/components/admin/AdminLayout";
import { CollapsibleSection } from "@/components/CollapsibleSection";
import { FileText, Users, TrendingUp, Shield, Zap, Settings, Bug, BarChart2, ChevronUp, ChevronDown, ChevronsUpDown } from "lucide-react";
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

type TimeRange = "7d" | "30d" | "all";

function formatLastSeen(value: string | undefined | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (isNaN(date.getTime())) return "—";
  const now = Date.now();
  const diffMs = now - date.getTime();
  const diffSecs = Math.floor(diffMs / 1000);
  const diffMins = Math.floor(diffSecs / 60);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);
  if (diffSecs < 60) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays === 1) return "yesterday";
  if (diffDays < 7) return `${diffDays} days ago`;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

const TIME_RANGE_LABELS: Record<TimeRange, string> = {
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  "all": "All time",
};

const STORAGE_KEY_RANGE = "admin_top_pages_time_range";

function loadStoredRange(): TimeRange {
  try {
    const v = localStorage.getItem(STORAGE_KEY_RANGE);
    if (v === "7d" || v === "30d" || v === "all") return v;
  } catch {}
  return "all";
}

export default function AdminDashboard() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [routeStats, setRouteStats] = useState<RouteVisitStat[] | null>(null);
  const [timeRange, setTimeRange] = useState<TimeRange>(loadStoredRange);
  const [backendSentryStatus, setBackendSentryStatus] = useState<"idle" | "loading" | "sent" | "error">("idle");
  type SortKey = "rank" | "routeKey" | "visitCount" | "updatedAt";
  type SortDir = "asc" | "desc";
  const [sortKey, setSortKey] = useState<SortKey>("visitCount");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  function handleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(key === "routeKey" ? "asc" : "desc");
    }
  }

  function SortIcon({ col }: { col: SortKey }) {
    if (sortKey !== col) return <ChevronsUpDown className="w-3 h-3 opacity-40" />;
    return sortDir === "asc" ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />;
  }
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
    try { localStorage.setItem(STORAGE_KEY_RANGE, timeRange); } catch {}
    setRouteStats(null);
    const url = timeRange === "all"
      ? "/api/admin/route-stats"
      : `/api/admin/route-stats?since=${timeRange}`;
    fetch(url, { credentials: "include" })
      .then((r) => r.json())
      .then((data: { stats: RouteVisitStat[] }) => setRouteStats(data.stats ?? []))
      .catch(() => setRouteStats([]));
  }, [timeRange]);

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

  const originalOrder = routeStats ?? [];
  const totalVisits = originalOrder.reduce((sum, r) => sum + r.visitCount, 0);

  const sortedStats: (RouteVisitStat & { originalRank: number })[] = [...originalOrder]
    .map((r, i) => ({ ...r, originalRank: i + 1 }))
    .sort((a, b) => {
      let cmp = 0;
      if (sortKey === "rank") {
        cmp = a.originalRank - b.originalRank;
      } else if (sortKey === "visitCount") {
        cmp = a.visitCount - b.visitCount;
      } else if (sortKey === "routeKey") {
        cmp = a.routeKey.localeCompare(b.routeKey);
      } else if (sortKey === "updatedAt") {
        const ta = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
        const tb = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
        cmp = ta - tb;
      }
      return sortDir === "asc" ? cmp : -cmp;
    });

  const maxCount = originalOrder.length > 0 ? Math.max(...originalOrder.map((r) => r.visitCount)) : 1;

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
          badge={TIME_RANGE_LABELS[timeRange]}
          description="Aggregate route visit counts across all users — update the prefetch list based on these."
          storageKey="admin_section_dashboard_top_pages"
        >
          <div className="flex gap-1 mb-3">
            {(["7d", "30d", "all"] as TimeRange[]).map((r) => (
              <button
                key={r}
                onClick={() => setTimeRange(r)}
                className={`px-2 py-0.5 rounded text-xs font-medium transition-colors border ${
                  timeRange === r
                    ? "bg-primary text-primary-foreground border-primary"
                    : "bg-muted text-muted-foreground border-border hover:bg-muted/80"
                }`}
              >
                {TIME_RANGE_LABELS[r]}
              </button>
            ))}
          </div>
          {routeStats === null ? (
            <p className="text-xs text-muted-foreground">Loading…</p>
          ) : routeStats.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No visit data yet. Counts are flushed from browsers on each page load.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border">
                    {(
                      [
                        { key: "rank", label: "#", className: "w-8 text-right pr-3" },
                        { key: "routeKey", label: "Route", className: "text-left pr-3" },
                        { key: "visitCount", label: "Visits", className: "w-16 text-right pr-3" },
                        { key: "updatedAt", label: "Last Seen", className: "w-20 text-right" },
                      ] as { key: "rank" | "routeKey" | "visitCount" | "updatedAt"; label: string; className: string }[]
                    ).map(({ key, label, className }) => (
                      <th
                        key={key}
                        className={`pb-2 text-xs font-medium text-muted-foreground uppercase tracking-wide ${className}`}
                        aria-sort={sortKey === key ? (sortDir === "asc" ? "ascending" : "descending") : "none"}
                      >
                        <button
                          onClick={() => handleSort(key)}
                          className={`inline-flex items-center gap-1 w-full cursor-pointer select-none hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring rounded ${key === "routeKey" ? "justify-start" : "justify-end"}`}
                        >
                          {label}
                          <SortIcon col={key} />
                        </button>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {sortedStats.map((row) => (
                    <tr key={row.routeKey} className="border-b border-border/50 last:border-0 hover:bg-muted/30 transition-colors">
                      <td className="py-2 pr-3 text-right text-muted-foreground text-xs tabular-nums w-8">
                        {row.originalRank}
                      </td>
                      <td className="py-2 pr-3">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-foreground">{row.routeKey}</span>
                          <div className="flex-1 bg-muted rounded-full h-1.5 overflow-hidden min-w-[40px]">
                            <div
                              className="bg-primary h-1.5 rounded-full transition-all"
                              style={{ width: `${Math.round((row.visitCount / maxCount) * 100)}%` }}
                            />
                          </div>
                          <span className="text-muted-foreground tabular-nums text-xs shrink-0">
                            {totalVisits > 0 ? `${Math.round((row.visitCount / totalVisits) * 100)}%` : "—"}
                          </span>
                        </div>
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums text-foreground font-medium w-16">
                        {row.visitCount.toLocaleString()}
                      </td>
                      <td className="py-2 text-right text-muted-foreground text-xs w-20" title={(() => { if (!row.updatedAt) return undefined; const d = new Date(row.updatedAt); return isNaN(d.getTime()) ? undefined : d.toLocaleString(); })()}>
                        {formatLastSeen(row.updatedAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
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
