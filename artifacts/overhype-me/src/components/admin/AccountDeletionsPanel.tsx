/**
 * @purpose The admin deletion panel on Admin Users (launch Phase 5, plan *Admin/User UX Impact*): every account deletion in progress with who asked, its stage, its purge date, a hold reason and the last error with its attempt count — a stuck purge first — and every kept account whose billing clean-up is unfinished; an admin can keep an account on its owner's behalf or purge it now (which also retries a purge that failed part-way).
 * @subsystem accounts-auth
 */
import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Loader2, RefreshCw, Trash2, UserX } from "lucide-react";

export interface AdminDeletionRequest {
  userId: string;
  email: string | null;
  displayName: string | null;
  requestedBy: "self" | "admin" | "unonboarded";
  requestedAt: string;
  purgeAfter: string;
  stage: "accepted" | "subscription_cancelled" | "notified" | "held" | "purging" | "done";
  stageUpdatedAt: string;
  holdReason: string | null;
  lastError: string | null;
  attempts: number;
  keptWithBillingUnsettled: boolean;
}

export const STAGE_LABEL: Record<AdminDeletionRequest["stage"], string> = {
  accepted: "Cancelling subscriptions",
  subscription_cancelled: "Emailing the member",
  notified: "Waiting out the 14 days",
  held: "Held",
  purging: "Purging",
  done: "Done",
};

export const REQUESTER_LABEL: Record<AdminDeletionRequest["requestedBy"], string> = {
  self: "The member asked",
  admin: "An admin deleted it",
  unonboarded: "Sign-up never finished",
};

