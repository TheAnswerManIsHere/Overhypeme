import { useCallback, useEffect, useMemo, useState } from "react";
import { AdminLayout } from "@/components/admin/AdminLayout";
import { Button } from "@/components/ui/Button";
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  Inbox,
  Loader2,
  RefreshCw,
  RotateCcw,
  Trash2,
  X,
} from "lucide-react";

type OutboxStatus = "pending" | "sending" | "delivered" | "abandoned";

interface EmailQueueRow {
  id: number;
  to: string;
  subject: string;
  text: string;
  html: string | null;
  kind: string | null;
  status: string;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  nextAttemptAt: string;
  createdAt: string;
  updatedAt: string;
}

interface ApiResponse {
  rows: EmailQueueRow[];
  total: number;
  page: number;
  limit: number;
  validStatuses: OutboxStatus[];
}

const PAGE_SIZE = 50;

const STATUS_OPTIONS: { value: "" | OutboxStatus; label: string }[] = [
  { value: "", label: "All" },
  { value: "pending", label: "Pending" },
  { value: "sending", label: "Sending" },
  { value: "delivered", label: "Delivered" },
  { value: "abandoned", label: "Abandoned" },
];

function statusBadgeClass(status: string): string {
  switch (status) {
    case "pending":
      return "bg-blue-500/15 text-blue-500 dark:text-blue-400 border-blue-500/30";
    case "sending":
      return "bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30";
    case "delivered":
      return "bg-green-500/15 text-green-600 dark:text-green-400 border-green-500/30";
    case "abandoned":
      return "bg-red-500/15 text-red-500 border-red-500/30";
    default:
      return "bg-muted text-muted-foreground border-border";
  }
}

