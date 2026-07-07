import { useState, useEffect, useCallback, useRef } from "react";
import { AdminLayout } from "@/components/admin/AdminLayout";
import { Link } from "wouter";
import { Button } from "@/components/ui/Button";
import {
  CheckCircle, CheckCircle2, XCircle, Clock, ChevronLeft, ChevronRight,
  ExternalLink, ClipboardList, Loader2, AlertTriangle, GitBranch,
  MessageSquare, Trash2, User, Image as ImageIcon, Sparkles, RefreshCw, Rocket,
  CheckCheck, SlidersHorizontal, Wand2,
} from "lucide-react";
import {
  type FactEnrichment,
  REVIEW_WORKFLOW_STAGE_DISPLAY,
  type ReviewWorkflowStage,
  type RenderReviewState,
  type RenderScenarioKey,
  RENDER_SCENARIO_DESCRIPTORS,
  type VisualConceptsResponse,
} from "@workspace/api-zod";
import {
  deriveModerationQueueState,
  stageToWizardStep,
  type WizardStep,
} from "@/components/admin/moderationQueueState";
import { EnrichmentEditor, EnrichmentSummary, isApprovable, withCoreSceneOverride } from "@/components/admin/EnrichmentEditor";
import { useFactEnrichmentEditing } from "@/components/admin/useFactEnrichmentEditing";
import { RefreshReviewBadge } from "@/components/admin/RefreshReviewBadge";
import { RuntimePromptPreview } from "@/components/admin/RuntimePromptPreview";
import { CollapsibleSection } from "@/components/CollapsibleSection";
import { FactVisualReviewGrid } from "@/components/admin/FactVisualReviewGrid";
import { VisualConceptCard } from "@/components/admin/VisualConceptCard";
import { VisualConceptCandidates } from "@/components/admin/VisualConceptCandidates";

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
  /** Visual-Idea generation lifecycle (facts.visual_concept_status). */
  visualConceptStatus: PrepStatus;
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
  /**
   * Non-null ⇒ this is a REFRESH cycle of a live fact (versioned enrichment):
   * Step 2 reviews/edits the candidate version, approval promotes it, and
   * rejection keeps the live fact exactly as-is. Null for first-time submissions.
   */
  candidateVersionId: number | null;
  /** True while a test render (auto-batch or manual re-run) is queued/rendering. */
  rendersRunning?: boolean;
  /** Coarse Step-3 render state (production_review rows only; null otherwise). */
  renderReviewState?: RenderReviewState | null;
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

/**
 * One prep step's live state. null/"pending" render as "working" (spinner).
 *
 * `optional` steps (e.g. best-effort seeding) never block approval, so they use a
 * softened palette: a failure reads as muted "unavailable" (not the alarming
 * destructive red of a required step), and a `null` status means "not run yet"
 * (muted, no spinner) rather than "working".
 *
 * `attentionWhenNull` is for a REQUIRED step whose `null` means "never generated
 * for this cycle" (e.g. Visual ideas on an old Step-3 row bounced back to Visual
 * Concept) — an actionable not-ready state, NOT work in progress. It renders as
 * amber "not generated" with no spinner, so the prep summary never masks it.
 */
