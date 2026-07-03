import { useState, useEffect, useCallback, useMemo } from "react";
import { Link } from "wouter";
import { AdminLayout } from "@/components/admin/AdminLayout";
import { Button } from "@/components/ui/Button";
import {
  Loader2, AlertTriangle, Activity, RefreshCw, ExternalLink, Wrench, Search, ListChecks,
  CheckCircle2, XCircle, Clock, Info, X, Rocket, Send,
} from "lucide-react";
import {
  currentTaxonomyVersions,
  enrichmentVersionStatusFromStored,
  type FactTaxonomyHealth,
  type TaxonomyHealthSummaryCounts,
  type TaxonomyHealthStatus,
  type TaxonomyHealthAction,
  type ActionOutcome,
} from "@workspace/api-zod";
import { CARD_META, type FilterStatus, type CardMeta, type CardTone } from "./taxonomyHealthCards";
import {
  useTaxonomyHealthActions,
  type UiOpState,
} from "@/components/admin/useTaxonomyHealthActions";
import { MarkMajorUpdateModal } from "@/components/admin/MarkMajorUpdateModal";
import { sendFactBackToReview } from "@/components/admin/sendBackToReview";

/**
 * The summary response carries the shared count shape PLUS `engineRevision`
 * (the current manual marker, for the header readout + "Mark major update").
 */
type TaxonomyHealthSummaryResponse = TaxonomyHealthSummaryCounts & { engineRevision: number };

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
  /** True when a refresh candidate is already in flight — pre-disables send-back. */
  refreshInReview: boolean;
}

/** Local per-row state for the synchronous "Send back to review" action. */
type SendBackRowState =
  | { status: "sending" }
  | { status: "sent"; reviewId?: number }
  | { status: "error"; message: string };

interface ListResponse {
  rows: HealthRow[];
  total: number;
  limit: number;
  offset: number;
}

const CURRENT_VERSIONS = currentTaxonomyVersions();

const TONE_CLASS: Record<CardTone, string> = {
  green:   "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  red:     "border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-300",
  amber:   "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  blue:    "border-blue-500/40 bg-blue-500/10 text-blue-700 dark:text-blue-300",
  neutral: "border-border bg-muted/20 text-muted-foreground",
};