function formatRelative(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (isNaN(date.getTime())) return "—";
  const now = Date.now();
  const diffMs = now - date.getTime();
  const diffSecs = Math.floor(diffMs / 1000);
  const diffMins = Math.floor(diffSecs / 60);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);
  if (Math.abs(diffSecs) < 60) return "just now";
  if (Math.abs(diffMins) < 60) return `${diffMins}m ago`;
  if (Math.abs(diffHours) < 24) return `${diffHours}h ago`;
  if (Math.abs(diffDays) === 1) return diffDays > 0 ? "yesterday" : "tomorrow";
  if (Math.abs(diffDays) < 7) return diffDays > 0 ? `${diffDays}d ago` : `in ${-diffDays}d`;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function formatFull(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (isNaN(date.getTime())) return "—";
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

interface DetailField {
  label: string;
  value: React.ReactNode;
}

function DetailRow({ label, value }: DetailField) {
  return (
    <div className="grid grid-cols-[120px_1fr] gap-x-3 gap-y-0.5 items-start">
      <span className="text-xs font-medium text-muted-foreground pt-0.5">{label}</span>
      <span className="text-xs text-foreground break-all">{value}</span>
    </div>
  );
}

interface EmailDetailModalProps {
  row: EmailQueueRow;
  onClose: () => void;
  onRetry: (id: number) => Promise<void>;
  retrying: boolean;
  retryError: string | null;
}

function EmailDetailModal({ row, onClose, onRetry, retrying, retryError }: EmailDetailModalProps) {
  const [bodyTab, setBodyTab] = useState<"text" | "html">("text");

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4"
      onClick={onClose}
    >
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
      <div
        className="relative z-10 w-full max-w-2xl max-h-[90vh] flex flex-col bg-card border border-border rounded-xl shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-border shrink-0">
          <h2 className="text-sm font-semibold text-foreground">Email Detail #{row.id}</h2>
          <button
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground transition-colors rounded p-0.5"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="overflow-y-auto flex-1 px-5 py-4 space-y-4">
          <div className="space-y-2">
            <DetailRow label="Recipient" value={<span className="font-mono">{row.to}</span>} />
            <DetailRow label="Subject" value={row.subject} />
            <DetailRow label="Kind" value={row.kind ?? "—"} />
            <DetailRow
              label="Status"
              value={
                <span
                  className={`inline-flex items-center px-2 py-0.5 text-xs font-semibold rounded-full border ${statusBadgeClass(row.status)}`}
                >
                  {row.status}
                </span>
              }
            />
            <DetailRow
              label="Attempts"
              value={`${row.attempts} of ${row.maxAttempts}`}
            />
            {row.lastError && (
              <DetailRow
                label="Last Error"
                value={
                  <span className="font-mono text-red-400 whitespace-pre-wrap">{row.lastError}</span>
                }
              />
            )}
            <DetailRow label="Created" value={formatFull(row.createdAt)} />
            <DetailRow label="Updated" value={formatFull(row.updatedAt)} />
            {row.status !== "delivered" && row.status !== "abandoned" && (
              <DetailRow label="Next Attempt" value={formatFull(row.nextAttemptAt)} />
            )}
          </div>

          <div className="border-t border-border pt-4">
            <div className="flex items-center gap-1 mb-3">
              <button
                onClick={() => setBodyTab("text")}
                className={`px-2.5 py-1 text-xs font-medium rounded-sm border transition-colors ${
                  bodyTab === "text"
                    ? "bg-primary text-primary-foreground border-primary"
                    : "bg-muted text-muted-foreground border-border hover:bg-muted/80"
                }`}
              >
                Plain Text
              </button>
              {row.html && (
                <button
                  onClick={() => setBodyTab("html")}
                  className={`px-2.5 py-1 text-xs font-medium rounded-sm border transition-colors ${
                    bodyTab === "html"
                      ? "bg-primary text-primary-foreground border-primary"
                      : "bg-muted text-muted-foreground border-border hover:bg-muted/80"
                  }`}
                >
                  HTML
                </button>
              )}
            </div>

            {bodyTab === "text" && (
              <pre className="text-xs text-foreground font-mono whitespace-pre-wrap break-words bg-muted/40 rounded-lg p-3 max-h-64 overflow-y-auto border border-border">
                {row.text || "—"}
              </pre>
            )}

            {bodyTab === "html" && row.html && (
              <pre className="text-xs text-foreground font-mono whitespace-pre-wrap break-words bg-muted/40 rounded-lg p-3 max-h-64 overflow-y-auto border border-border">
                {row.html}
              </pre>
            )}
          </div>
        </div>

        {row.status === "abandoned" && (
          <div className="px-5 py-3 border-t border-border shrink-0 flex items-center gap-3">
            <Button
              variant="outline"
              size="sm"
              className="h-8 px-3 text-xs gap-1.5"
              disabled={retrying}
              onClick={() => void onRetry(row.id)}
            >
              {retrying ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <RotateCcw className="w-3.5 h-3.5" />
              )}
              Retry
            </Button>
            {retryError && (
              <span className="text-xs text-red-400">{retryError}</span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default function AdminEmailQueue() {
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState<"" | OutboxStatus>("");
  const [retrying, setRetrying] = useState<Set<number>>(new Set());
  const [retryErrors, setRetryErrors] = useState<Record<number, string>>({});
  const [clearing, setClearing] = useState<"delivered" | "abandoned" | null>(null);
  const [clearError, setClearError] = useState<string | null>(null);
  const [loadKey, setLoadKey] = useState(0);
  const [selectedRow, setSelectedRow] = useState<EmailQueueRow | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const params = new URLSearchParams();
    params.set("page", String(page));
    params.set("limit", String(PAGE_SIZE));
    if (statusFilter) params.set("status", statusFilter);
    try {
      const res = await fetch(`/api/admin/email-queue?${params.toString()}`, {
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
      setSelectedRow((prev) => {
        if (!prev) return null;
        const updated = json.rows.find((r) => r.id === prev.id);
        return updated ?? prev;
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [page, statusFilter, loadKey]);

  useEffect(() => {
    void load();
  }, [load]);

  const totalPages = useMemo(() => {
    if (!data) return 1;
    return Math.max(1, Math.ceil(data.total / data.limit));
  }, [data]);

  function changeFilter(value: "" | OutboxStatus) {
    setStatusFilter(value);
    setPage(1);
  }

  async function handleRetry(id: number) {
    setRetrying((prev) => new Set(prev).add(id));
    setRetryErrors((prev) => { const next = { ...prev }; delete next[id]; return next; });
    try {
      const res = await fetch(`/api/admin/email-queue/${id}/retry`, {
        method: "POST",
        credentials: "include",
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error((body as { error?: string }).error ?? `Failed (HTTP ${res.status})`);
      }
      await load();
    } catch (e) {
      setRetryErrors((prev) => ({
        ...prev,
        [id]: e instanceof Error ? e.message : "Retry failed",
      }));
    } finally {
      setRetrying((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }

  async function handleClear(status: "delivered" | "abandoned") {
    const label = status === "delivered" ? "delivered" : "abandoned";
    const confirmed = window.confirm(
      `Delete all ${label} emails from the queue? This cannot be undone.`
    );
    if (!confirmed) return;
    setClearing(status);
    setClearError(null);
    try {
      const res = await fetch(`/api/admin/email-queue?status=${status}`, {
        method: "DELETE",
        credentials: "include",
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error((body as { error?: string }).error ?? `Failed (HTTP ${res.status})`);
      }
      setPage(1);
      setLoadKey((k) => k + 1);
    } catch (e) {
      setClearError(e instanceof Error ? e.message : "Clear failed");
    } finally {
      setClearing(null);
    }
  }

  const rows = data?.rows ?? [];

  return (
    <AdminLayout title="Email Queue">
      <div className="space-y-4">
        <div className="bg-card border border-border rounded-lg p-4 flex flex-wrap items-center gap-2">
          {STATUS_OPTIONS.map((opt) => {
            const active = statusFilter === opt.value;
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
          <Button
            variant="outline"
            size="sm"
            className="h-8 px-3 text-xs gap-1 text-green-600 dark:text-green-400 border-green-500/40 hover:bg-green-500/10"
            onClick={() => void handleClear("delivered")}
            disabled={clearing !== null || loading}
            title="Delete all delivered emails"
          >
            {clearing === "delivered" ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Trash2 className="w-3.5 h-3.5" />
            )}
            Clear delivered
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-8 px-3 text-xs gap-1 text-red-600 dark:text-red-400 border-red-500/40 hover:bg-red-500/10"
            onClick={() => void handleClear("abandoned")}
            disabled={clearing !== null || loading}
            title="Delete all abandoned emails"
          >
            {clearing === "abandoned" ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Trash2 className="w-3.5 h-3.5" />
            )}
            Clear abandoned
          </Button>
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

        {error && (
          <div className="bg-destructive/10 border border-destructive/30 text-destructive rounded-lg p-3 text-sm flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            {error}
          </div>
        )}

        {clearError && (
          <div className="bg-destructive/10 border border-destructive/30 text-destructive rounded-lg p-3 text-sm flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            {clearError}
          </div>
        )}

        <div className="bg-card border border-border rounded-lg overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/40">
                <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  <th className="px-3 py-2.5">Recipient</th>
                  <th className="px-3 py-2.5">Subject</th>
                  <th className="px-3 py-2.5">Kind</th>
                  <th className="px-3 py-2.5">Status</th>
                  <th className="px-3 py-2.5 text-right">Attempts</th>
                  <th className="px-3 py-2.5">Last Error</th>
                  <th className="px-3 py-2.5">Next Attempt</th>
                  <th className="px-3 py-2.5">Created</th>
                  <th className="px-3 py-2.5"></th>
                </tr>
              </thead>
              <tbody>
                {loading && rows.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="px-3 py-10 text-center text-muted-foreground">
                      <Loader2 className="w-4 h-4 animate-spin inline mr-2" />
                      Loading…
                    </td>
                  </tr>
                ) : rows.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="px-3 py-10 text-center text-muted-foreground">
                      <Inbox className="w-5 h-5 mx-auto mb-2 opacity-60" />
                      No email queue entries match the current filter.
                    </td>
                  </tr>
                ) : (
                  rows.map((row) => (
                    <tr
                      key={row.id}
                      className="border-t border-border hover:bg-muted/20 transition-colors align-top cursor-pointer"
                      onClick={() => setSelectedRow(row)}
                    >
                      <td className="px-3 py-2.5 max-w-[200px]">
                        <span className="block truncate text-foreground font-mono text-xs" title={row.to}>
                          {row.to}
                        </span>
                      </td>
                      <td className="px-3 py-2.5 max-w-[220px]">
                        <span className="block truncate text-foreground text-xs" title={row.subject}>
                          {row.subject}
                        </span>
                      </td>
                      <td className="px-3 py-2.5 whitespace-nowrap text-muted-foreground text-xs">
                        {row.kind ?? "—"}
                      </td>
                      <td className="px-3 py-2.5 whitespace-nowrap">
                        <span
                          className={`inline-flex items-center px-2 py-0.5 text-xs font-semibold rounded-full border ${statusBadgeClass(row.status)}`}
                        >
                          {row.status}
                        </span>
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums whitespace-nowrap text-xs text-muted-foreground">
                        {row.attempts} / {row.maxAttempts}
                      </td>
                      <td className="px-3 py-2.5 max-w-[240px]">
                        {row.lastError ? (
                          <span
                            className="block truncate text-xs text-red-400 font-mono"
                            title={row.lastError}
                          >
                            {row.lastError}
                          </span>
                        ) : (
                          <span className="text-muted-foreground text-xs">—</span>
                        )}
                      </td>
                      <td
                        className="px-3 py-2.5 whitespace-nowrap text-xs text-muted-foreground"
                        title={new Date(row.nextAttemptAt).toLocaleString()}
                      >
                        {row.status === "delivered" || row.status === "abandoned"
                          ? "—"
                          : formatRelative(row.nextAttemptAt)}
                      </td>
                      <td
                        className="px-3 py-2.5 whitespace-nowrap text-xs text-muted-foreground"
                        title={new Date(row.createdAt).toLocaleString()}
                      >
                        {formatRelative(row.createdAt)}
                      </td>
                      <td className="px-3 py-2.5 whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                        {row.status === "abandoned" && (
                          <div className="flex flex-col items-end gap-0.5">
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-7 px-2 text-xs gap-1"
                              disabled={retrying.has(row.id)}
                              onClick={() => void handleRetry(row.id)}
                            >
                              {retrying.has(row.id) ? (
                                <Loader2 className="w-3 h-3 animate-spin" />
                              ) : (
                                <RotateCcw className="w-3 h-3" />
                              )}
                              Retry
                            </Button>
                            {retryErrors[row.id] && (
                              <span className="text-[10px] text-red-400">{retryErrors[row.id]}</span>
                            )}
                          </div>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          {data && data.total > 0 && (
            <div className="flex items-center justify-between px-3 py-2 border-t border-border bg-muted/20 text-xs">
              <span className="text-muted-foreground">
                Page {data.page} of {totalPages} · {data.total.toLocaleString()} total
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

      {selectedRow && (
        <EmailDetailModal
          row={selectedRow}
          onClose={() => setSelectedRow(null)}
          onRetry={handleRetry}
          retrying={retrying.has(selectedRow.id)}
          retryError={retryErrors[selectedRow.id] ?? null}
        />
      )}
    </AdminLayout>
  );
}
