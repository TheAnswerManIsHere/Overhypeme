import { useCallback, useEffect, useMemo, useState } from "react";
import { AdminLayout } from "@/components/admin/AdminLayout";
import { Button } from "@/components/ui/Button";
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Loader2,
  RefreshCw,
  Search,
  ShieldAlert,
  Undo2,
} from "lucide-react";

type RefundDisputeEvent =
  | "refund"
  | "dispute_opened"
  | "dispute_won"
  | "dispute_lost"
  | "dispute_closed";

interface RefundDisputeRow {
  id: number;
  createdAt: string;
  event: RefundDisputeEvent | string;
  plan: string | null;
  amount: number | null;
  currency: string | null;
  stripePaymentIntentId: string | null;
  stripeSubscriptionId: string | null;
  stripeInvoiceId: string | null;
  stripeDisputeId: string | null;
  userId: string;
  userEmail: string | null;
  userDisplayName: string | null;
}

interface ApiResponse {
  rows: RefundDisputeRow[];
  total: number;
  page: number;
  limit: number;
  liveMode: boolean;
  eventTypes: RefundDisputeEvent[];
}

const PAGE_SIZE = 25;

const FILTER_OPTIONS: { value: "" | RefundDisputeEvent; label: string }[] = [
  { value: "", label: "All" },
  { value: "refund", label: "Refunds" },
  { value: "dispute_opened", label: "Disputes opened" },
  { value: "dispute_won", label: "Disputes won" },
  { value: "dispute_lost", label: "Disputes lost" },
  { value: "dispute_closed", label: "Disputes closed" },
];

function eventBadgeClass(event: string): string {
  switch (event) {
    case "refund":
      return "bg-blue-500/15 text-blue-500 dark:text-blue-400 border-blue-500/30";
    case "dispute_opened":
      return "bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30";
    case "dispute_lost":
      return "bg-red-500/15 text-red-500 border-red-500/30";
    case "dispute_won":
      return "bg-green-500/15 text-green-600 dark:text-green-400 border-green-500/30";
    case "dispute_closed":
      return "bg-muted text-muted-foreground border-border";
    default:
      return "bg-muted text-muted-foreground border-border";
  }
}

function formatEvent(event: string): string {
  switch (event) {
    case "refund":
      return "Refund";
    case "dispute_opened":
      return "Dispute opened";
    case "dispute_won":
      return "Dispute won";
    case "dispute_lost":
      return "Dispute lost";
    case "dispute_closed":
      return "Dispute closed";
    default:
      return event;
  }
}

function formatAmount(amount: number | null, currency: string | null): string {
  if (amount === null || amount === undefined) return "—";
  const cur = (currency ?? "usd").toUpperCase();
  // Stripe stores most currencies as the smallest unit (cents). Display with 2 decimals.
  const value = amount / 100;
  return `${value.toFixed(2)} ${cur}`;
}

function stripeBase(liveMode: boolean): string {
  return liveMode
    ? "https://dashboard.stripe.com"
    : "https://dashboard.stripe.com/test";
}

