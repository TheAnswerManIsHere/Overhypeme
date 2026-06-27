import { useState, useEffect, useCallback, useRef } from "react";
import { AdminLayout } from "@/components/admin/AdminLayout";
import { Link } from "wouter";
import { Button } from "@/components/ui/Button";
import {
  CheckCircle, CheckCircle2, XCircle, Clock, ChevronLeft, ChevronRight,
  ExternalLink, ClipboardList, Loader2, AlertTriangle, GitBranch,
  MessageSquare, Trash2, User, Image as ImageIcon, Sparkles, RefreshCw, Rocket,
} from "lucide-react";
import {
  type FactEnrichment,
  REVIEW_WORKFLOW_STAGE_DISPLAY,
  type ReviewWorkflowStage,
} from "@workspace/api-zod";
import { EnrichmentEditor, EnrichmentSummary, isApprovable } from "@/components/admin/EnrichmentEditor";
import { useEnrichmentJobs } from "@/components/admin/useEnrichmentJobs";
import { RuntimePromptPreview } from "@/components/admin/RuntimePromptPreview";
import { ModerationPexelsPanel } from "@/components/admin/ModerationPexelsPanel";

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

/** Lifecycle of a prep step on the staging fact: null/"pending" = working. */
type PrepStatus = "pending" | "ok" | "failed" | null;

/** Lightweight staging-fact prep slice returned on each list row. */
interface StagingFactSlice {
  id: number;
  isActive: boolean;
  enrichmentStatus: PrepStatus;
  pexelsStatus: PrepStatus;
}

/** Full staging-fact slice returned on the review detail (adds the blob to tune). */
interface StagingFactDetail extends StagingFactSlice {
  enrichment: FactEnrichment | null;
}

