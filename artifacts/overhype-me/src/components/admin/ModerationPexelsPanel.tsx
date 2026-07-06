import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight, ImageIcon, Loader2, AlertTriangle } from "lucide-react";
import { PexelsImageGallery, emptyPexelsImages, pexelsImageTotals, type PexelsGender, type PexelsThumb } from "./PexelsImageGallery";

/**
 * Shows the Pexels stock images pulled in for the fact under review, so a
 * moderator can see exactly what stock backgrounds were seeded before approving.
 *
 * Reads the admin endpoint (`GET /api/admin/reviews/:id/pexels-images`) which
 * serves the staging (inactive) fact's images across all three genders. While
 * `pexelsStatus` is "pending" it polls at ~1s with NO timeout (rule 8) so the
 * panel fills in live as the seed job runs; it stops on "ok"/"failed".
 */

interface PexelsResponse {
  pexelsStatus: "pending" | "ok" | "failed" | null;
  factType: "action" | "abstract" | null;
  keywords: { male: string; female: string; neutral: string } | null;
  images: Record<PexelsGender, PexelsThumb[]>;
}

const labelCls = "block text-[10px] font-semibold text-muted-foreground mb-1 uppercase tracking-wide";

export function ModerationPexelsPanel({ reviewId }: { reviewId: number }) {
  const [expanded, setExpanded] = useState(true);
  const [data, setData] = useState<PexelsResponse | null>(null);
  const [loaded, setLoaded] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/admin/reviews/${reviewId}/pexels-images`, { credentials: "include" });
      if (!res.ok) return;
      const d = (await res.json()) as PexelsResponse;
      setData(d);
      setLoaded(true);
    } catch {
      /* transient — keep whatever we have */
    }
  }, [reviewId]);

  useEffect(() => { void load(); }, [load]);

  // Poll while seeding (no timeout); stop once terminal.
  useEffect(() => {
    const clear = () => { if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; } };
    if (data?.pexelsStatus === "pending") {
      if (!timerRef.current) timerRef.current = setInterval(() => { void load(); }, 1000);
    } else {
      clear();
    }
    return clear;
  }, [data?.pexelsStatus, load]);

  const images = data?.images ?? emptyPexelsImages();
  const totals = pexelsImageTotals(images);
  const totalCount = totals.total;
  const status = data?.pexelsStatus ?? null;

  return (
    <div className="rounded-sm border border-border bg-muted/20" data-testid="moderation-pexels-panel">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center justify-between gap-2 p-3 text-left"
      >
        <span className="text-xs font-bold text-muted-foreground uppercase tracking-wide flex items-center gap-1.5">
          <ImageIcon className="w-3.5 h-3.5" /> Pexels images pulled
          <span className="font-normal normal-case text-[10px] text-muted-foreground" data-testid="pexels-counts">
            {status === "pending" && <span className="inline-flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" /> seeding…</span>}
            {status !== "pending" && loaded && `${totalCount} total · male ${totals.male} · female ${totals.female} · neutral ${totals.neutral}`}
          </span>
        </span>
        {expanded ? <ChevronDown className="w-4 h-4 text-muted-foreground" /> : <ChevronRight className="w-4 h-4 text-muted-foreground" />}
      </button>

      {expanded && (
        <div className="px-3 pb-3 space-y-2">
          {!loaded && (
            <p className="text-[11px] text-muted-foreground flex items-center gap-1.5">
              <Loader2 className="w-3 h-3 animate-spin" /> Loading…
            </p>
          )}

          {loaded && status === "failed" && (
            <div className="flex items-start gap-2 rounded-sm border border-amber-500/40 bg-amber-500/10 px-3 py-2" data-testid="pexels-failed">
              <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
              <p className="text-xs text-amber-700 dark:text-amber-300">
                Stock-image seeding failed after retries. This does not block approval — AI backgrounds can still be rendered above.
              </p>
            </div>
          )}

          {loaded && status === "pending" && (
            <p className="text-[11px] text-muted-foreground flex items-center gap-1.5" data-testid="pexels-pending">
              <Loader2 className="w-3 h-3 animate-spin" /> Seeding stock images — this view updates live; no refresh needed.
            </p>
          )}

          {loaded && (status === "ok" || status === "pending") && totalCount === 0 && status !== "pending" && (
            <p className="text-[11px] text-muted-foreground italic" data-testid="pexels-empty">
              Ready, but no Pexels images are available for these keywords.
            </p>
          )}

          {loaded && totalCount > 0 && (
            <PexelsImageGallery data={{ keywords: data?.keywords ?? null, images }} />
          )}
        </div>
      )}
    </div>
  );
}
