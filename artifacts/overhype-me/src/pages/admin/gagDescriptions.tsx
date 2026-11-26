/**
 * The gag descriptions still to review (plan PLAN_PHASE7_AI_PICTURE_FLOW.md):
 * every gag members can pick whose published content has no approved
 * one-line description, with its drafting state. The backfill's review is
 * done when this list is empty. Each row opens the fact's sheet, where the
 * description is edited and approved on the gag.
 */
import { useCallback, useEffect, useState } from "react";
import { Link } from "wouter";
import { Loader2, RefreshCw } from "lucide-react";
import { AdminLayout } from "@/components/admin/AdminLayout";
import { descriptionReviewApi, type DescriptionToReview } from "@/components/admin/gags/gagApi";

function stateWords(item: DescriptionToReview): string {
  const d = item.description;
  if (d.drafting === "drafting") return "Drafting…";
  if (d.drafting === "failed") return `Drafting failed${d.lastError ? `: ${d.lastError}` : ""}. Write one.`;
  return "Drafted, waiting for review";
}

export default function AdminGagDescriptions() {
  const [items, setItems] = useState<DescriptionToReview[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const load = useCallback(async () => {
    setLoading(true);
    const r = await descriptionReviewApi.list();
    setLoading(false);
    if (r.ok) { setItems(r.data.items); setError(null); } else setError(r.error);
  }, []);
  useEffect(() => { void load(); }, [load]);

  return (
    <AdminLayout title="Gag descriptions">
      <div className="space-y-4" data-testid="gag-descriptions-page">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <p className="text-sm text-muted-foreground" data-testid="gag-descriptions-count">
            {items == null
              ? "Loading…"
              : items.length === 0
                ? "Every gag members can pick has an approved description."
                : `${items.length} gag${items.length === 1 ? "" : "s"} members can pick ${items.length === 1 ? "needs" : "need"} a description approved.`}
          </p>
          <button type="button" onClick={() => void load()} disabled={loading} data-testid="gag-descriptions-reload"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm border border-border rounded-sm hover:bg-muted disabled:opacity-40">
            {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />} Refresh
          </button>
        </div>
        {error && <p className="text-sm text-destructive" data-testid="gag-descriptions-error">{error} <button type="button" className="underline" onClick={() => void load()}>Try again</button></p>}
        {items && items.length > 0 && (
          <ul className="divide-y divide-border rounded-sm border border-border">
            {items.map((item) => (
              <li key={item.gagId} className="p-3 space-y-1" data-testid="gag-description-item">
                <p className="text-sm text-foreground">
                  <Link href={`/admin/facts?focus=${item.factId}`} className="underline">Fact {item.factId}</Link>, visual gag {item.slot}
                </p>
                <p className="text-xs text-muted-foreground line-clamp-2">{item.factText}</p>
                {item.description.text && <p className="text-sm italic text-foreground">&ldquo;{item.description.text}&rdquo;</p>}
                <p className={`text-xs ${item.description.drafting === "failed" ? "text-destructive" : "text-muted-foreground"}`}>{stateWords(item)}</p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </AdminLayout>
  );
}
