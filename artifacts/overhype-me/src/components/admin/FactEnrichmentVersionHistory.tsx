import { useState } from "react";
import { ChevronDown, ChevronRight, History, Loader2 } from "lucide-react";

/** GET /admin/facts/:id/enrichment-versions response (metadata only — no blobs). */
export interface EnrichmentVersionInfo {
  current: {
    hasEnrichment: boolean;
    enrichmentStatus: string | null;
    hasOverrides: boolean;
  };
  versions: Array<{
    id: number;
    versionNo: number;
    /** Only history remains: open and declined refresh candidates were deleted with refresh reviews (migration 0151). */
    status: "promoted" | "superseded";
    source: string;
    sourceReviewId: number | null;
    note: string | null;
    createdByDisplayName: string | null;
    createdByEmail: string | null;
    createdAt: string;
    promotedAt: string | null;
    supersededAt: string | null;
    rejectedAt: string | null;
    enrichmentReady: boolean;
  }>;
}

function fmtDate(iso: string | null): string {
  return iso ? new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "";
}

/** Human label per version row — never the raw version_no. */
function versionLabel(v: EnrichmentVersionInfo["versions"][number]): string {
  switch (v.status) {
    case "promoted":
      return `Promoted refresh from ${fmtDate(v.promotedAt ?? v.createdAt)}`;
    case "superseded":
      return `Previous active (archived ${fmtDate(v.supersededAt ?? v.createdAt)})`;
  }
}

/** Human-readable actor label — never a raw user id. */
function actorLabel(v: EnrichmentVersionInfo["versions"][number]): string | null {
  return v.createdByDisplayName ?? v.createdByEmail ?? null;
}

const STATUS_TONE: Record<string, string> = {
  promoted: "text-green-600 dark:text-green-400",
  superseded: "text-muted-foreground",
};

/**
 * Read-only enrichment version history. Shows the current active state (from
 * facts.* — the version table never holds an active row) and the archived
 * classifications, newest first. Visibility only — no rollback.
 */
export function FactEnrichmentVersionHistory({
  info,
  loading = false,
}: {
  info: EnrichmentVersionInfo | null;
  loading?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="rounded-sm border border-border bg-muted/20" data-testid="enrichment-version-history">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center justify-between gap-2 p-3 text-left"
      >
        <span className="text-xs font-bold text-muted-foreground uppercase tracking-wide flex items-center gap-1.5">
          <History className="w-3.5 h-3.5 text-primary" /> Enrichment Version History
          {info && info.versions.length > 0 && (
            <span className="font-normal normal-case">({info.versions.length})</span>
          )}
        </span>
        {expanded ? <ChevronDown className="w-4 h-4 text-muted-foreground" /> : <ChevronRight className="w-4 h-4 text-muted-foreground" />}
      </button>

      {expanded && (
        <div className="px-3 pb-3 space-y-1.5">
          {loading && (
            <p className="text-xs text-muted-foreground flex items-center gap-1.5">
              <Loader2 className="w-3 h-3 animate-spin" /> Loading history…
            </p>
          )}
          {!loading && info && (
            <>
              <div className="flex items-center gap-2 text-sm" data-testid="version-current">
                <span className="font-semibold text-foreground">Current active</span>
                {info.current.enrichmentStatus === "pending" && (
                  <span className="text-xs text-muted-foreground flex items-center gap-1">
                    <Loader2 className="w-3 h-3 animate-spin" /> classifying…
                  </span>
                )}
                {info.current.hasOverrides && (
                  <span className="text-[10px] uppercase tracking-wide rounded-sm border border-border px-1 py-0.5 text-muted-foreground">
                    manually overridden
                  </span>
                )}
                {!info.current.hasEnrichment && (
                  <span className="text-xs text-muted-foreground">no enrichment yet</span>
                )}
              </div>
              {info.versions.length === 0 && (
                <p className="text-xs text-muted-foreground">No earlier classifications.</p>
              )}
              {info.versions.map((v) => (
                <div key={v.id} className="flex items-center gap-2 text-sm" data-testid={`version-row-${v.status}`}>
                  <span className={STATUS_TONE[v.status] ?? "text-muted-foreground"}>{versionLabel(v)}</span>
                  {actorLabel(v) && <span className="text-xs text-muted-foreground">by {actorLabel(v)}</span>}
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}
