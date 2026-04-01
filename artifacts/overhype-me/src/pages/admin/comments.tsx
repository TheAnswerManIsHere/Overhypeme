import { useState, useEffect, useCallback } from "react";
import { AdminLayout } from "@/components/admin/AdminLayout";
import { Link } from "wouter";
import { CheckCircle, XCircle, Trash2, MessageSquare, ExternalLink, Clock, AlertTriangle, User } from "lucide-react";

interface CommentAuthor {
  authorId: string | null;
  authorFirstName: string | null;
  authorLastName: string | null;
  authorDisplayName: string | null;
  authorEmail: string | null;
}

interface PendingComment extends CommentAuthor {
  id: number;
  factId: number;
  text: string;
  createdAt: string;
}

interface FlaggedComment extends CommentAuthor {
  id: number;
  factId: number;
  text: string;
  flagReason: string | null;
  createdAt: string;
}

type Tab = "pending" | "flagged";

interface RejectModalState {
  commentId: number;
  note: string;
}

function AuthorInfo({ comment }: { comment: CommentAuthor }) {
  const name = [comment.authorFirstName, comment.authorLastName].filter(Boolean).join(" ");
  const displayName = comment.authorDisplayName;
  const email = comment.authorEmail;

  if (!comment.authorId) {
    return <span className="text-xs text-muted-foreground italic">Anonymous</span>;
  }

  return (
    <div className="flex items-start gap-1.5 mt-2">
      <User className="w-3.5 h-3.5 text-muted-foreground mt-0.5 shrink-0" />
      <div className="text-xs text-muted-foreground space-y-0.5">
        {(displayName || name) && (
          <div>
            <span className="font-medium text-foreground">{displayName ?? name}</span>
            {displayName && name && displayName !== name && <span className="text-muted-foreground"> ({name})</span>}
          </div>
        )}
        {email && <div>{email}</div>}
        {!name && !displayName && !email && (
          <span className="italic">ID: {comment.authorId}</span>
        )}
      </div>
    </div>
  );
}