function when(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

type Busy = { userId: string; action: "keep" | "purge" } | null;

export function AccountDeletionsPanel() {
  const [rows, setRows] = useState<AdminDeletionRequest[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<Busy>(null);
  const [confirmPurge, setConfirmPurge] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ userId: string; text: string; tone: "ok" | "error" } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    try {
      const res = await fetch("/api/admin/account-deletions", { credentials: "include", cache: "no-store" });
      if (!res.ok) { setLoadError("Couldn't load account deletions."); return; }
      setRows(((await res.json()) as { requests: AdminDeletionRequest[] }).requests);
    } catch {
      setLoadError("Network error loading account deletions.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function keep(userId: string) {
    setBusy({ userId, action: "keep" });
    setNotice(null);
    try {
      const res = await fetch(`/api/admin/users/${encodeURIComponent(userId)}/deletion/cancel`, { method: "POST", credentials: "include" });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      setNotice(res.ok
        ? { userId, text: "Kept. The member has been emailed.", tone: "ok" }
        : { userId, text: data.error ?? "Couldn't keep this account.", tone: "error" });
      await load();
    } finally {
      setBusy(null);
    }
  }

  async function purge(userId: string) {
    setConfirmPurge(null);
    setBusy({ userId, action: "purge" });
    setNotice(null);
    try {
      const res = await fetch(`/api/admin/users/${encodeURIComponent(userId)}?hard=true`, { method: "DELETE", credentials: "include" });
      const data = (await res.json().catch(() => ({}))) as { deleted?: boolean; message?: string; error?: string; stage?: string };
      if (res.ok && data.deleted) setNotice({ userId, text: "Purged.", tone: "ok" });
      else if (res.ok) setNotice({ userId, text: data.message ?? "Not finished yet; the hourly job completes it.", tone: "error" });
      else setNotice({ userId, text: `${data.error ?? "Purge failed"}${data.stage ? ` (stopped at: ${STAGE_LABEL[data.stage as AdminDeletionRequest["stage"]] ?? data.stage})` : ""}. The hourly job retries it.`, tone: "error" });
      await load();
    } finally {
      setBusy(null);
    }
  }

  const stuckCount = rows?.filter((r) => r.lastError).length ?? 0;

  return (
    <div className="mt-8 bg-card border border-border rounded-lg overflow-hidden">
      <div className="px-5 py-4 border-b border-border flex items-center gap-3 flex-wrap">
        <UserX className="w-4 h-4 text-destructive shrink-0" />
        <h2 className="font-display font-bold uppercase tracking-wide text-sm text-foreground">Account deletions</h2>
        <span className="text-xs text-muted-foreground">
          {rows === null ? "" : rows.length === 0 ? "— none in progress" : `— ${rows.length} in progress${stuckCount ? `, ${stuckCount} with an error` : ""}`}
        </span>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} /> Refresh
        </button>
      </div>

      {loadError && <p className="px-5 py-3 text-sm text-destructive" role="alert">{loadError}</p>}
      {rows === null && !loadError && (
        <div className="px-5 py-6 flex justify-center"><Loader2 className="w-4 h-4 animate-spin text-muted-foreground" aria-label="Loading account deletions" /></div>
      )}

      {rows && rows.length > 0 && (
        <div className="divide-y divide-border">
          {rows.map((r) => {
            const rowBusy = busy?.userId === r.userId;
            const canKeep = !r.keptWithBillingUnsettled && r.stage !== "purging";
            const canPurge = !r.keptWithBillingUnsettled;
            return (
              <div key={r.userId} className="px-5 py-3 space-y-2">
                <div className="flex items-start gap-4 flex-wrap">
                  <div className="flex-1 min-w-[14rem]">
                    <p className="text-sm font-medium text-foreground truncate">{r.displayName ?? r.email ?? `${r.userId.slice(0, 12)}…`}</p>
                    {r.email && r.displayName && <p className="text-xs text-muted-foreground truncate">{r.email}</p>}
                    <p className="text-xs text-muted-foreground mt-1">
                      {r.keptWithBillingUnsettled
                        ? "Kept by the member. Billing clean-up unfinished: a cancelled subscription has not been refreshed yet; the hourly job retries it."
                        : <>{REQUESTER_LABEL[r.requestedBy]} · <span className="text-foreground">{STAGE_LABEL[r.stage]}</span> · purge {when(r.purgeAfter)}</>}
                    </p>
                    {r.holdReason && <p className="text-xs text-amber-500 mt-1">Held: {r.holdReason}</p>}
                    {r.lastError && (
                      <p className="text-xs text-destructive mt-1 flex items-start gap-1.5">
                        <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                        <span>
                          Last error, after {r.attempts} {r.attempts === 1 ? "attempt" : "attempts"} (in this stage since {when(r.stageUpdatedAt)}):{" "}
                          <span className="font-mono">{r.lastError}</span>
                        </span>
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {canKeep && (
                      <button
                        type="button"
                        onClick={() => void keep(r.userId)}
                        disabled={rowBusy}
                        className="px-3 py-1.5 rounded-sm border border-border text-xs font-medium text-foreground hover:border-muted-foreground/50 disabled:opacity-50"
                      >
                        {rowBusy && busy?.action === "keep" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Keep account"}
                      </button>
                    )}
                    {canPurge && confirmPurge !== r.userId && (
                      <button
                        type="button"
                        onClick={() => setConfirmPurge(r.userId)}
                        disabled={rowBusy}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-sm border border-destructive/60 text-xs font-medium text-destructive hover:bg-destructive/10 disabled:opacity-50"
                      >
                        {rowBusy && busy?.action === "purge" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <><Trash2 className="w-3.5 h-3.5" /> {r.lastError && r.stage === "purging" ? "Retry purge" : "Purge now"}</>}
                      </button>
                    )}
                  </div>
                </div>
                {confirmPurge === r.userId && (
                  <div className="flex items-center gap-2 flex-wrap border border-destructive/40 rounded-sm px-3 py-2">
                    <p className="text-xs text-foreground flex-1 min-w-[12rem]">Purge this account now? Its memes, photos, images, comments and reactions are removed for good.</p>
                    <button type="button" onClick={() => void purge(r.userId)} className="px-3 py-1.5 rounded-sm bg-destructive text-destructive-foreground text-xs font-bold">Purge</button>
                    <button type="button" onClick={() => setConfirmPurge(null)} className="px-3 py-1.5 rounded-sm border border-border text-xs">Cancel</button>
                  </div>
                )}
                {notice?.userId === r.userId && (
                  <p className={`text-xs ${notice.tone === "ok" ? "text-green-400" : "text-destructive"}`} role="status">{notice.text}</p>
                )}
              </div>
            );
          })}
        </div>
      )}
      {notice && rows && !rows.some((r) => r.userId === notice.userId) && (
        <p className={`px-5 py-3 text-xs ${notice.tone === "ok" ? "text-green-400" : "text-destructive"}`} role="status">{notice.text}</p>
      )}
    </div>
  );
}
