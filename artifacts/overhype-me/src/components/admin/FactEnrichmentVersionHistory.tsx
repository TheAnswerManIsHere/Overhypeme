import { useState } from "react";
import { ChevronDown, ChevronRight, History, Loader2 } from "lucide-react";

/** GET /admin/facts/:id/enrichment-versions response (metadata only — no blobs). */
export interface EnrichmentVersionInfo {
  current: {
    hasEnrichment: boolean;
    enrichmentStatus: string | null;
    hasOverrides: boolean;
  };
  inFlight: { candidateVersionId: number; reviewId: number | null } | null;
  versions: Array<{
    id: number;
    versionNo: number;
    status: "candidate" | "promoted" | "superseded" | "rejected";
    source: string;
    sourceReviewId: number | null;
    note: string | null;
    createdBy: string | null;
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
    case "candidate":
      return v.enrichmentReady
        ? `In review — refresh from ${fmtDate(v.createdAt)}`
        : `In review — refresh from ${fmtDate(v.createdAt)} (classifying…)`;
    case "promoted":
      return `Promoted refresh from ${fmtDate(v.promotedAt ?? v.createdAt)}`;
    case "rejected":
      return `Rejected refresh from ${fmtDate(v.rejectedAt ?? v.createdAt)}`;
    case "superseded":
      return `Previous active (archived ${fmtDate(v.supersededAt ?? v.createdAt)})`;
  }
}

const STATUS_TONE: Record<string, string> = {
  candidate: "text-blue-600 dark:text-blue-400",
  promoted: "text-green-600 dark:text-green-400",
  rejected: "text-muted-foreground",
  superseded: "text-muted-foreground",
};

/**
 * Read-only enrichment version history (stale-fact refresh). Shows the current
 * active state (from facts.* — the version table never holds an active row) and
 * the archived refresh cycles, newest first. Visibility only — no rollback.
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
                <p className="text-xs text-muted-foreground">No refresh history — this fact has never been sent back to review.</p>
              )}
              {info.versions.map((v) => (
                <div key={v.id} className="flex items-center gap-2 text-sm" data-testid={`version-row-${v.status}`}>
                  <span className={STATUS_TONE[v.status] ?? "text-muted-foreground"}>{versionLabel(v)}</span>
                  {v.status === "candidate" && v.sourceReviewId != null && (
                    <a href="/admin/moderation" className="text-xs text-primary underline hover:opacity-80">
                      Review #{v.sourceReviewId}
                    </a>
                  )}
                  {v.createdBy && <span className="text-xs text-muted-foreground">by {v.createdBy}</span>}
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}
