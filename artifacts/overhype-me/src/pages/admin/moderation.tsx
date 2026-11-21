import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { AdminLayout } from "@/components/admin/AdminLayout";
import { Link } from "wouter";
import { Button } from "@/components/ui/Button";
import {
  CheckCircle, CheckCircle2, XCircle, Clock, ChevronLeft, ChevronRight,
  ExternalLink, ClipboardList, Loader2, AlertTriangle,
  MessageSquare, Trash2, User, Rocket,
  CheckCheck, Wand2, Search,
} from "lucide-react";
import {
  type FactEnrichment,
  REVIEW_WORKFLOW_STAGE_DISPLAY,
  type ReviewWorkflowStage,
  type RenderReviewState,
  type VisualConceptsResponse,
  type StoredCandidateConcept,
  type FactGagsView,
  type ReviewReadingView,
  canEditWording,
  joinWithAnd,
  REJECTION_REASON_VALUES,
  REJECTION_REASON_LABELS,
  type RejectionReason,
} from "@workspace/api-zod";
import {
  deriveModerationQueueState,
  stageToWizardStep,
  type WizardStep,
} from "@/components/admin/moderationQueueState";
import { ReadingStep } from "@/components/admin/ReadingStep";
import { FinalHashtagsEditor } from "@/components/admin/FinalHashtagsEditor";
import { VisualConceptCandidates } from "@/components/admin/VisualConceptCandidates";
import { GagsPanel } from "@/components/admin/gags/GagsPanel";
import { SubmissionWording, type WordingSaved } from "@/components/admin/SubmissionWording";
import { DuplicateMatchPanel, DuplicateVerdictLine, NOT_CHECKED, duplicateMatchShown, useDuplicateCheck, verdictLabel, type DuplicateView } from "@/components/admin/DuplicateVerdict";
import { useGagIdeaActions } from "@/components/admin/gags/useGagIdeaActions";
import { DEFAULT_SUBJECT_EXAMPLE_NAMES } from "@/components/admin/subjectExampleNames";

/** Names the Gags panel's tokenizer recognises as the subject. */
const SUBJECT_NAMES: string[] = [...DEFAULT_SUBJECT_EXAMPLE_NAMES];

// ─── Shared ───────────────────────────────────────────────────────────────────

type ModerationSection = "facts" | "comments";

// ─── Fact Reviews (was "Duplicate Reviews") ───────────────────────────────────

interface Submitter {
  id: string;
  displayName: string | null;
  email: string | null;
}

/** Lifecycle of a prep step on the staging fact: null/"pending" = working. */
type PrepStatus = "pending" | "ok" | "failed" | null;

/** Lightweight staging-fact prep slice returned on each list row. */
interface StagingFactSlice {
  id: number;
  isActive: boolean;
  /** Visual-Idea generation lifecycle (facts.visual_concept_status). */
  visualConceptStatus: PrepStatus;
}

/**
 * The staging-fact slice on the review detail. Its stored taxonomy is not
 * shown or edited here (Issue #1018, increment 1.2c-ii); two things are read
 * from it when it exists: the fact's characters (naming hints for a gag's
 * cast) and its suggested hashtags.
 */
interface StagingFactDetail extends StagingFactSlice {
  enrichment: FactEnrichment | null;
}

interface Review {
  id: number;
  submittedText: string;
  /** The wording as submitted, when a moderator edited it at triage. */
  submittedTextOriginal?: string | null;
  status: "pending" | "approved" | "rejected";
  workflowStage: ReviewWorkflowStage;
  stagingFactId: number | null;
  stagingFact: StagingFactSlice | null;
  reason: string | null;
  adminNote: string | null;
  createdAt: string;
  reviewedAt: string | null;
  submitter: Submitter | null;
  /** The server's duplicate verdict for the saved wording (plan PLAN_DUPLICATE_VERDICT.md). */
  duplicate?: DuplicateView;
  approvedFactId: number | null;
  hashtags: string[] | null;
  /** True while a test render (auto-batch or manual re-run) is queued/rendering. */
  rendersRunning?: boolean;
  /** Coarse render state (Test Renders rows only; null otherwise). */
  renderReviewState?: RenderReviewState | null;
  /** The latest reading run's status (Reading rows only; null otherwise). */
  readingStatus?: PrepStatus;
}

interface ReviewsResponse {
  reviews: Review[];
  total: number;
  page: number;
  limit: number;
}

function useReviews(status: string, page: number, query: string) {
  const [data, setData] = useState<ReviewsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // Only the most recent request may write state: a slow earlier request (an
  // older search, tab or page) must not overwrite the results of a newer one.
  const latestRequest = useRef(0);

  const load = useCallback(async () => {
    const requestId = ++latestRequest.current;
    setLoading(true);
    setError("");
    try {
      const r = await fetch(`/api/admin/reviews?status=${status}&page=${page}&limit=20&q=${encodeURIComponent(query)}`, {
        credentials: "include",
      });
      if (!r.ok) throw new Error("Failed to load reviews");
      const body = await r.json() as ReviewsResponse;
      if (requestId === latestRequest.current) setData(body);
    } catch (e) {
      if (requestId === latestRequest.current) setError(String(e));
    } finally {
      if (requestId === latestRequest.current) setLoading(false);
    }
  }, [status, page, query]);

  return { data, loading, error, load };
}

