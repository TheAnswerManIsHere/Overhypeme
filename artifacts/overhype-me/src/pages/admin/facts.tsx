/**
 * The admin Facts page (plan docs/plans/PLAN_FACT_LIFECYCLE_REBUILD.md, items
 * 18–19; Issue #1018, increment 3.1): approved facts only, live or
 * deactivated, searchable, each row carrying the reasons it needs attention.
 * A row opens the fact sheet, the one editor for a fact's data. The counts
 * strip, filtering by reason, bulk actions and step-through are 3.3's.
 */
import { useCallback, useEffect, useState } from "react";
import { Search } from "lucide-react";
import { AdminLayout } from "@/components/admin/AdminLayout";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { GagFoldPanel } from "@/components/admin/GagFoldPanel";
import { FactSheet } from "@/components/admin/factSheet/FactSheet";
import { ATTENTION_WORDS, knownReasons } from "@/components/admin/factSheet/factSheetView";

/** One row of GET /admin/facts. */
interface FactRow {
  id: number;
  text: string;
  isActive: boolean;
  upvotes: number;
  downvotes: number;
  wilsonScore: number;
  createdAt: string;
  attention?: string[];
}

interface FactsResponse {
  facts: FactRow[];
  total: number;
}

type FactsTab = "facts" | "utilities";
type FactVisibilityFilter = "active" | "inactive" | "both";

const LIMIT = 25;

/** One row in the Facts list: the fact, its state and the reasons it needs a look. */
function FactListRow({ fact, onOpen }: { fact: FactRow; onOpen: () => void }) {
  const reasons = knownReasons(fact.attention);
  return (
    <button
      type="button"
      onClick={onOpen}
      data-testid={`fact-row-${fact.id}`}
      className="w-full text-left flex items-start gap-3 px-4 py-3 hover:bg-muted/40 transition-colors"
    >
      <span
        className={`mt-1.5 w-2 h-2 rounded-full shrink-0 ${fact.isActive ? "bg-green-500" : "bg-red-500"}`}
        title={fact.isActive ? "Live" : "Deactivated"}
      />
      <span className="flex-1 min-w-0">
        <span className={`block text-sm leading-snug line-clamp-2 ${fact.isActive ? "text-foreground" : "text-muted-foreground"}`}>{fact.text}</span>
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1 text-xs text-muted-foreground">
          <span className="font-mono">#{fact.id}</span>
          {!fact.isActive && <span className="font-semibold text-red-500">Deactivated</span>}
          <span className="font-mono">↑{fact.upvotes} ↓{fact.downvotes}</span>
          <span className="font-mono">W {(fact.wilsonScore ?? 0).toFixed(3)}</span>
          <span className="font-mono">{new Date(fact.createdAt).toLocaleDateString()}</span>
          {reasons.map((r) => (
            <span
              key={r}
              data-testid={`fact-row-${fact.id}-reason-${r}`}
              className="px-1.5 py-0.5 rounded-sm border border-amber-500/40 bg-amber-500/10 text-amber-600 font-semibold"
              title={ATTENTION_WORDS[r].sentence}
            >
              {ATTENTION_WORDS[r].label}
            </span>
          ))}
        </span>
      </span>
    </button>
  );
}

/** The fact a link opens: ?focus=<id>. */
function focusFromUrl(): number | null {
  const id = Number(new URLSearchParams(window.location.search).get("focus"));
  return Number.isInteger(id) && id > 0 ? id : null;
}

