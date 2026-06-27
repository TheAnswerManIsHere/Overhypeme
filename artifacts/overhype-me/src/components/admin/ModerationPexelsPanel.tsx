import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight, ImageIcon, Loader2, AlertTriangle, ExternalLink } from "lucide-react";

/**
 * Shows the Pexels stock images pulled in for the fact under review, so a
 * moderator can see exactly what stock backgrounds were seeded before approving.
 *
 * Reads the admin endpoint (`GET /api/admin/reviews/:id/pexels-images`) which
 * serves the staging (inactive) fact's images across all three genders. While
 * `pexelsStatus` is "pending" it polls at ~1s with NO timeout (rule 8) so the
 * panel fills in live as the seed job runs; it stops on "ok"/"failed".
 */

type Gender = "male" | "female" | "neutral";
const GENDERS: Gender[] = ["male", "female", "neutral"];

interface PexelsThumb {
  id: number;
  url: string;
  photographer?: string;
  photographer_url?: string;
}

interface PexelsResponse {
  pexelsStatus: "pending" | "ok" | "failed" | null;
  factType: "action" | "abstract" | null;
  keywords: { male: string; female: string; neutral: string } | null;
  images: Record<Gender, PexelsThumb[]>;
}

const labelCls = "block text-[10px] font-semibold text-muted-foreground mb-1 uppercase tracking-wide";

export function ModerationPexelsPanel({ reviewId }: { reviewId: number }) {
  const [expanded, setExpanded] = useState(true);
  const [data, setData] = useState<PexelsResponse | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [activeGender, setActiveGender] = useState<Gender>("neutral");
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

  const totals: Record<Gender, number> = {
    male: data?.images.male.length ?? 0,
    female: data?.images.female.length ?? 0,
    neutral: data?.images.neutral.length ?? 0,
  };
  const totalCount = totals.male + totals.female + totals.neutral;
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
            <>
              <div className="flex items-center gap-1.5" data-testid="pexels-gender-tabs">
                {GENDERS.map((g) => (
                  <button
                    key={g}
                    type="button"
                    onClick={() => setActiveGender(g)}
                    className={`px-2 py-1 text-[10px] font-semibold uppercase tracking-wide rounded-sm ${
                      activeGender === g ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"
                    }`}
                  >
                    {g} ({totals[g]})
                  </button>
                ))}
              </div>

              {data?.keywords && (
                <p className="text-[10px] text-muted-foreground italic">
                  Keywords ({activeGender}): {data.keywords[activeGender]}
                </p>
              )}

              <div className="grid grid-cols-3 sm:grid-cols-4 gap-1.5 max-h-72 overflow-auto" data-testid={`pexels-grid-${activeGender}`}>
                {(data?.images[activeGender] ?? []).map((p) => (
                  <a
                    key={p.id}
                    href={p.photographer_url ?? p.url}
                    target="_blank"
                    rel="noreferrer"
                    className="group relative block aspect-square overflow-hidden rounded-sm border border-border"
                    title={p.photographer ? `Photo by ${p.photographer}` : undefined}
                  >
                    <img src={p.url} alt="" loading="lazy" className="h-full w-full object-cover" />
                    {p.photographer && (
                      <span className="absolute inset-x-0 bottom-0 truncate bg-black/60 px-1 py-0.5 text-[8px] text-white opacity-0 group-hover:opacity-100">
                        {p.photographer}
                      </span>
                    )}
                  </a>
                ))}
              </div>
            </>
          )}

          {loaded && (
            <a
              href="https://www.pexels.com"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground"
            >
              Photos provided by Pexels <ExternalLink className="w-2.5 h-2.5" />
            </a>
          )}
        </div>
      )}
    </div>
  );
}