const STAGE_GROUP_STYLE: Record<string, string> = {
  needs_first_pass: "bg-yellow-500/15 text-yellow-600 dark:text-yellow-400 border-yellow-500/30",
  reading:          "bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/30",
  gags:             "bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/30",
  test_renders:     "bg-primary/15 text-primary border-primary/30",
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

/**
 * One background step's live state on a queue row: null/"pending" render as
 * "working" (spinner). `attentionWhenNull` is for a step whose `null` means
 * "never run for this cycle" (e.g. Visual ideas on a review the stage cutover
 * moved to Gags) — an actionable not-ready state, NOT work in progress. It
 * renders as amber "not generated" with no spinner.
 */
function PrepStepPill({ icon: Icon, label, status, attentionWhenNull }: { icon: typeof Wand2; label: string; status: PrepStatus; attentionWhenNull?: boolean }) {
  const ok = status === "ok";
  const failed = status === "failed";
  const notGenerated = attentionWhenNull === true && status == null;
  const tone = ok
    ? "text-green-600 dark:text-green-400 border-green-500/30 bg-green-500/10"
    : failed
    ? "text-destructive border-destructive/30 bg-destructive/10"
    : notGenerated
    ? "text-amber-700 dark:text-amber-400 border-amber-500/30 bg-amber-500/10"
    : "text-blue-600 dark:text-blue-400 border-blue-500/30 bg-blue-500/10";
  const word = ok ? "ready" : failed ? "failed" : notGenerated ? "not generated" : "working…";
  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-1 text-xs font-medium rounded-sm border ${tone}`}>
      <Icon className="w-3.5 h-3.5 shrink-0" />
      <span className="font-semibold">{label}</span>
      {ok ? <CheckCircle2 className="w-3.5 h-3.5" />
        : failed ? <XCircle className="w-3.5 h-3.5" />
        : notGenerated ? <AlertTriangle className="w-3.5 h-3.5" />
        : <Loader2 className="w-3.5 h-3.5 animate-spin" />}
      <span>{word}</span>
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
  if (reason && (REJECTION_REASON_VALUES as readonly string[]).includes(reason)) {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-semibold rounded-full border bg-muted text-muted-foreground border-border">
        {REJECTION_REASON_LABELS[reason as RejectionReason]}
      </span>
    );
  }
  return null;
}

const REJECTION_REASONS = REJECTION_REASON_VALUES.map((value) => ({ value, label: REJECTION_REASON_LABELS[value] }));

interface ReviewDetail extends Review {
  stagingFact: StagingFactDetail | null;
  /** Slice 2A: normalized candidate Visual concepts (server-computed `current`). */
  visualConcepts?: VisualConceptsResponse;
  /** The Reading step: the latest reading run and the approved note (null before acceptance). */
  reading?: ReviewReadingView | null;
}

/** Four-step wizard for a non-terminal review (WizardStep from the shared helper). */
const WIZARD_STEPS: { id: WizardStep; label: string }[] = [
  { id: "triage", label: "Triage" },
  { id: "reading", label: "Reading" },
  { id: "concept", label: "Gags" },
  { id: "render", label: "Test Renders" },
];

/** SubmitFact-style two-step indicator (numbered steps + connector). */
function StepIndicator({ step }: { step: WizardStep }) {
  const stepIndex = WIZARD_STEPS.findIndex((s) => s.id === step);
  return (
    <div className="flex items-center justify-center" data-testid="moderation-step-indicator">
      {WIZARD_STEPS.map((s, i) => (
        <div key={s.id} className="flex items-center">
          <div
            className={`flex items-center gap-2 px-4 py-1.5 rounded-full text-sm font-bold tracking-wide transition-all ${
              step === s.id
                ? "bg-primary text-primary-foreground"
                : stepIndex > i
                  ? "text-green-500"
                  : "text-muted-foreground"
            }`}
          >
            {stepIndex > i ? (
              <CheckCheck className="w-4 h-4" />
            ) : (
              <span className="w-5 h-5 rounded-full border-2 flex items-center justify-center text-xs border-current">
                {i + 1}
              </span>
            )}
            {s.label}
          </div>
          {i < WIZARD_STEPS.length - 1 && (
            <div className={`w-10 h-px mx-1 ${stepIndex > i ? "bg-green-500/40" : "bg-border"}`} />
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * Stage-aware review modal, presented as a four-step wizard for non-terminal
 * reviews (plan PLAN_FACT_LIFECYCLE_REBUILD.md, 1D; Issue #1018, increment
 * 1.2c-ii):
 *
 *  - Triage: keep/reject decision + duplicate context + submitter info.
 *  - Reading: how the fact was read — the draft humor note (editable) and,
 *    beneath it, the reference research it was written from. "Approve the
 *    humor note" opens Gags.
 *  - Gags: the Gags panel + Visual-Idea candidates, each usable on a gag.
 *    NO renders yet — "Approve the Gags" advances to Test Renders.
 *  - Test Renders: each gag's renders, where approving a render makes it that
 *    gag's example; final hashtags; "Approve for Production" or "Back to Gags".
 *  - resolved → read-only summary + link to the live fact.
 *
 * The taxonomy is not on this screen: it runs beside moderation and blocks
 * nothing. Reject (with a reason) is available on every step until the fact
 * goes live; past triage it asks for confirmation first.
 */
function ReviewModal({
  review,
  onClose,
  onActionDone,
  onRendersEnqueued,
}: {
  review: Review;
  onClose: () => void;
  onActionDone: () => void;
  /** Refresh the list after a test render is (re-)run so its row pill lights up. */
  onRendersEnqueued: () => void;
}) {
  const [detail, setDetail] = useState<ReviewDetail | null>(null);
  const [stage, setStage] = useState<ReviewWorkflowStage>(review.workflowStage);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [showClosest, setShowClosest] = useState(false);
  // The submission's wording and its duplicate verdict, which a triage edit
  // replaces together (plans PLAN_THREE_GAGS.md increment 3, PLAN_DUPLICATE_VERDICT.md).
  const [wording, setWording] = useState<WordingSaved>({
    submittedText: review.submittedText,
    submittedTextOriginal: review.submittedTextOriginal ?? null,
    duplicate: review.duplicate ?? NOT_CHECKED,
  });
  const [wordingDirty, setWordingDirty] = useState(false);

  // Decision inputs (local; the decision POST is the commit).
  const [note, setNote] = useState("");
  const [reason, setReason] = useState<RejectionReason | "">("");

  const modalBodyRef = useRef<HTMLDivElement | null>(null);

  const stagingFactId = detail?.stagingFact?.id ?? review.stagingFactId ?? 0;
  const isReading = stage === "reading";
  const isConceptReview = stage === "gags";
  const isProductionReview = stage === "test_renders";
  const isResolved = review.status !== "pending";
  // Reject past triage asks first: it deletes the submission's gags and emails
  // the submitter, and cannot be undone.
  const [confirmReject, setConfirmReject] = useState(false);

  // The duplicate verdict belongs to the saved wording: the on-open check
  // (David, Q1) applies only while that wording stands, and a wording save
  // supersedes any check in flight.
  const setDuplicate = useCallback((duplicate: DuplicateView) => {
    setWording((w) => ({ ...w, duplicate }));
    setShowClosest(false);
  }, []);
  const duplicateCheck = useDuplicateCheck({
    reviewId: review.id,
    submittedText: wording.submittedText,
    view: wording.duplicate,
    canCheck: stage === "triage",
    onView: setDuplicate,
    onChecked: onActionDone,
  });
  const duplicateSeq = duplicateCheck.seq;   // stable

  // The stored taxonomy, read-only and only for two conveniences: the fact's
  // characters (naming hints for a gag's cast) and its suggested hashtags. It
  // is absent until (and unless) the taxonomy run succeeds; nothing waits on it.
  const classification = detail?.stagingFact?.enrichment ?? null;
  const [gagsReloadKey, setGagsReloadKey] = useState(0);

  // The fact's gags, as the Gags panel last loaded them (plan
  // docs/plans/PLAN_THREE_GAGS.md). `gagsReloadKey` reloads the panel after an
  // idea is used on a gag from the Gag ideas cards.
  const [gagsView, setGagsView] = useState<FactGagsView | null>(null);
  // The gags with an edit not yet saved (or still saving) in the Gags panel,
  // named ("Gag 2"): approvals act on the saved gags, so they wait for it
  // (Codex, PR #956 round 2), and the warning says which gag.
  const [gagsUnsavedNames, setGagsUnsavedNames] = useState<string[]>([]);
  const gagsUnsaved = gagsUnsavedNames.length > 0;
  const unsavedGagsWords = joinWithAnd(gagsUnsavedNames) || "your gag";


  // Moderator-curated FINAL discovery tags — what actually ships on approval.
  // Seeded from the submitter's tags, or the taxonomy's suggestions when the
  // submitter left none, so the editor opens on what would ship.
  // `finalHashtagsDirtyRef` keeps the moderator's edits from being reseeded by
  // polling. Sent in the approve body; a fact can't be approved with none.
  const [finalHashtags, setFinalHashtags] = useState<string[]>([]);
  const finalHashtagsDirtyRef = useRef(false);
  const suggestedHashtags = classification?.suggestedHashtags;
  useEffect(() => {
    if (finalHashtagsDirtyRef.current) return;
    const submitter = review.hashtags ?? [];
    setFinalHashtags(submitter.length > 0 ? submitter : (suggestedHashtags ?? []));
  }, [review.hashtags, suggestedHashtags]);
  const onFinalHashtagsChange = (tags: string[]) => {
    finalHashtagsDirtyRef.current = true;
    setFinalHashtags(tags);
  };

  // Wizard step. The step follows the stage. When the stage first reaches a NEW
  // value (e.g. acceptance → reading, or the dedicated approve/back handlers
  // moving it), auto-navigate to the matching step — but
  // only ONCE per newly-seen stage, so a moderator who manually flips back isn't
  // yanked forward again by polling.
  const [step, setStep] = useState<WizardStep>(stageToWizardStep(review.workflowStage) ?? "triage");
  const autoNavStagesRef = useRef<Set<ReviewWorkflowStage>>(new Set([review.workflowStage]));
  useEffect(() => {
    if (autoNavStagesRef.current.has(stage)) return;
    autoNavStagesRef.current.add(stage);
    const target = stageToWizardStep(stage);
    if (target) setStep(target);
  }, [stage]);

  // Every step change — auto-nav, "Continue", "Back" — starts the new step at
  // the top of the modal body. The rAF defers until after the new step's
  // content has rendered. (Only the modal body scrolls: the admin shell is a
  // fixed viewport, so the page behind never moves.)
  useEffect(() => {
    requestAnimationFrame(() => modalBodyRef.current?.scrollTo({ top: 0, behavior: "smooth" }));
  }, [step]);

  const loadDetail = useCallback(async () => {
    const seqAtStart = duplicateSeq();
    const r = await fetch(`/api/admin/reviews/${review.id}`, { credentials: "include" });
    if (!r.ok) return;
    const d = (await r.json()) as ReviewDetail;
    setDetail(d);
    // The detail's verdict, unless the wording moved on or a newer check or
    // save replaced the verdict while this request was in flight.
    if (d.duplicate && duplicateSeq() === seqAtStart) {
      const fresh = d.duplicate;
      setWording((w) => (w.submittedText === d.submittedText ? { ...w, duplicate: fresh } : w));
    }
    setStage(d.workflowStage);
    setNote((cur) => (cur === "" && d.adminNote ? d.adminNote : cur));
    setReason((cur) => (cur === "" && d.reason ? (d.reason as RejectionReason) : cur));
  }, [review.id, duplicateSeq]);

  useEffect(() => { void loadDetail(); }, [loadDetail]);

  // Live reading polling (rule 8): while the reading run is in flight, poll
  // ~1.2s with NO timeout so the Reading step updates until it is terminal.
  const readingPending = isReading && detail?.reading?.latest?.status === "pending";
  useEffect(() => {
    if (!readingPending) return;
    const h = setInterval(() => { void loadDetail(); }, 1200);
    return () => clearInterval(h);
  }, [readingPending, loadDetail]);

  // Finite candidate-concept polling: the concept job runs in the background,
  // so poll ONLY while its status is "pending" and
  // stop on any terminal state. `null` = not started (no poll — the picker shows
  // a manual Generate), so old/pre-feature rows never poll forever.
  const visualConceptStatus: PrepStatus = detail?.visualConcepts?.status ?? null;
  useEffect(() => {
    if (visualConceptStatus !== "pending") return;
    const h = setInterval(() => { void loadDetail(); }, 1200);
    return () => clearInterval(h);
  }, [visualConceptStatus, loadDetail]);

  // POST regenerate: draft 3 fresh concepts. The server offers the moderator's
  // CURRENT unsaved Visual concept draft as "here's my direction — propose
  // distinct alternatives" context (it can't see local drafts otherwise). We
  // optimistically flip the local status to "pending" so the picker shows
  // "working" immediately, then let polling reconcile.
  const onGenerateConcepts = useCallback(async (): Promise<void> => {
    // The gag writer reads the fact's saved gags itself; an unsaved edit in a
    // gag card is not sent.
    const coreSceneDraft = null;
    const bubblesDraft = null;
    setError("");
    // Optimistic "pending" for instant feedback; loadDetail() in finally
    // reconciles against the real server state, so a rejected POST (409 stale
    // stage, 400, 5xx) reverts the pending rather than sticking on "Writing…".
    setDetail((d) => (d ? { ...d, visualConcepts: { status: "pending", candidates: [], current: false, humorNote: d.visualConcepts?.humorNote ?? null } } : d));
    try {
      const r = await fetch(`/api/admin/reviews/${review.id}/visual-concepts/regenerate`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ coreSceneDraft, bubblesDraft }),
      });
      if (!r.ok) {
        const d = (await r.json().catch(() => ({}))) as { error?: string };
        setError(d.error ?? `Could not write gag ideas (${r.status}).`);
      }
    } catch {
      setError("Network error — could not write gag ideas.");
    } finally {
      void loadDetail();
    }
  }, [review.id, loadDetail]);

  // PUT the humor note (confirm or correction). Returns an error message, or
  // null when saved; the panel shows "Saving…" and keeps the text on failure.
  const onSaveHumorNote = useCallback(async (text: string): Promise<string | null> => {
    try {
      const r = await fetch(`/api/admin/reviews/${review.id}/humor-note`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!r.ok) {
        const d = (await r.json().catch(() => ({}))) as { error?: string };
        return d.error ?? `Could not save the humor note (${r.status}).`;
      }
      void loadDetail();
      return null;
    } catch {
      return "Network error: the humor note was not saved.";
    }
  }, [review.id, loadDetail]);

  // Using a visual idea on a gag saves it as that gag's change (plan
  // docs/plans/PLAN_THREE_GAGS.md): in place of the default gag, as an
  // additional gag, or in place of a named one. The Facts editor's Draft more
  // gags offers the same actions (useGagIdeaActions).
  const onIdeaApplied = useCallback((view: FactGagsView) => {
    setGagsView(view);
    setGagsReloadKey((k) => k + 1);
  }, []);
  const { actions: conceptActions, saving: ideaSaving } = useGagIdeaActions({
    factId: stagingFactId,
    reviewId: review.id,
    gagsView,
    onApplied: onIdeaApplied,
    onError: setError,
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
      // A refused approval says why in words: CONCEPT_MISSING names each gag's
      // missing examples ("Gag 1 needs female and pet examples.").
      const d = (await r.json().catch(() => ({}))) as { error?: string };
      setError(d.error ?? `Request failed (${r.status})`);
    } catch {
      setError("Network error — could not reach the server.");
    } finally {
      setLoading(false);
    }
  }, [review.id, onActionDone, onClose]);

  const onProvisionalApprove = () => {
    const body: Record<string, unknown> = { adminNote: note || undefined };
    if (wordingDirty) { setError("Save or undo the wording edit before accepting."); return; }
    void runAction("provisional-approve", body);
  };
  const onReject = () => {
    // The rejection reason judges whether the FACT belongs in the database.
    if (!reason) { setError("Please select a rejection reason before rejecting."); return; }
    // Past triage, Reject deletes the submission's gags: ask first.
    if (stage !== "triage" && !confirmReject) { setError(""); setConfirmReject(true); return; }
    setConfirmReject(false);
    void runAction("reject", { rejectionReason: reason, adminNote: note || undefined });
  };
  const onApproveProduction = () => {
    const body: Record<string, unknown> = {
      adminNote: note || undefined,
      hashtags: finalHashtags,
    };
    void runAction("approve-for-production", body);
  };

  // Dedicated step-transition handlers. Unlike runAction (which CLOSES
  // the modal on success), these keep it OPEN: apply the returned workflowStage,
  // move the wizard step, and reload detail + the list row.
  const applyTransition = useCallback((nextStage: ReviewWorkflowStage, nextStep: WizardStep) => {
    setStage(nextStage);
    autoNavStagesRef.current.add(nextStage); // don't let the sync effect re-nav
    setStep(nextStep);
    void loadDetail();
    onRendersEnqueued(); // refresh the list row (stage / render state)
  }, [loadDetail, onRendersEnqueued]);

  // Reading → Gags: approve the note as shown. Resolves to an error message
  // for the Reading step, or null when the review moved on.
  const onApproveReading = useCallback(async (text: string, readingId: number): Promise<string | null> => {
    try {
      const r = await fetch(`/api/admin/reviews/${review.id}/approve-reading`, {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, readingId }),
      });
      const d = (await r.json().catch(() => ({}))) as { error?: string; workflowStage?: ReviewWorkflowStage };
      if (r.ok && d.workflowStage) { applyTransition(d.workflowStage, "concept"); return null; }
      void loadDetail();
      return d.error ?? `Could not approve the humor note (${r.status}).`;
    } catch {
      return "Network error: the humor note was not approved.";
    }
  }, [review.id, applyTransition, loadDetail]);

  // The Reading step's "Try again" / "Write the reading".
  const onRetryReading = useCallback(async (): Promise<void> => {
    setError("");
    try {
      const r = await fetch(`/api/admin/reviews/${review.id}/reading/retry`, {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" }, body: "{}",
      });
      if (!r.ok) {
        const d = (await r.json().catch(() => ({}))) as { error?: string };
        setError(d.error ?? `Could not start the reading (${r.status}).`);
      }
    } catch {
      setError("Network error — could not start the reading.");
    } finally {
      void loadDetail();
      onRendersEnqueued();
    }
  }, [review.id, loadDetail, onRendersEnqueued]);

  const onApproveVisualConcept = useCallback(async (): Promise<void> => {
    setLoading(true); setError("");
    try {
      const r = await fetch(`/api/admin/reviews/${review.id}/approve-visual-concept`, {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" }, body: "{}",
      });
      const d = (await r.json().catch(() => ({}))) as { error?: string; workflowStage?: ReviewWorkflowStage };
      if (r.ok && d.workflowStage) { applyTransition(d.workflowStage, "render"); return; }
      setError(d.error ?? `Could not approve the visual gag (${r.status}).`);
    } catch {
      setError("Network error — could not approve the visual gag.");
    } finally {
      setLoading(false);
    }
  }, [review.id, applyTransition]);

  const onBackToVisualConcept = useCallback(async (): Promise<void> => {
    setLoading(true); setError("");
    try {
      const r = await fetch(`/api/admin/reviews/${review.id}/back-to-visual-concept`, {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" }, body: "{}",
      });
      const d = (await r.json().catch(() => ({}))) as { error?: string; workflowStage?: ReviewWorkflowStage };
      if (r.ok && d.workflowStage) { applyTransition(d.workflowStage, "concept"); return; }
      setError(d.error ?? `Could not go back to Gags (${r.status}).`);
    } catch {
      setError("Network error — could not go back to Gags.");
    } finally {
      setLoading(false);
    }
  }, [review.id, applyTransition]);

  // A fact can't ship without discovery tags (the server refuses it too).
  // ── Gag gates (plans PLAN_THREE_GAGS.md and PLAN_GAG_EXAMPLES.md) ──
  // Approving the Gags step needs a saved gag; approving for production needs
  // the fact's whole draft set to meet the go-live rule: one to three gags,
  // each with approved male, female and pet renders of its current content
  // (plan PLAN_FACT_LIFECYCLE_REBUILD.md, item 12). The server evaluates the
  // rule, here (`draftReady`) and again when approving; this only keeps the
  // button honest.
  const gagsLive = gagsView?.gags ?? [];
  const hasSavedGag = gagsLive.some((g) => !!(g.pendingContent ?? g.approvedContent)?.coreSceneOverride?.trim());
  const draftReady = gagsView?.draftReady ?? { ok: false, reason: null };
  const canApproveProduction = finalHashtags.length > 0
    && draftReady.ok
    && !gagsUnsaved;
  const ideasPending = visualConceptStatus === "pending";
  const ideasTerminalOk = visualConceptStatus === "ok";
  // "Approve the gags": enabled with a saved gag AND terminal-OK ideas.
  const canApproveGag = hasSavedGag && ideasTerminalOk && !gagsUnsaved;
  const matchVisible = duplicateMatchShown(wording.duplicate, showClosest);

  // ── Sub-renders ────────────────────────────────────────────────────────────

  const SubmitterContext = (
    <>
      <div className="flex flex-wrap gap-4 text-sm text-muted-foreground">
        <span>
          Submitted by:{" "}
          <strong className="text-foreground">
            {review.submitter?.displayName ?? review.submitter?.email ?? "Unknown"}
          </strong>
        </span>
        {review.submitter?.email && <span>Email: <strong className="text-foreground">{review.submitter.email}</strong></span>}
        <DuplicateVerdictLine
          view={wording.duplicate}
          checking={duplicateCheck.checking}
          failed={duplicateCheck.failed}
          canCheck={stage === "triage"}
          onRetry={() => void duplicateCheck.check()}
          showClosest={showClosest}
          onShowClosest={() => setShowClosest(true)}
        />
        <span>Date: <strong className="text-foreground">{new Date(review.createdAt).toLocaleDateString()}</strong></span>
      </div>

      <div className={`grid gap-4 ${matchVisible ? "grid-cols-1 sm:grid-cols-2" : "grid-cols-1"}`}>
        <SubmissionWording
          reviewId={review.id}
          label="Submitted Fact"
          text={wording.submittedText}
          originalText={wording.submittedTextOriginal}
          editable={canEditWording(stage, review.status, review.stagingFactId != null)}
          onSaved={(saved) => { duplicateCheck.supersede(); setWording(saved); setShowClosest(false); onActionDone(); }}
          onDirtyChange={setWordingDirty}
        />
        {matchVisible && <DuplicateMatchPanel view={wording.duplicate} showClosest={showClosest} />}
      </div>
    </>
  );

  const DecisionInputs = (
    <div className="space-y-4">
      {/* Rejection Reason judges whether the FACT belongs in the database. */}
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
        <label className="block text-sm font-semibold text-foreground mb-2">
          Admin Note{" "}
          <span className="text-muted-foreground font-normal">
            (optional, sent to user)
          </span>
        </label>
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
  );

  // The submitted/live fact card, repeated at the top of Reading, Gags and Test Renders (each
  // may be reviewed in a separate pass, so the fact must be in view on both).
  const SubmittedFactCard = (
    <div className="bg-background border-2 border-border rounded-sm p-4">
      <p className="text-xs font-bold text-muted-foreground uppercase tracking-wide mb-3">
        Submitted Fact
      </p>
      <p className="text-base italic text-foreground leading-relaxed">"{review.submittedText}"</p>
    </div>
  );

  // Reject past triage, confirmed first.
  const RejectConfirm = confirmReject && (
    <div className="rounded-sm border-2 border-destructive/60 bg-destructive/10 p-4 space-y-3" data-testid="reject-confirm">
      <p className="text-sm text-foreground">
        <strong>Reject this submission?</strong> Its gags are deleted, it never goes live, and the submitter is emailed
        the reason{note ? " and your note" : ""}. This can't be undone.
      </p>
      <div className="flex flex-wrap gap-3">
        <Button onClick={onReject} isLoading={loading} disabled={loading}
          className="bg-destructive hover:bg-destructive/90 text-destructive-foreground gap-2" data-testid="reject-confirm-yes">
          <XCircle className="w-4 h-4" /> Yes, reject it
        </Button>
        <Button variant="outline" onClick={() => setConfirmReject(false)} disabled={loading}>Keep it</Button>
      </div>
    </div>
  );

  // data-modal-overlay: FieldInfo's popover uses this to close ONLY itself
  // (not the whole modal) when an outside-tap lands on this backdrop.
  return (
    <div data-modal-overlay className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4" onClick={onClose}>
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

        <div ref={modalBodyRef} className="p-6 space-y-6 overflow-y-auto">
          {/* Step indicator — only for the non-terminal wizard. */}
          {!isResolved && <StepIndicator step={step} />}

          {/* Submitter + fact + duplicate context: Triage step, and always when resolved. */}
          {(isResolved || step === "triage") && SubmitterContext}

          {/* ── Stage helper line (Triage step) ── */}
          {!isResolved && step === "triage" && (
            <p className="text-sm text-muted-foreground">{REVIEW_WORKFLOW_STAGE_DISPLAY[stage].hint}</p>
          )}

          {/* ── READING: the draft humor note and the research beneath it ── */}
          {!isResolved && step === "reading" && isReading && (
            <div className="space-y-4">
              {SubmittedFactCard}
              <ReadingStep
                reading={detail?.reading}
                disabled={loading}
                onApprove={onApproveReading}
                onRetry={onRetryReading}
              />
            </div>
          )}

          {/* ── GAGS — NO renders yet ── */}
          {!isResolved && step === "concept" && isConceptReview && (
            <div className="space-y-4">
              {SubmittedFactCard}

              {/* The fact's gags (plan docs/plans/PLAN_THREE_GAGS.md): each one's
                  scene, bubbles and art direction, saved as that gag's change. */}
              {stagingFactId > 0 && (
                <GagsPanel
                  factId={stagingFactId}
                  characters={classification?.characters}
                  reviewId={review.id}
                  rendersEnabled={false}
                  subjectNames={SUBJECT_NAMES}
                  reloadKey={gagsReloadKey}
                  onView={setGagsView}
                  onUnsavedChange={setGagsUnsavedNames}
                  disabled={loading || ideaSaving}
                  startWithGag1
                  awaitingIdeas={ideasPending}
                />
              )}

              {/* Gag ideas — REQUIRED gate on Gags: each card offers the
                  ways to use it on a gag. */}
              <VisualConceptCandidates
                visualConcepts={detail?.visualConcepts}
                disabled={loading || !gagsView || ideaSaving}
                pickBlockedReason={gagsUnsaved ? `Save or undo your edits to ${unsavedGagsWords} first: using an idea replaces that gag's saved version.` : null}
                actions={conceptActions}
                onGenerate={onGenerateConcepts}
                onSaveNote={onSaveHumorNote}
              />

            </div>
          )}

          {/* ── TEST RENDERS — renders, final hashtags ── */}
          {!isResolved && step === "render" && isProductionReview && (
            <div className="space-y-4">
              {SubmittedFactCard}

              {/* The tags that ship with the fact: a section of its own (plan
                  PLAN_GAG_EXAMPLES.md). */}
              {(
                <div className="rounded-sm border border-border bg-card p-3" data-testid="final-hashtags-section">
                  <FinalHashtagsEditor
                    finalHashtags={finalHashtags}
                    onFinalHashtagsChange={onFinalHashtagsChange}
                    aiSuggestions={suggestedHashtags ?? []}
                  />
                </div>
              )}

              {/* Every gag, editable here too, with its male, female and pet
                  test renders: approving all three makes them that gag's
                  examples (plan docs/plans/PLAN_GAG_EXAMPLES.md). */}
              {stagingFactId > 0 && (
                <GagsPanel
                  factId={stagingFactId}
                  characters={classification?.characters}
                  reviewId={review.id}
                  rendersEnabled
                  rendersExpected
                  subjectNames={SUBJECT_NAMES}
                  reloadKey={gagsReloadKey}
                  onView={setGagsView}
                  onUnsavedChange={setGagsUnsavedNames}
                  disabled={loading}
                />
              )}
            </div>
          )}

          {/* ── Decision inputs on the Triage step (Gags and Test Renders show them beside their actions) ── */}
          {!isResolved && step === "triage" && DecisionInputs}

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
            {RejectConfirm}
            {/* Triage-step decisions: provisional approve / reject. */}
            {!isResolved && step === "triage" && stage === "triage" && (
              <div className="flex flex-wrap gap-3">
                <Button onClick={onProvisionalApprove} isLoading={loading} disabled={loading || wordingDirty}
                  className="bg-green-600 hover:bg-green-700 text-white gap-2">
                  <CheckCircle2 className="w-4 h-4" /> Provisional Approve — Start Prep
                </Button>
                <Button variant="outline" onClick={onReject} isLoading={loading}
                  className="border-destructive text-destructive hover:bg-destructive/10 gap-2">
                  <XCircle className="w-4 h-4" /> Reject
                </Button>
                <Button variant="outline" onClick={onClose} disabled={loading}>Cancel</Button>
              </div>
            )}

            {/* A later step reachable from Triage: a "next" affordance. */}
            {!isResolved && step === "triage" && (isReading || isConceptReview || isProductionReview) && (
              <div className="flex flex-wrap gap-3">
                <Button onClick={() => setStep(isReading ? "reading" : isConceptReview ? "concept" : "render")} disabled={loading}
                  className="bg-primary hover:bg-primary/90 text-primary-foreground gap-2">
                  {isReading ? "Continue to Reading" : isConceptReview ? "Continue to Gags" : "Continue to Test Renders"} <ChevronRight className="w-4 h-4" />
                </Button>
                <Button variant="outline" onClick={onReject} isLoading={loading}
                  className="border-destructive text-destructive hover:bg-destructive/10 gap-2">
                  <XCircle className="w-4 h-4" /> Reject
                </Button>
                <Button variant="outline" onClick={onClose} disabled={loading}>Cancel</Button>
              </div>
            )}

            {/* Reading: approving the note is in the step body; here, reject. */}
            {!isResolved && step === "reading" && isReading && (
              <div className="space-y-3">
                {DecisionInputs}
                <div className="flex flex-wrap gap-3">
                  <Button variant="outline" onClick={() => setStep("triage")} disabled={loading} className="gap-2">
                    <ChevronLeft className="w-4 h-4" /> Back to Triage
                  </Button>
                  <Button variant="outline" onClick={onReject} isLoading={loading}
                    className="border-destructive text-destructive hover:bg-destructive/10 gap-2">
                    <XCircle className="w-4 h-4" /> Reject
                  </Button>
                  <Button variant="outline" onClick={onClose} disabled={loading}>Cancel</Button>
                </div>
              </div>
            )}

            {/* Gags: approve the gags (unlocks renders), or reject. */}
            {!isResolved && step === "concept" && isConceptReview && (
              <div className="space-y-3">
                {DecisionInputs}
                <div className="flex flex-wrap gap-3">
                  <Button variant="outline" onClick={() => setStep("triage")} disabled={loading} className="gap-2">
                    <ChevronLeft className="w-4 h-4" /> Back to Triage
                  </Button>
                  <Button onClick={() => void onApproveVisualConcept()} isLoading={loading}
                    disabled={!canApproveGag || loading}
                    title={canApproveGag ? undefined : "Approve is disabled — see the note below"}
                    className="bg-green-600 hover:bg-green-700 text-white gap-2 disabled:opacity-50"
                    data-testid="approve-visual-gag">
                    <Wand2 className="w-4 h-4" /> Approve the Gags
                  </Button>
                  <Button variant="outline" onClick={onReject} isLoading={loading}
                    className="border-destructive text-destructive hover:bg-destructive/10 gap-2">
                    <XCircle className="w-4 h-4" /> Reject
                  </Button>
                  <Button variant="outline" onClick={onClose} disabled={loading}>Cancel</Button>
                </div>
                {!canApproveGag && (
                  <p className="text-xs text-amber-600 dark:text-amber-400 flex items-center gap-1.5">
                    <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                    {gagsUnsaved
                      ? `Save or undo your edits to ${unsavedGagsWords} first: approving uses the saved gags.`
                      : !hasSavedGag
                      ? "Approve is locked until a gag is saved. Write one above (or use an idea) and save it."
                      : ideasPending
                      ? "Approve is locked while the gag ideas are being written."
                      : "Approve is locked until the gag ideas have been written. Regenerate them above."}
                  </p>
                )}
              </div>
            )}

            {/* Test Renders: approve for production. */}
            {!isResolved && step === "render" && isProductionReview && (
              <div className="space-y-3">
                {DecisionInputs}
                <div className="flex flex-wrap gap-3">
                  <Button variant="outline" onClick={() => void onBackToVisualConcept()} isLoading={loading} disabled={loading}
                    className="gap-2" data-testid="back-to-visual-concept">
                    <ChevronLeft className="w-4 h-4" /> Back to Gags
                  </Button>
                  <Button onClick={() => void onApproveProduction()} isLoading={loading} disabled={!canApproveProduction || loading}
                    title={canApproveProduction ? undefined : "Approve is disabled — see the note below"}
                    className="bg-green-600 hover:bg-green-700 text-white gap-2 disabled:opacity-50"
                    data-testid="approve-for-production">
                    <Rocket className="w-4 h-4" /> Approve for Production
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
                    {gagsUnsaved
                      ? `Save or undo your edits to ${unsavedGagsWords} first: approving uses the saved gags.`
                      : !draftReady.ok
                      ? `Approve is locked until every gag has its male, female and pet renders approved.${draftReady.reason ? ` ${draftReady.reason}` : ""}`
                      : "Approve is locked until there's at least one hashtag. Add a tag under Final hashtags (above the gags) — clearing them all is usually a mistake."}
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
  // `searchInput` is what's typed; `search` is what the list is filtered by,
  // applied after a short pause so each keystroke isn't a request.
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [selectedReview, setSelectedReview] = useState<Review | null>(null);
  const [actionMsg, setActionMsg] = useState("");
  const { data, loading, error, load } = useReviews(statusFilter, page, search);

  useEffect(() => {
    const trimmed = searchInput.trim();
    if (trimmed === search) return;
    const h = setTimeout(() => {
      setSearch(trimmed);
      setPage(1);
      setInitialized(false);
    }, 300);
    return () => clearTimeout(h);
  }, [searchInput, search]);

  const [initialized, setInitialized] = useState(false);
  if (!initialized) { setInitialized(true); void load(); }

  // Live list refresh (rule 8, aggregate altitude): while any row is still
  // "working" — prep running, visual ideas generating, or test renders in flight
  // (incl. a just-forced batch not yet materialized) — poll the page so its stage
  // + per-item status advance without a manual refresh. `deriveModerationQueueState`
  // owns the "is this row spinning?" decision (shared with the row chip).
  const anyActive = !!data?.reviews.some(
    (r) => deriveModerationQueueState({
      status: r.status,
      workflowStage: r.workflowStage,
      readingStatus: r.readingStatus ?? null,
      visualConceptStatus: r.stagingFact?.visualConceptStatus ?? null,
      renderReviewState: r.renderReviewState ?? null,
    }).spinner,
  );
  useEffect(() => {
    if (!anyActive) return;
    const h = setInterval(() => { void load(); }, 2500);
    return () => clearInterval(h);
  }, [anyActive, load]);

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

  const preppingCount = data?.reviews.filter((r) => r.workflowStage === "reading" && r.readingStatus === "pending").length ?? 0;

  const totalPages = data ? Math.ceil(data.total / data.limit) : 1;

  const FILTERS: { label: string; value: typeof statusFilter }[] = [
    { label: "Pending", value: "pending" },
    { label: "Approved", value: "approved" },
    { label: "Rejected", value: "rejected" },
    { label: "All", value: "all" },
  ];

  return (
    <div className="space-y-4">
      <div className="relative">
        <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
        <input
          type="search"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          placeholder="Search reviews by fact text or review number…"
          aria-label="Search reviews"
          data-testid="moderation-search"
          className="w-full pl-9 pr-3 py-2 bg-card border border-border rounded-sm text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary"
        />
      </div>

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
          {preppingCount} {preppingCount === 1 ? "fact is" : "facts are"} being read — updating live.
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
          <p>
            No {statusFilter === "all" ? "" : statusFilter} reviews found
            {search ? <> matching &ldquo;{search}&rdquo;</> : null}.
          </p>
        </div>
      )}

      {data && data.reviews.length > 0 && (
        <div className="space-y-3">
          {data.reviews.map((r) => {
            // Shared queue-state derivation (§8 label table) — one place decides
            // the row's headline label + spinner (also used for the poll trigger).
            const qs = deriveModerationQueueState({
              status: r.status,
              workflowStage: r.workflowStage,
              readingStatus: r.readingStatus ?? null,
              visualConceptStatus: r.stagingFact?.visualConceptStatus ?? null,
              renderReviewState: r.renderReviewState ?? null,
            });
            const qsTone =
              qs.tone === "working" ? "text-blue-600 dark:text-blue-400"
              : qs.tone === "ready" ? "text-green-600 dark:text-green-400"
              : qs.tone === "attention" ? "text-amber-600 dark:text-amber-400"
              : "text-muted-foreground";
            return (
            <div key={r.id}
              className="bg-card border border-border rounded-sm p-4 hover:border-primary/40 cursor-pointer transition-colors"
              onClick={() => setSelectedReview(r)}>
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-3 mb-2 flex-wrap">
                    <StageBadge stage={r.workflowStage} />
                    <ReasonBadge reason={r.reason} />
                    {r.duplicate?.state === "duplicate" && (
                      <span className="inline-flex items-center gap-1 text-xs font-semibold text-primary" data-testid="queue-duplicate-label" title={verdictLabel(r.duplicate)}>
                        Possible duplicate
                      </span>
                    )}
                    {r.status === "pending" && (
                      <span className={`inline-flex items-center gap-1.5 text-xs font-semibold ${qsTone}`} data-testid="queue-state-label">
                        {qs.spinner && <Loader2 className="w-3 h-3 animate-spin" />}
                        {qs.label}
                      </span>
                    )}
                    <span className="text-xs text-muted-foreground">
                      Review #{r.id} ·{" "}
                      by {r.submitter?.displayName ?? r.submitter?.email ?? "unknown"} · {new Date(r.createdAt).toLocaleDateString()}
                    </span>
                  </div>
                  <p className="text-sm text-foreground italic line-clamp-2">"{r.submittedText}"</p>
                  {r.duplicate?.state === "duplicate" && (r.duplicate.fact ?? r.duplicate.review) && (
                    <p className="text-xs text-muted-foreground mt-1 truncate" data-testid="queue-duplicate-match">
                      vs. "{(r.duplicate.fact ?? r.duplicate.review)!.text}"
                    </p>
                  )}
                  {/* Per-row live prep status (rule 8: per-item, in place). */}
                  {r.stagingFact && (r.workflowStage === "reading" || r.workflowStage === "gags" || r.workflowStage === "test_renders") && (
                    <div className="flex flex-wrap gap-2 mt-2">
                      {r.workflowStage === "reading" && (
                        <PrepStepPill icon={Wand2} label="Reading" status={r.readingStatus ?? null} attentionWhenNull />
                      )}
                      {/* Gags: Gag ideas are the required gate. A null status
                          reads as "not generated", never a spinner. */}
                      {r.workflowStage === "gags" && (
                        <PrepStepPill icon={Wand2} label="Gag ideas" status={r.stagingFact.visualConceptStatus} attentionWhenNull />
                      )}
                      {/* Test Renders: renders in flight (re-run, or the forced batch). */}
                      {r.workflowStage === "test_renders" && r.rendersRunning && (
                        <PrepStepPill icon={Wand2} label="Test renders" status="pending" />
                      )}
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
            );
          })}
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
          onRendersEnqueued={() => void load()}
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
