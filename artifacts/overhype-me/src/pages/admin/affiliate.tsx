import { useEffect, useMemo, useState } from "react";
import { AdminLayout } from "@/components/admin/AdminLayout";
import { ResponsiveTable, type ResponsiveColumn } from "@/components/admin/ResponsiveTable";
import { Link } from "wouter";
import { ExternalLink, TrendingUp, ShoppingBag, MapPin, LineChart as LineChartIcon } from "lucide-react";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

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

interface SourceDailyPoint {
  source: string | null;
  day: string;
  total: number;
}

interface StatsResponse {
  rows: ClickRow[];
  totals: DestTotal[];
  bySource: SourceTotal[];
  bySourceDaily: SourceDailyPoint[];
}

// Color palette mirroring SourcePill so the chart's series visually align with
// the totals pills above. Keep these in sync if the pill palette changes.
const SOURCE_COLORS: Record<string, string> = {
  "meme-page": "hsl(280 80% 60%)",
  "wear-page": "hsl(160 70% 45%)",
  "fact-detail": "hsl(210 80% 60%)",
};
const FALLBACK_COLORS = [
  "hsl(45 80% 55%)",
  "hsl(0 70% 60%)",
  "hsl(190 70% 55%)",
  "hsl(330 70% 60%)",
];
const NULL_SOURCE_KEY = "__none__";
const NULL_SOURCE_LABEL = "(no source)";

function colorForSource(source: string | null, fallbackIndex: number): string {
  if (!source) return "hsl(220 10% 50%)";
  return SOURCE_COLORS[source] ?? FALLBACK_COLORS[fallbackIndex % FALLBACK_COLORS.length];
}

// Bind ResponsiveTable's row type via a TypeScript instantiation expression
// so we don't need inline JSX generics (`<ResponsiveTable<ClickRow>`) at the
// call site. Inline JSX generics break in dev because @replit/vite-plugin-cartographer
// injects `data-component-name` attributes between the component name and the
// type argument, producing invalid JSX that babel rejects with an
// "Unexpected token" parser error.
const ClickRowTable = ResponsiveTable<ClickRow>;

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

  // Reshape the per-source-per-day series into the wide format Recharts expects:
  // one row per day, with one numeric column per source. Days that exist for
  // some sources but not others are zero-filled so the lines stay continuous.
  const { chartRows, sourceKeys } = useMemo(() => {
    const daily = data?.bySourceDaily ?? [];
    if (daily.length === 0) return { chartRows: [], sourceKeys: [] as string[] };

    const keys = new Set<string>();
    const byDay = new Map<string, Record<string, number | string>>();
    for (const point of daily) {
      const key = point.source ?? NULL_SOURCE_KEY;
      keys.add(key);
      let row = byDay.get(point.day);
      if (!row) {
        row = { day: point.day };
        byDay.set(point.day, row);
      }
      row[key] = (row[key] as number | undefined ?? 0) + point.total;
    }

    const sortedKeys = Array.from(keys).sort((a, b) => {
      // Push the null/legacy bucket to the end so the named sources lead.
      if (a === NULL_SOURCE_KEY) return 1;
      if (b === NULL_SOURCE_KEY) return -1;
      return a.localeCompare(b);
    });

    const rows = Array.from(byDay.values())
      .map((r) => {
        for (const k of sortedKeys) {
          if (r[k] === undefined) r[k] = 0;
        }
        return r;
      })
      .sort((a, b) => String(a.day).localeCompare(String(b.day)));

    return { chartRows: rows, sourceKeys: sortedKeys };
  }, [data]);

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

      {/* Daily clicks-by-source trend — answers "is meme-page growing or
          shrinking week-over-week?". Hidden when there are no daily points so
          we don't render an awkward empty axis on a fresh install. The series
          are zero-filled across days in the data transform above so each line
          stays continuous even on days where one source got no clicks. */}
      {chartRows.length > 0 && sourceKeys.length > 0 && (
        <div
          className="mb-8 bg-card border border-border rounded-lg p-5"
          data-testid="affiliate-source-trend"
        >
          <div className="flex items-center gap-2 mb-3">
            <LineChartIcon className="w-4 h-4 text-muted-foreground" />
            <h3 className="text-xs uppercase tracking-wide text-muted-foreground font-medium">
              Daily clicks by source
            </h3>
          </div>
          <div className="h-64 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartRows} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
                <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" />
                <XAxis
                  dataKey="day"
                  tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
                  stroke="hsl(var(--border))"
                />
                <YAxis
                  allowDecimals={false}
                  tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
                  stroke="hsl(var(--border))"
                />
                <Tooltip
                  contentStyle={{
                    background: "hsl(var(--card))",
                    border: "1px solid hsl(var(--border))",
                    borderRadius: 4,
                    fontSize: 12,
                  }}
                  labelStyle={{ color: "hsl(var(--muted-foreground))" }}
                />
                <Legend
                  formatter={(value) => (value === NULL_SOURCE_KEY ? NULL_SOURCE_LABEL : value)}
                  wrapperStyle={{ fontSize: 11 }}
                />
                {sourceKeys.map((key, i) => (
                  <Line
                    key={key}
                    type="monotone"
                    dataKey={key}
                    name={key}
                    stroke={colorForSource(key === NULL_SOURCE_KEY ? null : key, i)}
                    strokeWidth={2}
                    dot={false}
                    activeDot={{ r: 4 }}
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
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
      <ClickRowTable
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
