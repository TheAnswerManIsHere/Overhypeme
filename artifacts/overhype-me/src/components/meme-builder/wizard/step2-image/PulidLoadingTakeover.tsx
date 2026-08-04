import { useEffect, useRef, useState } from "react";
import { LoadingHero } from "@/components/ui/LoadingHero";
import {
  isRetryablePollError,
  pollHttpErrorFromResponse,
  retryDelayMsFor,
} from "../util/pollRetryClassification";

interface JobStatus {
  phase: "queued" | "in_progress" | "no_face_review" | "completed" | "failed";
  progress: number;
  generatedObjectPath?: string;
  errorCode?: string;
  errorMessage?: string;
  etaSeconds?: number;
  /** True when the server fell back to standard generation because no face was detected. */
  isFallback?: boolean;
}

interface Props {
  jobId: string;
  onComplete: (generatedObjectPath: string) => void;
  onError: (errorCode: string, message?: string) => void;
  /**
   * Called when the server parks the job at no_face_review. The parent (Step2Image)
   * responds by unmounting the takeover and surfacing the no-face choice modal so
   * the user can pick: try a different photo, or render an abstract image.
   */
  onNoFaceReview?: () => void;
}

const POLL_INTERVAL_MS = 500;
const FALLBACK_AFTER_MS = 3_000;
/**
 * Constant for the time-based fallback estimator. Picked so the bar reaches
 * ~63% at 18s (matches the default expectedRunMs).
 */
const FALLBACK_TAU_MS = 18_000;

/**
 * Full-screen takeover that drives a realistic progress bar from the
 * /api/memes/pulid-jobs/:jobId polling endpoint. Falls back to an exponential-
 * decay time-based estimator when the server hasn't yielded new progress for
 * `FALLBACK_AFTER_MS`.
 *
 * Copy is locked per Cross-MBFO spec:
 *   "Forging your likeness."
 *   "Standard mortals take days. This takes seconds."
 */
export function PulidLoadingTakeover({ jobId, onComplete, onError, onNoFaceReview }: Props) {
  const [displayProgress, setDisplayProgress] = useState(0.05);
  const [isFallback, setIsFallback] = useState(false);
  const startedAtRef = useRef(Date.now());
  const lastServerUpdateAtRef = useRef(Date.now());
  const lastServerProgressRef = useRef(0.05);
  const terminatedRef = useRef(false);

  // Poll loop.
  useEffect(() => {
    let cancelled = false;
    let consecutiveErrors = 0;

    const poll = async () => {
      if (cancelled || terminatedRef.current) return;
      try {
        const res = await fetch(`/api/memes/pulid-jobs/${encodeURIComponent(jobId)}`, {
          credentials: "include",
        });
        if (!res.ok) throw pollHttpErrorFromResponse(res);
        const status = (await res.json()) as JobStatus;
        consecutiveErrors = 0;
        lastServerUpdateAtRef.current = Date.now();
        lastServerProgressRef.current = status.progress;
        if (status.isFallback) setIsFallback(true);

        if (status.phase === "completed" && status.generatedObjectPath) {
          terminatedRef.current = true;
          setDisplayProgress(1);
          onComplete(status.generatedObjectPath);
          return;
        }
        if (status.phase === "failed") {
          terminatedRef.current = true;
          onError(status.errorCode ?? "internal", status.errorMessage);
          return;
        }
        if (status.phase === "no_face_review") {
          terminatedRef.current = true;
          onNoFaceReview?.();
          return;
        }
      } catch (err) {
        if (isRetryablePollError(err)) {
          // Rate-limited, not broken: back off past the normal poll interval
          // instead of hammering the limiter again immediately. This poller
          // already retries forever regardless, so the classification is
          // used purely for pacing here, not to avoid a false terminal state.
          if (!cancelled && !terminatedRef.current) {
            window.setTimeout(poll, retryDelayMsFor(err, POLL_INTERVAL_MS));
          }
          return;
        }
        consecutiveErrors += 1;
        // After 2 consecutive failures the fallback estimator takes over
        // (see the rAF loop below). We keep polling so we can recover.
      }
      if (!cancelled && !terminatedRef.current) {
        window.setTimeout(poll, POLL_INTERVAL_MS);
      }
    };

    void poll();
    return () => {
      cancelled = true;
    };
  }, [jobId, onComplete, onError, onNoFaceReview]);

  // Smooth animation loop — tween display toward server value, or fall back to
  // a time-based curve when polls are stale.
  useEffect(() => {
    let raf = 0;
    let cancelled = false;

    const tick = () => {
      if (cancelled || terminatedRef.current) return;
      setDisplayProgress((cur) => {
        const sinceServer = Date.now() - lastServerUpdateAtRef.current;
        const stale = sinceServer > FALLBACK_AFTER_MS;
        let target = lastServerProgressRef.current;
        if (stale) {
          const elapsed = Date.now() - startedAtRef.current;
          const fallback = 0.05 + 0.9 * (1 - Math.exp(-elapsed / FALLBACK_TAU_MS));
          target = Math.max(target, Math.min(0.95, fallback));
        }
        // Tween 12% of the gap per frame ≈ smooth catch-up over ~8 frames.
        return cur + (target - cur) * 0.12;
      });
      raf = window.requestAnimationFrame(tick);
    };

    raf = window.requestAnimationFrame(tick);
    return () => {
      cancelled = true;
      if (raf) window.cancelAnimationFrame(raf);
    };
  }, []);

  const heading = isFallback ? "Crafting your scene." : "Forging your likeness.";
  const subtext = isFallback
    ? "No face detected in your photo — generating an AI background instead."
    : "Standard mortals take days. This takes seconds.";

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={heading}
      className="fixed inset-0 z-[60] bg-[#111]"
      data-testid="pulid-loading-takeover"
    >
      <LoadingHero
        heading={heading}
        subhead={subtext}
        progress={displayProgress}
      />
    </div>
  );
}
