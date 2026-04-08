import { useEffect, useState } from "react";
import { TrendingUp, DollarSign, Loader2 } from "lucide-react";

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

interface SpendMonth {
  year: number;
  month: number;
  totalUsd: number;
  isCurrent: boolean;
}

interface SpendData {
  current: SpendMonth;
  history: SpendMonth[];
  lifetimeTotal: number;
}

function fmt(usd: number) {
  return `$${usd.toFixed(4)}`;
}

function MonthLabel({ year, month, isCurrent }: { year: number; month: number; isCurrent: boolean }) {
  return (
    <span className="flex items-center gap-1.5">
      {MONTH_NAMES[month - 1]} {year}
      {isCurrent && (
        <span className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-sm bg-primary/15 text-primary border border-primary/30">
          Current
        </span>
      )}
    </span>
  );
}

// ── SpendBreakdown — always-visible month-by-month table ──────────────────────

interface SpendBreakdownProps {
  endpoint: string;
}

export function SpendBreakdown({ endpoint }: SpendBreakdownProps) {
  const [data, setData] = useState<SpendData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(endpoint, { credentials: "include" })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((d) => { if (!cancelled) setData(d as SpendData); })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [endpoint]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-3 text-muted-foreground text-sm">
        <Loader2 className="w-3.5 h-3.5 animate-spin" />
        <span>Loading…</span>
      </div>
    );
  }

  if (error) {
    return <div className="text-destructive text-sm py-2">{error}</div>;
  }

  if (!data) return null;

  return (
    <div className="rounded-sm border border-border overflow-hidden text-sm">
      {data.history.length === 0 ? (
        <div className="px-4 py-5 text-center text-muted-foreground text-sm">
          No generation costs recorded yet.
        </div>
      ) : (
        <table className="w-full">
          <thead>
            <tr className="border-b border-border bg-muted/30">
              <th className="text-left px-4 py-2.5 text-xs font-bold uppercase tracking-wider text-muted-foreground">
                Month
              </th>
              <th className="text-right px-4 py-2.5 text-xs font-bold uppercase tracking-wider text-muted-foreground">
                Spend
              </th>
            </tr>
          </thead>
          <tbody>
            {data.history.map((row) => (
              <tr
                key={`${row.year}-${row.month}`}
                className={`border-b border-border/50 ${row.isCurrent ? "bg-primary/5" : ""}`}
              >
                <td className="px-4 py-3 text-foreground">
                  <MonthLabel year={row.year} month={row.month} isCurrent={row.isCurrent} />
                </td>
                <td className="px-4 py-3 text-right font-mono font-semibold text-foreground">
                  {fmt(row.totalUsd)}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t border-border bg-muted/20">
              <td className="px-4 py-3 text-xs font-bold uppercase tracking-wider text-muted-foreground">
                Lifetime Total
              </td>
              <td className="px-4 py-3 text-right font-mono font-bold text-foreground">
                {fmt(data.lifetimeTotal)}
              </td>
            </tr>
          </tfoot>
        </table>
      )}
    </div>
  );
}

// ── SpendWidget — compact clickable row (kept for tight-space contexts) ────────

interface SpendWidgetProps {
  endpoint: string;
  label?: string;
}

export function SpendWidget({ endpoint, label = "Generation Costs" }: SpendWidgetProps) {
  const [data, setData] = useState<SpendData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(endpoint, { credentials: "include" })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((d) => { if (!cancelled) setData(d as SpendData); })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load spend data"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [endpoint]);

  return (
    <div className="flex items-center gap-3 px-3 py-2.5 rounded-sm border border-border bg-muted/20">
      <DollarSign className="w-4 h-4 text-muted-foreground shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">{label}</div>
        {loading ? (
          <div className="flex items-center gap-1.5 mt-0.5">
            <Loader2 className="w-3 h-3 animate-spin text-muted-foreground" />
            <span className="text-xs text-muted-foreground">Loading…</span>
          </div>
        ) : error ? (
          <div className="text-xs text-destructive mt-0.5">{error}</div>
        ) : data ? (
          <div className="flex items-baseline gap-1.5 mt-0.5">
            <span className="font-mono font-semibold text-sm text-foreground">
              {fmt(data.current.totalUsd)}
            </span>
            <span className="text-[10px] text-muted-foreground">
              {MONTH_NAMES[(data.current.month ?? 1) - 1]}
            </span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

// ── SpendInline — admin shorthand ─────────────────────────────────────────────

interface SpendInlineProps {
  userId: string;
  isAdmin?: boolean;
}

export function SpendInline({ userId, isAdmin = false }: SpendInlineProps) {
  const endpoint = isAdmin
    ? `/api/admin/users/${userId}/spend`
    : `/api/users/me/spend`;
  return <SpendBreakdown endpoint={endpoint} />;
}
