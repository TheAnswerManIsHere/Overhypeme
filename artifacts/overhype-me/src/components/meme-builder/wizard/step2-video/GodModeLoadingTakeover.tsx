/**
 * Full-screen takeover that polls a video-job and renders stage-appropriate
 * content. Mounted by the Step 2 (video) orchestrator after a job is
 * created.
 *
 * Phases:
 *   queued / stage1_pulid       → bar 0→25%, forging-likeness copy
 *   stage1_review               → bar paused at 25%, VideoCheckpointScreen
 *   stage1_no_face_review       → bar paused at 25%, no-face fallback prompt
 *   stage2_video / stage2_subtitle / uploading → bar 25→100%, set-in-motion copy
 *   completed                   → onComplete(permalinkUrl)
 *   failed                      → error screen (moderation / service / budget / generic)
 *
 * Top-bar back/X behavior:
 *   stage1_*   → soft confirm "Cancel? Your stylized image will be saved."
 *   stage2_*   → disabled with tooltip "Generation in progress"
 *
 * Progress bar uses requestAnimationFrame exponential smoothing: the server
 * progress is the target, and we ease toward it so quick jumps don't snap.
 */

import { useEffect, useRef, useState, useCallback } from "react";
import { X, ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/Button";
import type { AspectRatio } from "../../types";
import type { LookStyleDTO } from "./data/videoCatalogue";
import { VideoCheckpointScreen } from "./VideoCheckpointScreen";
import { VideoBudgetExceededScreen } from "./VideoBudgetExceededScreen";
import { storageUrlFor } from "./util/resolveSourceImagePath";

export type VideoJobPhase =
  | "queued"
  | "stage1_pulid"
  | "stage1_review"
  | "stage1_no_face_review"
  | "stage2_video"
  | "stage2_subtitle"
  | "uploading"
  | "completed"
  | "failed"
  | "canceled";

export interface VideoJobStatus {
  jobId: string;
  phase: VideoJobPhase;
  /** 0..1 progress. */
  progress: number;
  etaSeconds?: number;
  stylizedStillObjectPath?: string;
  noFaceFallbackUsed?: boolean;
  rawVideoUrl?: string;
  finalVideoObjectPath?: string;
  memeId?: string;
  permalinkUrl?: string;
  errorCode?: "moderation" | "service_unavailable" | "budget_exceeded" | string;
  errorMessage?: string;
  budgetResetDate?: string;
}

export interface VideoJobApi {
  poll: (jobId: string) => Promise<VideoJobStatus>;
  proceed: (jobId: string) => Promise<void>;
  regenerate: (jobId: string, lookStyleId?: string) => Promise<void>;
  proceedWithNoFaceFallback: (jobId: string) => Promise<void>;
  cancel: (jobId: string) => Promise<{ promotedStillObjectPath?: string }>;
}

interface Props {
  jobId: string;
  aspectRatio: AspectRatio;
  currentLookStyleId: string;
  lookStyles: LookStyleDTO[];
  /** When the source mode bypassed Stage 1 entirely (use-photo-as-is etc). */
  bypassedStage1: boolean;
  /** Cost / budget annotations for the checkpoint screen. */
  nextStepCost?: string;
  remainingBudget?: string;
  api: VideoJobApi;
  /** Polling interval. Defaults to 500ms; tests override to 0. */
  pollIntervalMs?: number;
  onComplete: (permalinkUrl: string) => void;
  onCancel: () => void;
  /** Goes back to Step 2 (e.g. from the budget-exceeded terminal). */
  onGoBack: () => void;
}

const STAGE1_PHASES = new Set<VideoJobPhase>([
  "queued",
  "stage1_pulid",
  "stage1_review",
  "stage1_no_face_review",
]);
const STAGE2_PHASES = new Set<VideoJobPhase>([
  "stage2_video",
  "stage2_subtitle",
  "uploading",
]);

export function GodModeLoadingTakeover(props: Props) {
  const {
    jobId,
    aspectRatio,
    currentLookStyleId,
    lookStyles,
    bypassedStage1,
    nextStepCost,
    remainingBudget,
    api,
    pollIntervalMs = 500,
    onComplete,
    onCancel,
    onGoBack,
  } = props;

  const [status, setStatus] = useState<VideoJobStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [stage1Attempts, setStage1Attempts] = useState(1);
  const completedRef = useRef(false);

  // Poll the job.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      try {
        const next = await api.poll(jobId);
        if (cancelled) return;
        setStatus(next);
        if (next.phase === "completed" && !completedRef.current) {
          completedRef.current = true;
          if (next.permalinkUrl) onComplete(next.permalinkUrl);
          return;
        }
        if (next.phase === "failed" || next.phase === "canceled") {
          return;
        }
      } catch {
        // Swallow transient poll errors and try again.
      }
      if (!cancelled) {
        timer = setTimeout(tick, pollIntervalMs);
      }
    };

    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [api, jobId, pollIntervalMs, onComplete]);

  // Smoothed progress via rAF. The target is derived from phase + server
  // progress; the displayed value eases toward it.
  const displayProgress = useSmoothedProgress(deriveTargetProgress(status, bypassedStage1));

  const phase = status?.phase ?? "queued";
  const isStage1 = STAGE1_PHASES.has(phase);
  const isStage2 = STAGE2_PHASES.has(phase);

  const handleTopCancel = useCallback(() => {
    if (isStage1) {
      setConfirmCancel(true);
    }
    // Stage 2 disables the buttons; this is a no-op there.
  }, [isStage1]);

  const handleConfirmCancel = useCallback(async () => {
    setBusy(true);
    try {
      await api.cancel(jobId);
      onCancel();
    } finally {
      setBusy(false);
      setConfirmCancel(false);
    }
  }, [api, jobId, onCancel]);

  const handleProceed = useCallback(async () => {
    setBusy(true);
    try {
      await api.proceed(jobId);
    } finally {
      setBusy(false);
    }
  }, [api, jobId]);

  const handleRegenerate = useCallback(
    async (lookStyleId?: string) => {
      setBusy(true);
      try {
        await api.regenerate(jobId, lookStyleId);
        setStage1Attempts((n) => n + 1);
      } finally {
        setBusy(false);
      }
    },
    [api, jobId],
  );

  const handleNoFaceFallback = useCallback(async () => {
    setBusy(true);
    try {
      await api.proceedWithNoFaceFallback(jobId);
    } finally {
      setBusy(false);
    }
  }, [api, jobId]);

  const stillUrl = status?.stylizedStillObjectPath
    ? storageUrlFor(status.stylizedStillObjectPath)
    : null;

  return (
    <div
      className="fixed inset-0 z-[60] flex flex-col bg-[#0a0a0a] text-white"
      role="dialog"
      aria-modal="true"
      aria-label="Generating your meme"
      data-testid="god-mode-loading"
      data-phase={phase}
    >
      <TopBar
        isStage1={isStage1}
        isStage2={isStage2}
        onCancel={handleTopCancel}
      />

      <ProgressBar value={displayProgress} />

      <div className="flex-1 overflow-y-auto">
        {phase === "queued" || phase === "stage1_pulid" ? (
          <CenteredCopy
            heading="Forging your likeness."
            body="Standard mortals take days. This takes seconds."
          />
        ) : phase === "stage1_review" ? (
          <VideoCheckpointScreen
            stillUrl={stillUrl}
            aspectRatio={aspectRatio}
            currentLookStyleId={currentLookStyleId}
            lookStyles={lookStyles}
            stage1Attempts={stage1Attempts}
            nextStepCost={nextStepCost}
            remainingBudget={remainingBudget}
            onProceed={handleProceed}
            onRegenerateSameStyle={() => handleRegenerate(currentLookStyleId)}
            onRegenerateWithStyle={(id) => handleRegenerate(id)}
            onCancel={() => setConfirmCancel(true)}
            busy={busy}
          />
        ) : phase === "stage1_no_face_review" ? (
          <NoFaceFallback
            stillUrl={stillUrl}
            aspectRatio={aspectRatio}
            busy={busy}
            onTryAgain={async () => {
              setBusy(true);
              try {
                await api.cancel(jobId);
                onCancel();
              } finally {
                setBusy(false);
              }
            }}
            onUseAbstract={handleNoFaceFallback}
          />
        ) : isStage2 ? (
          <CenteredCopy
            heading="Setting you in motion."
            body="Welcome to legend."
          />
        ) : phase === "failed" ? (
          <FailedScreen
            errorCode={status?.errorCode}
            errorMessage={status?.errorMessage}
            budgetResetDate={status?.budgetResetDate}
            onRetry={onGoBack}
            onGoBack={onGoBack}
          />
        ) : phase === "completed" ? (
          <CenteredCopy heading="Done." body="Loading…" />
        ) : (
          <CenteredCopy heading="Working…" body="" />
        )}
      </div>

      {confirmCancel && (
        <CancelConfirm
          onConfirm={handleConfirmCancel}
          onDismiss={() => setConfirmCancel(false)}
          busy={busy}
        />
      )}
    </div>
  );
}

