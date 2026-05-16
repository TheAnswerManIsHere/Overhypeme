import { useEffect, useRef, useState } from "react";

interface JobStatus {
  phase: "queued" | "in_progress" | "completed" | "failed";
  progress: number;
  generatedObjectPath?: string;
  errorCode?: string;
  errorMessage?: string;
  etaSeconds?: number;
}

interface Props {
  jobId: string;
  onComplete: (generatedObjectPath: string) => void;
  onError: (errorCode: string, message?: string) => void;
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
export function PulidLoadingTakeover({ jobId, onComplete, onError }: Props) {
  const [displayProgress, setDisplayProgress] = useState(0.05);
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
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const status = (await res.json()) as JobStatus;
        consecutiveErrors = 0;
        lastServerUpdateAtRef.current = Date.now();
        lastServerProgressRef.current = status.progress;

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
      } catch {
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
  }, [jobId, onComplete, onError]);

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

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Forging your likeness"
      className="fixed inset-0 z-[60] flex flex-col items-center justify-center bg-[#111] px-6 text-center"
      data-testid="pulid-loading-takeover"
    >
      <h1 className="font-display text-3xl uppercase tracking-wide text-white">
        Forging your likeness.
      </h1>
      <p className="mt-3 max-w-sm text-sm text-white/70">
        Standard mortals take days. This takes seconds.
      </p>
      <div className="mt-8 w-full max-w-sm" aria-hidden>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
          <div
            className="h-full bg-[#ff6b35] transition-[width] duration-150 ease-out"
            style={{ width: `${Math.round(Math.min(1, Math.max(0, displayProgress)) * 100)}%` }}
            data-testid="pulid-progress-fill"
          />
        </div>
      </div>
    </div>
  );
}
