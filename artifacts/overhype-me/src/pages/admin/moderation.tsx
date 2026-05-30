import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { AdminLayout } from "@/components/admin/AdminLayout";
import { useFormDraft } from "@/hooks/use-form-draft";
import type { StorageAdapter } from "@/lib/form-draft-storage";
import { Link } from "wouter";
import { Button } from "@/components/ui/Button";
import {
  CheckCircle, CheckCircle2, XCircle, Clock, ChevronLeft, ChevronRight,
  ExternalLink, ClipboardList, Loader2, AlertTriangle, GitBranch,
  MessageSquare, Trash2, User,
} from "lucide-react";
import type { FactEnrichment } from "@workspace/api-zod";
import { EnrichmentEditor, EnrichmentSummary, isApprovable } from "@/components/admin/EnrichmentEditor";

// ─── Shared ───────────────────────────────────────────────────────────────────

type ModerationSection = "facts" | "comments";

// ─── Fact Reviews (was "Duplicate Reviews") ───────────────────────────────────

interface Submitter {
  id: string;
  displayName: string | null;
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
  matchingFactId: number | null;
  matchingSimilarity: number;
  status: "pending" | "approved" | "rejected";
  reason: string | null;
  adminNote: string | null;
  createdAt: string;
  reviewedAt: string | null;
  submitter: Submitter | null;
  matchingFact: MatchingFact | null;
  approvedFactId: number | null;
  hashtags: string[] | null;
  enrichment: FactEnrichment | null;
  enrichmentStatus: string | null;
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

  const load = useCallback(async () => {
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
  }, [status, page]);

  return { data, loading, error, load };
}

function ReviewStatusBadge({ status }: { status: Review["status"] }) {
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
  if (reason === "duplicate") {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-semibold rounded-full border bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/30">
        Duplicate Conflict
      </span>
    );
  }
  if (reason === "spam") {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-semibold rounded-full border bg-orange-500/15 text-orange-600 dark:text-orange-400 border-orange-500/30">
        Spam
      </span>
    );
  }
  if (reason === "offensive") {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-semibold rounded-full border bg-red-500/15 text-red-600 dark:text-red-400 border-red-500/30">
        Offensive
      </span>
    );
  }
  return null;
}

const REJECTION_REASONS = [
  { value: "duplicate", label: "Duplicate" },
  { value: "spam",      label: "Spam" },
  { value: "offensive", label: "Offensive" },
] as const;

type RejectionReason = typeof REJECTION_REASONS[number]["value"];