/* ────────────────────────── Sub-components ────────────────────────── */

interface TopBarProps {
  isStage1: boolean;
  isStage2: boolean;
  onCancel: () => void;
}
function TopBar({ isStage1, isStage2, onCancel }: TopBarProps) {
  const disabled = isStage2;
  return (
    <div className="flex items-center justify-between px-3 pt-[env(safe-area-inset-top)] h-12">
      <button
        type="button"
        onClick={disabled ? undefined : onCancel}
        disabled={disabled}
        aria-label="Back"
        title={disabled ? "Generation in progress" : "Cancel"}
        className="flex h-10 w-10 items-center justify-center rounded-full text-white/80 transition hover:bg-white/10 disabled:opacity-30 disabled:cursor-not-allowed"
        data-testid="god-mode-back"
      >
        <ArrowLeft className="h-5 w-5" />
      </button>
      <button
        type="button"
        onClick={disabled ? undefined : onCancel}
        disabled={disabled}
        aria-label="Close"
        title={disabled ? "Generation in progress" : "Cancel"}
        className="flex h-10 w-10 items-center justify-center rounded-full text-white/80 transition hover:bg-white/10 disabled:opacity-30 disabled:cursor-not-allowed"
        data-testid="god-mode-close"
      >
        <X className="h-5 w-5" />
      </button>
      {/* Visually-hidden marker so tests can read which stage the top-bar
          considers itself in. */}
      <span className="sr-only" data-testid="god-mode-topbar-stage">
        {isStage1 ? "stage1" : isStage2 ? "stage2" : "other"}
      </span>
    </div>
  );
}