interface Review {
  id: number;
  submittedText: string;
  matchingFactId: number | null;
  matchingSimilarity: number;
  status: "pending" | "approved" | "rejected";
  workflowStage: ReviewWorkflowStage;
  stagingFactId: number | null;
  stagingFact: StagingFactSlice | null;
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

const STAGE_GROUP_STYLE: Record<string, string> = {
  needs_first_pass: "bg-yellow-500/15 text-yellow-600 dark:text-yellow-400 border-yellow-500/30",
  prep:             "bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/30",
  production_review:"bg-primary/15 text-primary border-primary/30",
  resolved:         "bg-muted text-muted-foreground border-border",
};

/** The fine-grained workflow-stage chip (label + tooltip from the shared map). */
function StageBadge({ stage }: { stage: ReviewWorkflowStage }) {
  const d = REVIEW_WORKFLOW_STAGE_DISPLAY[stage];
  return (
    <span
      title={d.hint}
      className={`inline-flex items-center gap-1 px-2 py-0.5 text-xs font-semibold rounded-full border ${STAGE_GROUP_STYLE[d.group] ?? STAGE_GROUP_STYLE.resolved}`}
    >
      {d.label}
    </span>
  );
}

/** One prep step's live state. null/"pending" render as "working" (spinner). */
function PrepStepPill({ icon: Icon, label, status }: { icon: typeof Sparkles; label: string; status: PrepStatus }) {
  const working = status == null || status === "pending";
  const ok = status === "ok";
  const failed = status === "failed";
  const tone = ok
    ? "text-green-600 dark:text-green-400 border-green-500/30 bg-green-500/10"
    : failed
    ? "text-destructive border-destructive/30 bg-destructive/10"
    : "text-blue-600 dark:text-blue-400 border-blue-500/30 bg-blue-500/10";
  const word = ok ? "ready" : failed ? "failed" : "working…";
  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-1 text-xs font-medium rounded-sm border ${tone}`}>
      <Icon className="w-3.5 h-3.5 shrink-0" />
      <span className="font-semibold">{label}</span>
      {ok ? <CheckCircle2 className="w-3.5 h-3.5" />
        : failed ? <XCircle className="w-3.5 h-3.5" />
        : <Loader2 className="w-3.5 h-3.5 animate-spin" />}
      <span>{word}</span>
    </span>
  );
}

/**
 * Two-altitude prep status for a staging fact (CLAUDE.md rule 8): an aggregate
 * tally plus a per-step live pill for enrichment and Pexels image prep. Image
 * prep "failed" is surfaced but never blocks approval (best-effort seeding).
 */
function PrepStatusPanel({
  enrichmentStatus,
  pexelsStatus,
}: {
  enrichmentStatus: PrepStatus;
  pexelsStatus: PrepStatus;
}) {
  const steps: PrepStatus[] = [enrichmentStatus, pexelsStatus];
  const done = steps.filter((s) => s === "ok").length;
  const failed = steps.filter((s) => s === "failed").length;
  const running = steps.length - done - failed;
  return (
    <div className="space-y-2">
      <p className="text-xs font-mono text-muted-foreground">
        Prep: {done} of {steps.length} ready
        {failed > 0 ? ` · ${failed} failed` : ""}
        {running > 0 ? ` · ${running} working` : ""}
      </p>
      <div className="flex flex-wrap gap-2">
        <PrepStepPill icon={Sparkles} label="Enrichment" status={enrichmentStatus} />
        <PrepStepPill icon={ImageIcon} label="Pexels images" status={pexelsStatus} />
      </div>
    </div>
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
  { value: "lame",      label: "Lame" },
] as const;

type RejectionReason = typeof REJECTION_REASONS[number]["value"];

interface ReviewDetail extends Review {
  stagingFact: StagingFactDetail | null;
}

/**
 * Stage-aware review modal for the two-gate moderation lifecycle:
 *
 *  - triage_pending     → Provisional approve (start prep) / as variant / reject.
 *  - prep_pending        → LIVE prep status (enrichment + Pexels), polled until
 *                          terminal (rule 8); reject-after-prep available.
 *  - prep_failed         → Retry prep / reject.
 *  - production_review   → tune enrichment on the staging fact + runtime preview,
 *                          then Approve for production (soft-warn when images
 *                          aren't ready) / reject.
 *  - resolved            → read-only summary + link to the live fact.
 */
function ReviewModal({
  review,
  onClose,
  onActionDone,
  duplicateThreshold,
}: {
  review: Review;
  onClose: () => void;
  onActionDone: () => void;
  duplicateThreshold: number;
}) {
  const [detail, setDetail] = useState<ReviewDetail | null>(null);
  const [stage, setStage] = useState<ReviewWorkflowStage>(review.workflowStage);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [showDuplicate, setShowDuplicate] = useState(false);

  // Decision inputs (local; the decision POST is the commit).
  const [note, setNote] = useState("");
  const [reason, setReason] = useState<RejectionReason | "">("");
  const [confirmApprove, setConfirmApprove] = useState(false);

  // Production-review enrichment — tuned on the staging fact, sent on approve.
  const [enrichment, setEnrichment] = useState<FactEnrichment | null>(null);
  const [enrichmentStatus, setEnrichmentStatus] = useState<PrepStatus>(null);
  const dirtyRef = useRef(false);

  const stagingFactId = detail?.stagingFact?.id ?? review.stagingFactId ?? 0;
  const isProductionReview = stage === "production_review";
  const isResolved = review.status !== "pending";
  const pexelsStatus: PrepStatus = detail?.stagingFact?.pexelsStatus ?? review.stagingFact?.pexelsStatus ?? null;
  const liveEnrichmentStatus: PrepStatus = detail?.stagingFact?.enrichmentStatus ?? review.stagingFact?.enrichmentStatus ?? null;

  const loadDetail = useCallback(async () => {
    const r = await fetch(`/api/admin/reviews/${review.id}`, { credentials: "include" });
    if (!r.ok) return;
    const d = (await r.json()) as ReviewDetail;
    setDetail(d);
    setStage(d.workflowStage);
    setNote((cur) => (cur === "" && d.adminNote ? d.adminNote : cur));
    setReason((cur) => (cur === "" && d.reason ? (d.reason as RejectionReason) : cur));
    if (!dirtyRef.current) {
      setEnrichment(d.stagingFact?.enrichment ?? null);
      setEnrichmentStatus(d.stagingFact?.enrichmentStatus ?? null);
    }
  }, [review.id]);

  useEffect(() => { void loadDetail(); }, [loadDetail]);

  // Live prep polling (rule 8): while prep runs, poll ~1.2s with NO timeout so
  // the per-step status stays current until prep is terminal (then it stops).
  useEffect(() => {
    if (stage !== "prep_pending") return;
    const h = setInterval(() => { void loadDetail(); }, 1200);
    return () => clearInterval(h);
  }, [stage, loadDetail]);

  // Enrichment re-run + polling targets the STAGING FACT during production review.
  const jobs = useEnrichmentJobs({
    resource: "facts",
    id: stagingFactId,
    status: isProductionReview ? enrichmentStatus : null,
    isDirty: () => dirtyRef.current,
    applyServerState: (e, s) => { setEnrichment(e); setEnrichmentStatus(s as PrepStatus); dirtyRef.current = false; },
  });

  const runAction = useCallback(async (path: string, body: Record<string, unknown>): Promise<void> => {
    setLoading(true); setError("");
    try {
      const r = await fetch(`/api/admin/reviews/${review.id}/${path}`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (r.ok) { onActionDone(); onClose(); return; }
      const d = (await r.json().catch(() => ({}))) as { error?: string };
      setError(d.error ?? `Request failed (${r.status})`);
    } catch {
      setError("Network error — could not reach the server.");
    } finally {
      setLoading(false);
    }
  }, [review.id, onActionDone, onClose]);

  const onProvisionalApprove = (variant: boolean) => {
    const body: Record<string, unknown> = { adminNote: note || undefined };
    if (variant && review.matchingFact) body.parentFactId = review.matchingFact.id;
    void runAction("provisional-approve", body);
  };
  const onReject = () => {
    if (!reason) { setError("Please select a rejection reason before rejecting."); return; }
    void runAction("reject", { rejectionReason: reason, adminNote: note || undefined });
  };
  const onApproveProduction = () => {
    if (pexelsStatus !== "ok" && !confirmApprove) { setConfirmApprove(true); return; }
    void runAction("approve-for-production", { adminNote: note || undefined, enrichment: enrichment ?? undefined });
  };

  const canApproveProduction = isApprovable(enrichment);
  const matchVisible = review.matchingSimilarity >= duplicateThreshold || showDuplicate;

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
            <StageBadge stage={stage} />
            <ReasonBadge reason={review.reason} />
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground text-xl leading-none shrink-0">×</button>
        </div>

        <div className="p-6 space-y-6 overflow-y-auto">
          <div className="flex flex-wrap gap-4 text-sm text-muted-foreground">
            <span>Submitted by: <strong className="text-foreground">{review.submitter?.displayName ?? review.submitter?.email ?? "Unknown"}</strong></span>
            {review.submitter?.email && <span>Email: <strong className="text-foreground">{review.submitter.email}</strong></span>}
            <span className="flex items-center gap-2">
              Duplicate Likelihood: <strong className="text-foreground">{review.matchingSimilarity}%</strong>
              {review.matchingSimilarity > 0 && review.matchingSimilarity < duplicateThreshold && !showDuplicate && (
                <button onClick={() => setShowDuplicate(true)} className="text-xs text-primary underline hover:opacity-80 font-normal">
                  Show potential duplicate
                </button>
              )}
            </span>
            <span>Date: <strong className="text-foreground">{new Date(review.createdAt).toLocaleDateString()}</strong></span>
          </div>

          <div className={`grid gap-4 ${matchVisible ? "grid-cols-1 sm:grid-cols-2" : "grid-cols-1"}`}>
            <div className="bg-background border-2 border-border rounded-sm p-4">
              <p className="text-xs font-bold text-muted-foreground uppercase tracking-wide mb-3">Submitted Fact</p>
              <p className="text-base italic text-foreground leading-relaxed">"{review.submittedText}"</p>
            </div>
            {matchVisible && (
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

          {/* ── Stage helper line ── */}
          {!isResolved && (
            <p className="text-sm text-muted-foreground">{REVIEW_WORKFLOW_STAGE_DISPLAY[stage].hint}</p>
          )}

          {/* ── Live prep status (prep + production review) ── */}
          {(stage === "prep_pending" || stage === "prep_failed" || isProductionReview) && (
            <div className="bg-background border-2 border-border rounded-sm p-4">
              <PrepStatusPanel enrichmentStatus={isProductionReview ? "ok" : liveEnrichmentStatus} pexelsStatus={pexelsStatus} />
              {stage === "prep_pending" && (
                <p className="text-xs text-muted-foreground mt-2 flex items-center gap-1.5">
                  <Loader2 className="w-3 h-3 animate-spin" /> Prep is running — this view updates live; you don't need to refresh.
                </p>
              )}
              {stage === "prep_failed" && (
                <p className="text-xs text-destructive mt-2 flex items-center gap-1.5">
                  <AlertTriangle className="w-3.5 h-3.5" /> Enrichment failed after retries. Retry prep, or reject.
                </p>
              )}
            </div>
          )}

          {/* ── Production review: tune enrichment on the staging fact ── */}
          {isProductionReview && (
            <div className="space-y-2">
              <EnrichmentEditor
                value={enrichment}
                status={enrichmentStatus}
                factText={review.submittedText}
                onChange={(next) => { dirtyRef.current = true; setEnrichment(next); }}
                onRerun={jobs.onRerun}
                busy={loading || jobs.loading || jobs.rerunBusy}
                rerunBusy={jobs.rerunBusy}
                submittedHashtags={review.hashtags ?? []}
              />
              {jobs.error && (
                <div className="flex items-start gap-2 rounded-sm border border-destructive/50 bg-destructive/10 px-3 py-2">
                  <AlertTriangle className="w-4 h-4 text-destructive shrink-0 mt-0.5" />
                  <p className="text-sm text-destructive">{jobs.error}</p>
                </div>
              )}
              {stagingFactId > 0 && (
                <RuntimePromptPreview factId={stagingFactId} reviewIdForRender={review.id} />
              )}
              <ModerationPexelsPanel reviewId={review.id} />
            </div>
          )}

          {/* ── Resolved: read-only enrichment summary ── */}
          {isResolved && (detail?.stagingFact?.enrichment ?? review.enrichment) && (
            <EnrichmentSummary e={(detail?.stagingFact?.enrichment ?? review.enrichment) as FactEnrichment} />
          )}

          {/* ── Decision inputs (any pending stage) ── */}
          {!isResolved && (
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-semibold text-foreground mb-2">
                  Rejection Reason <span className="text-muted-foreground font-normal">(required to reject)</span>
                </label>
                <select
                  value={reason}
                  onChange={(e) => { setReason(e.target.value as RejectionReason | ""); setError(""); }}
                  className="w-full px-3 py-2 bg-background border border-border rounded-sm text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
                >
                  <option value="">— Select a reason —</option>
                  {REJECTION_REASONS.map((r) => (
                    <option key={r.value} value={r.value}>{r.label}</option>
                  ))}
                </select>
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
                <span className="text-xs text-muted-foreground">{note.length}/500</span>
              </div>
            </div>
          )}

          {/* ── Resolved: stored reason / note ── */}
          {isResolved && (review.reason || review.adminNote) && (
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

          {error && (
            <div className="flex items-start gap-2 rounded-sm border border-destructive/50 bg-destructive/10 px-3 py-2">
              <AlertTriangle className="w-4 h-4 text-destructive shrink-0 mt-0.5" />
              <p className="text-sm text-destructive">{error}</p>
            </div>
          )}

          {/* ── Stage-specific actions ── */}
          <div className="pt-2 border-t border-border space-y-3">
            {stage === "triage_pending" && (
              <div className="flex flex-wrap gap-3">
                <Button onClick={() => onProvisionalApprove(false)} isLoading={loading} disabled={loading}
                  className="bg-green-600 hover:bg-green-700 text-white gap-2">
                  <CheckCircle2 className="w-4 h-4" /> Provisional Approve — Start Prep
                </Button>
                {review.matchingFact && (
                  <Button variant="outline" onClick={() => onProvisionalApprove(true)} isLoading={loading} disabled={loading}
                    className="border-blue-500/50 text-blue-600 dark:text-blue-400 hover:bg-blue-500/10 gap-2">
                    <GitBranch className="w-4 h-4" /> Prep as Variant of #{review.matchingFact.id}
                  </Button>
                )}
                <Button variant="outline" onClick={onReject} isLoading={loading}
                  className="border-destructive text-destructive hover:bg-destructive/10 gap-2">
                  <XCircle className="w-4 h-4" /> Reject
                </Button>
                <Button variant="outline" onClick={onClose} disabled={loading}>Cancel</Button>
              </div>
            )}

            {stage === "prep_pending" && (
              <div className="flex flex-wrap gap-3">
                <Button variant="outline" onClick={onReject} isLoading={loading}
                  className="border-destructive text-destructive hover:bg-destructive/10 gap-2">
                  <XCircle className="w-4 h-4" /> Reject (cancels prep)
                </Button>
                <Button variant="outline" onClick={onClose} disabled={loading}>Close</Button>
              </div>
            )}

            {stage === "prep_failed" && (
              <div className="flex flex-wrap gap-3">
                <Button onClick={() => onProvisionalApprove(false)} isLoading={loading} disabled={loading}
                  className="bg-primary hover:bg-primary/90 text-primary-foreground gap-2">
                  <RefreshCw className="w-4 h-4" /> Retry Prep
                </Button>
                <Button variant="outline" onClick={onReject} isLoading={loading}
                  className="border-destructive text-destructive hover:bg-destructive/10 gap-2">
                  <XCircle className="w-4 h-4" /> Reject
                </Button>
                <Button variant="outline" onClick={onClose} disabled={loading}>Cancel</Button>
              </div>
            )}

            {isProductionReview && (
              <div className="space-y-3">
                {confirmApprove && pexelsStatus !== "ok" && (
                  <div className="flex items-start gap-2 rounded-sm border border-amber-500/50 bg-amber-500/10 px-3 py-2">
                    <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
                    <p className="text-sm text-amber-700 dark:text-amber-300">
                      Pexels images aren't ready ({pexelsStatus === "failed" ? "image prep failed" : "still working"}). The fact will go
                      live with no stock-photo library — the meme builder falls back to its other image sources. Click
                      <strong> Approve anyway</strong> to confirm, or close and retry prep first.
                    </p>
                  </div>
                )}
                <div className="flex flex-wrap gap-3">
                  <Button onClick={onApproveProduction} isLoading={loading} disabled={!canApproveProduction || loading}
                    title={canApproveProduction ? undefined : "Approve is disabled until the enrichment is valid"}
                    className="bg-green-600 hover:bg-green-700 text-white gap-2 disabled:opacity-50">
                    <Rocket className="w-4 h-4" /> {confirmApprove && pexelsStatus !== "ok" ? "Approve Anyway" : "Approve for Production"}
                  </Button>
                  <Button variant="outline" onClick={onReject} isLoading={loading}
                    className="border-destructive text-destructive hover:bg-destructive/10 gap-2">
                    <XCircle className="w-4 h-4" /> Reject
                  </Button>
                  <Button variant="outline" onClick={onClose} disabled={loading}>Cancel</Button>
                </div>
                {!canApproveProduction && (
                  <p className="text-xs text-amber-600 dark:text-amber-400 flex items-center gap-1.5">
                    <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                    Approve is locked until the enrichment is valid. Re-run classification or fill it in manually. On approve, the
                    server runs a renderability check — if the fact can't be rendered coherently, approval is blocked with a reason.
                  </p>
                )}
              </div>
            )}

            {isResolved && (
              <div className="flex gap-3">
                {review.approvedFactId && (
                  <a href={`/facts/${review.approvedFactId}`} target="_blank" rel="noreferrer">
                    <Button variant="outline" className="gap-2"><ExternalLink className="w-4 h-4" /> View Live Fact</Button>
                  </a>
                )}
                <Button variant="outline" onClick={onClose}>Close</Button>
              </div>
            )}
          </div>
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

  // Live list refresh (rule 8, aggregate altitude): while any row is mid-prep,
  // poll the page so its stage + status advance without a manual refresh. The
  // modal isn't required to watch progress.
  const anyPrepping = !!data?.reviews.some((r) => r.workflowStage === "prep_pending");
  useEffect(() => {
    if (!anyPrepping) return;
    const h = setInterval(() => { void load(); }, 2500);
    return () => clearInterval(h);
  }, [anyPrepping, load]);

  const handleFilterChange = (f: typeof statusFilter) => {
    setStatusFilter(f);
    setPage(1);
    setInitialized(false);
  };

  const reloadList = useCallback(() => {
    setActionMsg("");
    setInitialized(false);
    void load();
  }, [load]);

  const preppingCount = data?.reviews.filter((r) => r.workflowStage === "prep_pending").length ?? 0;

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
        <button onClick={reloadList}
          className="ml-auto text-xs text-muted-foreground hover:text-foreground flex items-center gap-1"
          disabled={loading}>
          {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
          Refresh
        </button>
      </div>

      {preppingCount > 0 && (
        <div className="p-3 rounded-sm text-sm bg-blue-500/10 text-blue-600 dark:text-blue-400 flex items-center gap-2">
          <Loader2 className="w-4 h-4 animate-spin shrink-0" />
          {preppingCount} {preppingCount === 1 ? "fact is" : "facts are"} in AI prep — updating live.
        </div>
      )}

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
                    <StageBadge stage={r.workflowStage} />
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
                  {/* Per-row live prep status (rule 8: per-item, in place). */}
                  {r.stagingFact && (r.workflowStage === "prep_pending" || r.workflowStage === "prep_failed" || r.workflowStage === "production_review") && (
                    <div className="flex flex-wrap gap-2 mt-2">
                      <PrepStepPill icon={Sparkles} label="Enrichment" status={r.workflowStage === "production_review" ? "ok" : r.stagingFact.enrichmentStatus} />
                      <PrepStepPill icon={ImageIcon} label="Images" status={r.stagingFact.pexelsStatus} />
                    </div>
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
          key={selectedReview.id}
          review={selectedReview}
          onClose={() => setSelectedReview(null)}
          onActionDone={reloadList}
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