export default function AdminComments() {
  const [tab, setTab] = useState<Tab>("pending");
  const [pending, setPending] = useState<PendingComment[]>([]);
  const [flagged, setFlagged] = useState<FlaggedComment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [rejectModal, setRejectModal] = useState<RejectModalState | null>(null);

  const loadPending = useCallback(() => {
    setLoading(true);
    setError(null);
    fetch("/api/admin/comments/pending", { credentials: "include" })
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json() as Promise<{ comments: PendingComment[] }>; })
      .then((d) => setPending(d.comments))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Failed to load"))
      .finally(() => setLoading(false));
  }, []);

  const loadFlagged = useCallback(() => {
    setLoading(true);
    setError(null);
    fetch("/api/admin/comments/flagged", { credentials: "include" })
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json() as Promise<{ comments: FlaggedComment[] }>; })
      .then((d) => setFlagged(d.comments))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Failed to load"))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (tab === "pending") loadPending();
    else loadFlagged();
  }, [tab, loadPending, loadFlagged]);

  const approve = async (id: number) => {
    const r = await fetch(`/api/admin/comments/${id}/approve`, { method: "POST", credentials: "include" });
    if (r.ok) {
      setPending((p) => p.filter((c) => c.id !== id));
      setFlagged((p) => p.filter((c) => c.id !== id));
    } else {
      alert(`Failed to approve (${r.status})`);
    }
  };

  const openRejectModal = (id: number) => {
    setRejectModal({ commentId: id, note: "" });
  };

  const confirmReject = async () => {
    if (!rejectModal) return;
    const { commentId, note } = rejectModal;
    const r = await fetch(`/api/admin/comments/${commentId}/reject`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ note: note.trim() || undefined }),
    });
    if (r.ok) {
      setPending((p) => p.filter((c) => c.id !== commentId));
      setFlagged((p) => p.filter((c) => c.id !== commentId));
      setRejectModal(null);
    } else {
      alert(`Failed to reject (${r.status})`);
    }
  };

  const deleteComment = async (id: number) => {
    const r = await fetch(`/api/admin/comments/${id}`, { method: "DELETE", credentials: "include" });
    if (r.ok) {
      setPending((p) => p.filter((c) => c.id !== id));
      setFlagged((p) => p.filter((c) => c.id !== id));
    } else {
      alert(`Failed to delete (${r.status})`);
    }
  };

  const currentList = tab === "pending" ? pending : flagged;

  return (
    <AdminLayout title="Comments">
      <div className="space-y-6">
        {/* Rejection note modal */}
        {rejectModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
            <div className="bg-card border border-border rounded-sm p-6 w-full max-w-md space-y-4 shadow-xl">
              <h2 className="text-base font-semibold text-foreground">Reject Comment</h2>
              <p className="text-sm text-muted-foreground">
                Optionally provide a reason for rejection. This will be included in the submitter's activity feed.
              </p>
              <textarea
                className="w-full border border-border rounded-sm bg-background text-foreground text-sm px-3 py-2 resize-none focus:outline-none focus:ring-1 focus:ring-primary"
                rows={3}
                placeholder="Reason for rejection (optional)"
                value={rejectModal.note}
                onChange={(e) => setRejectModal((m) => m ? { ...m, note: e.target.value } : m)}
              />
              <div className="flex gap-2 justify-end">
                <button
                  onClick={() => setRejectModal(null)}
                  className="px-4 py-2 text-sm font-medium bg-muted text-muted-foreground border border-border rounded-sm hover:bg-muted/80 transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={confirmReject}
                  className="px-4 py-2 text-sm font-medium bg-destructive/10 text-destructive border border-destructive/30 rounded-sm hover:bg-destructive/20 transition-colors"
                >
                  Confirm Reject
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Tabs */}
        <div className="flex gap-1 border-b border-border">
          <button
            onClick={() => setTab("pending")}
            className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors -mb-px ${
              tab === "pending"
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            <Clock className="w-3.5 h-3.5" />
            Pending
            {pending.length > 0 && (
              <span className="bg-destructive text-destructive-foreground text-[10px] font-bold px-1.5 py-0.5 rounded-full leading-none">
                {pending.length}
              </span>
            )}
          </button>
          <button
            onClick={() => setTab("flagged")}
            className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors -mb-px ${
              tab === "flagged"
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            <AlertTriangle className="w-3.5 h-3.5" />
            Flagged
            {flagged.length > 0 && (
              <span className="bg-orange-500 text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full leading-none">
                {flagged.length}
              </span>
            )}
          </button>
        </div>

        {/* Description */}
        <p className="text-sm text-muted-foreground">
          {tab === "pending"
            ? "New comments waiting for your approval before they appear publicly."
            : "Previously approved comments that were later flagged by AI for spam or abuse."}
        </p>

        {loading && <div className="text-muted-foreground text-sm">Loading…</div>}
        {error && <div className="text-destructive text-sm">Error: {error}</div>}

        {!loading && !error && currentList.length === 0 && (
          <div className="text-center py-16 text-muted-foreground">
            <MessageSquare className="w-12 h-12 mx-auto mb-4 opacity-30" />
            <p className="text-lg font-medium">
              {tab === "pending" ? "No pending comments" : "No flagged comments"}
            </p>
            <p className="text-sm mt-1">
              {tab === "pending" ? "All caught up." : "Nothing flagged by AI yet. Good sign."}
            </p>
          </div>
        )}

        {!loading && !error && currentList.length > 0 && (
          <div className="space-y-4">
            {currentList.map((c) => (
              <div key={c.id} className="bg-card border border-border rounded-sm p-5 space-y-3">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <p className="text-foreground">{c.text}</p>
                    {"flagReason" in c && c.flagReason && (
                      <p className="text-xs text-destructive mt-1.5 font-medium">
                        AI flag reason: {c.flagReason}
                      </p>
                    )}
                    <div className="flex items-center gap-3 mt-2 text-xs text-muted-foreground">
                      <span>{new Date(c.createdAt).toLocaleString()}</span>
                      <span>·</span>
                      <Link href={`/facts/${c.factId}`} className="flex items-center gap-1 hover:text-primary transition-colors">
                        <ExternalLink className="w-3 h-3" />
                        Fact #{c.factId}
                      </Link>
                    </div>
                    <AuthorInfo comment={c} />
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
                      onClick={() => openRejectModal(c.id)}
                      className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-destructive/10 text-destructive border border-destructive/30 rounded-sm hover:bg-destructive/20 transition-colors"
                    >
                      <XCircle className="w-3.5 h-3.5" />
                      Reject
                    </button>
                    <button
                      onClick={() => deleteComment(c.id)}
                      className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-muted text-muted-foreground border border-border rounded-sm hover:bg-destructive/10 hover:text-destructive hover:border-destructive/30 transition-colors"
                      title="Permanently delete"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
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
