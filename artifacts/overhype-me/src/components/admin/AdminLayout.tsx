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
  MessageSquareWarning,
  ShoppingBag,
  ClipboardList,
} from "lucide-react";

interface AdminLayoutProps {
  children: ReactNode;
  title: string;
}

const NAV_ITEMS = [
  { href: "/admin", label: "Dashboard", icon: LayoutDashboard, exact: true, badge: false as const },
  { href: "/admin/facts", label: "Facts", icon: FileText, badge: false as const },
  { href: "/admin/users", label: "Users", icon: Users, badge: false as const },
  { href: "/admin/reviews", label: "Reviews", icon: ClipboardList, badge: "reviews" as const },
  { href: "/admin/comments", label: "Comments", icon: MessageSquareWarning, badge: "comments" as const },
  { href: "/admin/billing", label: "Billing", icon: CreditCard, badge: false as const },
  { href: "/admin/affiliate", label: "Affiliate", icon: ShoppingBag, badge: false as const },
];

export function AdminLayout({ children, title }: AdminLayoutProps) {
  const [location] = useLocation();
  const { isAuthenticated, logout, isLoading } = useAuth();
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);
  const [pendingReviews, setPendingReviews] = useState(0);
  const [pendingComments, setPendingComments] = useState(0);

  useEffect(() => {
    if (isLoading) return;
    if (!isAuthenticated) {
      setIsAdmin(false);
      return;
    }
    fetch("/api/admin/me", { credentials: "include" })
      .then((r) => {
        setIsAdmin(r.ok);
        if (r.ok) {
          fetch("/api/admin/reviews/count", { credentials: "include" })
            .then((cr) => cr.json())
            .then((d: { total?: number }) => setPendingReviews(d.total ?? 0))
            .catch(() => {});
          fetch("/api/admin/comments/pending/count", { credentials: "include" })
            .then((cr) => cr.json())
            .then((d: { total?: number }) => setPendingComments(d.total ?? 0))
            .catch(() => {});
        }
      })
      .catch(() => setIsAdmin(false));
  }, [isAuthenticated, isLoading]);

  if (isLoading || isAdmin === null) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-muted-foreground">Loading…</div>
      </div>
    );
  }

  if (!isAuthenticated || isAdmin === false) {
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
      <aside className="w-56 shrink-0 bg-card border-r border-border flex flex-col">
        <div className="p-4 border-b border-border">
          <div className="flex items-center gap-2">
            <Shield className="w-5 h-5 text-primary" />
            <span className="font-display font-bold text-foreground uppercase tracking-widest text-sm">
              Admin
            </span>
          </div>
        </div>

        <nav className="flex-1 p-2 space-y-1">
          {NAV_ITEMS.map(({ href, label, icon: Icon, exact, badge }) => {
            const active = exact
              ? location === href
              : location.startsWith(href);
            const badgeCount = badge === "reviews" ? pendingReviews : badge === "comments" ? pendingComments : 0;
            return (
              <Link key={href} href={href}>
                <div
                  className={`flex items-center gap-3 px-3 py-2.5 rounded-sm cursor-pointer transition-colors ${
                    active
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:text-foreground hover:bg-muted"
                  }`}
                >
                  <Icon className="w-4 h-4 shrink-0" />
                  <span className="text-sm font-medium flex-1">{label}</span>
                  {badgeCount > 0 && (
                    <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full leading-none ${
                      active ? "bg-primary-foreground/20 text-primary-foreground" : "bg-destructive text-destructive-foreground"
                    }`}>
                      {badgeCount}
                    </span>
                  )}
                </div>
              </Link>
            );
          })}
        </nav>

        <div className="p-2 border-t border-border">
          <Link href="/">
            <div className="flex items-center gap-3 px-3 py-2.5 text-muted-foreground hover:text-foreground hover:bg-muted rounded-sm cursor-pointer transition-colors">
              <ChevronRight className="w-4 h-4" />
              <span className="text-sm font-medium">View Site</span>
            </div>
          </Link>
          <button
            onClick={() => logout()}
            className="w-full flex items-center gap-3 px-3 py-2.5 text-muted-foreground hover:text-destructive hover:bg-muted rounded-sm cursor-pointer transition-colors"
          >
            <LogOut className="w-4 h-4" />
            <span className="text-sm font-medium">Log Out</span>
          </button>
        </div>
      </aside>

      <main className="flex-1 min-w-0 flex flex-col">
        <header className="border-b border-border px-6 py-4 bg-card">
          <h1 className="text-xl font-display font-bold text-foreground uppercase tracking-wide">
            {title}
          </h1>
        </header>
        <div className="flex-1 p-6 overflow-auto">{children}</div>
      </main>
    </div>
  );
}