function PrepStepPill({ icon: Icon, label, status, optional, attentionWhenNull }: { icon: typeof Sparkles; label: string; status: PrepStatus; optional?: boolean; attentionWhenNull?: boolean }) {
  const ok = status === "ok";
  const failed = status === "failed";
  const notGenerated = !optional && attentionWhenNull === true && status == null;
  const notStarted = optional && status == null;
  const tone = ok
    ? "text-green-600 dark:text-green-400 border-green-500/30 bg-green-500/10"
    : failed
    ? (optional ? "text-amber-700 dark:text-amber-400 border-amber-500/30 bg-amber-500/10" : "text-destructive border-destructive/30 bg-destructive/10")
    : notGenerated
    ? "text-amber-700 dark:text-amber-400 border-amber-500/30 bg-amber-500/10"
    : notStarted
    ? "text-muted-foreground border-border bg-muted/40"
    : "text-blue-600 dark:text-blue-400 border-blue-500/30 bg-blue-500/10";
  const word = ok ? "ready" : failed ? (optional ? "unavailable" : "failed") : notGenerated ? "not generated" : notStarted ? "not run" : "working…";
  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-1 text-xs font-medium rounded-sm border ${tone}`}>
      <Icon className="w-3.5 h-3.5 shrink-0" />
      <span className="font-semibold">{label}</span>
      {ok ? <CheckCircle2 className="w-3.5 h-3.5" />
        : failed ? (optional ? <AlertTriangle className="w-3.5 h-3.5" /> : <XCircle className="w-3.5 h-3.5" />)
        : notGenerated ? <AlertTriangle className="w-3.5 h-3.5" />
        : notStarted ? null
        : <Loader2 className="w-3.5 h-3.5 animate-spin" />}
      <span>{word}</span>
      {optional && <span className="text-[10px] font-mono opacity-70">optional</span>}
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
  visualConceptStatus,
  conceptRequired,
}: {
  enrichmentStatus: PrepStatus;
  pexelsStatus: PrepStatus;
  /** Candidate Visual ideas (facts.visual_concept_status). */
  visualConceptStatus?: PrepStatus;
  /**
   * Step 2 (Visual Concept): Visual Ideas are a REQUIRED gate — counted in the
   * tally alongside Enrichment, and Pexels drops to best-effort background
   * seeding. Elsewhere (prep / Step 3) the old Enrichment + Pexels tally holds
   * and Visual ideas render as an optional bonus pill.
   */
  conceptRequired?: boolean;
}) {
  const tallySteps: PrepStatus[] = conceptRequired
    ? [enrichmentStatus, visualConceptStatus ?? null]
    : [enrichmentStatus, pexelsStatus];
  const done = tallySteps.filter((s) => s === "ok").length;
  const failed = tallySteps.filter((s) => s === "failed").length;
  // A required Visual-ideas step that's `null` means "never generated for this
  // cycle" — an actionable not-ready state, NOT work in progress. Keep it out of
  // the running count so the summary doesn't mask it as a spinner.
  const notGenerated = conceptRequired === true && visualConceptStatus == null ? 1 : 0;
  const running = tallySteps.length - done - failed - notGenerated;
  return (
    <div className="space-y-2">
      <p className="text-xs font-mono text-muted-foreground">
        Prep: {done} of {tallySteps.length} ready
        {failed > 0 ? ` · ${failed} failed` : ""}
        {notGenerated > 0 ? ` · ${notGenerated} not generated` : ""}
        {running > 0 ? ` · ${running} working` : ""}
      </p>
      <div className="flex flex-wrap gap-2">
        <PrepStepPill icon={Sparkles} label="Enrichment" status={enrichmentStatus} />
        {conceptRequired && (
          <PrepStepPill icon={Wand2} label="Visual ideas" status={visualConceptStatus ?? null} attentionWhenNull />
        )}
        <PrepStepPill
          icon={ImageIcon}
          label={conceptRequired ? "Pexels images (background)" : "Pexels images"}
          status={pexelsStatus}
          optional={conceptRequired}
        />
        {!conceptRequired && visualConceptStatus !== undefined && (
          <PrepStepPill icon={Wand2} label="Visual ideas" status={visualConceptStatus} optional />
        )}
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
  /** Slice 2A: normalized candidate Visual concepts (server-computed `current`). */
  visualConcepts?: VisualConceptsResponse;
}

/** A single visual-render problem returned by approve-for-production's 409. */
interface VisualRenderProblem {
  scenarioKey: RenderScenarioKey;
  status: string;
}

/** Three-step wizard for a non-terminal review (WizardStep from the shared helper). */
const WIZARD_STEPS: { id: WizardStep; label: string }[] = [
  { id: "triage", label: "Triage" },
  { id: "concept", label: "Visual Concept" },
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
 * Stage-aware review modal for the three-gate moderation lifecycle, presented as
 * a three-step wizard for non-terminal reviews:
 *
 *  - Step 1 "Triage": keep/reject decision + duplicate context + submitter info.
 *  - Step 2 "Visual Concept": Visual-Idea candidates + Visual Concept card +
 *    Advanced Options (enrichment / strategy / prompt diagnostics). NO renders
 *    yet — "Approve the visual gag" advances to Step 3 and force-fires renders.
 *  - Step 3 "Test Renders": output-first scenario grid + Advanced Options; final
 *    "Approve for Production" (existing render gate) or "Back to Visual Concept".
 *
 * Stage mapping:
 *  - triage_pending     → Step 1 only (provisional approve / variant / reject —
 *    the ONLY stage a first-time submission can be rejected from).
 *  - prep_pending        → Step 1 + LIVE prep status, polled until terminal (rule 8).
 *  - prep_failed         → Step 1 + retry prep. Stays pending until it succeeds.
 *  - concept_review      → Step 2 default (approve the visual gag / send back).
 *  - production_review   → Step 3 default (approve for production / back to concept).
 *  - resolved            → read-only summary + link to the live fact.
 *
 * Once triage passes, a first-time candidate is never rejected again — a
 * failed prep, an unfinished Visual Concept, or a render that isn't ready
 * just leaves it pending until an admin resolves it. A refresh cycle (an
 * already-live fact) is the one exception: its "reject" ("don't promote
 * this refresh") is available from any of these stages via `canRejectNow`.
 */
function ReviewModal({
  review,
  onClose,
  onActionDone,
  onRendersEnqueued,
  duplicateThreshold,
}: {
  review: Review;
  onClose: () => void;
  onActionDone: () => void;
  /** Refresh the list after a test render is (re-)run so its row pill lights up. */
  onRendersEnqueued: () => void;
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

  // Visual-render approval waiver (set when approve-for-production returns 409).
  const [renderProblems, setRenderProblems] = useState<VisualRenderProblem[] | null>(null);
  const modalBodyRef = useRef<HTMLDivElement | null>(null);

  const stagingFactId = detail?.stagingFact?.id ?? review.stagingFactId ?? 0;
  const isConceptReview = stage === "concept_review";
  const isProductionReview = stage === "production_review";
  // Both Step 2 and Step 3 expose the enrichment/Visual-Concept editor.
  const isEditableStep = isConceptReview || isProductionReview;
  const isResolved = review.status !== "pending";
  // A refresh cycle of a LIVE fact: Step 2 edits the CANDIDATE version (the
  // live fact's enrichment is frozen), approval promotes it, rejection keeps
  // the live fact untouched. Set at review creation — never flips mid-mount.
  const isRefreshCycle = (detail?.candidateVersionId ?? review.candidateVersionId) != null;
  const pexelsStatus: PrepStatus = detail?.stagingFact?.pexelsStatus ?? review.stagingFact?.pexelsStatus ?? null;
  const liveEnrichmentStatus: PrepStatus = detail?.stagingFact?.enrichmentStatus ?? review.stagingFact?.enrichmentStatus ?? null;

  // Production-review enrichment editing — the SHARED engine (same hook as the
  // Edit Fact screen, so the two flows stay in lockstep): tracked fields persist
  // instantly as per-field overrides on the staging fact (chips / Revert to AI /
  // "AI changed — review"); the Visual Strategy Override is the only untracked
  // field this surface may save, through the localStorage-backed draft (an
  // accidentally closed modal never loses work). Every successful mutation bumps
  // `gridReloadKey` so the scenario tiles recompute staleness immediately.
  const [gridReloadKey, setGridReloadKey] = useState(0);
  const enrichEditing = useFactEnrichmentEditing({
    // Refresh cycles edit the CANDIDATE version through the review-scoped
    // endpoints; first-time cycles edit the staging fact as before.
    target: isRefreshCycle
      ? { kind: "reviewCandidate", reviewId: review.id, factId: stagingFactId }
      : { kind: "fact", factId: stagingFactId },
    // Editable in BOTH Step 2 (Visual Concept) and Step 3 (Test Renders).
    enabled: isEditableStep && stagingFactId > 0,
    editableUntrackedFields: ["visualPromptStrategyOverride"],
    onAfterMutation: () => setGridReloadKey((k) => k + 1),
  });
  const { enrichment, draft: enrichmentDraft, jobs } = enrichEditing;

  // Moderator-curated FINAL discovery tags — what actually ships on approval.
  // Seeded from the submitter's tags, or the AI suggestions when the submitter
  // left none, so the editor opens on what would ship. `finalHashtagsDirtyRef`
  // keeps the moderator's edits from being reseeded by polling / enrichment
  // reloads. Sent in the approve body; a fact can't be approved with none.
  const [finalHashtags, setFinalHashtags] = useState<string[]>([]);
  const finalHashtagsDirtyRef = useRef(false);
  useEffect(() => {
    if (finalHashtagsDirtyRef.current) return;
    const submitter = review.hashtags ?? [];
    setFinalHashtags(submitter.length > 0 ? submitter : (enrichment?.suggestedHashtags ?? []));
  }, [review.hashtags, enrichment]);
  const onFinalHashtagsChange = (tags: string[]) => {
    finalHashtagsDirtyRef.current = true;
    setFinalHashtags(tags);
  };

  // Wizard step. The step follows the stage: concept_review opens on Step 2,
  // production_review on Step 3, everything else on Triage. When the stage first
  // reaches a NEW value (e.g. prep finishing → concept_review, or the dedicated
  // approve/back handlers moving it), auto-navigate to the matching step — but
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
    const r = await fetch(`/api/admin/reviews/${review.id}`, { credentials: "include" });
    if (!r.ok) return;
    const d = (await r.json()) as ReviewDetail;
    setDetail(d);
    setStage(d.workflowStage);
    setNote((cur) => (cur === "" && d.adminNote ? d.adminNote : cur));
    setReason((cur) => (cur === "" && d.reason ? (d.reason as RejectionReason) : cur));
    // Enrichment state is owned by the shared useFactEnrichmentEditing hook
    // (it fetches the staging fact itself once production_review is reached).
  }, [review.id]);

  useEffect(() => { void loadDetail(); }, [loadDetail]);

  // Live prep polling (rule 8): while prep runs, poll ~1.2s with NO timeout so
  // the per-step status stays current until prep is terminal (then it stops).
  useEffect(() => {
    if (stage !== "prep_pending") return;
    const h = setInterval(() => { void loadDetail(); }, 1200);
    return () => clearInterval(h);
  }, [stage, loadDetail]);

  // Finite candidate-concept polling: the concept job runs during
  // production_review (async), so poll ONLY while its status is "pending" and
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
    const coreSceneDraft = enrichment?.visualPromptStrategyOverride?.enabled
      ? (enrichment.visualPromptStrategyOverride.coreSceneOverride?.trim() || null)
      : null;
    setError("");
    // Optimistic "pending" for instant feedback; loadDetail() in finally
    // reconciles against the real server state, so a rejected POST (409 stale
    // stage, 400, 5xx) reverts the pending rather than sticking on "Drafting…".
    setDetail((d) => (d ? { ...d, visualConcepts: { status: "pending", candidates: [], current: false } } : d));
    try {
      const r = await fetch(`/api/admin/reviews/${review.id}/visual-concepts/regenerate`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ coreSceneDraft }),
      });
      if (!r.ok) {
        const d = (await r.json().catch(() => ({}))) as { error?: string };
        setError(d.error ?? `Could not generate visual ideas (${r.status}).`);
      }
    } catch {
      setError("Network error — could not generate visual ideas.");
    } finally {
      void loadDetail();
    }
  }, [review.id, enrichment, loadDetail]);

  const onPickConcept = useCallback((sceneDescription: string) => {
    if (!enrichment) return;
    enrichmentDraft.setValue({
      ...enrichment,
      visualPromptStrategyOverride: withCoreSceneOverride(enrichment.visualPromptStrategyOverride, sceneDescription),
    });
  }, [enrichment, enrichmentDraft]);

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
      const d = (await r.json().catch(() => ({}))) as {
        error?: string;
        problems?: VisualRenderProblem[];
      };
      // 409 visual_render_incomplete: surface the named problem scenarios and
      // offer "Approve anyway (waive)" rather than a generic error.
      if (r.status === 409 && d.error === "visual_render_incomplete" && Array.isArray(d.problems)) {
        setRenderProblems(d.problems);
        setError("");
        return;
      }
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
  const onReject = async () => {
    if (!reason) { setError("Please select a rejection reason before rejecting."); return; }
    // A refresh reject marks the candidate non-pending; drain any in-flight
    // per-field override write first so a field just blurred by this click
    // doesn't fail against the rejected candidate (the edit is moot on reject,
    // but the failed write would surface a spurious error).
    await enrichEditing.flushOverrides();
    void runAction("reject", { rejectionReason: reason, adminNote: note || undefined });
  };
  const onApproveProduction = async (waive?: boolean) => {
    // Land any in-flight per-field override write BEFORE promotion. A tracked
    // field (semantic entity, or a Revert-to-AI reset that never marks the
    // draft dirty) blurred by this very click fires an un-awaited PUT/DELETE;
    // promotion marks the candidate non-pending, so a write still in flight is
    // rejected (CANDIDATE_NOT_PENDING) and the human edit is silently dropped
    // from the promoted fact. Awaiting also lets adoptServerSlice reconcile the
    // draft, so the unsaved-VSO gate below reads true (post-flush) state.
    const flushed = await enrichEditing.flushOverrides();
    if (!flushed) {
      setError(
        isRefreshCycle
          ? "A field edit didn't save — resolve it (retry the field) before promoting."
          : "A field edit didn't save — resolve it (retry the field) before approving.",
      );
      return;
    }
    // Approval publishes the SAVED enrichment (staging fact for first-time
    // cycles; the candidate version for refresh cycles) — the client never
    // sends a blob. An unsaved Visual Strategy draft therefore wouldn't ship;
    // force a Save/Discard first so nothing silently diverges from what the
    // moderator sees. Read isDirty() (ref-based) so it reflects the just-flushed
    // reconcile, not the stale value this closure captured before the await.
    if (enrichmentDraft.isDirty()) {
      setError(
        isRefreshCycle
          ? "You have unsaved Visual Strategy Override edits — Save or Discard them before promoting (approval promotes the saved candidate)."
          : "You have unsaved Visual Strategy Override edits — Save or Discard them before approving (approval publishes the saved staging fact).",
      );
      return;
    }
    // The Pexels-not-ready confirm is a FIRST-TIME concern: a refresh never
    // re-runs image prep (the live fact keeps its existing library).
    if (!isRefreshCycle && pexelsStatus !== "ok" && !confirmApprove && !waive) { setConfirmApprove(true); return; }
    const body: Record<string, unknown> = {
      adminNote: note || undefined,
      // Refresh approval never attaches/rewrites discovery tags — send none.
      ...(isRefreshCycle ? {} : { hashtags: finalHashtags }),
    };
    if (waive && renderProblems) {
      body.waiveVisualRenderIssues = true;
      body.waivedScenarioKeys = renderProblems.map((p) => p.scenarioKey);
    }
    void runAction("approve-for-production", body);
  };

  // Dedicated Step-2/Step-3 transition handlers. Unlike runAction (which CLOSES
  // the modal on success), these keep it OPEN: apply the returned workflowStage,
  // move the wizard step, and reload detail + the list row.
  const applyTransition = useCallback((nextStage: ReviewWorkflowStage, nextStep: WizardStep) => {
    setStage(nextStage);
    autoNavStagesRef.current.add(nextStage); // don't let the sync effect re-nav
    setStep(nextStep);
    void loadDetail();
    onRendersEnqueued(); // refresh the list row (stage / render state)
  }, [loadDetail, onRendersEnqueued]);

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

  // Save the dirty Visual Concept draft first, then approve the gag — but ONLY if
  // the save succeeded. The server gates on the PERSISTED coreSceneOverride, so we
  // must never advance on a browser-only draft.
  const onSaveConceptAndApprove = useCallback(async (): Promise<void> => {
    if (enrichmentDraft.hasUncommittedChanges) {
      const ok = await enrichmentDraft.save();
      if (!ok) return; // save() surfaces its own error; don't advance
    }
    await onApproveVisualConcept();
  }, [enrichmentDraft, onApproveVisualConcept]);

  const onBackToVisualConcept = useCallback(async (): Promise<void> => {
    setLoading(true); setError("");
    try {
      const r = await fetch(`/api/admin/reviews/${review.id}/back-to-visual-concept`, {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" }, body: "{}",
      });
      const d = (await r.json().catch(() => ({}))) as { error?: string; workflowStage?: ReviewWorkflowStage };
      if (r.ok && d.workflowStage) { setRenderProblems(null); applyTransition(d.workflowStage, "concept"); return; }
      setError(d.error ?? `Could not send back to Visual Concept (${r.status}).`);
    } catch {
      setError("Network error — could not send back to Visual Concept.");
    } finally {
      setLoading(false);
    }
  }, [review.id, applyTransition]);

  // A first-time fact can't ship without discovery tags; a refresh keeps the
  // live fact's existing tags, so the gate doesn't apply (the server skips it too).
  const canApproveProduction = isApprovable(enrichment) && (isRefreshCycle || finalHashtags.length > 0);

  // ── Step-2 (Visual Concept) gag-gate derivation ──
  // `enrichment` from the hook is the DRAFT value; when the draft is clean it
  // equals the persisted enrichment, so a clean non-empty concept == a SAVED one.
  const conceptOverride = enrichment?.visualPromptStrategyOverride;
  const draftHasConcept = !!(conceptOverride?.enabled && conceptOverride.coreSceneOverride?.trim());
  const conceptDirty = enrichmentDraft.hasUncommittedChanges;
  const ideasPending = visualConceptStatus === "pending";
  const ideasFailed = visualConceptStatus === "failed";
  const ideasTerminalOk = visualConceptStatus === "ok";
  // The AI candidate cards are stale relative to the current enrichment input,
  // but a SAVED concept is what drives renders — so this is non-blocking.
  const ideasStaleButSaved = ideasTerminalOk && detail?.visualConcepts?.current === false && draftHasConcept;
  // "Approve the visual gag": enabled only with a SAVED (clean) non-empty concept
  // AND terminal-OK ideas. When dirty, the primary action is Save & Continue,
  // which needs a non-empty concept in the draft to persist.
  const canApproveGag = !conceptDirty && draftHasConcept && ideasTerminalOk;
  const canSaveConceptAndContinue = conceptDirty && draftHasConcept;
  // Refresh cycles reject the CANDIDATE, not the fact — the label says so.
  const rejectLabel = isRefreshCycle ? "Don't Promote Refresh" : "Reject";
  // A first-time submission can only be rejected during triage (Step 1) —
  // once triage passes, a stuck candidate stays pending until an admin
  // resolves it. A refresh cycle's "reject" ("don't promote") is always
  // available since it never touches the live fact.
  const canRejectNow = stage === "triage_pending" || isRefreshCycle;
  const matchVisible = review.matchingSimilarity >= duplicateThreshold || showDuplicate;

  // ── Sub-renders ────────────────────────────────────────────────────────────

  const SubmitterContext = (
    <>
      <div className="flex flex-wrap gap-4 text-sm text-muted-foreground">
        <span>
          Submitted by:{" "}
          <strong className="text-foreground">
            {isRefreshCycle ? "Admin-initiated refresh" : (review.submitter?.displayName ?? review.submitter?.email ?? "Unknown")}
          </strong>
        </span>
        {!isRefreshCycle && review.submitter?.email && <span>Email: <strong className="text-foreground">{review.submitter.email}</strong></span>}
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
    </>
  );

  const DecisionInputs = (
    <div className="space-y-4">
      {isRefreshCycle && (
        <p className="text-xs text-muted-foreground" data-testid="refresh-reject-hint">
          This rejects the refresh candidate only. The live fact stays published and unchanged.
        </p>
      )}
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
  );

  // The submitted/live fact card, repeated at the top of Step 2 and Step 3 (each
  // may be reviewed in a separate pass, so the fact must be in view on both).
  const SubmittedFactCard = (
    <div className="bg-background border-2 border-border rounded-sm p-4">
      <p className="text-xs font-bold text-muted-foreground uppercase tracking-wide mb-3">
        {isRefreshCycle ? "Live Fact (being refreshed)" : "Submitted Fact"}
      </p>
      <p className="text-base italic text-foreground leading-relaxed">"{review.submittedText}"</p>
    </div>
  );

  // Draft status + Save/Discard bar — shared by Step 2 and Step 3, kept OUTSIDE
  // (above) the collapsed Advanced Options so an edit made with the section
  // collapsed always has a visible way to persist it.
  const DraftSaveBar = (
    <>
      {enrichmentDraft.hasUncommittedChanges && !enrichmentDraft.commitError && (
        <div className="flex items-center justify-between gap-2 rounded-sm border border-amber-500/40 bg-amber-500/10 px-3 py-2" data-testid="enrichment-unsaved">
          <p className="text-xs text-amber-700 dark:text-amber-300 flex items-center gap-1.5">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
            {enrichmentDraft.committing
              ? "Saving to server…"
              : `Unsaved changes (${enrichmentDraft.draftLabel || "draft kept locally"}) — Save to persist your Visual Concept / render inputs.`}
          </p>
          <div className="flex items-center gap-3 shrink-0">
            <button
              type="button"
              onClick={() => void enrichmentDraft.save()}
              disabled={enrichmentDraft.committing}
              className="text-xs font-bold px-2 py-1 rounded-sm border border-amber-500/50 text-amber-700 dark:text-amber-300 hover:bg-amber-500/10 disabled:opacity-50"
              data-testid="enrichment-save"
            >
              Save
            </button>
            <button type="button" onClick={enrichmentDraft.discard} className="text-xs text-primary underline hover:opacity-80">
              Discard
            </button>
          </div>
        </div>
      )}
      {!enrichmentDraft.hasUncommittedChanges && enrichmentDraft.committedAt != null && (
        <p className="text-xs text-emerald-700 dark:text-emerald-300 flex items-center gap-1.5" data-testid="enrichment-saved">
          <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
          Saved.
        </p>
      )}
      {enrichmentDraft.commitError && (
        <div className="flex items-start gap-2 rounded-sm border border-destructive/50 bg-destructive/10 px-3 py-2">
          <AlertTriangle className="w-4 h-4 text-destructive shrink-0 mt-0.5" />
          <p className="text-sm text-destructive">{enrichmentDraft.commitError}</p>
        </div>
      )}
    </>
  );

  // Advanced Options — the technical machinery, collapsed by default. Shared by
  // Step 2 (tune the concept) and Step 3 (all knobs for render tweaking).
  const AdvancedOptions = (
    <CollapsibleSection
      title="Advanced Options"
      icon={<SlidersHorizontal className="w-4 h-4 text-muted-foreground" />}
      description="Enrichment, references, visual-strategy overrides, and prompt diagnostics."
      storageKey={`overhype:moderation:advanced:${review.id}`}
    >
      <EnrichmentEditor
        value={enrichment}
        status={enrichEditing.enrichmentStatus}
        factText={review.submittedText}
        onChange={(next) => enrichmentDraft.setValue(next)}
        onSave={enrichmentDraft.hasUncommittedChanges ? () => void enrichmentDraft.save() : undefined}
        // Deliberately NO onRerun at Step 2/3 (refresh AND first-time): the
        // generic job guard skips review-backed facts outside prep, so the button
        // could only strand the status on "classifying…". Re-classification lives
        // on the Facts page (live facts) and Retry Prep (prep_failed); refresh
        // cycles are re-classified by rejecting + re-sending.
        busy={loading || jobs.loading || jobs.rerunBusy || enrichmentDraft.committing}
        rerunBusy={jobs.rerunBusy}
        hideHashtags
        overrideContext={enrichEditing.overrideContext}
      />
      {jobs.error && (
        <div className="flex items-start gap-2 rounded-sm border border-destructive/50 bg-destructive/10 px-3 py-2">
          <AlertTriangle className="w-4 h-4 text-destructive shrink-0 mt-0.5" />
          <p className="text-sm text-destructive">{jobs.error}</p>
        </div>
      )}
      {enrichEditing.overrideError && (
        <div className="flex items-start gap-2 rounded-sm border border-destructive/50 bg-destructive/10 px-3 py-2" data-testid="override-error">
          <AlertTriangle className="w-4 h-4 text-destructive shrink-0 mt-0.5" />
          <p className="text-sm text-destructive">{enrichEditing.overrideError}</p>
        </div>
      )}
      {stagingFactId > 0 && (
        <RuntimePromptPreview factId={stagingFactId} reviewIdForRender={review.id} />
      )}
    </CollapsibleSection>
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
            {isRefreshCycle && <RefreshReviewBadge />}
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

          {/* ── Live prep status (prep + concept + Test Renders), on Triage step ── */}
          {step === "triage" && (stage === "prep_pending" || stage === "prep_failed" || isConceptReview || isProductionReview) && (
            <div className="bg-background border-2 border-border rounded-sm p-4">
              <PrepStatusPanel
                enrichmentStatus={isEditableStep ? "ok" : liveEnrichmentStatus}
                pexelsStatus={pexelsStatus}
                visualConceptStatus={isEditableStep ? visualConceptStatus : undefined}
                conceptRequired={isConceptReview}
              />
              {stage === "prep_pending" && (
                <p className="text-xs text-muted-foreground mt-2 flex items-center gap-1.5">
                  <Loader2 className="w-3 h-3 animate-spin" /> Prep is running — this view updates live; you don't need to refresh.
                </p>
              )}
              {stage === "prep_failed" && (
                <p className="text-xs text-destructive mt-2 flex items-center gap-1.5">
                  <AlertTriangle className="w-3.5 h-3.5" />
                  {canRejectNow
                    ? "Enrichment failed after retries. Retry prep, or reject."
                    : "Enrichment failed after retries. Retry prep — this stays pending until it succeeds."}
                </p>
              )}
              {isConceptReview && (
                <p className="text-xs text-muted-foreground mt-2">
                  Prep is complete. Go to <strong>Visual Concept</strong> to review the visual gag and approve it.
                </p>
              )}
              {isProductionReview && (
                <p className="text-xs text-muted-foreground mt-2">
                  Go to <strong>Test Renders</strong> to check the test renders and approve for production.
                </p>
              )}
            </div>
          )}

          {/* ── STEP 2: VISUAL CONCEPT (concept_review) — NO renders yet ── */}
          {!isResolved && step === "concept" && isConceptReview && (
            <div className="space-y-4">
              {SubmittedFactCard}

              {isRefreshCycle && (
                <p className="text-xs text-muted-foreground" data-testid="refresh-step2-hint">
                  Refresh review: you're editing and approving the <strong>candidate</strong> enrichment. Approving the
                  visual gag applies it to future renders only; rejecting keeps the live fact exactly as it is. Existing
                  memes, images, and hashtags are never changed.
                </p>
              )}

              <p className="text-xs text-muted-foreground">
                Accept, edit, or write the Visual Concept — the plain-language description of how the gag works
                visually. Approving the gag spends nothing yet; it unlocks the test renders in the next step.
              </p>

              {/* Visual concept — the moderator's primary lever: describe the
                  picture in plain language and the planner/compiler realize it.
                  Edits the same override blob (and rides the same draft) as the
                  panel inside Advanced Options. */}
              <VisualConceptCard
                value={enrichment?.visualPromptStrategyOverride}
                disabled={!enrichment || loading || enrichmentDraft.committing}
                onChange={(next) => {
                  if (enrichment) enrichmentDraft.setValue({ ...enrichment, visualPromptStrategyOverride: next });
                }}
              />

              {/* Candidate Visual ideas — REQUIRED gate in Step 2: picking one
                  fills the concept field above (draft only; still Save). */}
              <VisualConceptCandidates
                visualConcepts={detail?.visualConcepts}
                disabled={!enrichment || loading || enrichmentDraft.committing}
                onPick={onPickConcept}
                onGenerate={onGenerateConcepts}
              />

              {/* Blocking-gate status for the Visual Ideas prep artifact. */}
              {ideasPending && (
                <p className="text-xs text-muted-foreground flex items-center gap-1.5" data-testid="ideas-pending-note">
                  <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
                  {canRejectNow
                    ? "Visual ideas are still generating. Wait for them to finish, then retry, edit, reject, or send back to prep."
                    : "Visual ideas are still generating. Wait for them to finish, then retry, edit, or send back to prep — this stays pending until it's resolved."}
                </p>
              )}
              {ideasFailed && (
                <p className="text-xs text-destructive flex items-center gap-1.5" data-testid="ideas-failed-note">
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                  {canRejectNow
                    ? "Visual-ideas generation failed. Regenerate them (above), or reject / send back to prep."
                    : "Visual-ideas generation failed. Regenerate them (above), or send back to prep — this stays pending until it's resolved."}
                </p>
              )}
              {visualConceptStatus == null && (
                <p className="text-xs text-amber-600 dark:text-amber-400 flex items-center gap-1.5" data-testid="ideas-missing-note">
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                  Visual ideas haven't been generated for this cycle. Generate them (above) before approving the gag.
                </p>
              )}
              {ideasStaleButSaved && (
                <p className="text-xs text-muted-foreground flex items-center gap-1.5" data-testid="ideas-stale-note">
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0 text-amber-500" />
                  Visual ideas were generated before your latest Advanced Options edit. You can regenerate them, but the
                  saved Visual Concept below is what will drive renders.
                </p>
              )}

              {DraftSaveBar}
              {AdvancedOptions}
            </div>
          )}

          {/* ── STEP 3: TEST RENDERS (production_review) — renders + all knobs ── */}
          {!isResolved && step === "render" && isProductionReview && (
            <div className="space-y-4">
              {SubmittedFactCard}

              {isRefreshCycle && (
                <p className="text-xs text-muted-foreground" data-testid="refresh-step3-hint">
                  Refresh review: you're editing and approving the <strong>candidate</strong> enrichment. Promoting
                  applies it to future renders only; rejecting keeps the live fact exactly as it is. Existing memes,
                  images, and hashtags are never changed.
                </p>
              )}

              <FactVisualReviewGrid
                reviewId={review.id}
                enrichment={enrichment}
                reloadKey={gridReloadKey}
                finalHashtags={finalHashtags}
                onFinalHashtagsChange={onFinalHashtagsChange}
                hideFinalHashtags={isRefreshCycle}
                onRunScenarios={onRendersEnqueued}
              />

              {DraftSaveBar}
              {AdvancedOptions}
            </div>
          )}

          {/* ── Resolved: read-only enrichment summary ── */}
          {isResolved && (detail?.stagingFact?.enrichment ?? review.enrichment) && (
            <EnrichmentSummary e={(detail?.stagingFact?.enrichment ?? review.enrichment) as FactEnrichment} />
          )}

          {/* ── Decision inputs (Triage step only, and only where reject is available) ── */}
          {!isResolved && step === "triage" && canRejectNow && DecisionInputs}

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

          {/* ── Visual-render incomplete (409): named problems + waive option ── */}
          {renderProblems && (
            <div
              className="rounded-sm border border-amber-500/50 bg-amber-500/10 px-3 py-3 space-y-2"
              data-testid="visual-render-incomplete"
            >
              <p className="text-sm font-semibold text-amber-700 dark:text-amber-300 flex items-center gap-1.5">
                <AlertTriangle className="w-4 h-4 shrink-0" /> Visual review is incomplete
              </p>
              <p className="text-xs text-amber-700 dark:text-amber-300">
                These required test renders still have problems. Run or rerun them in Visual review, or approve
                anyway to publish with the issues waived.
              </p>
              <ul className="space-y-1">
                {renderProblems.map((p) => (
                  <li key={p.scenarioKey} className="text-xs text-amber-700 dark:text-amber-300 font-mono">
                    {RENDER_SCENARIO_DESCRIPTORS[p.scenarioKey]?.label ?? p.scenarioKey} — {p.status}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* ── Stage-specific actions ── */}
          <div className="pt-2 border-t border-border space-y-3">
            {/* Triage-step decisions: provisional approve / variant / reject. */}
            {!isResolved && step === "triage" && stage === "triage_pending" && (
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
                  <XCircle className="w-4 h-4" /> {rejectLabel}
                </Button>
                <Button variant="outline" onClick={onClose} disabled={loading}>Cancel</Button>
              </div>
            )}

            {!isResolved && step === "triage" && stage === "prep_pending" && (
              <div className="flex flex-wrap gap-3">
                {canRejectNow && (
                  <Button variant="outline" onClick={onReject} isLoading={loading}
                    className="border-destructive text-destructive hover:bg-destructive/10 gap-2">
                    <XCircle className="w-4 h-4" /> {rejectLabel} (cancels prep)
                  </Button>
                )}
                <Button variant="outline" onClick={onClose} disabled={loading}>Close</Button>
              </div>
            )}

            {!isResolved && step === "triage" && stage === "prep_failed" && (
              <div className="flex flex-wrap gap-3">
                <Button onClick={() => onProvisionalApprove(false)} isLoading={loading} disabled={loading}
                  className="bg-primary hover:bg-primary/90 text-primary-foreground gap-2">
                  <RefreshCw className="w-4 h-4" /> Retry Prep
                </Button>
                {canRejectNow && (
                  <Button variant="outline" onClick={onReject} isLoading={loading}
                    className="border-destructive text-destructive hover:bg-destructive/10 gap-2">
                    <XCircle className="w-4 h-4" /> {rejectLabel}
                  </Button>
                )}
                <Button variant="outline" onClick={onClose} disabled={loading}>Cancel</Button>
              </div>
            )}

            {/* Concept / Test-Renders reachable from Triage: a "next" affordance. */}
            {!isResolved && step === "triage" && (isConceptReview || isProductionReview) && (
              <div className="flex flex-wrap gap-3">
                <Button onClick={() => setStep(isConceptReview ? "concept" : "render")} disabled={loading}
                  className="bg-primary hover:bg-primary/90 text-primary-foreground gap-2">
                  {isConceptReview ? "Continue to Visual Concept" : "Continue to Test Renders"} <ChevronRight className="w-4 h-4" />
                </Button>
                {canRejectNow && (
                  <Button variant="outline" onClick={onReject} isLoading={loading}
                    className="border-destructive text-destructive hover:bg-destructive/10 gap-2">
                    <XCircle className="w-4 h-4" /> {rejectLabel}
                  </Button>
                )}
                <Button variant="outline" onClick={onClose} disabled={loading}>Cancel</Button>
              </div>
            )}

            {/* Step 2 (Visual Concept): approve the gag (unlocks renders), or —
                for a refresh cycle only — decline to promote it. A first-time
                candidate that's stuck here stays pending until an admin fixes
                the Visual Concept; it is never rejected past triage. */}
            {!isResolved && step === "concept" && isConceptReview && (
              <div className="space-y-3">
                {canRejectNow && DecisionInputs}
                <div className="flex flex-wrap gap-3">
                  <Button variant="outline" onClick={() => setStep("triage")} disabled={loading} className="gap-2">
                    <ChevronLeft className="w-4 h-4" /> Back to Triage
                  </Button>
                  {conceptDirty ? (
                    <Button onClick={() => void onSaveConceptAndApprove()} isLoading={loading || enrichmentDraft.committing}
                      disabled={!canSaveConceptAndContinue || loading || enrichmentDraft.committing}
                      title={canSaveConceptAndContinue ? undefined : "Write or pick a Visual Concept first"}
                      className="bg-green-600 hover:bg-green-700 text-white gap-2 disabled:opacity-50"
                      data-testid="save-concept-and-continue">
                      <ChevronRight className="w-4 h-4" /> Save Visual Concept &amp; Continue
                    </Button>
                  ) : (
                    <Button onClick={() => void onApproveVisualConcept()} isLoading={loading}
                      disabled={!canApproveGag || loading}
                      title={canApproveGag ? undefined : "Approve is disabled — see the note below"}
                      className="bg-green-600 hover:bg-green-700 text-white gap-2 disabled:opacity-50"
                      data-testid="approve-visual-gag">
                      <Wand2 className="w-4 h-4" /> Approve the Visual Gag
                    </Button>
                  )}
                  {canRejectNow && (
                    <Button variant="outline" onClick={onReject} isLoading={loading}
                      className="border-destructive text-destructive hover:bg-destructive/10 gap-2">
                      <XCircle className="w-4 h-4" /> {rejectLabel}
                    </Button>
                  )}
                  <Button variant="outline" onClick={onClose} disabled={loading}>Cancel</Button>
                </div>
                {!conceptDirty && !canApproveGag && (
                  <p className="text-xs text-amber-600 dark:text-amber-400 flex items-center gap-1.5">
                    <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                    {!draftHasConcept
                      ? "Approve is locked until a Visual Concept is saved. Write one above (or pick an idea) and Save."
                      : ideasPending
                      ? "Approve is locked while visual ideas are still generating — this updates live."
                      : "Approve is locked until visual ideas have been generated. Regenerate them above."}
                  </p>
                )}
              </div>
            )}

            {/* Step 3 (Test Renders): approve for production (with waiver path). */}
            {!isResolved && step === "render" && isProductionReview && (
              <div className="space-y-3">
                {confirmApprove && pexelsStatus !== "ok" && !renderProblems && (
                  <div className="flex items-start gap-2 rounded-sm border border-amber-500/50 bg-amber-500/10 px-3 py-2">
                    <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
                    <p className="text-sm text-amber-700 dark:text-amber-300">
                      Pexels images aren't ready ({pexelsStatus === "failed" ? "image prep failed" : "still working"}). The fact will go
                      live with no stock-photo library — the meme builder falls back to its other image sources. Click
                      <strong> Approve anyway</strong> to confirm, or close and retry prep first.
                    </p>
                  </div>
                )}
                {/* Rejection Reason + note live here too, right above the buttons —
                    but only for a refresh cycle ("don't promote"). A first-time
                    candidate stuck on a bad render stays pending until an admin
                    fixes it; it is never rejected past triage. */}
                {canRejectNow && DecisionInputs}
                <div className="flex flex-wrap gap-3">
                  <Button variant="outline" onClick={() => void onBackToVisualConcept()} isLoading={loading} disabled={loading}
                    className="gap-2" data-testid="back-to-visual-concept">
                    <ChevronLeft className="w-4 h-4" /> Back to Visual Concept
                  </Button>
                  {renderProblems ? (
                    <Button onClick={() => onApproveProduction(true)} isLoading={loading} disabled={!canApproveProduction || loading}
                      title={canApproveProduction ? undefined : "Approve is disabled — see the note below"}
                      className="bg-amber-600 hover:bg-amber-700 text-white gap-2 disabled:opacity-50"
                      data-testid="approve-anyway-waive">
                      <Rocket className="w-4 h-4" /> {isRefreshCycle ? "Promote Anyway" : "Approve Anyway"} (Waive {renderProblems.length})
                    </Button>
                  ) : (
                    <Button onClick={() => onApproveProduction()} isLoading={loading} disabled={!canApproveProduction || loading}
                      title={canApproveProduction ? undefined : "Approve is disabled — see the note below"}
                      className="bg-green-600 hover:bg-green-700 text-white gap-2 disabled:opacity-50">
                      <Rocket className="w-4 h-4" /> {isRefreshCycle ? "Promote Refresh" : confirmApprove && pexelsStatus !== "ok" ? "Approve Anyway" : "Approve for Production"}
                    </Button>
                  )}
                  {canRejectNow && (
                    <Button variant="outline" onClick={onReject} isLoading={loading}
                      className="border-destructive text-destructive hover:bg-destructive/10 gap-2">
                      <XCircle className="w-4 h-4" /> {rejectLabel}
                    </Button>
                  )}
                  <Button variant="outline" onClick={onClose} disabled={loading}>Cancel</Button>
                </div>
                {!canApproveProduction && (
                  <p className="text-xs text-amber-600 dark:text-amber-400 flex items-center gap-1.5">
                    <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                    {!isApprovable(enrichment)
                      ? "Approve is locked until the enrichment is valid. Re-run classification or fill it in manually. Approval also requires the required test renders above to be fresh and successful (or explicitly waived)."
                      : "Approve is locked until there's at least one hashtag. Add a tag under Final hashtags (above the test renders) — clearing them all is usually a mistake."}
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

  // Live list refresh (rule 8, aggregate altitude): while any row is still
  // "working" — prep running, visual ideas generating, or test renders in flight
  // (incl. a just-forced batch not yet materialized) — poll the page so its stage
  // + per-item status advance without a manual refresh. `deriveModerationQueueState`
  // owns the "is this row spinning?" decision (shared with the row chip).
  const anyActive = !!data?.reviews.some(
    (r) => deriveModerationQueueState({
      status: r.status,
      workflowStage: r.workflowStage,
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
          {data.reviews.map((r) => {
            // Shared queue-state derivation (§8 label table) — one place decides
            // the row's headline label + spinner (also used for the poll trigger).
            const qs = deriveModerationQueueState({
              status: r.status,
              workflowStage: r.workflowStage,
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
                    {r.candidateVersionId != null && <RefreshReviewBadge />}
                    <ReasonBadge reason={r.reason} />
                    {r.status === "pending" && (
                      <span className={`inline-flex items-center gap-1.5 text-xs font-semibold ${qsTone}`} data-testid="queue-state-label">
                        {qs.spinner && <Loader2 className="w-3 h-3 animate-spin" />}
                        {qs.label}
                      </span>
                    )}
                    <span className="text-xs text-muted-foreground">
                      {r.matchingSimilarity >= duplicateThreshold ? `${r.matchingSimilarity}% match · ` : ""}
                      by {r.candidateVersionId != null ? "admin refresh" : (r.submitter?.displayName ?? r.submitter?.email ?? "unknown")} · {new Date(r.createdAt).toLocaleDateString()}
                    </span>
                  </div>
                  <p className="text-sm text-foreground italic line-clamp-2">"{r.submittedText}"</p>
                  {r.matchingFact && r.matchingSimilarity >= duplicateThreshold && (
                    <p className="text-xs text-muted-foreground mt-1 truncate">vs. "{r.matchingFact.text}"</p>
                  )}
                  {/* Per-row live prep status (rule 8: per-item, in place). */}
                  {r.stagingFact && (r.workflowStage === "prep_pending" || r.workflowStage === "prep_failed" || r.workflowStage === "concept_review" || r.workflowStage === "production_review") && (
                    <div className="flex flex-wrap gap-2 mt-2">
                      <PrepStepPill icon={Sparkles} label="Enrichment" status={r.workflowStage === "concept_review" || r.workflowStage === "production_review" ? "ok" : r.stagingFact.enrichmentStatus} />
                      {/* Step 2: Visual ideas are the required gate. A null status
                          (e.g. an old row bounced back) reads as "not generated",
                          never a spinner. */}
                      {r.workflowStage === "concept_review" && (
                        <PrepStepPill icon={Wand2} label="Visual ideas" status={r.stagingFact.visualConceptStatus} attentionWhenNull />
                      )}
                      <PrepStepPill icon={ImageIcon} label="Stock photos" status={r.stagingFact.pexelsStatus} optional={r.workflowStage === "concept_review"} />
                      {/* Step 3: test renders in flight (re-run, or the forced batch). */}
                      {r.workflowStage === "production_review" && r.rendersRunning && (
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
