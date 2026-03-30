import { useState, useEffect } from "react";
import { AdminLayout } from "@/components/admin/AdminLayout";
import { Link } from "wouter";
import { CheckCircle, Trash2, MessageSquare, ExternalLink } from "lucide-react";

interface FlaggedComment {
  id: number;
  factId: number;
  text: string;
  authorId: string | null;
  flagReason: string | null;
  createdAt: string;
}

export default function AdminComments() {
  const [comments, setComments] = useState<FlaggedComment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch("/api/admin/comments/flagged", { credentials: "include" })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<{ comments: FlaggedComment[] }>;
      })
      .then((data) => {
        if (!cancelled) setComments(data.comments);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  const approve = async (id: number) => {
    await fetch(`/api/admin/comments/${id}/approve`, { method: "POST", credentials: "include" });
    setComments((prev) => prev.filter((c) => c.id !== id));
  };

  const reject = async (id: number) => {
    await fetch(`/api/admin/comments/${id}`, { method: "DELETE", credentials: "include" });
    setComments((prev) => prev.filter((c) => c.id !== id));
  };

  return (
    <AdminLayout title="Flagged Comments">
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            Comments auto-flagged by AI for spam or abuse. Approve to restore or reject to delete.
          </p>
          {!loading && (
            <span className="text-sm font-medium text-foreground">
              {comments.length} flagged
            </span>
          )}
        </div>

        {loading && (
          <div className="text-muted-foreground text-sm">Loading flagged comments…</div>
        )}

        {error && (
          <div className="text-destructive text-sm">Error: {error}</div>
        )}

        {!loading && !error && comments.length === 0 && (
          <div className="text-center py-16 text-muted-foreground">
            <MessageSquare className="w-12 h-12 mx-auto mb-4 opacity-30" />
            <p className="text-lg font-medium">No flagged comments</p>
            <p className="text-sm mt-1">The AI hasn&apos;t flagged any comments yet. Good sign.</p>
          </div>
        )}

        {!loading && !error && comments.length > 0 && (
          <div className="space-y-4">
            {comments.map((c) => (
              <div key={c.id} className="bg-card border border-border rounded-sm p-5 space-y-3">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <p className="text-foreground">{c.text}</p>
                    {c.flagReason && (
                      <p className="text-xs text-destructive mt-1.5 font-medium">
                        AI flag reason: {c.flagReason}
                      </p>
                    )}
                    <div className="flex items-center gap-3 mt-2 text-xs text-muted-foreground">
                      <span>{new Date(c.createdAt).toLocaleString()}</span>
                      <span>·</span>
                      <Link href={`/facts/${c.factId}`} className="flex items-center gap-1 hover:text-primary transition-colors">
                        <ExternalLink className="w-3 h-3" />
                        View fact #{c.factId}
                      </Link>
                    </div>
                  </div>
                  <div className="flex gap-2 shrink-0">
                    <button
                      onClick={() => approve(c.id)}
                      className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-green-500/10 text-green-600 border border-green-500/30 rounded-sm hover:bg-green-500/20 transition-colors"
                    >
                      <CheckCircle className="w-3.5 h-3.5" />
                      Approve
                    </button>
                    <button
                      onClick={() => reject(c.id)}
                      className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-destructive/10 text-destructive border border-destructive/30 rounded-sm hover:bg-destructive/20 transition-colors"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      Delete
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </AdminLayout>
  );
}
