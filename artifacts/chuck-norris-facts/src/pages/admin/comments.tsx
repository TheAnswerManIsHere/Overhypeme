import { useState } from "react";
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

function useFlaggedComments() {
  const [comments, setComments] = useState<FlaggedComment[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const load = async () => {
    if (loaded) return;
    setLoading(true);
    try {
      const r = await fetch("/api/admin/comments/flagged", { credentials: "include" });
      if (r.ok) {
        const data: { comments: FlaggedComment[] } = await r.json();
        setComments(data.comments);
        setLoaded(true);
      }
    } finally {
      setLoading(false);
    }
  };

  return { comments, loading, load, setComments };
}

export default function AdminComments() {
  const { comments, loading, load, setComments } = useFlaggedComments();

  if (comments === null && !loading) {
    load();
  }

  const approve = async (id: number) => {
    await fetch(`/api/admin/comments/${id}/approve`, { method: "POST", credentials: "include" });
    setComments((prev) => prev?.filter((c) => c.id !== id) ?? null);
  };

  const reject = async (id: number) => {
    await fetch(`/api/admin/comments/${id}`, { method: "DELETE", credentials: "include" });
    setComments((prev) => prev?.filter((c) => c.id !== id) ?? null);
  };

  return (
    <AdminLayout title="Flagged Comments">
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            Comments auto-flagged by AI for spam or abuse. Approve to restore or reject to delete.
          </p>
          <span className="text-sm font-medium text-foreground">
            {comments !== null ? `${comments.length} flagged` : ""}
          </span>
        </div>

        {loading && (
          <div className="text-muted-foreground text-sm">Loading flagged comments…</div>
        )}

        {comments !== null && comments.length === 0 && (
          <div className="text-center py-16 text-muted-foreground">
            <MessageSquare className="w-12 h-12 mx-auto mb-4 opacity-30" />
            <p className="text-lg font-medium">No flagged comments</p>
            <p className="text-sm mt-1">The AI hasn't flagged any comments yet. Good sign.</p>
          </div>
        )}

        {comments !== null && comments.length > 0 && (
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
