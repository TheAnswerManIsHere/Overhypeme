import { useCallback, useState } from "react";
import {
  Loader2,
  Check,
  AlertTriangle,
  Ban,
  ImageOff,
  RefreshCw,
  ChevronDown,
  ChevronRight,
  Play,
  MinusCircle,
} from "lucide-react";
import {
  type RenderScenarioCard,
  type RenderScenarioKey,
  type RenderScenarioStatus,
} from "@workspace/api-zod";

/**
 * One scenario card in the Step-2 visual-review grid (rule 8: per-item, in-place
 * live status). Renders the label + purpose, a reference-type chip, the live
 * status (queued/rendering spinner → done thumbnail / failed / blocked / skipped
 * icon — distinct visuals per state), a "stale" overlay badge on a done-but-old
 * image, the error/block message, a per-tile Rerun, a "Run anyway" for skipped
 * non-human scenarios, and a lazy-loaded "Scenario diagnostics" disclosure that
 * fetches the FROZEN prompt that produced THIS image.
 */

const REFERENCE_CHIP_LABEL: Record<string, string> = {
  male: "Male reference",
  female: "Female reference",
  nonhuman_animal: "Animal reference",
  nonhuman_object_vehicle: "Object / vehicle reference",
};

const labelCls = "block text-[10px] font-semibold text-muted-foreground mb-1 uppercase tracking-wide";

// ── Frozen attempt diagnostics (endpoint #3) ─────────────────────────────────

interface AttemptDiagnostics {
  status: string;
  subjectRenderMode: string | null;
  generationMode: string | null;
  actualImageEngineId: string | null;
  referenceIdentityType: string | null;
  visualPlan: Record<string, unknown> | null;
  compiledPrompt:
    | { prompt?: string; imagePrompt?: string; negativePrompt?: string }
    | string
    | null;
  subjectFactCompatibility: Record<string, unknown> | null;
  error: string | null;
  blocked: boolean;
  blockReason: string | null;
  stale: boolean;
}

// Compact visual-plan keys to surface (plain, not the full debug blob).
const COMPACT_VISUAL_PLAN_KEYS = [
  "sceneConcept",
  "coreScene",
  "subjectDetails",
  "environment",
  "lightingAndStyle",
  "composition",
];

function compiledPromptText(cp: AttemptDiagnostics["compiledPrompt"]): string {
  if (!cp) return "";
  if (typeof cp === "string") return cp;
  return cp.imagePrompt || cp.prompt || "";
}

