import { useEffect, useRef, useState } from "react";
import { AdminLayout } from "@/components/admin/AdminLayout";
import { CollapsibleSection } from "@/components/CollapsibleSection";
import { FileText, Users, TrendingUp, Shield, Zap, Settings, Bug } from "lucide-react";
import { Sentry, markNextEventAsDebugTest } from "@/lib/sentry";
import { getFeedback } from "@sentry/react";

interface BackendSentryStatus {
  dsnConfigured: boolean;
  environment: string;
  release: string;
}

interface Stats {
  totalFacts: number;
  totalUsers: number;
}

export default function AdminDashboard() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [backendSentryStatus, setBackendSentryStatus] = useState<"idle" | "loading" | "sent" | "error">("idle");
  const [backendStatus, setBackendStatus] = useState<BackendSentryStatus | null>(null);
  const [backendStatusError, setBackendStatusError] = useState<string | null>(null);
  const [handledStatus, setHandledStatus] = useState<"idle" | "sent">("idle");
  const [feedbackError, setFeedbackError] = useState<string | null>(null);
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

  const handledTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (handledTimeoutRef.current) clearTimeout(handledTimeoutRef.current); }, []);

  function sendHandledFrontendException() {
    markNextEventAsDebugTest();
    Sentry.captureException(new Error("Sentry frontend handled-exception smoke test"));
    setHandledStatus("sent");
    if (handledTimeoutRef.current) clearTimeout(handledTimeoutRef.current);
    handledTimeoutRef.current = setTimeout(() => setHandledStatus("idle"), 4000);
  }

  function openFeedbackWidget() {
    setFeedbackError(null);
    const feedback = getFeedback();
    if (!feedback) {
      setFeedbackError("Feedback integration not loaded. Is VITE_SENTRY_DSN set?");
      return;
    }
    const form = feedback.createForm();
    form.then((f) => {
      f.appendToDom();
      f.open();
    }).catch((err: unknown) => {
      setFeedbackError(err instanceof Error ? err.message : String(err));
    });
  }

  useEffect(() => {
    fetch("/api/admin/sentry-status", { credentials: "include" })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<BackendSentryStatus>;
      })
      .then((data) => { setBackendStatus(data); setBackendStatusError(null); })
      .catch((err: unknown) => {
        setBackendStatus(null);
        setBackendStatusError(err instanceof Error ? err.message : String(err));
      });
  }, []);

  useEffect(() => {
    fetch("/api/admin/stats", { credentials: "include" })
      .then((r) => r.json())
      .then((data: Stats) => setStats(data))
      .catch(() => {});
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
              Set <code className="text-primary bg-muted px-1 rounded">TURNSTILE_SECRET_KEY</code> (and <code className="text-primary bg-muted px-1 rounded">VITE_TURNSTILE_SITE_KEY</code>) for
              production bot protection.
            </li>
            <li>Stripe integration available in the Billing section once ready.</li>
          </ul>
        </CollapsibleSection>
      </div>

      <div className="border-t border-border pt-4">
        <p className="text-xs text-muted-foreground uppercase tracking-wider font-semibold mb-3 flex items-center gap-1.5">
          <Bug className="w-3.5 h-3.5" /> Diagnostics
        </p>
        <CollapsibleSection
          title="Sentry diagnostics"
          icon={<Bug className="w-4 h-4 text-red-400" />}
          description="Verify error reporting end-to-end. Issues land in the Issues tab; user feedback lands in the User Feedback tab."
          storageKey="admin_section_dashboard_sentry"
        >
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-4 text-xs">
            <div className="border border-border rounded p-2 bg-muted/30">
              <div className="font-semibold text-foreground mb-1">Frontend</div>
              <div className="flex justify-between"><span className="text-muted-foreground">DSN</span><span className={import.meta.env.VITE_SENTRY_DSN ? "text-green-400" : "text-red-400"}>{import.meta.env.VITE_SENTRY_DSN ? "configured" : "missing"}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">environment</span><span className="font-mono">{import.meta.env.PROD ? "production" : "development"}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">release</span><span className="font-mono truncate ml-2" title={String(import.meta.env.VITE_SENTRY_RELEASE ?? "dev")}>{String(import.meta.env.VITE_SENTRY_RELEASE ?? "dev")}</span></div>
            </div>
            <div className="border border-border rounded p-2 bg-muted/30">
              <div className="font-semibold text-foreground mb-1">Backend</div>
              {backendStatus === null ? (
                backendStatusError ? (
                  <div className="text-red-400">Failed to load: {backendStatusError}</div>
                ) : (
                  <div className="text-muted-foreground">Loading…</div>
                )
              ) : (
                <>
                  <div className="flex justify-between"><span className="text-muted-foreground">DSN</span><span className={backendStatus.dsnConfigured ? "text-green-400" : "text-red-400"}>{backendStatus.dsnConfigured ? "configured" : "missing"}</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">environment</span><span className="font-mono">{backendStatus.environment}</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">release</span><span className="font-mono truncate ml-2" title={backendStatus.release}>{backendStatus.release}</span></div>
                </>
              )}
            </div>
          </div>
          <p className="text-xs text-muted-foreground mb-3">
            Each button below produces a different kind of Sentry event. After clicking, refresh
            the corresponding Sentry project page (filter by <code className="bg-muted px-1 rounded">debug:sentry-test</code>)
            to confirm it arrived. The feedback widget reports go to the <strong>User Feedback</strong> tab,
            not the Issues tab.
          </p>
          <div className="flex flex-col gap-2">
            <button
              onClick={() => setThrowForBoundary(true)}
              className="w-full text-left px-3 py-2 rounded bg-muted border border-border text-sm hover:bg-red-950 hover:border-red-700 transition-colors"
            >
              1. Throw frontend exception (caught by ErrorBoundary, shows fallback UI)
            </button>
            <button
              onClick={sendHandledFrontendException}
              className="w-full text-left px-3 py-2 rounded bg-muted border border-border text-sm hover:bg-red-950 hover:border-red-700 transition-colors"
            >
              {handledStatus === "sent"
                ? "2. Handled exception sent — check Sentry (frontend project)"
                : "2. Send handled frontend exception (Sentry.captureException)"}
            </button>
            <button
              onClick={() => triggerBackendSentry()}
              disabled={backendSentryStatus === "loading"}
              className="w-full text-left px-3 py-2 rounded bg-muted border border-border text-sm hover:bg-red-950 hover:border-red-700 disabled:opacity-50 transition-colors"
            >
              {backendSentryStatus === "loading" && "3. Sending…"}
              {backendSentryStatus === "sent" && "3. Backend error sent — check Sentry (backend project)"}
              {backendSentryStatus === "error" && "3. Request failed — check credentials"}
              {backendSentryStatus === "idle" && "3. Trigger backend exception (POST /api/admin/_debug/sentry)"}
            </button>
            <button
              onClick={openFeedbackWidget}
              className="w-full text-left px-3 py-2 rounded bg-muted border border-border text-sm hover:bg-blue-950 hover:border-blue-700 transition-colors"
            >
              4. Open feedback widget (sends to Sentry → User Feedback tab)
            </button>
            {feedbackError && (
              <p className="text-xs text-red-400">{feedbackError}</p>
            )}
          </div>
        </CollapsibleSection>
      </div>
    </AdminLayout>
  );
}
