import { useState, useEffect } from "react";
import { useLocation, Link } from "wouter";
import { useAuth } from "@workspace/replit-auth-web";
import { Layout } from "@/components/layout/Layout";
import { Button } from "@/components/ui/Button";
import {
  Activity, CheckCircle2, XCircle, ClipboardList, MessageSquare,
  ThumbsUp, FileText, Bell, Loader2, ChevronLeft, ChevronRight,
  ShieldAlert,
} from "lucide-react";

type ActivityType =
  | "fact_submitted"
  | "fact_approved"
  | "duplicate_flagged"
  | "review_submitted"
  | "review_approved"
  | "review_rejected"
  | "comment_posted"
  | "comment_approved"
  | "comment_rejected"
  | "vote_cast"
  | "system_message";

interface ActivityEntry {
  id: number;
  actionType: ActivityType;
  message: string;
  metadata: Record<string, unknown> | null;
  read: boolean;
  createdAt: string;
}

interface FeedResponse {
  entries: ActivityEntry[];
  total: number;
  unread: number;
  page: number;
  limit: number;
}

const ACTION_META: Record<ActivityType, { icon: React.ElementType; color: string; label: string }> = {
  fact_submitted:    { icon: FileText,      color: "text-blue-500",   label: "Fact Submitted" },
  fact_approved:     { icon: CheckCircle2,  color: "text-green-500",  label: "Fact Approved" },
  duplicate_flagged: { icon: ClipboardList, color: "text-yellow-500", label: "Duplicate Flagged" },
  review_submitted:  { icon: ClipboardList, color: "text-orange-500", label: "Review Submitted" },
  review_approved:   { icon: CheckCircle2,  color: "text-green-500",  label: "Review Approved" },
  review_rejected:   { icon: XCircle,       color: "text-red-500",    label: "Review Rejected" },
  comment_posted:    { icon: MessageSquare, color: "text-purple-500", label: "Comment Submitted" },
  comment_approved:  { icon: CheckCircle2,  color: "text-green-500",  label: "Comment Approved" },
  comment_rejected:  { icon: XCircle,       color: "text-red-500",    label: "Comment Rejected" },
  vote_cast:         { icon: ThumbsUp,      color: "text-primary",    label: "Vote Cast" },
  system_message:    { icon: Bell,          color: "text-muted-foreground", label: "System" },
};

function TimeAgo({ iso }: { iso: string }) {
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return <span>just now</span>;
  if (mins < 60) return <span>{mins}m ago</span>;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return <span>{hrs}h ago</span>;
  const days = Math.floor(hrs / 24);
  if (days < 7) return <span>{days}d ago</span>;
  return <span>{new Date(iso).toLocaleDateString()}</span>;
}

function EntryCard({ entry }: { entry: ActivityEntry }) {
  const meta = ACTION_META[entry.actionType] ?? ACTION_META.system_message;
  const Icon = meta.icon;

  const factId = entry.metadata?.factId as number | undefined;
  const reviewId = entry.metadata?.reviewId as number | undefined;

  return (
    <div className={`flex gap-4 p-4 rounded-sm border transition-colors ${entry.read ? "bg-card border-border" : "bg-primary/5 border-primary/20"}`}>
      <div className={`shrink-0 w-9 h-9 rounded-full bg-muted flex items-center justify-center ${meta.color}`}>
        <Icon className="w-4 h-4" />
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1 flex-wrap">
          <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">{meta.label}</span>
          {!entry.read && (
            <span className="w-2 h-2 rounded-full bg-primary shrink-0" title="Unread" />
          )}
          <span className="text-xs text-muted-foreground ml-auto"><TimeAgo iso={entry.createdAt} /></span>
        </div>

        <p className="text-sm text-foreground leading-relaxed">{entry.message}</p>

        {entry.metadata?.text && (
          <p className="text-xs text-muted-foreground italic mt-1 truncate">
            "{String(entry.metadata.text)}"
          </p>
        )}

        {/* Action links */}
        <div className="flex gap-3 mt-2">
          {factId && (
            <Link href={`/facts/${factId}`} className="text-xs text-primary hover:underline">
              View fact →
            </Link>
          )}
          {reviewId && !factId && (
            <span className="text-xs text-muted-foreground">Review #{reviewId}</span>
          )}
        </div>
      </div>
    </div>
  );
}