function ReviewModal({
  review,
  onClose,
  onDecision,
  duplicateThreshold,
}: {
  review: Review;
  onClose: () => void;
  onDecision: (id: number, action: "approve" | "reject" | "approve-variant", note: string, parentFactId?: number, rejectionReason?: RejectionReason, enrichment?: FactEnrichment | null) => Promise<string | null>;
  duplicateThreshold: number;
}) {
  const [note, setNote] = useState(review.adminNote ?? "");
  const [loading, setLoading] = useState(false);
  const [rejectionReason, setRejectionReason] = useState<RejectionReason | "">("");
  const [enrichment, setEnrichment] = useState<FactEnrichment | null>(review.enrichment);
  const [enrichmentStatus, setEnrichmentStatus] = useState<string | null>(review.enrichmentStatus);
  const [errorMsg, setErrorMsg] = useState("");
  const [rerunBusy, setRerunBusy] = useState(false);
  const [previewBusy, setPreviewBusy] = useState(false);
  // dirtyRef: true while there are unsaved admin edits. Prevents syncFromServer
  // from clobbering local state. A parallel `dirty` state gates the autosave hook
  // (a ref can't drive the hook's effect); both reset together on a successful save.
  const dirtyRef = useRef(false);
  const [dirty, setDirty] = useState(false);
  const [previewPolls, setPreviewPolls] = useState(0);

  // Pull the latest stored enrichment from the server (async job writes it
  // out-of-band). Returns the fresh enrichmentStatus, or null when skipped/failed.
  const syncFromServer = useCallback(async (): Promise<string | null> => {
    if (dirtyRef.current) return null;
    try {
      const r = await fetch(`/api/admin/reviews/${review.id}`, { credentials: "include" });
      if (!r.ok || dirtyRef.current) return null;
      const fresh = await r.json() as Review;
      if (dirtyRef.current) return null;
      setEnrichment(fresh.enrichment);
      setEnrichmentStatus(fresh.enrichmentStatus);
      return fresh.enrichmentStatus;
    } catch {
      return null;
    }
  }, [review.id]);

  // Server-backed draft adapter for the shared useFormDraft hook: persistence is
  // a PATCH rather than localStorage. load() is a no-op (server authority comes
  // from syncFromServer polling); save() throws on failure so the hook surfaces
  // the error. The 1.5s debounce only fires while `dirty` is true, so server
  // syncs are never echoed back. onSaved resets dirty/dirtyRef — and the hook
  // calls it only for the latest save, so a stale PATCH response can't re-mark
  // the form clean while a newer edit is pending (which would unblock the poll).
  const enrichmentAdapter = useMemo<StorageAdapter<FactEnrichment | null>>(
    () => ({
      load: () => null,
      clear: () => {},
      save: async (enrichmentToSave) => {
        if (!enrichmentToSave) return Date.now();
        let r: Response;
        try {
          r = await fetch(`/api/admin/reviews/${review.id}/enrichment`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({ enrichment: enrichmentToSave }),
          });
        } catch {
          throw new Error("Network error — could not save.");
        }
        if (!r.ok) {
          throw new Error(
            r.status === 503 ? "API unavailable — try again shortly." : `Save failed (${r.status}).`,
          );
        }
        return Date.now();
      },
    }),
    [review.id],
  );

  const draft = useFormDraft<FactEnrichment | null>({
    value: enrichment,
    adapter: enrichmentAdapter,
    debounceMs: 1500,
    restoreOnMount: false,
    manualDirty: dirty,
    isEmpty: (e) => e == null,
    onSaved: () => {
      dirtyRef.current = false;
      setDirty(false);
    },
  });

  // While enrichment is still running, poll until it lands. Clear rerunBusy
  // as soon as the status leaves "pending".
  useEffect(() => {
    if (enrichmentStatus !== "pending") {
      setRerunBusy(false);
      return;
    }
    let cancelled = false;
    const id = setInterval(async () => {
      const status = await syncFromServer();
      if (cancelled) return;
      if (status && status !== "pending") {
        clearInterval(id);
        setRerunBusy(false);
      }
    }, 2500);
    return () => { cancelled = true; clearInterval(id); };
  }, [enrichmentStatus, syncFromServer]);

  // Preview regeneration runs as a separate async job; poll briefly so the
  // result shows up. Clear previewBusy when polling ends.
  useEffect(() => {
    if (previewPolls === 0) return;
    setPreviewBusy(true);
    let cancelled = false;
    let ticks = 0;
    const id = setInterval(async () => {
      ticks += 1;
      await syncFromServer();
      if (cancelled) return;
      if (ticks >= 6) {
        clearInterval(id);
        setPreviewBusy(false);
      }
    }, 2500);
    return () => { cancelled = true; clearInterval(id); setPreviewBusy(false); };
  }, [previewPolls, syncFromServer]);

  const rerunEnrichment = async () => {
    setLoading(true);
    setErrorMsg("");
    try {
      const r = await fetch(`/api/admin/reviews/${review.id}/enrich`, { method: "POST", credentials: "include" });
      if (r.ok) {
        dirtyRef.current = false;
        setDirty(false);
        setRerunBusy(true);
        setEnrichmentStatus("pending");
      } else {
        setErrorMsg(
          r.status === 503 ? "API unavailable — try again shortly." :
          r.status === 429 ? "Rate limited — wait a moment and retry." :
          `Re-run failed (${r.status}).`
        );
      }
    } catch {
      setErrorMsg("Network error — could not reach the server.");
    }
    setLoading(false);
  };

  const regeneratePreview = async () => {
    if (!enrichment) return;
    setLoading(true);
    setErrorMsg("");
    // Save first so the server generates the preview from the current enrichment
    // (including any unsaved cultural references / semantic entities). Also
    // resets dirty so the preview-polling syncFromServer is not blocked. If the
    // save fails, do not kick off the preview job.
    const saved = await draft.saveNow();
    if (!saved) { setLoading(false); return; }
    try {
      const r = await fetch(`/api/admin/reviews/${review.id}/preview`, { method: "POST", credentials: "include" });
      if (r.ok) {
        setPreviewPolls((n) => n + 1);
      } else {
        setErrorMsg(
          r.status === 503 ? "API unavailable — try again shortly." :
          r.status === 429 ? "Rate limited — wait a moment and retry." :
          `Preview regeneration failed (${r.status}).`
        );
      }
    } catch {
      setErrorMsg("Network error — could not reach the server.");
    }
    setLoading(false);
  };

  const canApprove = isApprovable(enrichment);

  const [decisionError, setDecisionError] = useState("");
  const [showDuplicate, setShowDuplicate] = useState(false);

  const handle = async (action: "approve" | "reject" | "approve-variant") => {
    if (action === "reject" && !rejectionReason) {
      setDecisionError("Please select a rejection reason before rejecting.");
      return;
    }
    setLoading(true);
    setDecisionError("");
    const err =
      action === "approve-variant"
        ? await onDecision(review.id, action, note, review.matchingFact?.id ?? undefined, undefined, enrichment)
        : action === "reject"
        ? await onDecision(review.id, action, note, undefined, rejectionReason || undefined)
        : await onDecision(review.id, action, note, undefined, undefined, enrichment);
    if (err) setDecisionError(err);
    setLoading(false);
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-card border-2 border-border rounded-sm w-full max-w-3xl shadow-2xl flex flex-col max-h-[90vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-border px-6 py-4 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-3 flex-wrap">
            <ClipboardList className="w-5 h-5 text-primary" />
            <h2 className="font-display font-bold uppercase tracking-wide text-foreground">Review #{review.id}</h2>
            <ReviewStatusBadge status={review.status} />
            <ReasonBadge reason={review.reason} />
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground text-xl leading-none">×</button>
        </div>

        <div className="p-6 space-y-6 overflow-y-auto">
          <div className="flex flex-wrap gap-4 text-sm text-muted-foreground">
            <span>Submitted by: <strong className="text-foreground">{review.submitter?.displayName ?? review.submitter?.email ?? "Unknown"}</strong></span>
            {review.submitter?.email && <span>Email: <strong className="text-foreground">{review.submitter.email}</strong></span>}
            <span className="flex items-center gap-2">
              Duplicate Likelihood: <strong className="text-foreground">{review.matchingSimilarity}%</strong>
              {review.matchingSimilarity > 0 && review.matchingSimilarity < duplicateThreshold && !showDuplicate && (
                <button
                  onClick={() => setShowDuplicate(true)}
                  className="text-xs text-primary underline hover:opacity-80 font-normal"
                >
                  Show potential duplicate
                </button>
              )}
            </span>
            <span>Date: <strong className="text-foreground">{new Date(review.createdAt).toLocaleDateString()}</strong></span>
          </div>

          <div className={`grid gap-4 ${(review.matchingSimilarity >= duplicateThreshold || showDuplicate) ? "grid-cols-1 sm:grid-cols-2" : "grid-cols-1"}`}>
            <div className="bg-background border-2 border-border rounded-sm p-4">
              <p className="text-xs font-bold text-muted-foreground uppercase tracking-wide mb-3">Submitted Fact</p>
              <p className="text-base italic text-foreground leading-relaxed">"{review.submittedText}"</p>
            </div>
            {(review.matchingSimilarity >= duplicateThreshold || showDuplicate) && (
              <div className="bg-background border-2 border-primary/40 rounded-sm p-4">
                <div className="flex items-center justify-between mb-3">
                  <p className="text-xs font-bold text-primary uppercase tracking-wide">Flagged Duplicate</p>
                  {review.matchingFact && (
                    <a href={`/facts/${review.matchingFact.id}`} target="_blank" rel="noreferrer"
                      className="text-xs text-primary hover:underline flex items-center gap-1">
                      View <ExternalLink className="w-3 h-3" />
                    </a>
                  )}
                </div>
                {review.matchingFact ? (
                  <p className="text-base italic text-foreground leading-relaxed">"{review.matchingFact.text}"</p>
                ) : review.matchingFactId != null ? (
                  <p className="text-muted-foreground text-sm italic">Original fact no longer available</p>
                ) : (
                  <p className="text-muted-foreground text-sm italic">Duplicate found in pending submissions — no approved original yet</p>
                )}
              </div>
            )}
          </div>

          {review.status === "pending" ? (
            <div className="space-y-2">
              <EnrichmentEditor
                value={enrichment}
                status={enrichmentStatus}
                factText={review.submittedText}
                onChange={(next) => { dirtyRef.current = true; setDirty(true); setEnrichment(next); }}
                onRerun={rerunEnrichment}
                onRegeneratePreview={regeneratePreview}
                busy={loading || rerunBusy || previewBusy}
                rerunBusy={rerunBusy}
                previewBusy={previewBusy}
                submittedHashtags={review.hashtags ?? []}
              />
              <div className="flex items-center justify-between gap-2">
                <div className="text-xs text-muted-foreground">
                  {draft.status === "saving" && <span className="flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" />Saving…</span>}
                  {draft.status === "saved" && draft.savedLabel && <span>{draft.savedLabel}</span>}
                  {draft.status === "error" && <span className="text-destructive">Auto-save failed — see error below</span>}
                </div>
              </div>
              {(errorMsg || draft.error) && (
                <div className="flex items-start gap-2 rounded-sm border border-destructive/50 bg-destructive/10 px-3 py-2">
                  <AlertTriangle className="w-4 h-4 text-destructive shrink-0 mt-0.5" />
                  <p className="text-sm text-destructive">{errorMsg || draft.error}</p>
                </div>
              )}
            </div>
          ) : enrichment ? (
            <EnrichmentSummary e={enrichment} />
          ) : null}

          {review.status === "pending" && (
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-semibold text-foreground mb-2">
                  Rejection Reason <span className="text-destructive font-normal">*</span>
                </label>
                <select
                  value={rejectionReason}
                  onChange={(e) => { setRejectionReason(e.target.value as RejectionReason | ""); setDecisionError(""); }}
                  className="w-full px-3 py-2 bg-background border border-border rounded-sm text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
                >
                  <option value="">— No specific reason —</option>
                  {REJECTION_REASONS.map((r) => (
                    <option key={r.value} value={r.value}>{r.label}</option>
                  ))}
                </select>
                {decisionError && (
                  <div className="flex items-start gap-2 mt-2 rounded-sm border border-destructive/50 bg-destructive/10 px-3 py-2">
                    <AlertTriangle className="w-4 h-4 text-destructive shrink-0 mt-0.5" />
                    <p className="text-sm text-destructive">{decisionError}</p>
                  </div>
                )}
              </div>
              <div>
                <label className="block text-sm font-semibold text-foreground mb-2">Admin Note <span className="text-muted-foreground font-normal">(optional, sent to user)</span></label>
                <textarea
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  rows={3}
                  maxLength={500}
                  placeholder="Add a personal message to explain your decision…"
                  className="w-full px-3 py-2 bg-background border border-border rounded-sm text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary resize-none"
                />
              </div>
            </div>
          )}

          {review.status === "rejected" && (review.reason || review.adminNote) && (
            <div className="bg-muted/40 border border-border rounded-sm p-3 space-y-2">
              {review.reason && (
                <div>
                  <p className="text-xs font-semibold text-muted-foreground uppercase mb-1">Rejection Reason</p>
                  <ReasonBadge reason={review.reason} />
                </div>
              )}
              {review.adminNote && (
                <div>
                  <p className="text-xs font-semibold text-muted-foreground uppercase mb-1">Admin Note</p>
                  <p className="text-sm text-foreground">{review.adminNote}</p>
                </div>
              )}
            </div>
          )}

          {review.status === "approved" && review.adminNote && (
            <div className="bg-muted/40 border border-border rounded-sm p-3">
              <p className="text-xs font-semibold text-muted-foreground uppercase mb-1">Admin Note</p>
              <p className="text-sm text-foreground">{review.adminNote}</p>
            </div>
          )}

          {review.status === "pending" ? (
            <div className="pt-2 border-t border-border space-y-3">
              <div className="flex flex-wrap gap-3">
                <Button
                  onClick={() => handle("approve")}
                  isLoading={loading}
                  disabled={!canApprove || loading}
                  title={canApprove ? undefined : "Approve is disabled until enrichment is valid and a visual preview exists"}
                  className="bg-green-600 hover:bg-green-700 text-white gap-2 disabled:opacity-50"
                >
                  <CheckCircle2 className="w-4 h-4" /> Approve — New Fact
                </Button>
                {review.matchingFact && (
                  <Button variant="outline" onClick={() => handle("approve-variant")} isLoading={loading}
                    disabled={!review.matchingFact}
                    className="border-blue-500/50 text-blue-600 dark:text-blue-400 hover:bg-blue-500/10 gap-2">
                    <GitBranch className="w-4 h-4" /> Approve as Variant of #{review.matchingFact.id}
                  </Button>
                )}
                <Button variant="outline" onClick={() => handle("reject")} isLoading={loading}
                  className="border-destructive text-destructive hover:bg-destructive/10 gap-2">
                  <XCircle className="w-4 h-4" /> Reject
                </Button>
                <Button variant="outline" onClick={onClose} disabled={loading}>Cancel</Button>
              </div>
              {!canApprove && (
                <p className="text-xs text-amber-600 dark:text-amber-400 flex items-center gap-1.5">
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                  Approve is locked until enrichment is valid and a visual preview exists. Generate one or fill it in manually.
                </p>
              )}

            </div>
          ) : (
            <div className="flex gap-3 pt-2 border-t border-border">
              {review.status === "approved" && review.approvedFactId && (
                <a href={`/facts/${review.approvedFactId}`} target="_blank" rel="noreferrer">
                  <Button variant="outline" className="gap-2"><ExternalLink className="w-4 h-4" /> View Approved Fact</Button>
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

function FactReviewsPanel() {
  const [statusFilter, setStatusFilter] = useState<"pending" | "approved" | "rejected" | "all">("pending");
  const [page, setPage] = useState(1);
  const [selectedReview, setSelectedReview] = useState<Review | null>(null);
  const [actionMsg, setActionMsg] = useState("");
  const [duplicateThreshold, setDuplicateThreshold] = useState(80);

  useEffect(() => {
    fetch("/api/admin/config", { credentials: "include" })
      .then((r) => r.ok ? r.json() as Promise<{ key: string; value: string }[]> : Promise.reject())
      .then((rows) => {
        const row = rows.find((r) => r.key === "review_duplicate_threshold");
        if (row) {
          const n = parseInt(row.value, 10);
          if (isFinite(n)) setDuplicateThreshold(n);
        }
      })
      .catch(() => {});
  }, []);

  const { data, loading, error, load } = useReviews(statusFilter, page);

  const [initialized, setInitialized] = useState(false);
  if (!initialized) { setInitialized(true); void load(); }

  const handleFilterChange = (f: typeof statusFilter) => {
    setStatusFilter(f);
    setPage(1);
    setInitialized(false);
  };

  const handleDecision = async (
    id: number,
    action: "approve" | "reject" | "approve-variant",
    note: string,
    parentFactId?: number,
    rejectionReason?: RejectionReason,
    enrichment?: FactEnrichment | null,
  ): Promise<string | null> => {
    const body: Record<string, unknown> = { adminNote: note || undefined };
    if (action === "approve-variant" && parentFactId !== undefined) body.parentFactId = parentFactId;
    if (action === "reject" && rejectionReason) body.rejectionReason = rejectionReason;
    if ((action === "approve" || action === "approve-variant") && enrichment) body.enrichment = enrichment;
    const r = await fetch(`/api/admin/reviews/${id}/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify(body),
    });
    if (r.ok) {
      setSelectedReview(null);
      setInitialized(false);
      void load();
      return null;
    }
    const d = await r.json() as { error?: string };
    return d.error ?? `Request failed (${r.status})`;
  };

  const totalPages = data ? Math.ceil(data.total / data.limit) : 1;

  const FILTERS: { label: string; value: typeof statusFilter }[] = [
    { label: "Pending", value: "pending" },
    { label: "Approved", value: "approved" },
    { label: "Rejected", value: "rejected" },
    { label: "All", value: "all" },
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 flex-wrap">
        {FILTERS.map((f) => (
          <button key={f.value} onClick={() => handleFilterChange(f.value)}
            className={`px-4 py-1.5 text-sm font-medium rounded-sm border transition-colors ${
              statusFilter === f.value
                ? "bg-primary text-primary-foreground border-primary"
                : "bg-card text-muted-foreground border-border hover:text-foreground"
            }`}>
            {f.label}
          </button>
        ))}
        <button onClick={() => { setInitialized(false); void load(); }}
          className="ml-auto text-xs text-muted-foreground hover:text-foreground flex items-center gap-1"
          disabled={loading}>
          {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
          Refresh
        </button>
      </div>

      {actionMsg && (
        <div className="p-3 rounded-sm text-sm bg-green-500/10 text-green-600">
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
            <div key={r.id}
              className="bg-card border border-border rounded-sm p-4 hover:border-primary/40 cursor-pointer transition-colors"
              onClick={() => setSelectedReview(r)}>
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-3 mb-2 flex-wrap">
                    <ReviewStatusBadge status={r.status} />
                    <ReasonBadge reason={r.reason} />
                    <span className="text-xs text-muted-foreground">
                      {r.matchingSimilarity >= duplicateThreshold ? `${r.matchingSimilarity}% match · ` : ""}
                      by {r.submitter?.displayName ?? r.submitter?.email ?? "unknown"} · {new Date(r.createdAt).toLocaleDateString()}
                    </span>
                  </div>
                  <p className="text-sm text-foreground italic line-clamp-2">"{r.submittedText}"</p>
                  {r.matchingFact && r.matchingSimilarity >= duplicateThreshold && (
                    <p className="text-xs text-muted-foreground mt-1 truncate">vs. "{r.matchingFact.text}"</p>
                  )}
                </div>
                <button
                  className="shrink-0 text-xs text-primary hover:underline whitespace-nowrap"
                  onClick={(e) => { e.stopPropagation(); setSelectedReview(r); }}>
                  {r.status === "pending" ? "Review →" : "Details →"}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {data && totalPages > 1 && (
        <div className="flex items-center justify-between pt-4">
          <span className="text-sm text-muted-foreground">
            Page {data.page} of {totalPages} · {data.total} total
          </span>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" disabled={page <= 1}
              onClick={() => { setPage(p => p - 1); setInitialized(false); }}>
              <ChevronLeft className="w-4 h-4" />
            </Button>
            <Button size="sm" variant="outline" disabled={page >= totalPages}
              onClick={() => { setPage(p => p + 1); setInitialized(false); }}>
              <ChevronRight className="w-4 h-4" />
            </Button>
          </div>
        </div>
      )}

      {selectedReview && (
        <ReviewModal
          review={selectedReview}
          onClose={() => setSelectedReview(null)}
          onDecision={handleDecision}
          duplicateThreshold={duplicateThreshold}
        />
      )}
    </div>
  );
}

// ─── Comment Reviews (was "Comments") ────────────────────────────────────────

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

type CommentTab = "pending" | "flagged";

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

function CommentReviewsPanel() {
  const [tab, setTab] = useState<CommentTab>("pending");
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
    <div className="space-y-6">
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
              <button onClick={() => setRejectModal(null)}
                className="px-4 py-2 text-sm font-medium bg-muted text-muted-foreground border border-border rounded-sm hover:bg-muted/80 transition-colors">
                Cancel
              </button>
              <button onClick={confirmReject}
                className="px-4 py-2 text-sm font-medium bg-destructive/10 text-destructive border border-destructive/30 rounded-sm hover:bg-destructive/20 transition-colors">
                Confirm Reject
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="flex gap-1 border-b border-border">
        <button onClick={() => setTab("pending")}
          className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors -mb-px ${
            tab === "pending" ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"
          }`}>
          <Clock className="w-3.5 h-3.5" />
          Pending
          {pending.length > 0 && (
            <span className="bg-destructive text-destructive-foreground text-[10px] font-bold px-1.5 py-0.5 rounded-full leading-none">
              {pending.length}
            </span>
          )}
        </button>
        <button onClick={() => setTab("flagged")}
          className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors -mb-px ${
            tab === "flagged" ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"
          }`}>
          <AlertTriangle className="w-3.5 h-3.5" />
          Flagged
          {flagged.length > 0 && (
            <span className="bg-orange-500 text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full leading-none">
              {flagged.length}
            </span>
          )}
        </button>
      </div>

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
          <p className="text-lg font-medium">{tab === "pending" ? "No pending comments" : "No flagged comments"}</p>
          <p className="text-sm mt-1">{tab === "pending" ? "All caught up." : "Nothing flagged by AI yet. Good sign."}</p>
        </div>
      )}

      {!loading && !error && currentList.length > 0 && (
        <div className="space-y-4">
          {currentList.map((c) => (
            <div key={c.id} className="bg-card border border-border rounded-sm p-5 space-y-3">
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <p className="text-foreground">{c.text}</p>
                  {"flagReason" in c && (c as FlaggedComment).flagReason && (
                    <p className="text-xs text-destructive mt-1.5 font-medium">
                      AI flag reason: {(c as FlaggedComment).flagReason}
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
                  <button onClick={() => approve(c.id)}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-green-500/10 text-green-600 border border-green-500/30 rounded-sm hover:bg-green-500/20 transition-colors">
                    <CheckCircle className="w-3.5 h-3.5" /> Approve
                  </button>
                  <button onClick={() => setRejectModal({ commentId: c.id, note: "" })}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-destructive/10 text-destructive border border-destructive/30 rounded-sm hover:bg-destructive/20 transition-colors">
                    <XCircle className="w-3.5 h-3.5" /> Reject
                  </button>
                  <button onClick={() => deleteComment(c.id)}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-muted text-muted-foreground border border-border rounded-sm hover:bg-destructive/10 hover:text-destructive hover:border-destructive/30 transition-colors"
                    title="Permanently delete">
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Main Moderation Page ─────────────────────────────────────────────────────

const SECTION_TABS: { value: ModerationSection; label: string }[] = [
  { value: "facts", label: "Fact Reviews" },
  { value: "comments", label: "Comment Reviews" },
];

export default function AdminModeration() {
  const [section, setSection] = useState<ModerationSection>("facts");

  return (
    <AdminLayout title="Moderation">
      <div className="space-y-6">
        {/* Section toggle */}
        <div className="flex gap-1 p-1 bg-muted rounded-lg w-fit">
          {SECTION_TABS.map((t) => (
            <button
              key={t.value}
              onClick={() => setSection(t.value)}
              className={`px-5 py-2 text-sm font-semibold rounded-md transition-colors ${
                section === t.value
                  ? "bg-card text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {section === "facts" && <FactReviewsPanel />}
        {section === "comments" && <CommentReviewsPanel />}
      </div>
    </AdminLayout>
  );
}