export default function AdminFacts() {
  const [facts, setFacts] = useState<FactRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [activeTab, setActiveTab] = useState<FactsTab>("facts");
  const [visibilityFilter, setVisibilityFilter] = useState<FactVisibilityFilter>("active");
  const [openFactId, setOpenFactId] = useState<number | null>(focusFromUrl);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 400);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => { setPage(1); }, [debouncedSearch, visibilityFilter]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError("");
    const params = new URLSearchParams({
      page: String(page),
      limit: String(LIMIT),
      visibility: visibilityFilter,
      ...(debouncedSearch ? { search: debouncedSearch } : {}),
    });
    fetch(`/api/admin/facts?${params}`, { credentials: "include" })
      .then(async (r) => {
        const data = (await r.json().catch(() => ({}))) as Partial<FactsResponse> & { error?: string };
        if (!r.ok || !Array.isArray(data.facts)) throw new Error(data.error ?? `Could not load the facts (${r.status}).`);
        if (cancelled) return;
        setFacts(data.facts);
        setTotal(data.total ?? 0);
      })
      .catch((err: unknown) => { if (!cancelled) setLoadError(err instanceof Error ? err.message : "Could not load the facts."); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [page, debouncedSearch, visibilityFilter, refreshNonce]);

  const reload = useCallback(() => setRefreshNonce((n) => n + 1), []);
  const closeSheet = useCallback(() => setOpenFactId(null), []);

  const totalPages = Math.ceil(total / LIMIT);

  return (
    <AdminLayout title="Facts Management">
      {openFactId != null && <FactSheet key={openFactId} factId={openFactId} onClose={closeSheet} onChanged={reload} />}

      <div className="mb-4 flex gap-2 border-b border-border">
        {(["facts", "utilities"] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setActiveTab(t)}
            className={`px-4 py-2 text-sm font-bold uppercase tracking-wide border-b-2 transition-colors ${activeTab === t ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground"}`}
          >
            {t === "facts" ? "Facts" : "Utilities"}
          </button>
        ))}
      </div>

      {activeTab === "facts" ? (
        <div className="bg-card border border-border rounded-lg overflow-hidden flex flex-col" data-testid="facts-list">
          <div className="p-4 border-b border-border flex flex-wrap items-center gap-3">
            <div className="relative flex-1 min-w-[12rem]">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search wording or fact number…"
                className="pl-9"
                aria-label="Search facts"
              />
            </div>
            <label className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground shrink-0">
              <span>Show</span>
              <select
                value={visibilityFilter}
                onChange={(e) => setVisibilityFilter(e.target.value as FactVisibilityFilter)}
                className="h-9 rounded-sm border border-border bg-background px-2 text-xs font-medium text-foreground focus:outline-none focus:border-primary"
                aria-label="Show facts"
              >
                <option value="active">Live</option>
                <option value="inactive">Deactivated</option>
                <option value="both">Both</option>
              </select>
            </label>
            <span className="text-sm text-muted-foreground whitespace-nowrap font-mono" data-testid="facts-total">{total}</span>
          </div>
          <p className="px-4 py-2 text-xs text-muted-foreground border-b border-border">
            Approved facts only. A submission still in moderation is on the Moderation page.
          </p>

          <div className="divide-y divide-border">
            {loadError ? (
              <div className="p-8 text-center text-destructive text-sm" role="alert">{loadError}</div>
            ) : loading ? (
              <div className="p-8 text-center text-muted-foreground text-sm">Loading…</div>
            ) : facts.length === 0 ? (
              <div className="p-8 text-center text-muted-foreground text-sm">No facts found.</div>
            ) : (
              facts.map((fact) => <FactListRow key={fact.id} fact={fact} onOpen={() => setOpenFactId(fact.id)} />)
            )}
          </div>

          {totalPages > 1 && (
            <div className="p-3 border-t border-border flex items-center justify-between">
              <Button variant="ghost" size="sm" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1}>
                Previous
              </Button>
              <span className="text-xs text-muted-foreground">Page {page} of {totalPages}</span>
              <Button variant="ghost" size="sm" onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page === totalPages}>
                Next
              </Button>
            </div>
          )}
        </div>
      ) : (
        <div className="bg-card border border-border rounded-lg p-5 flex flex-col gap-4" data-testid="facts-utilities">
          {/* The gag fold (Issue #982): its run on the live database is still
              owed, so it moved here when Taxonomy Health went (plan
              PLAN_FACT_LIFECYCLE_REBUILD.md, 2A). */}
          <GagFoldPanel />
        </div>
      )}
    </AdminLayout>
  );
}
