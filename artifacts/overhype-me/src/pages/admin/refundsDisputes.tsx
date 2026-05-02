import { useCallback, useEffect, useMemo, useState } from "react";
import { AdminLayout } from "@/components/admin/AdminLayout";
import { ResponsiveTable, type ResponsiveColumn } from "@/components/admin/ResponsiveTable";
import { Button } from "@/components/ui/Button";
import { stripeDashboardUrl } from "@/lib/stripeDashboardUrl";
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

// Bind ResponsiveTable's row type via a TypeScript instantiation expression so
// we don't need inline JSX generics (`<ResponsiveTable<RefundDisputeRow>`) at
// the call site. Inline JSX generics break in dev because
// @replit/vite-plugin-cartographer injects `data-component-name` attributes
// between the component name and the type argument, producing invalid JSX
// that babel rejects with an "Unexpected token" parser error.
const RefundDisputeTable = ResponsiveTable<RefundDisputeRow>;

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
        <RefundDisputeTable
          rows={rows}
          getKey={(row) => row.id}
          loading={loading}
          emptyState={
            <div className="flex flex-col items-center gap-2">
              <ShieldAlert className="w-5 h-5 opacity-60" />
              <span>No refund or dispute events match the current filters.</span>
            </div>
          }
          mobilePrimary={(row) => (
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-foreground truncate">
                  {row.userDisplayName ?? row.userEmail ?? <em className="text-muted-foreground">no name</em>}
                </p>
                <p className="text-xs text-muted-foreground truncate mt-0.5">
                  {row.userEmail ?? row.userId}
                </p>
              </div>
              <span
                className={`shrink-0 inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-semibold rounded-full border ${eventBadgeClass(row.event)}`}
              >
                {row.event === "refund" ? <Undo2 className="w-3 h-3" /> : <ShieldAlert className="w-3 h-3" />}
                {formatEvent(row.event)}
              </span>
            </div>
          )}
          columns={[
            {
              key: "createdAt",
              header: "When",
              className: "whitespace-nowrap text-muted-foreground text-xs",
              cell: (row) => new Date(row.createdAt).toLocaleString(),
              mobileValue: (row) =>
                new Date(row.createdAt).toLocaleString(undefined, {
                  month: "short",
                  day: "numeric",
                  hour: "2-digit",
                  minute: "2-digit",
                }),
            },
            {
              key: "event",
              header: "Event",
              hideOnMobile: true,
              className: "whitespace-nowrap",
              cell: (row) => (
                <span
                  className={`inline-flex items-center gap-1 px-2 py-0.5 text-xs font-semibold rounded-full border ${eventBadgeClass(row.event)}`}
                >
                  {row.event === "refund" ? <Undo2 className="w-3 h-3" /> : <ShieldAlert className="w-3 h-3" />}
                  {formatEvent(row.event)}
                </span>
              ),
            },
            {
              key: "user",
              header: "User",
              hideOnMobile: true,
              cell: (row) => (
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
              ),
            },
            {
              key: "plan",
              header: "Plan",
              className: "text-muted-foreground text-xs whitespace-nowrap",
              cell: (row) => row.plan ?? "—",
              mobileSecondary: true,
            },
            {
              key: "amount",
              header: "Amount",
              className: "text-right tabular-nums whitespace-nowrap",
              cell: (row) => formatAmount(row.amount, row.currency),
            },
            {
              key: "stripe",
              header: "Stripe",
              mobileSecondary: true,
              cell: (row) => {
                const piUrl = row.stripePaymentIntentId
                  ? stripeDashboardUrl("payments", row.stripePaymentIntentId, { liveMode })
                  : null;
                const disputeUrl = row.stripeDisputeId
                  ? stripeDashboardUrl("disputes", row.stripeDisputeId, { liveMode })
                  : null;
                const subUrl = row.stripeSubscriptionId
                  ? stripeDashboardUrl("subscriptions", row.stripeSubscriptionId, { liveMode })
                  : null;
                return (
                  <div className="flex flex-col gap-0.5 text-xs font-mono">
                    {disputeUrl && (
                      <a
                        href={disputeUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-primary hover:underline min-h-[32px]"
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
                        className="inline-flex items-center gap-1 text-primary hover:underline min-h-[32px]"
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
                        className="inline-flex items-center gap-1 text-primary hover:underline min-h-[32px]"
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
                );
              },
            },
          ] satisfies ResponsiveColumn<RefundDisputeRow>[]}
          footer={
            data && data.total > 0 ? (
              <div className="flex items-center justify-between gap-2 px-3 py-2 border-t border-border bg-muted/20 text-xs flex-wrap">
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
                    className="h-8 min-w-[40px] px-2"
                    disabled={page <= 1 || loading}
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                  >
                    <ChevronLeft className="w-3.5 h-3.5" />
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 min-w-[40px] px-2"
                    disabled={page >= totalPages || loading}
                    onClick={() => setPage((p) => p + 1)}
                  >
                    <ChevronRight className="w-3.5 h-3.5" />
                  </Button>
                </div>
              </div>
            ) : null
          }
        />
      </div>
    </AdminLayout>
  );
}