function ScenarioDiagnostics({
  reviewId,
  scenarioKey,
  attemptId,
}: {
  reviewId: number;
  scenarioKey: RenderScenarioKey;
  attemptId: number;
}) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<AttemptDiagnostics | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadedFor, setLoadedFor] = useState<number | null>(null);

  const fetchDiagnostics = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/admin/reviews/${reviewId}/render-scenarios/${scenarioKey}/attempts/${attemptId}`,
        { credentials: "include" },
      );
      if (!res.ok) {
        setError(`Failed to load diagnostics (${res.status})`);
        return;
      }
      setData((await res.json()) as AttemptDiagnostics);
      setLoadedFor(attemptId);
    } catch {
      setError("Network error — could not load diagnostics.");
    } finally {
      setLoading(false);
    }
  }, [reviewId, scenarioKey, attemptId]);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    // Lazy-fetch on first open, or refetch if the attempt changed since last load.
    if (next && loadedFor !== attemptId) void fetchDiagnostics();
  };

  const promptText = data ? compiledPromptText(data.compiledPrompt) : "";
  const compactPlan = data?.visualPlan
    ? Object.fromEntries(
        COMPACT_VISUAL_PLAN_KEYS.map((k) => [k, data.visualPlan?.[k]]).filter(([, v]) => v != null && v !== ""),
      )
    : {};
  const hasPlan = Object.keys(compactPlan).length > 0;

  return (
    <div className="border-t border-border pt-2" data-testid="scenario-diagnostics">
      <button
        type="button"
        onClick={toggle}
        className="flex items-center gap-1 text-[10px] font-semibold text-muted-foreground uppercase tracking-wide hover:text-foreground"
        data-testid="scenario-diagnostics-toggle"
      >
        {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        Scenario diagnostics
      </button>
      {open && (
        <div className="mt-2 space-y-2">
          {loading && (
            <p className="text-[11px] text-muted-foreground flex items-center gap-1.5">
              <Loader2 className="w-3 h-3 animate-spin" /> Loading the frozen prompt that produced this image…
            </p>
          )}
          {error && <p className="text-[11px] text-destructive">{error}</p>}
          {data && !loading && (
            <>
              <p className="text-[10px] text-muted-foreground italic leading-snug">
                The FROZEN prompt that produced this image — distinct from the live "Prompt diagnostics"
                in Advanced Options, which recomputes under the current assumptions.
              </p>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-[10px]">
                {[
                  ["mode", data.subjectRenderMode],
                  ["generation", data.generationMode],
                  ["engine", data.actualImageEngineId],
                  ["reference", data.referenceIdentityType],
                ].map(([k, v]) => (
                  <div key={k} className="flex gap-1">
                    <dt className="text-muted-foreground">{k}:</dt>
                    <dd className="text-foreground font-medium break-all">{v == null || v === "" ? "—" : String(v)}</dd>
                  </div>
                ))}
              </dl>
              {promptText && (
                <div>
                  <span className={labelCls}>Compiled prompt (frozen)</span>
                  <pre
                    className="whitespace-pre-wrap font-mono text-[10px] text-foreground bg-background border border-border rounded-sm p-2 max-h-56 overflow-auto"
                    data-testid="scenario-diagnostics-prompt"
                  >
                    {promptText}
                  </pre>
                </div>
              )}
              {hasPlan && (
                <div>
                  <span className={labelCls}>Visual plan</span>
                  <dl className="space-y-0.5 text-[10px]">
                    {Object.entries(compactPlan).map(([k, v]) => (
                      <div key={k}>
                        <dt className="text-muted-foreground inline">{k}: </dt>
                        <dd className="text-foreground inline break-words">{String(v)}</dd>
                      </div>
                    ))}
                  </dl>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ── Status presentation ──────────────────────────────────────────────────────

function StatusBadge({ status, stale }: { status: RenderScenarioStatus; stale: boolean }) {
  const active = status === "queued" || status === "rendering";
  if (active) {
    return (
      <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-blue-600 dark:text-blue-400">
        <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
        {status === "queued" ? "Queued…" : "Rendering…"}
      </span>
    );
  }
  if (status === "done") {
    return (
      <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-emerald-600 dark:text-emerald-400">
        <Check className="w-3.5 h-3.5 shrink-0" /> Rendered
        {stale && <span className="text-amber-600 dark:text-amber-400">· stale</span>}
      </span>
    );
  }
  if (status === "failed") {
    return (
      <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-destructive">
        <AlertTriangle className="w-3.5 h-3.5 shrink-0" /> Failed
      </span>
    );
  }
  if (status === "blocked") {
    return (
      <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-amber-600 dark:text-amber-400">
        <Ban className="w-3.5 h-3.5 shrink-0" /> Blocked
      </span>
    );
  }
  if (status === "skipped") {
    return (
      <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-muted-foreground">
        <MinusCircle className="w-3.5 h-3.5 shrink-0" /> Skipped
      </span>
    );
  }
  // missing
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-muted-foreground">
      <ImageOff className="w-3.5 h-3.5 shrink-0" /> Not rendered
    </span>
  );
}

export function FactRenderScenarioTile({
  reviewId,
  card,
  onRun,
}: {
  reviewId: number;
  card: RenderScenarioCard;
  /** Enqueue this scenario; `force` is used for the "Run anyway" on a skipped tile. */
  onRun: (keys: RenderScenarioKey[], force?: boolean) => void;
}) {
  const active = card.status === "queued" || card.status === "rendering";
  const chip = card.referenceIdentityType ? REFERENCE_CHIP_LABEL[card.referenceIdentityType] : "Text-to-image";

  return (
    <div
      className="rounded-sm border border-border bg-background p-3 space-y-2 flex flex-col"
      data-testid="render-scenario-tile"
      data-scenario={card.key}
      data-status={card.status}
      data-stale={String(card.stale)}
    >
      {/* Header: label + reference chip */}
      <div className="space-y-1">
        <div className="flex items-start justify-between gap-2">
          <p className="text-sm font-semibold text-foreground leading-snug">{card.label}</p>
          {!card.required && (
            <span className="shrink-0 text-[9px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded-sm bg-muted text-muted-foreground">
              optional
            </span>
          )}
        </div>
        <span className="inline-block text-[9px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded-sm bg-primary/10 text-primary">
          {chip}
        </span>
        <p className="text-[11px] text-muted-foreground leading-snug">{card.purpose}</p>
      </div>

      {/* Live status */}
      <StatusBadge status={card.status} stale={card.stale} />

      {/* Image (done) with a stale overlay when applicable */}
      {card.status === "done" && card.imageUrl && (
        <div className="relative">
          <img
            src={card.imageUrl}
            alt={`${card.label} test render`}
            loading="lazy"
            className={`w-full rounded-sm border border-border ${card.stale ? "opacity-75" : ""}`}
            data-testid="render-scenario-image"
          />
          {card.stale && (
            <span
              className="absolute top-1 left-1 inline-flex items-center gap-1 rounded-sm bg-amber-500/90 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-white"
              data-testid="render-scenario-stale-badge"
            >
              <AlertTriangle className="w-3 h-3" /> Stale
            </span>
          )}
        </div>
      )}
      {card.status === "done" && card.stale && (
        <p className="text-[10px] text-amber-700 dark:text-amber-300 leading-snug">
          Generated before the latest tuning — rerun recommended.
        </p>
      )}

      {/* Error / block message */}
      {(card.status === "failed" || card.status === "blocked") && card.message && (
        <p
          className={`text-[10px] leading-snug ${card.status === "blocked" ? "text-amber-700 dark:text-amber-300" : "text-destructive"}`}
          data-testid="render-scenario-message"
        >
          {card.message}
        </p>
      )}

      {/* Skipped (non-human) — applicability reason + "Run anyway" */}
      {card.status === "skipped" && (
        <div className="space-y-1.5">
          {card.applicability?.reason && (
            <p className="text-[10px] text-muted-foreground leading-snug" data-testid="render-scenario-skip-reason">
              {card.applicability.reason}
            </p>
          )}
          <button
            type="button"
            onClick={() => onRun([card.key], true)}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-semibold rounded-sm border border-border hover:bg-muted text-foreground"
            data-testid="render-scenario-run-anyway"
          >
            <Play className="w-3 h-3" /> Run anyway
          </button>
        </div>
      )}

      {/* Per-tile rerun (any non-active tile that isn't a skip-only state) */}
      {!active && card.status !== "skipped" && (
        <button
          type="button"
          onClick={() => onRun([card.key], false)}
          className="inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-semibold rounded-sm border border-border hover:bg-muted text-foreground self-start"
          data-testid="render-scenario-rerun"
        >
          <RefreshCw className="w-3 h-3" /> {card.status === "missing" ? "Render" : "Rerun"}
        </button>
      )}

      {/* Lazy diagnostics (frozen prompt) — only when there is a real attempt. */}
      {card.latestAttemptId != null && (
        <ScenarioDiagnostics reviewId={reviewId} scenarioKey={card.key} attemptId={card.latestAttemptId} />
      )}
    </div>
  );
}
