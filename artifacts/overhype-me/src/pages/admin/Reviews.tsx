import { useState } from "react";
import { AdminLayout } from "@/components/admin/AdminLayout";
import { Button } from "@/components/ui/Button";
import {
  CheckCircle2, XCircle, Clock, ChevronLeft, ChevronRight,
  ExternalLink, ClipboardList, Loader2, AlertTriangle,
} from "lucide-react";

interface Submitter {
  id: string;
  username: string | null;
  firstName: string | null;
  email: string | null;
}

interface MatchingFact {
  id: number;
  text: string;
  score?: number;
}

interface Review {
  id: number;
  submittedText: string;
  matchingSimilarity: number;
  status: "pending" | "approved" | "rejected";
  reason: string | null;
  adminNote: string | null;
  createdAt: string;
  reviewedAt: string | null;
  submitter: Submitter | null;
  matchingFact: MatchingFact | null;
  approvedFactId: number | null;
}

interface ReviewsResponse {
  reviews: Review[];
  total: number;
  page: number;
  limit: number;
}

function useReviews(status: string, page: number) {
  const [data, setData] = useState<ReviewsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const r = await fetch(`/api/admin/reviews?status=${status}&page=${page}&limit=20`, {
        credentials: "include",
      });
      if (!r.ok) throw new Error("Failed to load reviews");
      setData(await r.json() as ReviewsResponse);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  return { data, loading, error, load };
}

