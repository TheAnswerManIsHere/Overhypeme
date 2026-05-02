import { useEffect, useState } from "react";
import { AdminLayout } from "@/components/admin/AdminLayout";
import { ResponsiveTable, type ResponsiveColumn } from "@/components/admin/ResponsiveTable";
import { Link } from "wouter";
import { ExternalLink, TrendingUp, ShoppingBag, MapPin } from "lucide-react";

interface ClickRow {
  sourceType: "fact" | "meme";
  sourceId: string;
  destination: "zazzle";
  source: string | null;
  clicks: number;
  lastClicked: string;
}

interface DestTotal {
  destination: "zazzle";
  total: number;
}

interface SourceTotal {
  source: string | null;
  total: number;
}

interface StatsResponse {
  rows: ClickRow[];
  totals: DestTotal[];
  bySource: SourceTotal[];
}

function SourcePill({ value }: { value: string | null }) {
  // Visualize the click-origin (`source` column). null/empty = legacy row
  // logged before the column existed or a click that arrived without
  // attribution; render as a muted "—" so it's visually distinct from a
  // real source value.
  if (!value) {
    return <span className="text-xs text-muted-foreground">—</span>;
  }
  // Reserve a couple of color slots for the canonical sources we ship; new
  // sources fall through to a neutral pill.
  const palette: Record<string, string> = {
    "meme-page": "bg-primary/20 text-primary",
    "wear-page": "bg-emerald-500/20 text-emerald-400",
    "fact-detail": "bg-blue-500/20 text-blue-400",
  };
  const cls = palette[value] ?? "bg-muted text-foreground";
  return (
    <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded-sm tracking-wider ${cls}`}>
      {value}
    </span>
  );
}

export default function AdminAffiliate() {
  const [data, setData] = useState<StatsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  function load() {
    setLoading(true);
    setError(null);
    const params = new URLSearchParams();
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    fetch(`/api/affiliate/stats?${params}`, { credentials: "include" })
      .then(async (r) => {
        if (r.status === 401) { setError("Admin access required. Please log in as an admin user."); setData(null); return; }
        if (!r.ok) { setError(`Error loading stats: ${r.statusText}`); setData(null); return; }
        const d = (await r.json()) as StatsResponse;
        setData(d);
      })
      .catch(() => { setError("Failed to load affiliate stats. Please try again."); setData(null); })
      .finally(() => setLoading(false));
  }

  useEffect(() => { load(); }, []);

  const totals = data?.totals ?? [];
  const zazzleTotal = totals.find((t) => t.destination === "zazzle")?.total ?? 0;
  const grandTotal = zazzleTotal;
  const bySource = data?.bySource ?? [];

  return (
    <AdminLayout title="Affiliate Click-Throughs">
      {/* Error state */}
      {error && (
        <div className="mb-6 p-4 bg-destructive/10 border border-destructive/30 text-destructive rounded-lg text-sm">
          {error}
        </div>
      )}

      {/* Summary cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-6">
        {[
          { label: "Total Clicks", value: grandTotal, icon: TrendingUp, color: "text-primary" },
          { label: "Zazzle", value: zazzleTotal, icon: ShoppingBag, color: "text-orange-400" },
        ].map(({ label, value, icon: Icon, color }) => (
          <div key={label} className="bg-card border border-border rounded-lg p-5 flex items-center gap-4">
            <div className={`p-3 rounded-lg bg-muted ${color}`}>
              <Icon className="w-5 h-5" />
            </div>
            <div>
              <p className="text-muted-foreground text-xs uppercase tracking-wide font-medium">{label}</p>
              <p className="text-2xl font-bold text-foreground">{value}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Clicks-by-source breakdown — surfaces the new `source` attribution
          so it's the first thing an admin sees alongside the top-line totals.
          Shown only when at least one row has a source, so the panel doesn't
          appear empty for fresh installs. */}
      {bySource.length > 0 && (
        <div className="mb-8 bg-card border border-border rounded-lg p-5">
          <div className="flex items-center gap-2 mb-3">
            <MapPin className="w-4 h-4 text-muted-foreground" />
            <h3 className="text-xs uppercase tracking-wide text-muted-foreground font-medium">By source</h3>
          </div>
          <div className="flex flex-wrap gap-2">
            {bySource.map((s) => (
              <div
                key={s.source ?? "__none__"}
                className="flex items-center gap-2 bg-background border border-border rounded-sm px-3 py-2"
              >
                <SourcePill value={s.source} />
                <span className="font-mono text-sm text-foreground tabular-nums">{s.total}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Date filter */}
      <div className="flex flex-wrap items-end gap-3 mb-6">
        <div>
          <label className="block text-xs text-muted-foreground mb-1">From</label>
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="bg-input border border-border text-foreground rounded-sm px-3 py-1.5 text-sm"
          />
        </div>
        <div>
          <label className="block text-xs text-muted-foreground mb-1">To</label>
          <input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="bg-input border border-border text-foreground rounded-sm px-3 py-1.5 text-sm"
          />
        </div>
        <button
          onClick={load}
          className="px-4 py-1.5 bg-primary text-primary-foreground rounded-sm text-sm font-medium"
        >
          Filter
        </button>
        <button
          onClick={() => { setFrom(""); setTo(""); setTimeout(load, 0); }}
          className="px-4 py-1.5 border border-border text-muted-foreground rounded-sm text-sm"
        >
          Clear
        </button>
      </div>

      {/* Table */}
      <ResponsiveTable<ClickRow>
        rows={data?.rows ?? []}
        getKey={(row) => `${row.sourceType}-${row.sourceId}-${row.destination}-${row.source ?? "__none__"}`}
        loading={loading}
        emptyState="No affiliate clicks recorded yet."
        mobilePrimary={(row) => (
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <span
                className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded-sm shrink-0 ${
                  row.sourceType === "fact"
                    ? "bg-primary/20 text-primary"
                    : "bg-blue-500/20 text-blue-400"
                }`}
              >
                {row.sourceType}
              </span>
              <span className="font-mono text-sm text-foreground truncate">{row.sourceId}</span>
            </div>
            <span className="text-base font-bold text-foreground tabular-nums shrink-0">
              {row.clicks}
            </span>
          </div>
        )}
        mobileFooter={(row) =>
          row.sourceType === "fact" ? (
            <Link href={`/facts/${row.sourceId}`}>
              <a className="inline-flex items-center justify-center gap-1.5 min-h-[44px] w-full text-sm text-primary border border-primary/30 hover:bg-primary/10 rounded-sm px-3">
                View source <ExternalLink className="w-3.5 h-3.5" />
              </a>
            </Link>
          ) : (
            <Link href={`/meme/${row.sourceId}`}>
              <a className="inline-flex items-center justify-center gap-1.5 min-h-[44px] w-full text-sm text-primary border border-primary/30 hover:bg-primary/10 rounded-sm px-3">
                View source <ExternalLink className="w-3.5 h-3.5" />
              </a>
            </Link>
          )
        }
        columns={[
          {
            key: "sourceType",
            header: "Type",
            hideOnMobile: true,
            cell: (row) => (
              <span
                className={`text-xs font-bold uppercase px-2 py-0.5 rounded-sm ${
                  row.sourceType === "fact"
                    ? "bg-primary/20 text-primary"
                    : "bg-blue-500/20 text-blue-400"
                }`}
              >
                {row.sourceType}
              </span>
            ),
          },
          {
            key: "id",
            header: "ID",
            hideOnMobile: true,
            cell: (row) => <span className="font-mono text-foreground">{row.sourceId}</span>,
          },
          {
            key: "source",
            header: "Source",
            mobileLabel: "From",
            mobileSecondary: true,
            cell: (row) => <SourcePill value={row.source} />,
          },
          {
            key: "destination",
            header: "Destination",
            mobileLabel: "Destination",
            cell: (row) => (
              <span className="text-xs uppercase font-medium text-orange-400">{row.destination}</span>
            ),
          },
          {
            key: "clicks",
            header: "Clicks",
            hideOnMobile: true,
            className: "text-right font-bold text-foreground",
            cell: (row) => row.clicks,
          },
          {
            key: "lastClicked",
            header: "Last Click",
            mobileLabel: "Last click",
            className: "text-right text-muted-foreground text-xs",
            cell: (row) => new Date(row.lastClicked).toLocaleDateString(),
            mobileSecondary: true,
          },
          {
            key: "view",
            header: "",
            hideOnMobile: true,
            className: "text-right",
            cell: (row) =>
              row.sourceType === "fact" ? (
                <Link href={`/facts/${row.sourceId}`}>
                  <a className="text-primary hover:underline text-xs inline-flex items-center gap-1 justify-end">
                    View <ExternalLink className="w-3 h-3" />
                  </a>
                </Link>
              ) : (
                <Link href={`/meme/${row.sourceId}`}>
                  <a className="text-primary hover:underline text-xs inline-flex items-center gap-1 justify-end">
                    View <ExternalLink className="w-3 h-3" />
                  </a>
                </Link>
              ),
          },
        ] satisfies ResponsiveColumn<ClickRow>[]}
        footer={
          !loading && data?.rows && data.rows.length >= 200 ? (
            <p className="text-xs text-muted-foreground px-4 py-3 border-t border-border/50">
              Showing the 200 most recent grouped rows. Use date filters to narrow the range and see all results.
            </p>
          ) : null
        }
      />
    </AdminLayout>
  );
}