export default function ActivityFeed() {
  const { isAuthenticated, isLoading: authLoading } = useAuth();
  const [, setLocation] = useLocation();
  const [data, setData] = useState<FeedResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);

  const load = async (p = page) => {
    setLoading(true);
    try {
      const r = await fetch(`/api/activity-feed?page=${p}&limit=20`, { credentials: "include" });
      if (r.ok) setData(await r.json() as FeedResponse);
    } finally {
      setLoading(false);
    }
  };

  const markAllRead = async () => {
    await fetch("/api/activity-feed/mark-read", { method: "POST", credentials: "include" });
    setData((prev) => prev ? { ...prev, unread: 0, entries: prev.entries.map((e) => ({ ...e, read: true })) } : prev);
  };

  useEffect(() => {
    if (isAuthenticated) void load(page);
  }, [isAuthenticated, page]);

  if (authLoading) {
    return (
      <Layout>
        <div className="flex h-[50vh] items-center justify-center">
          <div className="w-10 h-10 border-4 border-primary border-t-transparent rounded-full animate-spin" />
        </div>
      </Layout>
    );
  }

  if (!isAuthenticated) {
    return (
      <Layout>
        <div className="max-w-2xl mx-auto px-4 py-24 text-center">
          <ShieldAlert className="w-16 h-16 text-primary mx-auto mb-6 opacity-80" />
          <h1 className="text-3xl font-display uppercase mb-4">Login Required</h1>
          <p className="text-muted-foreground mb-6">Your activity feed is only visible when you're logged in.</p>
          <Button onClick={() => setLocation("/login")}>Log In</Button>
        </div>
      </Layout>
    );
  }

  const totalPages = data ? Math.ceil(data.total / data.limit) : 1;

  return (
    <Layout>
      <div className="max-w-2xl mx-auto px-4 py-12">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-3xl font-display uppercase tracking-wider text-foreground flex items-center gap-3">
              <Activity className="w-7 h-7 text-primary" />
              Activity Feed
            </h1>
            {data && data.unread > 0 && (
              <p className="text-sm text-muted-foreground mt-1">
                {data.unread} unread notification{data.unread !== 1 ? "s" : ""}
              </p>
            )}
          </div>
          {data && data.unread > 0 && (
            <Button size="sm" variant="outline" onClick={markAllRead}>
              Mark all read
            </Button>
          )}
        </div>

        {loading && !data && (
          <div className="flex justify-center py-20">
            <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
          </div>
        )}

        {data && data.entries.length === 0 && (
          <div className="text-center py-20 text-muted-foreground">
            <Activity className="w-14 h-14 mx-auto mb-4 opacity-20" />
            <p className="text-lg">No activity yet.</p>
            <p className="text-sm mt-2">
              Start by{" "}
              <Link href="/submit" className="text-primary underline">submitting a fact</Link>.
            </p>
          </div>
        )}

        {data && data.entries.length > 0 && (
          <div className="space-y-3">
            {data.entries.map((entry) => (
              <EntryCard key={entry.id} entry={entry} />
            ))}
          </div>
        )}

        {data && totalPages > 1 && (
          <div className="flex items-center justify-between mt-8">
            <span className="text-sm text-muted-foreground">
              Page {data.page} of {totalPages}
            </span>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>
                <ChevronLeft className="w-4 h-4" />
              </Button>
              <Button size="sm" variant="outline" disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}>
                <ChevronRight className="w-4 h-4" />
              </Button>
            </div>
          </div>
        )}
      </div>
    </Layout>
  );
}