function StatusBadge({ status }: { status: Review["status"] }) {
  const styles = {
    pending: "bg-yellow-500/15 text-yellow-600 dark:text-yellow-400 border-yellow-500/30",
    approved: "bg-green-500/15 text-green-600 dark:text-green-400 border-green-500/30",
    rejected: "bg-red-500/15 text-red-500 border-red-500/30",
  };
  const icons = { pending: Clock, approved: CheckCircle2, rejected: XCircle };
  const Icon = icons[status];
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 text-xs font-semibold rounded-full border ${styles[status]}`}>
      <Icon className="w-3 h-3" /> {status}
    </span>
  );
}

function ReasonBadge({ reason }: { reason: string | null }) {
  if (reason === "malformed_template") {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-semibold rounded-full border bg-orange-500/15 text-orange-600 dark:text-orange-400 border-orange-500/30">
        <AlertTriangle className="w-3 h-3" /> Malformed Template
      </span>
    );
  }
  if (reason === "duplicate") {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-semibold rounded-full border bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/30">
        Duplicate Conflict
      </span>
    );
  }
  return null;
}

function ReviewModal({
  review,
  onClose,
  onDecision,
}: {
  review: Review;
  onClose: () => void;
  onDecision: (id: number, action: "approve" | "reject", note: string) => Promise<void>;
}) {
  const [note, setNote] = useState(review.adminNote ?? "");
  const [loading, setLoading] = useState(false);

  const handle = async (action: "approve" | "reject") => {
    setLoading(true);
    await onDecision(review.id, action, note);
    setLoading(false);
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-card border-2 border-border rounded-sm w-full max-w-3xl shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-border px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3 flex-wrap">
            <ClipboardList className="w-5 h-5 text-primary" />
            <h2 className="font-display font-bold uppercase tracking-wide text-foreground">Review #{review.id}</h2>
            <StatusBadge status={review.status} />
            <ReasonBadge reason={review.reason} />
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground text-xl leading-none">×</button>
        </div>

        <div className="p-6 space-y-6">
          {/* Metadata */}
          <div className="flex flex-wrap gap-4 text-sm text-muted-foreground">
            <span>Submitted by: <strong className="text-foreground">{review.submitter?.username ?? review.submitter?.firstName ?? "Unknown"}</strong></span>
            {review.submitter?.email && <span>Email: <strong className="text-foreground">{review.submitter.email}</strong></span>}
            <span>Similarity: <strong className="text-foreground">{review.matchingSimilarity}%</strong></span>
            <span>Date: <strong className="text-foreground">{new Date(review.createdAt).toLocaleDateString()}</strong></span>
          </div>

          {/* Side-by-side */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="bg-background border-2 border-border rounded-sm p-4">
              <p className="text-xs font-bold text-muted-foreground uppercase tracking-wide mb-3">Submitted Fact</p>
              <p className="text-base italic text-foreground leading-relaxed">"{review.submittedText}"</p>
            </div>

            <div className="bg-background border-2 border-primary/40 rounded-sm p-4">
              <div className="flex items-center justify-between mb-3">
                <p className="text-xs font-bold text-primary uppercase tracking-wide">Flagged Duplicate</p>
                {review.matchingFact && (
                  <a
                    href={`/facts/${review.matchingFact.id}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-xs text-primary hover:underline flex items-center gap-1"
                  >
                    View <ExternalLink className="w-3 h-3" />
                  </a>
                )}
              </div>
              {review.matchingFact ? (
                <p className="text-base italic text-foreground leading-relaxed">"{review.matchingFact.text}"</p>
              ) : (
                <p className="text-muted-foreground text-sm italic">Original fact no longer available</p>
              )}
            </div>
          </div>

          {/* Admin note */}
          {review.status === "pending" && (
            <div>
              <label className="block text-sm font-semibold text-foreground mb-2">Admin Note (optional, sent to user)</label>
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={3}
                maxLength={500}
                placeholder="Explain your decision to help the user understand…"
                className="w-full px-3 py-2 bg-background border border-border rounded-sm text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary resize-none"
              />
            </div>
          )}

          {review.adminNote && review.status !== "pending" && (
            <div className="bg-muted/40 border border-border rounded-sm p-3">
              <p className="text-xs font-semibold text-muted-foreground uppercase mb-1">Admin Note</p>
              <p className="text-sm text-foreground">{review.adminNote}</p>
            </div>
          )}

          {/* Actions */}
          {review.status === "pending" ? (
            <div className="flex flex-wrap gap-3 pt-2 border-t border-border">
              <Button
                onClick={() => handle("approve")}
                isLoading={loading}
                className="bg-green-600 hover:bg-green-700 text-white gap-2"
              >
                <CheckCircle2 className="w-4 h-4" />
                Approve — Add to Database
              </Button>
              <Button
                variant="outline"
                onClick={() => handle("reject")}
                isLoading={loading}
                className="border-destructive text-destructive hover:bg-destructive/10 gap-2"
              >
                <XCircle className="w-4 h-4" />
                Reject
              </Button>
              <Button variant="outline" onClick={onClose} disabled={loading}>Cancel</Button>
            </div>
          ) : (
            <div className="flex gap-3 pt-2 border-t border-border">
              {review.status === "approved" && review.approvedFactId && (
                <a href={`/facts/${review.approvedFactId}`} target="_blank" rel="noreferrer">
                  <Button variant="outline" className="gap-2">
                    <ExternalLink className="w-4 h-4" /> View Approved Fact
                  </Button>
                </a>
              )}
              <Button variant="outline" onClick={onClose}>Close</Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function AdminReviews() {
  const [statusFilter, setStatusFilter] = useState<"pending" | "approved" | "rejected" | "all">("pending");
  const [page, setPage] = useState(1);
  const [selectedReview, setSelectedReview] = useState<Review | null>(null);
  const [actionMsg, setActionMsg] = useState("");

  const { data, loading, error, load } = useReviews(statusFilter, page);

  // Load on mount and when filter/page changes
  const [initialized, setInitialized] = useState(false);
  if (!initialized) { setInitialized(true); void load(); }

  const handleFilterChange = (f: typeof statusFilter) => {
    setStatusFilter(f);
    setPage(1);
    setInitialized(false);
  };

  const handleDecision = async (id: number, action: "approve" | "reject", note: string) => {
    setActionMsg("");
    const r = await fetch(`/api/admin/reviews/${id}/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ adminNote: note || undefined }),
    });
    if (r.ok) {
      setActionMsg(`Review #${id} ${action}d successfully.`);
      setSelectedReview(null);
      setInitialized(false);
      void load();
    } else {
      const d = await r.json() as { error?: string };
      setActionMsg(`Error: ${d.error ?? "Unknown error"}`);
    }
  };

  const totalPages = data ? Math.ceil(data.total / data.limit) : 1;

  const FILTERS: { label: string; value: typeof statusFilter }[] = [
    { label: "Pending", value: "pending" },
    { label: "Approved", value: "approved" },
    { label: "Rejected", value: "rejected" },
    { label: "All", value: "all" },
  ];

  return (
    <AdminLayout title="Duplicate Reviews">
      <div className="space-y-4">
        {/* Filters */}
        <div className="flex items-center gap-2 flex-wrap">
          {FILTERS.map((f) => (
            <button
              key={f.value}
              onClick={() => handleFilterChange(f.value)}
              className={`px-4 py-1.5 text-sm font-medium rounded-sm border transition-colors ${
                statusFilter === f.value
                  ? "bg-primary text-primary-foreground border-primary"
                  : "bg-card text-muted-foreground border-border hover:text-foreground"
              }`}
            >
              {f.label}
            </button>
          ))}
          <button
            onClick={() => { setInitialized(false); void load(); }}
            className="ml-auto text-xs text-muted-foreground hover:text-foreground flex items-center gap-1"
            disabled={loading}
          >
            {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
            Refresh
          </button>
        </div>

        {actionMsg && (
          <div className={`p-3 rounded-sm text-sm ${actionMsg.startsWith("Error") ? "bg-destructive/10 text-destructive" : "bg-green-500/10 text-green-600"}`}>
            {actionMsg}
          </div>
        )}

        {error && <div className="p-3 bg-destructive/10 text-destructive text-sm rounded-sm">{error}</div>}

        {loading && !data && (
          <div className="flex justify-center py-16">
            <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
          </div>
        )}

        {data && data.reviews.length === 0 && (
          <div className="text-center py-16 text-muted-foreground">
            <ClipboardList className="w-12 h-12 mx-auto mb-3 opacity-30" />
            <p>No {statusFilter === "all" ? "" : statusFilter} reviews found.</p>
          </div>
        )}

        {data && data.reviews.length > 0 && (
          <div className="space-y-3">
            {data.reviews.map((r) => (
              <div
                key={r.id}
                className="bg-card border border-border rounded-sm p-4 hover:border-primary/40 cursor-pointer transition-colors"
                onClick={() => setSelectedReview(r)}
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-3 mb-2 flex-wrap">
                      <StatusBadge status={r.status} />
                      <ReasonBadge reason={r.reason} />
                      <span className="text-xs text-muted-foreground">
                        {r.reason !== "malformed_template" && `${r.matchingSimilarity}% match · `}by {r.submitter?.username ?? r.submitter?.firstName ?? "unknown"} · {new Date(r.createdAt).toLocaleDateString()}
                      </span>
                    </div>
                    <p className="text-sm text-foreground italic line-clamp-2">"{r.submittedText}"</p>
                    {r.matchingFact && (
                      <p className="text-xs text-muted-foreground mt-1 truncate">
                        vs. "{r.matchingFact.text}"
                      </p>
                    )}
                  </div>
                  <button
                    className="shrink-0 text-xs text-primary hover:underline whitespace-nowrap"
                    onClick={(e) => { e.stopPropagation(); setSelectedReview(r); }}
                  >
                    {r.status === "pending" ? "Review →" : "Details →"}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Pagination */}
        {data && totalPages > 1 && (
          <div className="flex items-center justify-between pt-4">
            <span className="text-sm text-muted-foreground">
              Page {data.page} of {totalPages} · {data.total} total
            </span>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={page <= 1}
                onClick={() => { setPage(p => p - 1); setInitialized(false); }}
              >
                <ChevronLeft className="w-4 h-4" />
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={page >= totalPages}
                onClick={() => { setPage(p => p + 1); setInitialized(false); }}
              >
                <ChevronRight className="w-4 h-4" />
              </Button>
            </div>
          </div>
        )}
      </div>

      {selectedReview && (
        <ReviewModal
          review={selectedReview}
          onClose={() => setSelectedReview(null)}
          onDecision={handleDecision}
        />
      )}
    </AdminLayout>
  );
}