export default function AdminRefundsDisputes() {
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [page, setPage] = useState(1);
  const [eventFilter, setEventFilter] = useState<"" | RefundDisputeEvent>("");
  const [searchInput, setSearchInput] = useState("");
  const [searchActive, setSearchActive] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const params = new URLSearchParams();
    params.set("page", String(page));
    params.set("limit", String(PAGE_SIZE));
    if (eventFilter) params.set("event", eventFilter);
    if (searchActive) params.set("search", searchActive);
    try {
      const res = await fetch(`/api/admin/refunds-disputes?${params.toString()}`, {
        credentials: "include",
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(
          (body as { error?: string }).error ?? `Failed to load (HTTP ${res.status})`,
        );
      }
      const json = (await res.json()) as ApiResponse;
      setData(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [page, eventFilter, searchActive]);

  useEffect(() => {
    void load();
  }, [load]);

  const totalPages = useMemo(() => {
    if (!data) return 1;
    return Math.max(1, Math.ceil(data.total / data.limit));
  }, [data]);

  function applySearch(e?: React.FormEvent) {
    e?.preventDefault();
    setPage(1);
    setSearchActive(searchInput.trim());
  }

  function clearSearch() {
    setSearchInput("");
    setSearchActive("");
    setPage(1);
  }

  function changeFilter(value: "" | RefundDisputeEvent) {
    setEventFilter(value);
    setPage(1);
  }

  const liveMode = data?.liveMode ?? false;
  const sBase = stripeBase(liveMode);
  const rows = data?.rows ?? [];

  return (
    <AdminLayout title="Refunds & Disputes">
      <div className="space-y-4">
        {/* Filters */}
        <div className="bg-card border border-border rounded-lg p-4 flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            {FILTER_OPTIONS.map((opt) => {
              const active = eventFilter === opt.value;
              return (
                <button
                  key={opt.value || "all"}
                  onClick={() => changeFilter(opt.value)}
                  className={`px-2.5 py-1 text-xs font-medium rounded-sm border transition-colors ${
                    active
                      ? "bg-primary text-primary-foreground border-primary"
                      : "bg-muted text-muted-foreground border-border hover:bg-muted/80"
                  }`}
                >
                  {opt.label}
                </button>
              );
            })}
            <span className="ml-auto text-xs text-muted-foreground">
              {data ? `${data.total.toLocaleString()} record${data.total === 1 ? "" : "s"}` : ""}
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <form onSubmit={applySearch} className="flex items-center gap-2 flex-1 min-w-[240px]">
              <div className="relative flex-1">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
                <input
                  type="text"
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                  placeholder="Search by user email, name, or ID"
                  className="w-full pl-8 pr-2 py-1.5 text-sm bg-muted border border-border rounded-sm focus:outline-none focus:border-primary"
                />
              </div>
              <Button type="submit" variant="outline" size="sm" className="h-8 px-3 text-xs">
                Search
              </Button>
              {searchActive && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-8 px-3 text-xs"
                  onClick={clearSearch}
                >
                  Clear
                </Button>
              )}
            </form>
            <Button
              variant="outline"
              size="sm"
              className="h-8 px-3 text-xs gap-1"
              onClick={() => void load()}
              disabled={loading}
            >
              {loading ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <RefreshCw className="w-3.5 h-3.5" />
              )}
              Refresh
            </Button>
          </div>
        </div>

        {error && (
          <div className="bg-destructive/10 border border-destructive/30 text-destructive rounded-lg p-3 text-sm flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            {error}
          </div>
        )}

        {/* Table */}
        <div className="bg-card border border-border rounded-lg overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/40">
                <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  <th className="px-3 py-2.5">When</th>
                  <th className="px-3 py-2.5">Event</th>
                  <th className="px-3 py-2.5">User</th>
                  <th className="px-3 py-2.5">Plan</th>
                  <th className="px-3 py-2.5 text-right">Amount</th>
                  <th className="px-3 py-2.5">Stripe</th>
                </tr>
              </thead>
              <tbody>
                {loading && rows.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-3 py-10 text-center text-muted-foreground">
                      <Loader2 className="w-4 h-4 animate-spin inline mr-2" />
                      Loading…
                    </td>
                  </tr>
                ) : rows.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-3 py-10 text-center text-muted-foreground">
                      <ShieldAlert className="w-5 h-5 mx-auto mb-2 opacity-60" />
                      No refund or dispute events match the current filters.
                    </td>
                  </tr>
                ) : (
                  rows.map((row) => {
                    const piUrl = row.stripePaymentIntentId
                      ? `${sBase}/payments/${row.stripePaymentIntentId}`
                      : null;
                    const disputeUrl = row.stripeDisputeId
                      ? `${sBase}/disputes/${row.stripeDisputeId}`
                      : null;
                    const subUrl = row.stripeSubscriptionId
                      ? `${sBase}/subscriptions/${row.stripeSubscriptionId}`
                      : null;

                    return (
                      <tr
                        key={row.id}
                        className="border-t border-border hover:bg-muted/20 transition-colors align-top"
                      >
                        <td className="px-3 py-2.5 whitespace-nowrap text-muted-foreground text-xs">
                          {new Date(row.createdAt).toLocaleString()}
                        </td>
                        <td className="px-3 py-2.5 whitespace-nowrap">
                          <span
                            className={`inline-flex items-center gap-1 px-2 py-0.5 text-xs font-semibold rounded-full border ${eventBadgeClass(
                              row.event,
                            )}`}
                          >
                            {row.event === "refund" ? (
                              <Undo2 className="w-3 h-3" />
                            ) : (
                              <ShieldAlert className="w-3 h-3" />
                            )}
                            {formatEvent(row.event)}
                          </span>
                        </td>
                        <td className="px-3 py-2.5">
                          <div className="flex flex-col">
                            <span className="text-foreground font-medium truncate max-w-[220px]">
                              {row.userDisplayName ?? <em className="text-muted-foreground">no name</em>}
                            </span>
                            <span className="text-xs text-muted-foreground truncate max-w-[220px]">
                              {row.userEmail ?? "—"}
                            </span>
                            <span className="text-[10px] font-mono text-muted-foreground/80 truncate max-w-[220px]">
                              {row.userId}
                            </span>
                          </div>
                        </td>
                        <td className="px-3 py-2.5 text-muted-foreground text-xs whitespace-nowrap">
                          {row.plan ?? "—"}
                        </td>
                        <td className="px-3 py-2.5 text-right tabular-nums whitespace-nowrap">
                          {formatAmount(row.amount, row.currency)}
                        </td>
                        <td className="px-3 py-2.5">
                          <div className="flex flex-col gap-0.5 text-xs font-mono">
                            {disputeUrl && (
                              <a
                                href={disputeUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1 text-primary hover:underline"
                                title="Open dispute in Stripe"
                              >
                                <ExternalLink className="w-3 h-3 shrink-0" />
                                <span className="truncate max-w-[180px]">{row.stripeDisputeId}</span>
                              </a>
                            )}
                            {piUrl && (
                              <a
                                href={piUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1 text-primary hover:underline"
                                title="Open payment intent in Stripe"
                              >
                                <ExternalLink className="w-3 h-3 shrink-0" />
                                <span className="truncate max-w-[180px]">{row.stripePaymentIntentId}</span>
                              </a>
                            )}
                            {subUrl && !piUrl && !disputeUrl && (
                              <a
                                href={subUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1 text-primary hover:underline"
                                title="Open subscription in Stripe"
                              >
                                <ExternalLink className="w-3 h-3 shrink-0" />
                                <span className="truncate max-w-[180px]">{row.stripeSubscriptionId}</span>
                              </a>
                            )}
                            {!piUrl && !disputeUrl && !subUrl && (
                              <span className="text-muted-foreground italic">—</span>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {data && data.total > 0 && (
            <div className="flex items-center justify-between px-3 py-2 border-t border-border bg-muted/20 text-xs">
              <span className="text-muted-foreground">
                Page {data.page} of {totalPages} · {data.total.toLocaleString()} total
                {!liveMode && (
                  <span className="ml-2 text-blue-400">(Stripe links open in TEST mode)</span>
                )}
              </span>
              <div className="flex items-center gap-1">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 px-2"
                  disabled={page <= 1 || loading}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                >
                  <ChevronLeft className="w-3.5 h-3.5" />
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 px-2"
                  disabled={page >= totalPages || loading}
                  onClick={() => setPage((p) => p + 1)}
                >
                  <ChevronRight className="w-3.5 h-3.5" />
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </AdminLayout>
  );
}