const ACTION_LABEL: Record<TaxonomyHealthAction, string> = {
  re_enrich: "Re-enrich",
  repair_projections: "Repair projections",
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

/**
 * Compact stored→current version diff for a fact's enrichment, shown in the
 * Health cell when the row is version-stale. Uses the shared comparison so it
 * matches the evaluator + the per-fact enrichment panel.
 */
function VersionDiff({ summary }: { summary: FactTaxonomyHealth["summary"] }) {
  const status = enrichmentVersionStatusFromStored({
    classificationPromptVersion: summary.classificationPromptVersion,
  });
  const stale = status.fields.filter((f) => f.stale);
  if (stale.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-x-2 gap-y-0.5" data-testid="version-diff">
      {stale.map((f) => (
        <span key={f.field} className="text-[10px] text-amber-700 dark:text-amber-300">
          {f.label === "Taxonomy enrichment" ? "enrich" : "plan"}{" "}
          <span className="font-mono">{f.missing ? "—" : f.stored}</span>
          <span aria-hidden>→</span>
          <span className="font-mono font-semibold">{f.current}</span>
        </span>
      ))}
    </div>
  );
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

/** Per-row operation indicator: spinner → done/failed/skipped/still-running. */
function ActionIndicator({ state, outcome }: { state: UiOpState; outcome: ActionOutcome | null }) {
  switch (state) {
    case "posting":
      return (
        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
          <Loader2 className="w-3 h-3 animate-spin" /> Sending…
        </span>
      );
    case "queued":
      return (
        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
          <Loader2 className="w-3 h-3 animate-spin" /> Queued…
        </span>
      );
    case "processing":
      return (
        <span className="inline-flex items-center gap-1 text-xs text-blue-600 dark:text-blue-400">
          <Loader2 className="w-3 h-3 animate-spin" /> Working…
        </span>
      );
    case "done":
      return (
        <span className="inline-flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
          <CheckCircle2 className="w-3 h-3" /> Done
        </span>
      );
    case "failed":
      return (
        <span
          className="inline-flex items-center gap-1 text-xs text-red-600 dark:text-red-400"
          title={outcome?.status === "failed" ? outcome.error : undefined}
        >
          <XCircle className="w-3 h-3" /> Failed
        </span>
      );
    case "skipped":
      return (
        <span
          className="inline-flex items-center gap-1 text-xs text-muted-foreground"
          title={outcome?.status === "skipped" ? outcome.message : undefined}
        >
          <Info className="w-3 h-3" />
          {outcome?.status === "skipped" && outcome.reason === "admin_edited"
            ? "Skipped — admin-edited"
            : "Skipped"}
        </span>
      );
    case "still_running":
      return (
        <span className="inline-flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400">
          <Clock className="w-3 h-3" /> Still running
        </span>
      );
    default:
      return null;
  }
}

/**
 * The stale-for-reprocess row action: a direct "Send back to review" button
 * that flips to an "in review" pill once fired (or if a refresh was already in
 * flight). The row stays listed — it's still stale until the refresh promotes.
 */
function RowSendBack({
  row,
  state,
  onSend,
}: {
  row: HealthRow;
  state: SendBackRowState | undefined;
  onSend: () => void;
}) {
  const inReview = row.refreshInReview || state?.status === "sent";
  if (inReview) {
    const reviewId = state?.status === "sent" ? state.reviewId : undefined;
    return (
      <span
        className="inline-flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400"
        data-testid="send-back-in-review"
      >
        <Clock className="w-3 h-3" /> {reviewId != null ? `Refresh #${reviewId} — in review` : "Refresh in review"}
      </span>
    );
  }
  return (
    <div className="flex flex-col gap-0.5">
      <Button
        variant="secondary"
        size="sm"
        disabled={state?.status === "sending"}
        onClick={onSend}
        data-testid="send-back-to-review"
      >
        {state?.status === "sending"
          ? <Loader2 className="w-3 h-3 mr-1 animate-spin" />
          : <Send className="w-3 h-3 mr-1" />}
        Send back to review
      </Button>
      {state?.status === "error" && (
        <span className="text-[10px] text-red-600 dark:text-red-400" data-testid="send-back-error">{state.message}</span>
      )}
    </div>
  );
}

export default function TaxonomyHealth() {
  const [summary, setSummary] = useState<TaxonomyHealthSummaryResponse | null>(null);
  const [rows, setRows] = useState<HealthRow[]>([]);
  const [total, setTotal] = useState(0);
  const [filter, setFilter] = useState<FilterStatus>("missing_enrichment");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [markModalOpen, setMarkModalOpen] = useState(false);
  // Keyed by factId — the synchronous send-back is NOT routed through the async
  // job hook (that's for pollable jobs; PR4's bulk reprocess will use it).
  const [sendBackStates, setSendBackStates] = useState<Record<number, SendBackRowState>>({});

  const loadSummary = useCallback(async () => {
    try {
      const r = await fetch("/api/admin/taxonomy-health/summary", { credentials: "include" });
      if (!r.ok) throw new Error("summary_failed");
      setSummary(await r.json() as TaxonomyHealthSummaryResponse);
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

  // Refresh both surfaces whenever an action reaches a terminal transition. The
  // selected `filter` is intentionally NOT reset, so the admin stays on the
  // card they were working; rows that get fixed simply drop out of the list.
  const onChanged = useCallback(() => {
    void loadSummary();
    void loadList();
  }, [loadSummary, loadList]);

  const actions = useTaxonomyHealthActions(onChanged);

  const activeCard: CardMeta | undefined = useMemo(
    () => CARD_META.find((c) => c.filter === filter),
    [filter],
  );

  const bulkActions = useMemo(() => {
    const list: Array<{
      key: string;
      label: string;
      action: TaxonomyHealthAction;
      url: string;
      body: Record<string, unknown>;
      confirm?: (count: number) => string;
    }> = [];
    if (filter === "missing_enrichment") {
      list.push({
        key: "backfill_missing",
        label: "Backfill missing enrichment",
        action: "re_enrich",
        url: "/api/admin/taxonomy-health/actions/backfill-enrichment",
        body: { mode: "missing_only" },
        confirm: (n) => `Queue enrichment model jobs for ${n} fact${n === 1 ? "" : "s"}? This costs model calls and can take a while. Admin-edited facts are skipped automatically.`,
      });
    }
    if (filter === "stale_enrichment_version") {
      list.push({
        key: "reenrich_stale",
        label: "Re-enrich stale facts",
        action: "re_enrich",
        url: "/api/admin/taxonomy-health/actions/backfill-enrichment",
        body: { mode: "stale_only" },
        confirm: (n) => `Re-enrich ${n} stale fact${n === 1 ? "" : "s"}? This costs model calls and can take a while. Admin-edited facts are skipped automatically.`,
      });
    }
    if (filter === "projection_mismatch") {
      list.push({
        key: "repair_projections",
        label: "Repair projection mismatches",
        action: "repair_projections",
        url: "/api/admin/taxonomy-health/actions/repair-projections",
        body: { mode: "mismatches_only" },
        // No confirm — projection repair is fast, idempotent, and makes no model calls.
      });
    }
    return list;
  }, [filter]);

  const runBulk = useCallback(
    (a: { label: string; action: TaxonomyHealthAction; url: string; body: Record<string, unknown>; confirm?: (count: number) => string }) => {
      if (a.confirm) {
        const msg = a.confirm(total);
        if (!window.confirm(msg)) return;
      }
      void actions.submit("bulk", a.action, a.url, a.body);
    },
    [actions, total],
  );

  const runRow = useCallback(
    (factId: number, action: TaxonomyHealthAction, url: string) => {
      void actions.submit(`row:${factId}`, action, url, { mode: "selected_fact_ids", factIds: [factId] });
    },
    [actions],
  );

  // Direct, inline send-back for a stale-for-reprocess row (David's choice:
  // fire immediately, no modal, keep overrides). The row stays listed (still
  // stale until the refresh is promoted); only the button flips to "in review".
  const handleSendBack = useCallback(async (factId: number) => {
    setSendBackStates((prev) => ({ ...prev, [factId]: { status: "sending" } }));
    const result = await sendFactBackToReview(factId);
    if (result.success) {
      setSendBackStates((prev) => ({ ...prev, [factId]: { status: "sent", reviewId: result.reviewId } }));
      // The count is unchanged (still stale), but refresh the summary so any
      // other lens that tracks in-flight work stays current.
      void loadSummary();
    } else {
      setSendBackStates((prev) => ({ ...prev, [factId]: { status: "error", message: result.error ?? "Send back failed" } }));
    }
  }, [loadSummary]);

  // Live "X of N done" tally + per-state breakdown, recomputed on every poll.
  const banner = useMemo(() => {
    const op = actions.lastOp;
    if (!op) return null;
    const c = actions.counts(op.scope);
    if (!c) return null;
    const label = ACTION_LABEL[op.action];
    if (op.posting) return { text: `${label}: sending…`, done: false };
    if (c.requested === 0) return { text: `${label}: no matching facts.`, done: true };
    const segs: string[] = [];
    if (c.running > 0) segs.push(`${c.running} in progress`);
    if (c.failed > 0) segs.push(`${c.failed} failed`);
    if (c.skipped > 0) segs.push(`${c.skipped} skipped`);
    if (c.stillRunning > 0) segs.push(`${c.stillRunning} still running`);
    const detail = segs.length > 0 ? ` · ${segs.join(" · ")}` : "";
    const allDone = c.running === 0 && c.stillRunning === 0;
    return { text: `${label}: ${c.done} of ${c.requested} done${detail}`, done: allDone };
  }, [actions]);

  const isBulkMode = filter !== "any";

  return (
    <AdminLayout title="Taxonomy Health">
      <div className="space-y-4">
        <div className="flex items-center gap-2 flex-wrap">
          <Activity className="w-5 h-5 text-primary" />
          <h2 className="text-lg font-bold">Taxonomy Health</h2>
          <Button variant="secondary" size="sm" onClick={() => { void loadSummary(); void loadList(); }} disabled={loading}>
            <RefreshCw className="w-3 h-3 mr-1" /> Refresh
          </Button>
          <div className="ml-auto flex items-center gap-2 flex-wrap justify-end">
            <span className="text-[11px] text-muted-foreground" data-testid="engine-revision">
              Engine revision{" "}
              <span className="font-mono text-foreground">{summary?.engineRevision ?? "—"}</span>
            </span>
            <Button variant="secondary" size="sm" onClick={() => setMarkModalOpen(true)} data-testid="mark-major-update-open">
              <Rocket className="w-3 h-3 mr-1" /> Mark major update
            </Button>
            <span className="text-[11px] text-muted-foreground" data-testid="current-versions">
              Current versions — taxonomy{" "}
              <span className="font-mono text-foreground">{CURRENT_VERSIONS.classificationPromptVersion}</span> · strategy{" "}
              <span className="font-mono text-foreground">{CURRENT_VERSIONS.visualStrategyVersion}</span>
            </span>
          </div>
        </div>

        {markModalOpen && (
          <MarkMajorUpdateModal
            currentRevision={summary?.engineRevision ?? null}
            onCancel={() => setMarkModalOpen(false)}
            onDone={(result) => {
              setMarkModalOpen(false);
              // Reflect the new revision immediately, then reconcile from the server.
              setSummary((prev) => (prev ? { ...prev, engineRevision: result.engineRevision } : prev));
              void loadSummary();
              void loadList();
            }}
          />
        )}

        {/* Summary cards */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
          <SummaryCard label="Total facts" value={summary?.totalFacts ?? null} tone="neutral" onClick={() => setFilter("any")} active={filter === "any"} />
          {CARD_META.map((d) => (
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

        {/* Selected-card explanation */}
        {activeCard ? (
          <CardDescriptionPanel card={activeCard} />
        ) : (
          <div className="rounded-sm border border-border bg-muted/20 p-3 text-xs text-muted-foreground">
            Showing all facts. Select a card above to see what each health issue means and how to fix it.
            Cards are filters, not exclusive buckets — a fact can appear under more than one.
          </div>
        )}

        {/* Filters + search + bulk actions */}
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
              disabled={actions.busy("bulk")}
              onClick={() => runBulk(a)}
            >
              {actions.busy("bulk") ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <ListChecks className="w-3 h-3 mr-1" />}
              {a.label}
            </Button>
          ))}
        </div>

        {/* Last-action banner — live total progress */}
        {banner && !actions.bannerDismissed && (
          <div className="rounded-sm border border-border bg-muted/30 p-2 text-xs text-foreground flex items-start justify-between gap-2">
            <span className="inline-flex items-center gap-1.5">
              {banner.done
                ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400 shrink-0" />
                : <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />}
              <span className="whitespace-pre-wrap">{banner.text}</span>
            </span>
            <button type="button" onClick={actions.dismissBanner} className="text-muted-foreground hover:text-foreground shrink-0" aria-label="Dismiss">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {actions.error && (
          <div className="rounded-sm border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
            {actions.error}
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
                rows.map((row) => {
                  // Busy if this fact has in-flight work from ANY operation —
                  // including a bulk run — so we never double-queue it.
                  const rowBusy = actions.factBusy(row.factId);
                  const { state, outcome } = actions.rowState(row.factId);
                  return (
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
                      {!row.health.statuses.includes("missing_enrichment") &&
                        !row.health.reviewFlags.invalidEnrichment &&
                        row.health.reviewFlags.staleEnrichmentVersion && (
                          <VersionDiff summary={row.health.summary} />
                        )}
                      {row.health.issues.length > 0 && (
                        <p className="text-[10px] text-muted-foreground">{row.health.issues[0]!.message}</p>
                      )}
                    </td>
                    <td className="px-2 py-1.5 align-top whitespace-nowrap">
                      <div className="flex items-center gap-1 flex-wrap">
                        {row.health.reviewFlags.projectionMismatch && (
                          <Button
                            variant="secondary"
                            size="sm"
                            disabled={rowBusy}
                            onClick={() => runRow(row.factId, "repair_projections", "/api/admin/taxonomy-health/actions/repair-projections")}
                          >
                            <Wrench className="w-3 h-3 mr-1" /> Repair
                          </Button>
                        )}
                        {(row.health.statuses.includes("missing_enrichment") || row.health.reviewFlags.staleEnrichmentVersion || row.health.reviewFlags.invalidEnrichment) &&
                          // Refresh-first: a stale-for-reprocess row offers ONLY
                          // "Send back to review". A direct Re-enrich writes
                          // facts.* without stamping a signature, so it wouldn't
                          // clear the stale-for-reprocess flag anyway.
                          !row.health.reviewFlags.staleForReprocess && (
                          <Button
                            variant="secondary"
                            size="sm"
                            disabled={rowBusy}
                            onClick={() => runRow(row.factId, "re_enrich", "/api/admin/taxonomy-health/actions/backfill-enrichment")}
                          >
                            <RefreshCw className="w-3 h-3 mr-1" /> Re-enrich
                          </Button>
                        )}
                        {row.health.reviewFlags.staleForReprocess && (
                          <RowSendBack
                            row={row}
                            state={sendBackStates[row.factId]}
                            onSend={() => void handleSendBack(row.factId)}
                          />
                        )}
                        <ActionIndicator state={state} outcome={outcome} />
                      </div>
                    </td>
                  </tr>
                  );
                })}
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
  tone: CardTone;
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

function CardDescriptionPanel({ card }: { card: CardMeta }) {
  const safetyLabel: Record<string, string> = {
    safe: "Safe to repeat · no model calls",
    costs_model_calls: "Costs model calls",
    overwrite_risk: "May overwrite data",
  };
  return (
    <div className="rounded-sm border border-border bg-muted/20 p-3 space-y-2">
      <p className="text-sm font-bold text-foreground">{card.label}</p>
      <p className="text-xs text-foreground">{card.description}</p>
      <p className="text-xs text-muted-foreground"><span className="font-semibold text-foreground">What to do:</span> {card.whatToDo}</p>
      {card.actions.length > 0 && (
        <ul className="space-y-1">
          {card.actions.map((a) => (
            <li key={a.label} className="text-xs text-muted-foreground">
              <span className="font-semibold text-foreground">{a.label}</span>
              <span className={`ml-2 inline-block px-1.5 py-0.5 rounded-sm text-[10px] uppercase tracking-wide ${a.safety === "safe" ? "bg-emerald-500/20 text-emerald-700 dark:text-emerald-300" : a.safety === "overwrite_risk" ? "bg-red-500/20 text-red-700 dark:text-red-300" : "bg-amber-500/20 text-amber-700 dark:text-amber-300"}`}>
                {safetyLabel[a.safety]}
              </span>
              <span className="block">{a.help}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="text-[10px] text-muted-foreground italic">
        Cards are filters, not exclusive buckets — a fact can appear under more than one. A completed action doesn't always
        resolve the issue; the refreshed list is the source of truth.
      </p>
    </div>
  );
}
