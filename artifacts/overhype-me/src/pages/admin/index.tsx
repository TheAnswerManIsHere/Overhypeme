import { useEffect, useState } from "react";
import { AdminLayout } from "@/components/admin/AdminLayout";
import { CollapsibleSection } from "@/components/CollapsibleSection";
import { FileText, Users, TrendingUp, Shield, Zap, Settings } from "lucide-react";

interface Stats {
  totalFacts: number;
  totalUsers: number;
}

export default function AdminDashboard() {
  const [stats, setStats] = useState<Stats | null>(null);

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
