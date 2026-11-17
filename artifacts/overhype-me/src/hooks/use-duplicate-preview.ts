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
import { makeAbortController } from "@/lib/makeAbortController";

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
  // Each new request aborts the one before it; a superseded answer is dropped.
  const requests = useRef(makeAbortController()).current;

  const check = useCallback(async (text: string) => {
    const { signal, isLatest } = requests.next();
    setChecking(true);
    try {
      const r = await fetch("/api/ai/check-duplicate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ text }),
        signal,
      });
      if (!isLatest()) return;
      const data = r.ok ? (await r.json()) as Omit<DuplicatePreview, "forText"> : null;
      if (isLatest()) setResult(data ? { ...data, forText: text } : null);
    } catch {
      if (isLatest()) setResult(null);
    } finally {
      if (isLatest()) setChecking(false);
    }
  }, [requests]);

  useEffect(() => {
    requests.next();               // abort any request for older text
    setChecking(false);
    if (input.length < DUPLICATE_PREVIEW_MIN_CHARS) { setResult(null); return; }
    const timer = setTimeout(() => { void check(input); }, DUPLICATE_PREVIEW_DELAY_MS);
    return () => clearTimeout(timer);
  }, [input, check, requests]);

  const clear = useCallback(() => { requests.next(); setResult(null); setChecking(false); }, [requests]);
  const shown = result && result.forText === input && result.outcome === "duplicate" ? result : null;
  return { checking, shown, clear };
}
