/**
 * @purpose An account's credits on the admin Users page (launch Phase 7, plan PLAN_PHASE7_IMAGE_OFFERING.md §1): the balance, the ledger newest first, and an adjustment with a required note. The server decides; this only shows what it said.
 * @subsystem membership
 */
import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Textarea } from "@/components/ui/textarea";

export interface CreditEntry {
  id: number;
  kind: string;
  credits: number;
  lotId: number | null;
  note: string | null;
  actorLabel: string | null;
  createdAt: string;
}

const KIND_LABEL: Record<string, string> = {
  free_grant: "Free credit (account verified)",
  admin_grant: "Added by an admin",
  admin_debit: "Removed by an admin",
};

function creditKindLabel(kind: string): string {
  return KIND_LABEL[kind] ?? kind;
}

/** The server's `ADMIN_ADJUSTMENT_NOTE_MAX`; the server enforces it, this only stops typing past it. */
const NOTE_MAX = 1000;

function newRequestId(): string {
  return globalThis.crypto.randomUUID();
}

export function UserCredits({ userId }: { userId: string }) {
  const [data, setData] = useState<{ balance: number; entries: CreditEntry[] } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  // One id per intended adjustment, kept across a retry so the server applies it once.
  const [requestId, setRequestId] = useState(newRequestId);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<{ type: "success" | "error"; message: string } | null>(null);

  async function load(signal?: AbortSignal) {
    setLoadError(null);
    try {
      const res = await fetch(`/api/admin/users/${userId}/credits`, { credentials: "include", signal });
      const body = (await res.json()) as { balance?: number; entries?: CreditEntry[]; error?: string };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setData({ balance: body.balance ?? 0, entries: body.entries ?? [] });
    } catch (err) {
      if (signal?.aborted) return;
      setLoadError(err instanceof Error ? err.message : "Could not load credits");
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    setData(null);
    setResult(null);
    void load(controller.signal);
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  const credits = Number(amount);
  const canSubmit = Number.isInteger(credits) && credits !== 0 && note.trim() !== "" && !saving;

  async function submit() {
    if (!canSubmit) return;
    setSaving(true);
    setResult(null);
    try {
      const res = await fetch(`/api/admin/users/${userId}/credits`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ credits, note: note.trim(), requestId }),
      });
      const body = (await res.json()) as { applied?: boolean; balance?: number; error?: string };
      if (!res.ok) throw new Error(body.error ?? "The adjustment could not be saved.");
      setResult({
        type: "success",
        message: body.applied ? `Saved. The balance is now ${body.balance}.` : `Already saved. The balance is ${body.balance}.`,
      });
      setAmount("");
      setNote("");
      setRequestId(newRequestId());
      await load();
    } catch (err) {
      setResult({ type: "error", message: err instanceof Error ? err.message : "The adjustment could not be saved." });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-3" data-testid="admin-user-credits">
      {loadError ? (
        <p className="text-sm text-destructive">Credits could not be loaded: {loadError}</p>
      ) : !data ? (
        <p className="text-sm text-muted-foreground flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Loading credits…</p>
      ) : (
        <>
          <p className="text-sm">
            Balance: <span className="font-bold" data-testid="admin-user-credits-balance">{data.balance}</span> {data.balance === 1 ? "credit" : "credits"}
          </p>
          {data.entries.length === 0 ? (
            <p className="text-sm text-muted-foreground">No credits yet. The free credit arrives when the email is verified.</p>
          ) : (
            <ul className="text-xs divide-y divide-border border border-border rounded-sm max-h-48 overflow-y-auto">
              {data.entries.map((e) => (
                <li key={e.id} className="px-2 py-1.5 flex flex-wrap gap-x-3">
                  <span className="text-muted-foreground">{new Date(e.createdAt).toLocaleString()}</span>
                  <span className={e.credits > 0 ? "text-green-500 font-bold" : "text-destructive font-bold"}>{e.credits > 0 ? `+${e.credits}` : e.credits}</span>
                  <span>{creditKindLabel(e.kind)}</span>
                  {e.actorLabel && <span className="text-muted-foreground">by {e.actorLabel}</span>}
                  {e.note && <span className="w-full text-muted-foreground">“{e.note}”</span>}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      <div className="grid gap-2">
        <Input
          type="number"
          step={1}
          value={amount}
          onChange={(ev) => setAmount(ev.target.value)}
          placeholder="Credits to add, or a minus number to remove"
          aria-label="Credits to add or remove"
        />
        <Textarea
          value={note}
          onChange={(ev) => setNote(ev.target.value)}
          placeholder="Why (required; kept on the ledger)"
          aria-label="Why this adjustment is made"
          rows={2}
          maxLength={NOTE_MAX}
        />
        <Button type="button" onClick={() => void submit()} disabled={!canSubmit}>
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : null} Adjust credits
        </Button>
        {result && (
          <p className={result.type === "success" ? "text-sm text-green-500" : "text-sm text-destructive"} role="status">{result.message}</p>
        )}
      </div>
    </div>
  );
}
