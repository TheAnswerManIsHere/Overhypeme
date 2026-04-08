import { useState, useEffect } from "react";
import { X, TrendingUp, DollarSign, Calendar, ChevronRight, Loader2 } from "lucide-react";

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

interface SpendHistoryModalProps {
  data: SpendData;
  onClose: () => void;
}

function SpendHistoryModal({ data, onClose }: SpendHistoryModalProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" onClick={onClose}>
      <div
        className="bg-card border border-border rounded-lg w-full max-w-md flex flex-col shadow-xl max-h-[80vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-5 border-b border-border">
          <div className="flex items-center gap-2">
            <TrendingUp className="w-4 h-4 text-primary" />
            <h2 className="font-display font-bold text-foreground uppercase tracking-wide text-sm">
              Generation Cost History
            </h2>
          </div>
          <button
            onClick={onClose}
            className="p-1 text-muted-foreground hover:text-foreground transition-colors rounded-sm"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="overflow-y-auto flex-1">
          {data.history.length === 0 ? (
            <div className="p-8 text-center text-muted-foreground text-sm">
              No generation costs recorded yet.
            </div>
          ) : (
            <table className="w-full text-sm">
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
                    className={`border-b border-border/50 ${row.isCurrent ? "bg-primary/5" : "hover:bg-muted/20"}`}
                  >
                    <td className="px-4 py-3">
                      <MonthLabel year={row.year} month={row.month} isCurrent={row.isCurrent} />
                    </td>
                    <td className="px-4 py-3 text-right font-mono font-semibold text-foreground">
                      {fmt(row.totalUsd)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="p-4 border-t border-border bg-muted/20 flex items-center justify-between">
          <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
            Lifetime Total
          </span>
          <span className="font-mono font-bold text-foreground text-base">
            {fmt(data.lifetimeTotal)}
          </span>
        </div>
      </div>
    </div>
  );
}

interface SpendWidgetProps {
  endpoint: string;
  label?: string;
}

export function SpendWidget({ endpoint, label = "Generation Costs" }: SpendWidgetProps) {
  const [data, setData] = useState<SpendData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showModal, setShowModal] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(endpoint, { credentials: "include" })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((d) => { if (!cancelled) setData(d); })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load spend data"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [endpoint]);

  return (
    <>
      {showModal && data && (
        <SpendHistoryModal data={data} onClose={() => setShowModal(false)} />
      )}

      <div
        className="flex items-center gap-3 px-3 py-2.5 rounded-sm border border-border bg-muted/20 cursor-pointer hover:bg-muted/40 hover:border-primary/30 transition-colors group"
        onClick={() => { if (data) setShowModal(true); }}
      >
        <DollarSign className="w-4 h-4 text-muted-foreground group-hover:text-primary shrink-0 transition-colors" />
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
          ) : (
            <div className="text-xs text-muted-foreground mt-0.5">Click to load</div>
          )}
        </div>
        <div className="flex items-center gap-1 text-[10px] text-muted-foreground group-hover:text-primary transition-colors shrink-0">
          <Calendar className="w-3 h-3" />
          <span className="hidden sm:block">History</span>
          <ChevronRight className="w-3 h-3" />
        </div>
      </div>
    </>
  );
}

interface SpendInlineProps {
  userId: string;
  isAdmin?: boolean;
}

export function SpendInline({ userId, isAdmin = false }: SpendInlineProps) {
  const endpoint = isAdmin
    ? `/api/admin/users/${userId}/spend`
    : `/api/users/me/spend`;
  return <SpendWidget endpoint={endpoint} />;
}