function ProgressBar({ value }: { value: number }) {
  const pct = Math.max(0, Math.min(100, Math.round(value * 100)));
  return (
    <div
      className="h-[3px] bg-white/10"
      role="progressbar"
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label="Generation progress"
      data-testid="god-mode-progress"
    >
      <div
        className="h-full bg-[#ff6b35] transition-[width] duration-150"
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

function CenteredCopy({ heading, body }: { heading: string; body: string }) {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center px-6 text-center">
      <h2 className="font-display text-3xl uppercase tracking-wide">{heading}</h2>
      {body && <p className="mt-2 text-white/70">{body}</p>}
    </div>
  );
}

interface NoFaceFallbackProps {
  stillUrl: string | null;
  aspectRatio: AspectRatio;
  busy: boolean;
  onTryAgain: () => void;
  onUseAbstract: () => void;
}
function NoFaceFallback({ stillUrl, aspectRatio, busy, onTryAgain, onUseAbstract }: NoFaceFallbackProps) {
  const aspectClass: Record<AspectRatio, string> = {
    landscape: "aspect-[16/9]",
    square: "aspect-square",
    portrait: "aspect-[9/16]",
  };
  return (
    <div className="flex h-full w-full flex-col items-center px-6 pt-6 pb-8 text-center" data-testid="god-mode-no-face">
      <div className="w-full max-w-md space-y-4">
        <h2 className="font-display text-2xl uppercase tracking-wide">
          We couldn't find a face in your photo.
        </h2>
        <p className="text-sm text-white/70">
          The platform expects a photo with your face — but if you'd rather not
          use a face this time, we can generate an abstract image from the fact
          instead.
        </p>
        {stillUrl && (
          <div className={`mx-auto w-full overflow-hidden rounded-xl border border-white/10 bg-black ${aspectClass[aspectRatio]}`}>
            <img src={stillUrl} alt="" className="h-full w-full object-cover" />
          </div>
        )}
        <div className="space-y-2">
          <Button
            type="button"
            disabled={busy}
            onClick={onTryAgain}
            variant="secondary"
            className="w-full"
            data-testid="god-mode-no-face-try-again"
          >
            Try a different photo
          </Button>
          <Button
            type="button"
            disabled={busy}
            onClick={onUseAbstract}
            className="w-full"
            data-testid="god-mode-no-face-use-abstract"
          >
            Use an abstract image based on the fact
          </Button>
        </div>
      </div>
    </div>
  );
}

interface FailedProps {
  errorCode?: string;
  errorMessage?: string;
  budgetResetDate?: string;
  onRetry: () => void;
  onGoBack: () => void;
}
function FailedScreen({ errorCode, errorMessage, budgetResetDate, onRetry, onGoBack }: FailedProps) {
  if (errorCode === "budget_exceeded") {
    return (
      <VideoBudgetExceededScreen
        resetDate={budgetResetDate ?? ""}
        onGoBack={onGoBack}
      />
    );
  }
  if (errorCode === "moderation") {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center px-6 text-center" data-testid="god-mode-failed-moderation">
        <div className="max-w-sm space-y-4">
          <h2 className="font-display text-2xl uppercase tracking-wide">
            That one didn't pass moderation.
          </h2>
          <p className="text-sm text-white/70">
            Pick a different photo or style and try again.
          </p>
          <Button type="button" onClick={onGoBack} variant="secondary">
            Go back
          </Button>
        </div>
      </div>
    );
  }
  if (errorCode === "service_unavailable") {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center px-6 text-center" data-testid="god-mode-failed-service">
        <div className="max-w-sm space-y-4">
          <h2 className="font-display text-2xl uppercase tracking-wide">
            Servers overloaded.
          </h2>
          <p className="text-sm text-white/70">
            Our servers couldn't handle that much legend at once. They need a
            minute. Try again shortly.
          </p>
          <Button type="button" onClick={onRetry} variant="secondary">
            Try again
          </Button>
        </div>
      </div>
    );
  }
  return (
    <div className="flex h-full w-full flex-col items-center justify-center px-6 text-center" data-testid="god-mode-failed-generic">
      <div className="max-w-sm space-y-4">
        <h2 className="font-display text-2xl uppercase tracking-wide">
          Something went wrong.
        </h2>
        <p className="text-sm text-white/70">
          {errorMessage ?? "We hit a snag. Try again in a moment."}
        </p>
        <Button type="button" onClick={onRetry} variant="secondary">
          Try again
        </Button>
      </div>
    </div>
  );
}

