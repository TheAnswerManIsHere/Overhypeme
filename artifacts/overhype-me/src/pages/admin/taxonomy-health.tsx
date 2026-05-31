import { useState, useEffect, useCallback, useMemo } from "react";
import { Link } from "wouter";
import { AdminLayout } from "@/components/admin/AdminLayout";
import { Button } from "@/components/ui/Button";
import {
  Loader2, AlertTriangle, Activity, RefreshCw, ExternalLink, Wrench, Search, ListChecks,
} from "lucide-react";
import type {
  FactTaxonomyHealth,
  TaxonomyHealthSummaryCounts,
  TaxonomyHealthStatus,
} from "@workspace/api-zod";

type FilterStatus =
  | "any"
  | "missing_enrichment"
  | "invalid_enrichment"
  | "needs_admin_review"
  | "missing_visual_preview"
  | "stale_visual_preview"
  | "stale_enrichment_version"
  | "projection_mismatch"
  | "incomplete_cultural_references"
  | "semantic_entities_need_review"
  | "low_confidence"
  | "questionable_fit";

interface HealthRow {
  factId: number;
  factText: string;
  primaryArchetype: string | null;
  subtype: string | null;
  overhypeFit: string | null;
  adultSuitability: string | null;
  taxonomyConfidence: number | null;
  health: FactTaxonomyHealth;
  updatedAt: string | null;
}

interface ListResponse {
  rows: HealthRow[];
  total: number;
  limit: number;
  offset: number;
}

const CARD_DEFS: Array<{ key: keyof TaxonomyHealthSummaryCounts; label: string; filter: FilterStatus; tone: "green" | "red" | "amber" | "blue" | "neutral" }> = [
  { key: "healthy",                      label: "Healthy",                         filter: "any",                            tone: "green"   },
  { key: "missingEnrichment",            label: "Missing enrichment",              filter: "missing_enrichment",             tone: "red"     },
  { key: "invalidEnrichment",            label: "Invalid enrichment",              filter: "invalid_enrichment",             tone: "red"     },
  { key: "needsAdminReview",             label: "Needs admin review",              filter: "needs_admin_review",             tone: "amber"   },
  { key: "missingVisualPreview",         label: "Missing preview",                 filter: "missing_visual_preview",         tone: "amber"   },
  { key: "staleVisualPreview",           label: "Stale preview",                   filter: "stale_visual_preview",           tone: "amber"   },
  { key: "staleEnrichmentVersion",       label: "Stale enrichment",                filter: "stale_enrichment_version",       tone: "amber"   },
  { key: "projectionMismatch",           label: "Projection mismatch",             filter: "projection_mismatch",            tone: "blue"    },
  { key: "incompleteCulturalReferences", label: "Cultural refs need research",     filter: "incomplete_cultural_references", tone: "amber"   },
  { key: "semanticEntitiesNeedReview",   label: "Semantic entities need review",   filter: "semantic_entities_need_review",  tone: "amber"   },
  { key: "lowConfidence",                label: "Low confidence",                  filter: "low_confidence",                 tone: "amber"   },
];

const TONE_CLASS: Record<"green"|"red"|"amber"|"blue"|"neutral", string> = {
  green:   "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  red:     "border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-300",
  amber:   "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  blue:    "border-blue-500/40 bg-blue-500/10 text-blue-700 dark:text-blue-300",
  neutral: "border-border bg-muted/20 text-muted-foreground",
};

function fmtConfidence(c: number | null): string {
  if (c == null) return "—";
  return c.toFixed(2);
}

function HealthBadge({ s }: { s: TaxonomyHealthStatus }) {
  const label = s.replace(/_/g, " ");
  const color =
    s === "missing_enrichment" || s === "invalid_enrichment"
      ? "bg-red-500/20 text-red-700 dark:text-red-300"
      : s === "projection_mismatch"
        ? "bg-blue-500/20 text-blue-700 dark:text-blue-300"
        : s === "complete"
          ? "bg-emerald-500/20 text-emerald-700 dark:text-emerald-300"
          : "bg-amber-500/20 text-amber-700 dark:text-amber-300";
  return <span className={`inline-block px-1.5 py-0.5 rounded-sm text-[10px] uppercase tracking-wide ${color}`}>{label}</span>;
}

