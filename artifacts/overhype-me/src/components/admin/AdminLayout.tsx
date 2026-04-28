import { type ReactNode, useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import { useAuth } from "@workspace/replit-auth-web";
import {
  LayoutDashboard,
  FileText,
  Users,
  CreditCard,
  LogOut,
  Shield,
  ChevronRight,
  ShoppingBag,
  Settings,
  Film,
  PanelLeftClose,
  PanelLeftOpen,
  ToggleLeft,
  ShieldAlert,
  Undo2,
  Mail,
} from "lucide-react";

interface AdminLayoutProps {
  children: ReactNode;
  title: string;
}

const NAV_ITEMS = [
  { href: "/admin", label: "Dashboard", icon: LayoutDashboard, exact: true, badge: false as const },
  { href: "/admin/facts", label: "Facts", icon: FileText, badge: false as const },
  { href: "/admin/users", label: "Users", icon: Users, badge: false as const },
  { href: "/admin/moderation", label: "Moderation", icon: ShieldAlert, badge: "moderation" as const },
  { href: "/admin/billing", label: "Billing", icon: CreditCard, badge: false as const },
  { href: "/admin/refunds-disputes", label: "Refunds & Disputes", icon: Undo2, badge: false as const },
  { href: "/admin/affiliate", label: "Affiliate", icon: ShoppingBag, badge: false as const },
  { href: "/admin/video-styles", label: "Video Styles", icon: Film, badge: false as const },
  { href: "/admin/email-queue", label: "Email Queue", icon: Mail, badge: false as const },
  { href: "/admin/features", label: "Features", icon: ToggleLeft, badge: false as const },
  { href: "/admin/config", label: "Configuration", icon: Settings, badge: false as const },
];

const COLLAPSED_KEY = "admin_sidebar_collapsed";

export function AdminLayout({ children, title }: AdminLayoutProps) {
  const [location] = useLocation();
  const { isAuthenticated, logout, isLoading, role } = useAuth();
  const [pendingReviews, setPendingReviews] = useState(0);
  const [pendingComments, setPendingComments] = useState(0);
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem(COLLAPSED_KEY) === "true"; } catch { return false; }
  });

  const toggleCollapsed = () => {
    setCollapsed((v) => {
      const next = !v;
      try { localStorage.setItem(COLLAPSED_KEY, String(next)); } catch { /* ignore */ }
      return next;
    });
  };

  const isAdmin = role === "admin";

  useEffect(() => {
    if (isLoading || !isAdmin) return;
    fetch("/api/admin/reviews/count", { credentials: "include" })
      .then((cr) => cr.json())
      .then((d: { total?: number }) => setPendingReviews(d.total ?? 0))
      .catch(() => {});
    fetch("/api/admin/comments/pending/count", { credentials: "include" })
      .then((cr) => cr.json())
      .then((d: { total?: number }) => setPendingComments(d.total ?? 0))
      .catch(() => {});
  }, [isLoading, isAdmin]);

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-muted-foreground">Loading…</div>
      </div>
    );
  }

  if (!isAuthenticated || !isAdmin) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-4">
        <div className="text-center space-y-4 max-w-md">
          <Shield className="w-16 h-16 text-muted-foreground mx-auto" />
          <h1 className="text-2xl font-bold text-foreground">Access Denied</h1>
          <p className="text-muted-foreground">
            This area is restricted to administrators only.
          </p>
          {isAuthenticated && (
            <div className="text-left bg-card border border-border rounded-sm p-4 text-sm text-muted-foreground space-y-2">
              <p className="font-semibold text-foreground">First-time setup?</p>
              <p>
                Set the <code className="bg-muted px-1 rounded">ADMIN_USER_IDS</code> environment variable to your Replit user ID (comma-separated for multiple admins). Your ID is shown in your{" "}
                <Link href="/profile" className="text-primary hover:underline">profile page</Link>.
              </p>
            </div>
          )}
          <Link href="/" className="text-primary hover:underline text-sm">
            ← Back to site
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background flex">
      <aside
        className={`shrink-0 bg-card border-r border-border flex flex-col transition-all duration-200 ${
          collapsed ? "w-14" : "w-56"
        }`}
      >
        <div className={`border-b border-border flex items-center ${collapsed ? "justify-center p-3" : "justify-between p-4"}`}>
          {!collapsed && (
            <div className="flex items-center gap-2 min-w-0">
              <Shield className="w-5 h-5 text-primary shrink-0" />
              <span className="font-display font-bold text-foreground uppercase tracking-widest text-sm truncate">
                Admin
              </span>
            </div>
          )}
          <button
            onClick={toggleCollapsed}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors shrink-0"
          >
            {collapsed ? (
              <PanelLeftOpen className="w-4 h-4" />
            ) : (
              <PanelLeftClose className="w-4 h-4" />
            )}
          </button>
        </div>

        <nav className="flex-1 p-2 space-y-1">
          {NAV_ITEMS.map(({ href, label, icon: Icon, exact, badge }) => {
            const active = exact
              ? location === href
              : location.startsWith(href);
            const badgeCount = badge === "moderation" ? pendingReviews + pendingComments : 0;
            return (
              <Link key={href} href={href}>
                <div
                  title={collapsed ? label : undefined}
                  className={`flex items-center rounded-sm cursor-pointer transition-colors ${
                    collapsed ? "justify-center px-2 py-2.5" : "gap-3 px-3 py-2.5"
                  } ${
                    active
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:text-foreground hover:bg-muted"
                  }`}
                >
                  <div className="relative shrink-0">
                    <Icon className="w-4 h-4" />
                    {collapsed && badgeCount > 0 && (
                      <span className="absolute -top-1.5 -right-1.5 w-3.5 h-3.5 flex items-center justify-center text-[8px] font-bold rounded-full bg-destructive text-destructive-foreground leading-none">
                        {badgeCount > 9 ? "9+" : badgeCount}
                      </span>
                    )}
                  </div>
                  {!collapsed && (
                    <>
                      <span className="text-sm font-medium flex-1">{label}</span>
                      {badgeCount > 0 && (
                        <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full leading-none ${
                          active ? "bg-primary-foreground/20 text-primary-foreground" : "bg-destructive text-destructive-foreground"
                        }`}>
                          {badgeCount}
                        </span>
                      )}
                    </>
                  )}
                </div>
              </Link>
            );
          })}
        </nav>
      </aside>

      <main className="flex-1 min-w-0 flex flex-col">
        <header className="border-b border-border px-6 py-3 bg-card flex items-center justify-between gap-4">
          <h1 className="text-xl font-display font-bold text-foreground uppercase tracking-wide">
            {title}
          </h1>
          <div className="flex items-center gap-1 shrink-0">
            <Link href="/">
              <div className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground hover:bg-muted rounded-sm cursor-pointer transition-colors">
                <ChevronRight className="w-4 h-4" />
                <span>View Site</span>
              </div>
            </Link>
            <button
              onClick={() => logout()}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-muted-foreground hover:text-destructive hover:bg-muted rounded-sm cursor-pointer transition-colors"
            >
              <LogOut className="w-4 h-4" />
              <span>Log Out</span>
            </button>
          </div>
        </header>
        <div className="flex-1 p-6 overflow-auto">{children}</div>
      </main>
    </div>
  );
}