interface CancelConfirmProps {
  onConfirm: () => void;
  onDismiss: () => void;
  busy: boolean;
}
function CancelConfirm({ onConfirm, onDismiss, busy }: CancelConfirmProps) {
  return (
    <div
      className="absolute inset-0 z-[70] flex items-center justify-center bg-black/80 backdrop-blur-sm"
      data-testid="god-mode-cancel-confirm"
    >
      <div className="mx-4 w-full max-w-sm space-y-4 rounded-lg border border-white/10 bg-[#111] p-5">
        <h3 className="font-display text-lg uppercase tracking-wide">Cancel?</h3>
        <p className="text-sm text-white/70">
          Your stylized image will be saved to your library.
        </p>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="ghost"
            disabled={busy}
            onClick={onDismiss}
            className="flex-1"
          >
            Keep going
          </Button>
          <Button
            type="button"
            variant="secondary"
            disabled={busy}
            onClick={onConfirm}
            className="flex-1"
            data-testid="god-mode-cancel-confirm-yes"
          >
            Cancel job
          </Button>
        </div>
      </div>
    </div>
  );
}

/* ────────────────────────── Helpers ────────────────────────── */

function deriveTargetProgress(
  status: VideoJobStatus | null,
  bypassedStage1: boolean,
): number {
  if (!status) return bypassedStage1 ? 0.02 : 0;
  const { phase, progress } = status;
  const clamped = Math.max(0, Math.min(1, progress));
  if (phase === "queued" || phase === "stage1_pulid") {
    // Map server 0..1 to 0..0.25.
    return clamped * 0.25;
  }
  if (phase === "stage1_review" || phase === "stage1_no_face_review") {
    return 0.25;
  }
  if (phase === "stage2_video" || phase === "stage2_subtitle" || phase === "uploading") {
    // When stage 1 was bypassed, use the full 0..1; otherwise 0.25..1.
    if (bypassedStage1) return clamped;
    return 0.25 + clamped * 0.75;
  }
  if (phase === "completed") return 1;
  return 0;
}

/**
 * Exponential-decay smoothing of the progress bar driven by rAF.
 *
 * Pattern mirrors how the image flow's PuLID overlay eases its
 * estimated-progress bar — the bar never snaps to the new target, it
 * approaches it asymptotically so quick poll jumps look smooth.
 */
function useSmoothedProgress(target: number): number {
  const [display, setDisplay] = useState(target);
  const rafRef = useRef<number | null>(null);
  const targetRef = useRef(target);
  const lastRef = useRef(target);

  useEffect(() => {
    targetRef.current = target;
    // If we don't have rAF (jsdom in tests sometimes does, sometimes
    // doesn't), just jump straight to the target.
    if (typeof requestAnimationFrame !== "function") {
      lastRef.current = target;
      setDisplay(target);
      return;
    }
    if (rafRef.current !== null) return; // already running

    const tick = () => {
      const diff = targetRef.current - lastRef.current;
      if (Math.abs(diff) < 0.001) {
        lastRef.current = targetRef.current;
        setDisplay(targetRef.current);
        rafRef.current = null;
        return;
      }
      lastRef.current = lastRef.current + diff * 0.18;
      setDisplay(lastRef.current);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [target]);

  return display;
}
