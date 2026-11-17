/**
 * @purpose The submit page's duplicate preview: the server's verdict for the text being judged, dropped the moment that text changes.
 * @subsystem facts
 *
 * Plan docs/plans/PLAN_DUPLICATE_VERDICT.md (Astra R3): a displayed verdict
 * belongs to the current input. Changing the input invalidates the previous
 * preview and re-checks after a pause; a late answer for older text never
 * replaces a newer one. It is only a preview — the stored verdict is the
 * server's own check of the saved wording after submission.
 */
import { useCallback, useEffect, useRef, useState } from "react";

export interface DuplicatePreview {
  outcome: "duplicate" | "distinct" | "unavailable";
  /** The text this verdict is for (set here, not by the server). */
  forText: string;
  isDuplicate: boolean;
  confidence: number;
  matchingFactId?: number;
  matchingFactText?: string;
  matchingCanonicalText?: string;
  matchingReviewId?: number;
  llmChecked?: boolean;
}

export const DUPLICATE_PREVIEW_MIN_CHARS = 20;
export const DUPLICATE_PREVIEW_DELAY_MS = 1200;

export function useDuplicatePreview(input: string): {
  checking: boolean;
  /** The "duplicate" verdict for the current input, or null. */
  shown: DuplicatePreview | null;
  clear: () => void;
} {
  const [result, setResult] = useState<DuplicatePreview | null>(null);
  const [checking, setChecking] = useState(false);
  const reqIdRef = useRef(0);

  const check = useCallback(async (text: string) => {
    const reqId = ++reqIdRef.current;
    setChecking(true);
    try {
      const r = await fetch("/api/ai/check-duplicate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ text }),
      });
      if (reqId !== reqIdRef.current) return;
      if (r.ok) {
        const data = (await r.json()) as Omit<DuplicatePreview, "forText">;
        if (reqId === reqIdRef.current) setResult({ ...data, forText: text });
      } else {
        setResult(null);
      }
    } catch {
      if (reqId === reqIdRef.current) setResult(null);
    } finally {
      if (reqId === reqIdRef.current) setChecking(false);
    }
  }, []);

  useEffect(() => {
    reqIdRef.current++;            // any answer in flight is for older text
    setChecking(false);
    if (input.length < DUPLICATE_PREVIEW_MIN_CHARS) { setResult(null); return; }
    const timer = setTimeout(() => { void check(input); }, DUPLICATE_PREVIEW_DELAY_MS);
    return () => clearTimeout(timer);
  }, [input, check]);

  const clear = useCallback(() => { reqIdRef.current++; setResult(null); setChecking(false); }, []);
  const shown = result && result.forText === input && result.outcome === "duplicate" ? result : null;
  return { checking, shown, clear };
}
