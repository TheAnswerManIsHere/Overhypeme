import { useEffect, useState } from "react";
import { AdminLayout } from "@/components/admin/AdminLayout";
import { Link } from "wouter";
import { ExternalLink, TrendingUp, ShoppingBag } from "lucide-react";

interface ClickRow {
  sourceType: "fact" | "meme";
  sourceId: string;
  destination: "zazzle" | "cafepress";
  clicks: number;
  lastClicked: string;
}

interface DestTotal {
  destination: "zazzle" | "cafepress";
  total: number;
}

interface StatsResponse {
  rows: ClickRow[];
  totals: DestTotal[];
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
  const cafePressTotal = totals.find((t) => t.destination === "cafepress")?.total ?? 0;
  const grandTotal = zazzleTotal + cafePressTotal;

  return (
    <AdminLayout title="Affiliate Click-Throughs">
      {/* Error state */}
      {error && (
        <div className="mb-6 p-4 bg-destructive/10 border border-destructive/30 text-destructive rounded-lg text-sm">
          {error}
        </div>
      )}

      {/* Summary cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-8">
        {[
          { label: "Total Clicks", value: grandTotal, icon: TrendingUp, color: "text-primary" },
          { label: "Zazzle", value: zazzleTotal, icon: ShoppingBag, color: "text-orange-400" },
          { label: "CafePress", value: cafePressTotal, icon: ShoppingBag, color: "text-blue-400" },
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
      <div className="bg-card border border-border rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted border-b border-border">
            <tr>
              <th className="text-left px-4 py-3 text-xs uppercase tracking-wide text-muted-foreground">Source</th>
              <th className="text-left px-4 py-3 text-xs uppercase tracking-wide text-muted-foreground">ID</th>
              <th className="text-left px-4 py-3 text-xs uppercase tracking-wide text-muted-foreground">Destination</th>
              <th className="text-right px-4 py-3 text-xs uppercase tracking-wide text-muted-foreground">Clicks</th>
              <th className="text-right px-4 py-3 text-xs uppercase tracking-wide text-muted-foreground">Last Click</th>
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={6} className="text-center py-12 text-muted-foreground">Loading…</td>
              </tr>
            )}
            {!loading && (!data?.rows || data.rows.length === 0) && (
              <tr>
                <td colSpan={6} className="text-center py-12 text-muted-foreground">No affiliate clicks recorded yet.</td>
              </tr>
            )}
            {!loading && data?.rows.map((row, i) => (
              <tr key={i} className="border-b border-border/50 hover:bg-secondary/30 transition-colors">
                <td className="px-4 py-3">
                  <span className={`text-xs font-bold uppercase px-2 py-0.5 rounded-sm ${row.sourceType === "fact" ? "bg-primary/20 text-primary" : "bg-blue-500/20 text-blue-400"}`}>
                    {row.sourceType}
                  </span>
                </td>
                <td className="px-4 py-3 font-mono text-foreground">{row.sourceId}</td>
                <td className="px-4 py-3">
                  <span className={`text-xs uppercase font-medium ${row.destination === "zazzle" ? "text-orange-400" : "text-blue-400"}`}>
                    {row.destination}
                  </span>
                </td>
                <td className="px-4 py-3 text-right font-bold text-foreground">{row.clicks}</td>
                <td className="px-4 py-3 text-right text-muted-foreground text-xs">
                  {new Date(row.lastClicked).toLocaleDateString()}
                </td>
                <td className="px-4 py-3 text-right">
                  {row.sourceType === "fact" ? (
                    <Link href={`/facts/${row.sourceId}`}>
                      <a className="text-primary hover:underline text-xs flex items-center gap-1 justify-end">
                        View <ExternalLink className="w-3 h-3" />
                      </a>
                    </Link>
                  ) : (
                    <Link href={`/meme/${row.sourceId}`}>
                      <a className="text-primary hover:underline text-xs flex items-center gap-1 justify-end">
                        View <ExternalLink className="w-3 h-3" />
                      </a>
                    </Link>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </AdminLayout>
  );
}