function OverallBadge({ s }: { s: FactTaxonomyHealth["overallStatus"] }) {
  const color =
    s === "healthy"
      ? "bg-emerald-500/20 text-emerald-700 dark:text-emerald-300"
      : s === "broken" || s === "missing"
        ? "bg-red-500/20 text-red-700 dark:text-red-300"
        : "bg-amber-500/20 text-amber-700 dark:text-amber-300";
  return <span className={`inline-block px-1.5 py-0.5 rounded-sm text-xs uppercase tracking-wide ${color}`}>{s}</span>;
}

export default function TaxonomyHealth() {
  const [summary, setSummary] = useState<TaxonomyHealthSummaryCounts | null>(null);
  const [rows, setRows] = useState<HealthRow[]>([]);
  const [total, setTotal] = useState(0);
  const [filter, setFilter] = useState<FilterStatus>("missing_enrichment");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);

  const loadSummary = useCallback(async () => {
    try {
      const r = await fetch("/api/admin/taxonomy-health/summary", { credentials: "include" });
      if (!r.ok) throw new Error("summary_failed");
      setSummary(await r.json() as TaxonomyHealthSummaryCounts);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  const loadList = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (filter && filter !== "any") params.set("status", filter);
      if (search.trim()) params.set("search", search.trim());
      params.set("limit", "100");
      const r = await fetch(`/api/admin/taxonomy-health/facts?${params}`, { credentials: "include" });
      if (!r.ok) throw new Error("list_failed");
      const body = (await r.json()) as ListResponse;
      setRows(body.rows);
      setTotal(body.total);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [filter, search]);

  useEffect(() => { void loadSummary(); }, [loadSummary]);
  useEffect(() => { void loadList(); }, [loadList]);

  const runAction = useCallback(
    async (label: string, url: string, body: Record<string, unknown>, confirmMsg?: string) => {
      if (confirmMsg && !window.confirm(confirmMsg)) return;
      setActionBusy(label);
      setActionMessage(null);
      try {
        const r = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify(body),
        });
        if (!r.ok) throw new Error(`${label}_failed`);
        const result = await r.json() as Record<string, unknown>;
        setActionMessage(`${label}: ${JSON.stringify(result)}`);
        await loadSummary();
        await loadList();
      } catch (err) {
        setActionMessage(`${label} failed: ${(err as Error).message}`);
      } finally {
        setActionBusy(null);
      }
    },
    [loadList, loadSummary],
  );

  const isBulkMode = filter !== "any";
  const bulkActions = useMemo(() => {
    const list: Array<{ key: string; label: string; url: string; body: Record<string, unknown>; confirmMsg?: string }> = [];
    if (filter === "missing_enrichment") {
      list.push({
        key: "backfill_missing",
        label: "Backfill missing enrichment",
        url: "/api/admin/taxonomy-health/actions/backfill-enrichment",
        body: { mode: "missing_only" },
        confirmMsg: "Queue enrichment for all facts missing enrichment?",
      });
    }
    if (filter === "stale_enrichment_version") {
      list.push({
        key: "reenrich_stale",
        label: "Re-enrich stale facts",
        url: "/api/admin/taxonomy-health/actions/backfill-enrichment",
        body: { mode: "stale_only" },
        confirmMsg: "Re-enrich stale facts? Admin-edited rows (enrichedBy=admin or with adminReviewNotes) are skipped automatically.",
      });
    }
    if (filter === "missing_visual_preview") {
      list.push({
        key: "regen_missing_previews",
        label: "Regenerate missing previews",
        url: "/api/admin/taxonomy-health/actions/regenerate-previews",
        body: { mode: "missing_only" },
        confirmMsg: "Queue preview generation for all facts missing a preview?",
      });
    }
    if (filter === "stale_visual_preview") {
      list.push({
        key: "regen_stale_previews",
        label: "Regenerate stale previews",
        url: "/api/admin/taxonomy-health/actions/regenerate-previews",
        body: { mode: "stale_only" },
        confirmMsg: "Queue preview regeneration for facts with a stale preview?",
      });
    }
    if (filter === "projection_mismatch") {
      list.push({
        key: "repair_projections",
        label: "Repair projection mismatches",
        url: "/api/admin/taxonomy-health/actions/repair-projections",
        body: { mode: "mismatches_only" },
        confirmMsg: "Repair projection columns for all facts where they don't match the enrichment? Safe — derives from the existing JSONB blob.",
      });
    }
    return list;
  }, [filter]);

  return (
    <AdminLayout title="Taxonomy Health">
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <Activity className="w-5 h-5 text-primary" />
          <h2 className="text-lg font-bold">Taxonomy Health</h2>
          <Button variant="secondary" size="sm" onClick={() => { void loadSummary(); void loadList(); }} disabled={loading}>
            <RefreshCw className="w-3 h-3 mr-1" /> Refresh
          </Button>
        </div>

        {/* Summary cards */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
          <SummaryCard label="Total facts" value={summary?.totalFacts ?? null} tone="neutral" onClick={() => setFilter("any")} active={filter === "any"} />
          {CARD_DEFS.map((d) => (
            <SummaryCard
              key={d.key}
              label={d.label}
              value={summary ? summary[d.key] : null}
              tone={d.tone}
              onClick={() => setFilter(d.filter)}
              active={filter === d.filter}
            />
          ))}
        </div>

        {/* Filters + search */}
        <div className="flex items-end gap-2 flex-wrap">
          <div className="flex-1 min-w-[240px]">
            <label className="block text-xs text-muted-foreground uppercase tracking-wide mb-1">Search fact text</label>
            <div className="relative">
              <Search className="w-3 h-3 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <input
                className="w-full pl-7 pr-2 py-1.5 text-sm bg-background border border-border rounded-sm"
                placeholder="search…"
                value={search}
                onChange={(ev) => setSearch(ev.target.value)}
              />
            </div>
          </div>
          {bulkActions.map((a) => (
            <Button
              key={a.key}
              variant="primary"
              size="sm"
              disabled={actionBusy !== null}
              onClick={() => void runAction(a.label, a.url, a.body, a.confirmMsg)}
            >
              {actionBusy === a.label ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <ListChecks className="w-3 h-3 mr-1" />}
              {a.label}
            </Button>
          ))}
        </div>

        {actionMessage && (
          <div className="rounded-sm border border-border bg-muted/30 p-2 text-xs text-foreground whitespace-pre-wrap">
            {actionMessage}
          </div>
        )}

        {error && (
          <div className="rounded-sm border border-destructive/40 bg-destructive/10 p-3 flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 text-destructive shrink-0 mt-0.5" />
            <p className="text-sm text-destructive">{error}</p>
          </div>
        )}

        {/* Table */}
        <div className="rounded-sm border border-border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/30">
              <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-2 py-1">ID</th>
                <th className="px-2 py-1">Fact</th>
                <th className="px-2 py-1">Archetype / Subtype</th>
                <th className="px-2 py-1">Conf</th>
                <th className="px-2 py-1">Health</th>
                <th className="px-2 py-1">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr>
                  <td className="px-2 py-3 text-center text-muted-foreground" colSpan={6}>
                    <Loader2 className="w-4 h-4 animate-spin inline-block mr-2" /> Loading…
                  </td>
                </tr>
              )}
              {!loading && rows.length === 0 && (
                <tr>
                  <td className="px-2 py-3 text-center text-muted-foreground" colSpan={6}>
                    No facts match this filter.
                  </td>
                </tr>
              )}
              {!loading &&
                rows.map((row) => (
                  <tr key={row.factId} className="border-t border-border">
                    <td className="px-2 py-1.5 align-top">
                      <Link href={`/admin/facts?focus=${row.factId}`} className="text-primary hover:underline inline-flex items-center gap-1">
                        {row.factId} <ExternalLink className="w-3 h-3" />
                      </Link>
                    </td>
                    <td className="px-2 py-1.5 align-top max-w-[420px]">
                      <p className="text-foreground line-clamp-2">{row.factText}</p>
                    </td>
                    <td className="px-2 py-1.5 align-top text-xs text-foreground">
                      {row.primaryArchetype ?? "—"}
                      {row.subtype && <><span className="text-muted-foreground"> · </span>{row.subtype}</>}
                    </td>
                    <td className="px-2 py-1.5 align-top text-xs text-foreground">{fmtConfidence(row.taxonomyConfidence)}</td>
                    <td className="px-2 py-1.5 align-top space-y-1">
                      <OverallBadge s={row.health.overallStatus} />
                      <div className="flex flex-wrap gap-1">
                        {row.health.statuses
                          .filter((s) => s !== "complete" && s !== "needs_admin_review")
                          .slice(0, 4)
                          .map((s) => <HealthBadge key={s} s={s} />)}
                      </div>
                      {row.health.issues.length > 0 && (
                        <p className="text-[10px] text-muted-foreground">{row.health.issues[0]!.message}</p>
                      )}
                    </td>
                    <td className="px-2 py-1.5 align-top whitespace-nowrap space-x-1">
                      {row.health.reviewFlags.projectionMismatch && (
                        <Button
                          variant="secondary"
                          size="sm"
                          disabled={actionBusy !== null}
                          onClick={() =>
                            void runAction(
                              "Repair projections",
                              "/api/admin/taxonomy-health/actions/repair-projections",
                              { mode: "selected_fact_ids", factIds: [row.factId] },
                            )
                          }
                        >
                          <Wrench className="w-3 h-3 mr-1" /> Repair
                        </Button>
                      )}
                      {(row.health.statuses.includes("missing_enrichment") || row.health.reviewFlags.staleEnrichmentVersion) && (
                        <Button
                          variant="secondary"
                          size="sm"
                          disabled={actionBusy !== null}
                          onClick={() =>
                            void runAction(
                              "Re-enrich",
                              "/api/admin/taxonomy-health/actions/backfill-enrichment",
                              { mode: "selected_fact_ids", factIds: [row.factId] },
                              row.health.statuses.includes("missing_enrichment")
                                ? undefined
                                : "Re-run classification on this fact? Admin-edited enrichment may be replaced unless you have force-overwrite off.",
                            )
                          }
                        >
                          <RefreshCw className="w-3 h-3 mr-1" /> Re-enrich
                        </Button>
                      )}
                      {(row.health.reviewFlags.missingPreview || row.health.reviewFlags.stalePreview) && (
                        <Button
                          variant="secondary"
                          size="sm"
                          disabled={actionBusy !== null}
                          onClick={() =>
                            void runAction(
                              "Regenerate preview",
                              "/api/admin/taxonomy-health/actions/regenerate-previews",
                              { mode: "selected_fact_ids", factIds: [row.factId] },
                            )
                          }
                        >
                          Preview
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>

        <p className="text-xs text-muted-foreground">
          {isBulkMode && `Filter: ${filter.replace(/_/g, " ")}. `}
          {total} matching {total === 1 ? "fact" : "facts"}.
        </p>
      </div>
    </AdminLayout>
  );
}

function SummaryCard({
  label,
  value,
  tone,
  onClick,
  active,
}: {
  label: string;
  value: number | null;
  tone: "green" | "red" | "amber" | "blue" | "neutral";
  onClick?: () => void;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`text-left rounded-sm border p-2 transition ${TONE_CLASS[tone]} ${active ? "ring-2 ring-primary/60" : ""}`}
    >
      <p className="text-[10px] uppercase tracking-wide opacity-80">{label}</p>
      <p className="text-lg font-bold">{value ?? "—"}</p>
    </button>
  );
}
