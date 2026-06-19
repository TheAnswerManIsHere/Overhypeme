import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AdminLayout } from "@/components/admin/AdminLayout";
import { RuntimePromptPreview } from "@/components/admin/RuntimePromptPreview";
import { Button } from "@/components/ui/Button";
import { Textarea, Input } from "@/components/ui/Input";
import { Trash2, Upload, Search, AlertCircle, CheckCircle, Pencil, X, Save, GitBranch, Plus, Brain, EyeOff, Eye, RefreshCw, ImageIcon, Loader2, Sparkles } from "lucide-react";
import type { FactEnrichment } from "@workspace/api-zod";
import { EnrichmentEditor } from "@/components/admin/EnrichmentEditor";
import { useEnrichmentJobs } from "@/components/admin/useEnrichmentJobs";
import { useDraftForm } from "@/components/admin/useDraftForm";

/** Server response from the enrichment PATCH, including re-synced projection columns. */
interface EnrichmentSaveResponse {
  enrichment: FactEnrichment;
  projection?: {
    primaryArchetype: string;
    subtype: string;
    overhypeFit: string;
    adultSuitability: string;
  };
}

/** The slice of a fact's detail record consumed by the enrichment editor. */
interface FactServerRecord {
  enrichment?: FactEnrichment | null;
  enrichmentStatus?: string | null;
}

const USE_CASE_SUGGESTIONS = ["default", "one_line", "two_line", "short", "long", "meme_caption", "shirt_print", "social_media", "title_case"];

interface Fact {
  id: number;
  text: string;
  canonicalText: string | null;
  parentId: number | null;
  useCase: string | null;
  isActive: boolean;
  hasEmbedding: boolean;
  hasPexelsImages: boolean;
  upvotes: number;
  downvotes: number;
  score: number;
  wilsonScore: number;
  commentCount: number;
  shareCount: number;
  submittedById: string | null;
  splitTokenIndex: number | null;
  createdAt: string;
  updatedAt: string;
  // Visual-taxonomy enrichment projections (present from the list query; the
  // full blob is loaded on demand by the enrichment editor).
  primaryArchetype?: string | null;
  enrichmentStatus?: string | null;
  hasEnrichment?: boolean;
}

interface FactVariant {
  id: number;
  text: string;
  useCase: string | null;
  createdAt: string;
}

interface FactsResponse {
  facts: Fact[];
  total: number;
  page: number;
  limit: number;
}

type ImportMode = "json" | "csv" | "lines";

type EditDraft = Omit<Fact, "id" | "createdAt" | "updatedAt" | "hasEmbedding" | "hasPexelsImages" | "splitTokenIndex">;

/** Blank baseline used by the edit form while no fact is selected. */
const EMPTY_EDIT_DRAFT: EditDraft = {
  text: "",
  canonicalText: null,
  parentId: null,
  useCase: null,
  isActive: true,
  upvotes: 0,
  downvotes: 0,
  score: 0,
  wilsonScore: 0,
  commentCount: 0,
  shareCount: 0,
  submittedById: "",
};

/** Project a fact (the server source of truth) into the editable form value. */
function factToEditDraft(fact: Fact): EditDraft {
  return {
    text: fact.text,
    canonicalText: fact.canonicalText ?? null,
    parentId: fact.parentId ?? null,
    useCase: fact.useCase ?? null,
    isActive: fact.isActive,
    upvotes: fact.upvotes,
    downvotes: fact.downvotes,
    score: fact.score,
    wilsonScore: fact.wilsonScore ?? 0,
    commentCount: fact.commentCount ?? 0,
    shareCount: fact.shareCount ?? 0,
    submittedById: fact.submittedById ?? "",
  };
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <label className="block text-xs font-bold uppercase tracking-wider text-muted-foreground mb-1">
      {children}
    </label>
  );
}

function ReadOnlyField({ label, value }: { label: string; value: string | number }) {
  return (
    <div>
      <FieldLabel>{label}</FieldLabel>
      <div className="h-9 px-3 flex items-center bg-muted/40 border border-border rounded-sm text-sm text-muted-foreground font-mono select-all">
        {value}
      </div>
    </div>
  );
}

/**
 * The shared Visual Taxonomy Enrichment editor, surfaced on a live fact. Uses the
 * SAME universal autosave helper (`useFormDraft`) as every other form, plus the
 * shared `useEnrichmentJobs` for the enrichment-specific ACTIONS (re-run, preview,
 * polling). Keyed by fact id at the call site so it resets cleanly between facts.
 *
 * Unlike the moderation review form (which stores drafts as-is), a live fact is
 * validated server-side on save and its projection columns re-synced — so an
 * invalid edit surfaces here as a save error rather than being stored.
 */
function FactEnrichmentPanel({ fact, onSaved }: { fact: Fact; onSaved: (resp: EnrichmentSaveResponse) => void }) {
  const [enrichmentStatus, setEnrichmentStatus] = useState<string | null>(fact.enrichmentStatus ?? null);

  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;

  // Local-draft model: edits autosave to localStorage; an explicit Save commits to
  // the server (validated + projections re-synced) and becomes the new baseline;
  // Discard reverts to the server source of truth. Keyed by fact id at the call
  // site so the draft resets cleanly between facts.
  const draft = useDraftForm<FactEnrichment | null, FactServerRecord>({
    storageKey: `fact-enrichment-draft::${fact.id}`,
    emptyValue: null,
    debounceMs: 1500,
    fetchServer: async () => {
      const r = await fetch(`/api/admin/facts/${fact.id}`, { credentials: "include" });
      if (!r.ok) return null;
      return (await r.json()) as FactServerRecord;
    },
    selectValue: (rec) => rec.enrichment ?? null,
    onServerRecord: (rec) => setEnrichmentStatus(rec?.enrichmentStatus ?? null),
    commit: async (toSave) => {
      if (!toSave) throw new Error("Nothing to save.");
      let r: Response;
      try {
        r = await fetch(`/api/admin/facts/${fact.id}/enrichment`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ enrichment: toSave }),
        });
      } catch {
        throw new Error("Network error — could not save.");
      }
      if (!r.ok) {
        let msg = r.status === 503 ? "API unavailable — try again shortly." : `Save failed (${r.status}).`;
        try { const b = (await r.json()) as { error?: string }; if (b?.error) msg = b.error; } catch { /* generic */ }
        throw new Error(msg);
      }
      try {
        const body = (await r.json()) as EnrichmentSaveResponse;
        if (body?.enrichment) onSavedRef.current?.(body);
      } catch {
        /* response body is best-effort; the save itself succeeded */
      }
    },
  });

  const enrichment = draft.value;

  const jobs = useEnrichmentJobs({
    resource: "facts",
    id: fact.id,
    status: enrichmentStatus,
    isDirty: () => draft.hasUncommittedChanges,
    // A background re-run rewrites the enrichment server-side; fold it into BOTH
    // value and baseline so it becomes the new source of truth.
    applyServerState: (e, s) => { draft.adoptServerSlice(() => e); setEnrichmentStatus(s); },
  });

  // Re-running classification overwrites possibly admin-tuned metadata on a live
  // fact, so confirm first when enrichment already exists.
  async function handleRerun() {
    if (
      enrichment &&
      !window.confirm(
        "Re-running classification will overwrite the current, possibly admin-tuned, enrichment for this fact. Continue?",
      )
    ) {
      return;
    }
    await jobs.onRerun();
  }

  const busy = draft.loading || draft.committing || jobs.loading || jobs.rerunBusy;

  return (
    <div className="space-y-2">
      {/* Pinned header bar with draft status */}
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-display font-bold text-foreground uppercase tracking-wide text-sm flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-primary" />
          Visual Taxonomy Enrichment
        </h3>
        <div className="flex items-center gap-3 shrink-0">
          <div className="text-xs text-muted-foreground">
            {draft.committing ? (
              <span className="flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" />Saving to server…</span>
            ) : draft.commitError ? (
              <span className="text-destructive">{draft.commitError}</span>
            ) : draft.hasUncommittedChanges ? (
              <span>{draft.draftLabel || "Unsaved changes"}</span>
            ) : draft.committedAt ? (
              <span className="text-green-600 dark:text-green-400">Saved to server</span>
            ) : null}
          </div>
          {draft.hasUncommittedChanges && (
            <button
              type="button"
              onClick={draft.discard}
              className="text-xs text-primary underline hover:opacity-80"
            >
              Discard changes
            </button>
          )}
        </div>
      </div>

      {draft.loading && !enrichment && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="w-3 h-3 animate-spin" /> Loading enrichment…
        </div>
      )}
      <EnrichmentEditor
        value={enrichment}
        status={enrichmentStatus}
        factText={fact.text}
        onChange={(next) => draft.setValue(next)}
        onSave={draft.hasUncommittedChanges ? () => void draft.save() : undefined}
        onRerun={handleRerun}
        busy={busy}
        rerunBusy={jobs.rerunBusy}
      />
      <div className="flex items-center justify-end gap-3 min-h-[1.75rem]">
        <Button
          variant="outline"
          size="sm"
          onClick={draft.discard}
          disabled={!draft.hasUncommittedChanges || draft.committing}
        >
          Discard changes
        </Button>
      </div>
      {jobs.error && (
        <div className="flex items-start gap-2 rounded-sm border border-destructive/50 bg-destructive/10 px-3 py-2">
          <AlertCircle className="w-4 h-4 text-destructive shrink-0 mt-0.5" />
          <p className="text-sm text-destructive">{jobs.error}</p>
        </div>
      )}
    </div>
  );
}

export default function AdminFacts() {
  const [facts, setFacts] = useState<Fact[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [showInactive, setShowInactive] = useState(false);

  const [selectedFact, setSelectedFact] = useState<Fact | null>(null);
  const selectedFactRef = useRef<Fact | null>(null);
  selectedFactRef.current = selectedFact;
  const [variants, setVariants] = useState<FactVariant[]>([]);
  const [loadingVariants, setLoadingVariants] = useState(false);
  const [newVariantText, setNewVariantText] = useState("");
  const [newVariantUseCase, setNewVariantUseCase] = useState("");
  const [addingVariant, setAddingVariant] = useState(false);
  const [showAddVariant, setShowAddVariant] = useState(false);
  const [saveResult, setSaveResult] = useState<{ type: "success" | "error"; message: string } | null>(null);

  const [importMode, setImportMode] = useState<ImportMode>("lines");
  const [importText, setImportText] = useState("");
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [deleteModal, setDeleteModal] = useState<null | "choose" | "confirm-hard">(null);
  const [deleting, setDeleting] = useState(false);

  // Image pipeline state
  const [pipelineRunning, setPipelineRunning] = useState(false);
  const [pipelineResult, setPipelineResult] = useState<{ type: "success" | "info" | "error"; message: string } | null>(null);

  const [backfillingEnrichment, setBackfillingEnrichment] = useState(false);
  const [enrichmentBackfillResult, setEnrichmentBackfillResult] = useState<{ type: "success" | "error"; message: string } | null>(null);

  // Patch the selected fact + its list row when the enrichment editor saves, so
  // the projection (archetype) and status stay consistent without a refetch.
  function applyEnrichmentSave(factId: number, resp: EnrichmentSaveResponse) {
    const patch = {
      primaryArchetype: resp.projection?.primaryArchetype ?? resp.enrichment.primaryArchetype,
      enrichmentStatus: "ok" as const,
      hasEnrichment: true,
    };
    setFacts((prev) => prev.map((f) => (f.id === factId ? { ...f, ...patch } : f)));
    setSelectedFact((f) => (f && f.id === factId ? { ...f, ...patch } : f));
  }

  // The fact text/use-case edit form follows the universal local-draft model:
  // edits autosave to localStorage, "Save Changes" commits to the server (new
  // baseline), and "Discard" reverts to the server source of truth. The baseline
  // comes from the in-memory selected fact (the list already carries every
  // editable field); no separate fetch is needed.
  const editForm = useDraftForm<EditDraft, Fact>({
    storageKey: selectedFact ? `fact-edit-draft::${selectedFact.id}` : "fact-edit-draft::none",
    emptyValue: EMPTY_EDIT_DRAFT,
    debounceMs: 1000,
    fetchServer: async () => selectedFactRef.current,
    selectValue: (fact) => factToEditDraft(fact),
    commit: async (v) => {
      const sf = selectedFactRef.current;
      if (!sf) throw new Error("No fact selected.");
      const body = {
        text: v.text,
        parentId: v.parentId !== null && v.parentId !== undefined && String(v.parentId) !== "" ? Number(v.parentId) : null,
        useCase: v.useCase || null,
        isActive: v.isActive,
        upvotes: Number(v.upvotes),
        downvotes: Number(v.downvotes),
        score: Number(v.score),
        wilsonScore: Number(v.wilsonScore),
        commentCount: Number(v.commentCount),
        shareCount: Number(v.shareCount),
        submittedById: v.submittedById || null,
      };
      const res = await fetch(`/api/admin/facts/${sf.id}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as { success?: boolean; fact?: Fact; error?: string };
      if (!res.ok) throw new Error(data.error ?? "Save failed");
      const updated = data.fact!;
      setFacts((prev) => prev.map((f) => (f.id === updated.id ? updated : f)));
      setSelectedFact(updated);
      setSaveResult({ type: "success", message: "Saved successfully." });
    },
  });
  const draft = editForm.value;

  const LIMIT = 25;

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 400);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => { setPage(1); }, [debouncedSearch]);

  useEffect(() => {
    setLoading(true);
    const params = new URLSearchParams({
      page: String(page),
      limit: String(LIMIT),
      ...(debouncedSearch ? { search: debouncedSearch } : {}),
      ...(showInactive ? { inactive: "true" } : {}),
    });
    fetch(`/api/admin/facts?${params}`, { credentials: "include" })
      .then(async (r) => {
        const data = (await r.json()) as Partial<FactsResponse>;
        if (r.ok && Array.isArray(data.facts)) {
          setFacts(data.facts);
          setTotal(data.total ?? 0);
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [page, debouncedSearch, showInactive]);

  function selectFact(fact: Fact) {
    setSelectedFact(fact);
    setSaveResult(null);
    setShowAddVariant(false);
    setNewVariantText("");
    setNewVariantUseCase("");
    setPipelineResult(null);
    // Fetch variants for root facts
    if (fact.parentId === null) {
      setLoadingVariants(true);
      fetch(`/api/facts/${fact.id}`, { credentials: "include" })
        .then((r) => r.json())
        .then((data: { variants?: FactVariant[] }) => {
          setVariants(data.variants ?? []);
        })
        .catch(() => setVariants([]))
        .finally(() => setLoadingVariants(false));
    } else {
      setVariants([]);
    }
  }

  function clearSelection() {
    setSelectedFact(null);
    setSaveResult(null);
    setVariants([]);
    setShowAddVariant(false);
    setPipelineResult(null);
  }

  // On mount: if ?focus=<id> is in the URL (e.g. linked from Taxonomy Health),
  // fetch that fact by ID and select it immediately, regardless of which page of
  // the list it would appear on.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const focusId = Number(params.get("focus"));
    if (!Number.isInteger(focusId) || focusId <= 0) return;
    fetch(`/api/admin/facts/${focusId}`, { credentials: "include" })
      .then(async (r) => {
        if (!r.ok) return;
        const fact = (await r.json()) as Fact;
        selectFact(fact);
      })
      .catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function triggerImagePipeline(factId: number, force: boolean) {
    setPipelineRunning(true);
    setPipelineResult(null);
    try {
      const url = `/api/admin/facts/${factId}/refresh-images${force ? "?force=true" : ""}`;
      const res = await fetch(url, { method: "POST", credentials: "include" });
      const data = (await res.json()) as { success?: boolean; skipped?: boolean; message?: string; error?: string };
      if (!res.ok) throw new Error(data.error ?? "Pipeline failed");
      if (data.skipped) {
        setPipelineResult({ type: "info", message: data.message ?? "Skipped — images already exist." });
      } else {
        setPipelineResult({ type: "success", message: data.message ?? "Pipeline started." });
        // Refresh the fact in the list to show updated hasPexelsImages status after a delay
        setTimeout(() => {
          setFacts((prev) => prev.map((f) => f.id === factId ? { ...f, hasPexelsImages: true } : f));
          if (selectedFact?.id === factId) {
            setSelectedFact((f) => f ? { ...f, hasPexelsImages: true } : f);
          }
        }, 5000);
      }
    } catch (err) {
      setPipelineResult({ type: "error", message: err instanceof Error ? err.message : "Pipeline failed" });
    } finally {
      setPipelineRunning(false);
    }
  }

  async function addVariant() {
    if (!selectedFact || !newVariantText.trim()) return;
    setAddingVariant(true);
    try {
      const res = await fetch(`/api/admin/facts/${selectedFact.id}/variants`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: newVariantText.trim(), useCase: newVariantUseCase || null }),
      });
      const data = (await res.json()) as { success?: boolean; variant?: FactVariant; error?: string };
      if (!res.ok) throw new Error(data.error ?? "Failed to add variant");
      setVariants((prev) => [...prev, data.variant!]);
      setNewVariantText("");
      setNewVariantUseCase("");
      setShowAddVariant(false);
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to add variant");
    } finally {
      setAddingVariant(false);
    }
  }

  async function deleteVariant(variantId: number) {
    if (!confirm("Delete this variant permanently?")) return;
    await fetch(`/api/admin/facts/variants/${variantId}`, { method: "DELETE", credentials: "include" });
    setVariants((prev) => prev.filter((v) => v.id !== variantId));
  }

  async function deleteFact(hard: boolean) {
    if (!selectedFact) return;
    setDeleting(true);
    try {
      const url = `/api/admin/facts/${selectedFact.id}${hard ? "?hard=true" : ""}`;
      const res = await fetch(url, { method: "DELETE", credentials: "include" });
      const data = (await res.json()) as { success?: boolean; error?: string };
      if (!res.ok) throw new Error(data.error ?? "Delete failed");
      setFacts((prev) => prev.filter((f) => f.id !== selectedFact.id));
      setTotal((t) => t - 1);
      clearSelection();
      setDeleteModal(null);
    } catch (err) {
      setSaveResult({ type: "error", message: err instanceof Error ? err.message : "Delete failed" });
      setDeleteModal(null);
    } finally {
      setDeleting(false);
    }
  }

  async function handleImport() {
    setImporting(true);
    setImportResult(null);
    try {
      let body: BodyInit;
      let url: string;
      if (importMode === "csv") {
        url = "/api/admin/facts/import-csv";
        body = JSON.stringify({ csv: importText });
      } else {
        url = "/api/admin/facts/import";
        let factsArr: string[];
        if (importMode === "json") {
          factsArr = JSON.parse(importText) as string[];
          if (!Array.isArray(factsArr)) throw new Error("JSON must be an array");
        } else {
          factsArr = importText.split("\n").map((l) => l.trim()).filter(Boolean);
        }
        body = JSON.stringify({ facts: factsArr });
      }
      const res = await fetch(url, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body,
      });
      const data = (await res.json()) as { imported?: number; error?: string };
      if (!res.ok) throw new Error(data.error ?? "Import failed");
      setImportResult({ type: "success", message: `Successfully imported ${data.imported} fact(s).` });
      setImportText("");
      setPage(1);
      setDebouncedSearch("");
    } catch (err) {
      setImportResult({ type: "error", message: err instanceof Error ? err.message : "Import failed" });
    } finally {
      setImporting(false);
    }
  }

  async function handleBackfillEnrichment() {
    setBackfillingEnrichment(true);
    setEnrichmentBackfillResult(null);
    try {
      const res = await fetch("/api/admin/facts/backfill-enrichment", { method: "POST", credentials: "include" });
      const data = await res.json() as { queued?: number; message?: string; error?: string };
      if (res.ok) {
        setEnrichmentBackfillResult({ type: "success", message: data.message ?? `Queued ${data.queued ?? 0} facts.` });
      } else {
        setEnrichmentBackfillResult({ type: "error", message: data.error ?? "Backfill failed" });
      }
    } catch (err) {
      setEnrichmentBackfillResult({ type: "error", message: err instanceof Error ? err.message : "Backfill failed" });
    } finally {
      setBackfillingEnrichment(false);
    }
  }

  function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      setImportText(ev.target?.result as string);
      setImportMode(file.name.endsWith(".json") ? "json" : "csv");
    };
    reader.readAsText(file);
  }

  const totalPages = Math.ceil(total / LIMIT);
  const numField = (key: keyof EditDraft) => (
    <input
      type="number"
      value={String(draft?.[key] ?? "")}
      onChange={(e) => editForm.setValue((d) => d ? { ...d, [key]: e.target.value } : d)}
      className="h-9 w-full px-3 bg-background border border-border rounded-sm text-sm font-mono focus:outline-none focus:border-primary"
    />
  );

  return (
    <AdminLayout title="Facts Management">
      {/* Delete Modal */}
      {deleteModal && selectedFact && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="bg-card border border-border rounded-lg w-full max-w-sm p-6 flex flex-col gap-5 shadow-xl">
            {deleteModal === "choose" ? (
              <>
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-full bg-destructive/10 flex items-center justify-center shrink-0">
                    <Trash2 className="w-5 h-5 text-destructive" />
                  </div>
                  <div>
                    <h2 className="font-display font-bold text-foreground uppercase tracking-wide">Delete Fact</h2>
                    <p className="text-xs text-muted-foreground mt-0.5">#{selectedFact.id}</p>
                  </div>
                </div>
                <p className="text-sm text-muted-foreground line-clamp-2 italic">"{selectedFact.text}"</p>
                <p className="text-sm text-muted-foreground">Choose how to delete this fact:</p>
                <div className="flex flex-col gap-2">
                  <button
                    onClick={() => deleteFact(false)}
                    disabled={deleting}
                    className="w-full flex items-center gap-3 px-4 py-3 rounded-sm border border-border hover:border-yellow-500/50 hover:bg-yellow-500/5 text-left transition-colors disabled:opacity-50"
                  >
                    <EyeOff className="w-5 h-5 text-yellow-500 shrink-0" />
                    <div>
                      <div className="text-sm font-medium text-foreground">Soft Delete</div>
                      <div className="text-xs text-muted-foreground">Marks the fact as inactive. Data is preserved.</div>
                    </div>
                  </button>
                  <button
                    onClick={() => setDeleteModal("confirm-hard")}
                    disabled={deleting}
                    className="w-full flex items-center gap-3 px-4 py-3 rounded-sm border border-border hover:border-destructive/50 hover:bg-destructive/5 text-left transition-colors disabled:opacity-50"
                  >
                    <Trash2 className="w-5 h-5 text-destructive shrink-0" />
                    <div>
                      <div className="text-sm font-medium text-foreground">Hard Delete</div>
                      <div className="text-xs text-muted-foreground">Permanently removes the row from the database.</div>
                    </div>
                  </button>
                </div>
                <Button variant="outline" onClick={() => setDeleteModal(null)} className="w-full">
                  Cancel
                </Button>
              </>
            ) : (
              <>
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-full bg-destructive/10 flex items-center justify-center shrink-0">
                    <Trash2 className="w-5 h-5 text-destructive" />
                  </div>
                  <div>
                    <h2 className="font-display font-bold text-foreground uppercase tracking-wide">Confirm Hard Delete</h2>
                    <p className="text-xs text-muted-foreground mt-0.5">This action cannot be undone.</p>
                  </div>
                </div>
                <p className="text-sm text-muted-foreground">
                  You are about to <span className="text-destructive font-semibold">permanently delete</span> fact{" "}
                  <span className="font-medium text-foreground">#{selectedFact.id}</span> and all its data. This cannot be reversed.
                </p>
                <div className="flex gap-3">
                  <Button
                    onClick={() => deleteFact(true)}
                    isLoading={deleting}
                    className="flex-1 bg-destructive hover:bg-destructive/90 text-destructive-foreground border-destructive"
                  >
                    <Trash2 className="w-4 h-4" /> Delete Forever
                  </Button>
                  <Button variant="outline" onClick={() => setDeleteModal("choose")} className="flex-1" disabled={deleting}>
                    Back
                  </Button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        {/* Left — fact list */}
        <div className="bg-card border border-border rounded-lg overflow-hidden flex flex-col">
          <div className="p-4 border-b border-border flex items-center gap-3">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search facts…"
                className="pl-9"
              />
            </div>
            <button
              onClick={() => { setShowInactive((v) => !v); setPage(1); }}
              className={`flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium border rounded-sm transition-colors shrink-0 ${
                showInactive
                  ? "bg-amber-500/10 text-amber-600 border-amber-500/30"
                  : "text-muted-foreground border-border hover:border-primary/40 hover:text-foreground"
              }`}
              title={showInactive ? "Hide inactive facts" : "Show inactive facts"}
            >
              {showInactive ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
              {showInactive ? "All" : "Active"}
            </button>
            <span className="text-sm text-muted-foreground whitespace-nowrap">
              {total}
            </span>
          </div>

          <div className="flex-1 overflow-auto divide-y divide-border">
            {loading ? (
              <div className="p-8 text-center text-muted-foreground text-sm">Loading…</div>
            ) : facts.length === 0 ? (
              <div className="p-8 text-center text-muted-foreground text-sm">No facts found.</div>
            ) : (
              facts.map((fact) => {
                const isSelected = selectedFact?.id === fact.id;
                return (
                  <div
                    key={fact.id}
                    onClick={() => selectFact(fact)}
                    className={`flex items-start gap-3 px-4 py-3 cursor-pointer group transition-colors ${
                      isSelected ? "bg-primary/10 border-l-2 border-primary" : "hover:bg-muted/40 border-l-2 border-transparent"
                    } ${!fact.isActive ? "opacity-50" : ""}`}
                  >
                    <div className="mt-1 shrink-0">
                      <div className={`w-2 h-2 rounded-full ${fact.isActive ? "bg-green-500" : "bg-red-500"}`} title={fact.isActive ? "Active" : "Inactive"} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-foreground leading-snug line-clamp-2">{fact.text}</p>
                      <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-1 text-xs text-muted-foreground">
                        <span className="font-mono">#{fact.id}</span>
                        <span>↑{fact.upvotes} ↓{fact.downvotes}</span>
                        <span>W:{(fact.wilsonScore ?? 0).toFixed(3)}</span>
                        <span title={fact.hasEmbedding ? "Embedding present" : "No embedding — won't appear in duplicate check"}>
                          <Brain className={`inline w-3 h-3 ${fact.hasEmbedding ? "text-green-500" : "text-destructive"}`} />
                          {fact.hasEmbedding ? "" : " no embed"}
                        </span>
                        {fact.hasEnrichment && (
                          <span
                            className="inline-flex items-center gap-1 text-primary"
                            title={fact.primaryArchetype ? `Enriched — ${fact.primaryArchetype}` : "Has visual taxonomy enrichment"}
                          >
                            <Sparkles className="inline w-3 h-3" />
                            {fact.enrichmentStatus === "pending" ? "classifying…" : (fact.primaryArchetype ?? "enriched")}
                          </span>
                        )}
                        <span>{new Date(fact.createdAt).toLocaleDateString()}</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <Pencil className={`w-3.5 h-3.5 transition-opacity ${isSelected ? "text-primary opacity-100" : "text-muted-foreground opacity-0 group-hover:opacity-100"}`} />
                      <button
                        onClick={(e) => { e.stopPropagation(); selectFact(fact); setDeleteModal("choose"); }}
                        className="p-1 text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100 transition-all"
                        title="Delete fact"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                );
              })
            )}
          </div>

          {totalPages > 1 && (
            <div className="p-3 border-t border-border flex items-center justify-between">
              <Button variant="ghost" size="sm" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1}>
                Previous
              </Button>
              <span className="text-xs text-muted-foreground">Page {page} of {totalPages}</span>
              <Button variant="ghost" size="sm" onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page === totalPages}>
                Next
              </Button>
            </div>
          )}
        </div>

        {/* Right — edit panel or bulk import */}
        {selectedFact && draft ? (
          <div className="bg-card border border-border rounded-lg p-5 flex flex-col gap-4">
            {/* Header */}
            <div className="flex items-center justify-between">
              <h2 className="font-display font-bold text-foreground uppercase tracking-wide flex items-center gap-2">
                <Pencil className="w-4 h-4 text-primary" />
                Edit Fact #{selectedFact.id}
              </h2>
              <div className="flex items-center gap-3 shrink-0">
                {/* Draft status — always visible in the pinned header */}
                <div className="text-xs text-muted-foreground">
                  {editForm.committing ? (
                    <span className="flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" />Saving to server…</span>
                  ) : editForm.commitError ? (
                    <span className="text-destructive">{editForm.commitError}</span>
                  ) : editForm.hasUncommittedChanges ? (
                    <span>{editForm.draftLabel || "Unsaved changes"}</span>
                  ) : editForm.committedAt ? (
                    <span className="text-green-600 dark:text-green-400">Saved to server</span>
                  ) : null}
                </div>
                {editForm.hasUncommittedChanges && (
                  <button
                    type="button"
                    onClick={editForm.discard}
                    className="text-xs text-primary underline hover:opacity-80"
                  >
                    Discard changes
                  </button>
                )}
                <button
                  onClick={clearSelection}
                  className="flex items-center justify-center w-11 h-11 -mr-2 text-muted-foreground hover:text-foreground transition-colors rounded-sm"
                  title="Close"
                  aria-label="Close edit panel"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            {/* Status badges */}
            <div className="flex flex-wrap gap-2 items-center">
              <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-bold rounded-sm border ${
                selectedFact.isActive
                  ? "bg-green-500/10 text-green-600 border-green-500/30"
                  : "bg-red-500/10 text-red-500 border-red-500/30"
              }`}>
                <div className={`w-1.5 h-1.5 rounded-full ${selectedFact.isActive ? "bg-green-500" : "bg-red-500"}`} />
                {selectedFact.isActive ? "Active" : "Inactive"}
              </span>
              <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-bold rounded-sm border ${
                selectedFact.hasEmbedding
                  ? "bg-blue-500/10 text-blue-600 border-blue-500/30"
                  : "bg-amber-500/10 text-amber-600 border-amber-500/30"
              }`}>
                <Brain className="w-3 h-3" />
                {selectedFact.hasEmbedding ? "Embedding ✓" : "No Embedding"}
              </span>
              {selectedFact.parentId !== null && (
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-bold rounded-sm border bg-violet-500/10 text-violet-600 border-violet-500/30">
                  <GitBranch className="w-3 h-3" />
                  Variant of #{selectedFact.parentId}
                </span>
              )}
            </div>

            {/* Read-only metadata row */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <ReadOnlyField label="ID" value={selectedFact.id} />
              <ReadOnlyField label="Created At" value={new Date(selectedFact.createdAt).toLocaleDateString()} />
              <ReadOnlyField label="Updated At" value={new Date(selectedFact.updatedAt).toLocaleDateString()} />
              <ReadOnlyField label="Caption Split" value={selectedFact.splitTokenIndex ?? "auto"} />
            </div>

            {/* Text */}
            <div>
              <FieldLabel>Text</FieldLabel>
              <textarea
                value={draft.text}
                onChange={(e) => editForm.setValue((d) => d ? { ...d, text: e.target.value } : d)}
                rows={4}
                className="w-full px-3 py-2 bg-background border border-border rounded-sm text-sm focus:outline-none focus:border-primary resize-none"
              />
            </div>

            {/* Canonical text (read-only) */}
            {selectedFact.canonicalText && (
              <div>
                <FieldLabel>Canonical Text (used for embeddings)</FieldLabel>
                <p className="text-xs text-muted-foreground bg-muted/50 rounded px-3 py-2 leading-relaxed border border-border italic">
                  {selectedFact.canonicalText}
                </p>
              </div>
            )}

            {/* Active toggle */}
            <div className="flex items-center justify-between py-2 border border-border rounded-md px-3">
              <div>
                <p className="text-sm font-medium">Active</p>
                <p className="text-xs text-muted-foreground">Inactive facts are hidden from the public.</p>
              </div>
              <button
                type="button"
                onClick={() => editForm.setValue((d) => d ? { ...d, isActive: !d.isActive } : d)}
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none ${
                  draft.isActive ? "bg-green-500" : "bg-muted-foreground/30"
                }`}
                title={draft.isActive ? "Click to deactivate" : "Click to activate"}
              >
                <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
                  draft.isActive ? "translate-x-6" : "translate-x-1"
                }`} />
              </button>
            </div>

            {/* Vote / score row */}
            <div className="grid grid-cols-3 gap-3">
              <div>
                <FieldLabel>Upvotes</FieldLabel>
                {numField("upvotes")}
              </div>
              <div>
                <FieldLabel>Downvotes</FieldLabel>
                {numField("downvotes")}
              </div>
              <div>
                <FieldLabel>Score</FieldLabel>
                {numField("score")}
              </div>
            </div>

            {/* Wilson / counts row */}
            <div className="grid grid-cols-3 gap-3">
              <div>
                <FieldLabel>Wilson Score</FieldLabel>
                <input
                  type="number"
                  step="0.000001"
                  value={String(draft.wilsonScore)}
                  onChange={(e) => editForm.setValue((d) => d ? { ...d, wilsonScore: parseFloat(e.target.value) || 0 } : d)}
                  className="h-9 w-full px-3 bg-background border border-border rounded-sm text-sm font-mono focus:outline-none focus:border-primary"
                />
              </div>
              <div>
                <FieldLabel>Comment Count</FieldLabel>
                {numField("commentCount")}
              </div>
              <div>
                <FieldLabel>Share Count</FieldLabel>
                {numField("shareCount")}
              </div>
            </div>

            {/* Relationship / identity fields */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <FieldLabel>Parent ID (blank = root fact)</FieldLabel>
                <input
                  type="number"
                  value={draft.parentId !== null && draft.parentId !== undefined ? String(draft.parentId) : ""}
                  onChange={(e) => editForm.setValue((d) => d ? { ...d, parentId: e.target.value ? Number(e.target.value) : null } : d)}
                  placeholder="blank for root"
                  className="h-9 w-full px-3 bg-background border border-border rounded-sm text-sm font-mono focus:outline-none focus:border-primary"
                />
              </div>
              <div>
                <FieldLabel>Use Case</FieldLabel>
                <input
                  list="use-case-options"
                  value={draft.useCase ?? ""}
                  onChange={(e) => editForm.setValue((d) => d ? { ...d, useCase: e.target.value || null } : d)}
                  placeholder="e.g. one_line, meme_caption…"
                  className="h-9 w-full px-3 bg-background border border-border rounded-sm text-sm font-mono focus:outline-none focus:border-primary"
                />
                <datalist id="use-case-options">
                  {USE_CASE_SUGGESTIONS.map(s => <option key={s} value={s} />)}
                </datalist>
              </div>
              <div>
                <FieldLabel>Submitted By ID</FieldLabel>
                <input
                  type="text"
                  value={draft.submittedById ?? ""}
                  onChange={(e) => editForm.setValue((d) => d ? { ...d, submittedById: e.target.value } : d)}
                  placeholder="user UUID or blank"
                  className="h-9 w-full px-3 bg-background border border-border rounded-sm text-sm font-mono focus:outline-none focus:border-primary"
                />
              </div>
            </div>

            {/* Variants section — only shown for root facts */}
            {selectedFact.parentId === null && (
              <div className="border border-border rounded-sm overflow-hidden">
                <div className="flex items-center justify-between px-3 py-2 bg-muted/30 border-b border-border">
                  <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                    <GitBranch className="w-3.5 h-3.5" />
                    Variants {loadingVariants ? "(loading…)" : `(${variants.length})`}
                  </span>
                  {!showAddVariant && (
                    <button
                      onClick={() => setShowAddVariant(true)}
                      className="flex items-center justify-center min-w-[44px] min-h-[44px] -my-2 -mr-1 text-primary hover:text-primary/80 transition-colors"
                      title="Add variant"
                      aria-label="Add variant"
                    >
                      <Plus className="w-5 h-5" />
                    </button>
                  )}
                </div>

                {showAddVariant && (
                  <div className="p-3 border-b border-border bg-primary/5 space-y-2">
                    <textarea
                      value={newVariantText}
                      onChange={(e) => setNewVariantText(e.target.value)}
                      rows={2}
                      placeholder="Variant text…"
                      className="w-full px-3 py-2 bg-background border border-border rounded-sm text-sm focus:outline-none focus:border-primary resize-none"
                    />
                    <div className="flex gap-2">
                      <input
                        list="use-case-options-new"
                        value={newVariantUseCase}
                        onChange={(e) => setNewVariantUseCase(e.target.value)}
                        placeholder="use_case (e.g. one_line)"
                        className="flex-1 h-8 px-2 bg-background border border-border rounded-sm text-xs font-mono focus:outline-none focus:border-primary"
                      />
                      <datalist id="use-case-options-new">
                        {USE_CASE_SUGGESTIONS.map(s => <option key={s} value={s} />)}
                      </datalist>
                      <Button size="sm" onClick={addVariant} isLoading={addingVariant} disabled={!newVariantText.trim()}>
                        Add
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => { setShowAddVariant(false); setNewVariantText(""); setNewVariantUseCase(""); }}>
                        Cancel
                      </Button>
                    </div>
                  </div>
                )}

                <div className="divide-y divide-border max-h-40 overflow-auto">
                  {variants.length === 0 && !loadingVariants ? (
                    <p className="text-xs text-muted-foreground p-3 italic">No variants yet. Click + to add one.</p>
                  ) : (
                    variants.map((v) => (
                      <div key={v.id} className="flex items-start gap-2 px-3 py-2 group hover:bg-muted/20">
                        <div className="flex-1 min-w-0">
                          {v.useCase && (
                            <span className="inline-block text-[10px] font-bold uppercase tracking-wider text-primary bg-primary/10 border border-primary/20 px-1.5 py-0.5 rounded-sm mr-1.5 mb-1">
                              {v.useCase.replace(/_/g, " ")}
                            </span>
                          )}
                          <p className="text-xs text-foreground leading-snug line-clamp-2">{v.text}</p>
                          <span className="text-[10px] text-muted-foreground font-mono">#{v.id}</span>
                        </div>
                        <button
                          onClick={() => deleteVariant(v.id)}
                          className="shrink-0 flex items-center justify-center min-w-[44px] min-h-[44px] -my-1 text-muted-foreground hover:text-destructive md:opacity-0 md:group-hover:opacity-100 transition-all"
                          title="Delete variant"
                          aria-label="Delete variant"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}

            {/* Pexels Image Pipeline (root facts only) */}
            {selectedFact.parentId === null && (
              <div className="border border-border rounded-sm overflow-hidden">
                <div className="flex items-center justify-between px-3 py-2 bg-muted/30 border-b border-border">
                  <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                    <ImageIcon className="w-3.5 h-3.5" />
                    Pexels Image Pipeline
                  </span>
                  <span className={`inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-sm border ${
                    selectedFact.hasPexelsImages
                      ? "bg-green-500/10 text-green-600 border-green-500/30"
                      : "bg-amber-500/10 text-amber-600 border-amber-500/30"
                  }`}>
                    <div className={`w-1.5 h-1.5 rounded-full ${selectedFact.hasPexelsImages ? "bg-green-500" : "bg-amber-500"}`} />
                    {selectedFact.hasPexelsImages ? "Images present" : "No images"}
                  </span>
                </div>
                <div className="p-3 space-y-2">
                  {pipelineResult && (
                    <div className={`flex items-center gap-2 text-xs rounded-sm px-3 py-2 ${
                      pipelineResult.type === "success"
                        ? "bg-green-500/10 text-green-400 border border-green-500/30"
                        : pipelineResult.type === "info"
                        ? "bg-blue-500/10 text-blue-400 border border-blue-500/30"
                        : "bg-destructive/10 text-destructive border border-destructive/30"
                    }`}>
                      {pipelineResult.type === "success" ? <CheckCircle className="w-3.5 h-3.5 shrink-0" /> : <AlertCircle className="w-3.5 h-3.5 shrink-0" />}
                      {pipelineResult.message}
                    </div>
                  )}
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void triggerImagePipeline(selectedFact.id, false)}
                    isLoading={pipelineRunning}
                    disabled={pipelineRunning}
                    className="w-full gap-1.5 text-xs min-h-[44px]"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    {selectedFact.hasPexelsImages ? "Re-run Pipeline" : "Run Image Pipeline"}
                  </Button>
                  {selectedFact.hasPexelsImages && (
                    <div className="pt-2 mt-2 border-t border-dashed border-amber-500/20 space-y-1.5">
                      <p className="text-[10px] font-bold uppercase tracking-wider text-amber-600 dark:text-amber-500 flex items-center gap-1">
                        <AlertCircle className="w-3 h-3" /> Destructive
                      </p>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => void triggerImagePipeline(selectedFact.id, true)}
                        isLoading={pipelineRunning}
                        disabled={pipelineRunning}
                        className="w-full gap-1.5 text-xs text-amber-500 border-amber-500/30 hover:border-amber-400 hover:bg-amber-500/10 min-h-[44px]"
                        title="Force overwrite existing images"
                      >
                        Force overwrite existing images
                      </Button>
                    </div>
                  )}
                  <p className="text-[10px] text-muted-foreground">
                    {selectedFact.hasPexelsImages
                      ? "Re-run fetches new Pexels photos. Use Force to overwrite existing images."
                      : "Fetches Pexels stock photos for this fact using AI-generated keywords."}
                  </p>
                </div>
              </div>
            )}

            {/* Runtime Compiled Prompt Preview (Phase 2C) — the ACTUAL render-time
                engine prompt for a chosen render context. Distinct from the
                enrichment editor's preview-only example prompts below. Shown for
                any selected fact; it reads the fact's saved enrichment by id. The
                component renders its own collapsible bordered header. */}
            <div className="border-t border-border pt-3">
              <RuntimePromptPreview factId={selectedFact.id} />
            </div>

            {/* Visual Taxonomy Enrichment — the shared editor (same as moderation).
                Edit + autosave the metadata, regenerate the visual preview, or
                re-run classification to tune a fact rendering bad images/videos. */}
            <div className="border-t border-border pt-3">
              <FactEnrichmentPanel
                key={selectedFact.id}
                fact={selectedFact}
                onSaved={(resp) => applyEnrichmentSave(selectedFact.id, resp)}
              />
            </div>

            {/* Save result */}
            {saveResult && (
              <div className={`flex items-start gap-2 text-sm px-3 py-2.5 rounded-sm ${
                saveResult.type === "success"
                  ? "bg-green-500/10 text-green-400 border border-green-500/30"
                  : "bg-destructive/10 text-destructive border border-destructive/30"
              }`}>
                {saveResult.type === "success"
                  ? <CheckCircle className="w-4 h-4 shrink-0 mt-0.5" />
                  : <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />}
                {saveResult.message}
              </div>
            )}

            {/* Actions */}
            <div className="flex gap-3 pt-1">
              <Button
                onClick={() => void editForm.save()}
                isLoading={editForm.committing}
                disabled={!editForm.hasUncommittedChanges}
                className="flex-1"
              >
                <Save className="w-4 h-4" /> Save Changes
              </Button>
              <Button
                variant="outline"
                onClick={editForm.discard}
                disabled={!editForm.hasUncommittedChanges || editForm.committing}
                className="flex-1"
              >
                Discard
              </Button>
              <Button variant="outline" onClick={clearSelection} className="flex-1">
                Cancel
              </Button>
            </div>

            <div className="border-t border-border pt-3">
              <Button
                variant="outline"
                onClick={() => setDeleteModal("choose")}
                className="w-full text-destructive border-destructive/30 hover:bg-destructive/10 hover:border-destructive/60"
              >
                <Trash2 className="w-4 h-4" /> Delete Fact
              </Button>
            </div>
          </div>
        ) : (
          /* Bulk import (default right panel) */
          <div className="bg-card border border-border rounded-lg p-5 flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <h2 className="font-display font-bold text-foreground uppercase tracking-wide">Bulk Import</h2>
              <label className="cursor-pointer">
                <input ref={fileInputRef} type="file" accept=".txt,.csv,.json" className="hidden" onChange={handleFileUpload} />
                <span className="flex items-center gap-1.5 text-xs text-primary hover:underline">
                  <Upload className="w-3.5 h-3.5" /> Upload file
                </span>
              </label>
            </div>

            <div className="flex gap-2 text-xs">
              {(["lines", "csv", "json"] as ImportMode[]).map((mode) => (
                <button
                  key={mode}
                  onClick={() => setImportMode(mode)}
                  className={`px-3 py-1 rounded-sm border transition-colors ${
                    importMode === mode
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border text-muted-foreground hover:border-primary/50"
                  }`}
                >
                  {mode === "lines" ? "One per line" : mode.toUpperCase()}
                </button>
              ))}
            </div>

            <div className="text-xs text-muted-foreground bg-muted/50 rounded-sm p-3 leading-relaxed">
              {importMode === "lines" && <>Paste one fact per line. Empty lines are ignored.</>}
              {importMode === "csv" && <>Paste CSV data. Each line becomes a fact. Surrounding quotes are stripped.</>}
              {importMode === "json" && (
                <>
                  Paste a JSON array of strings or objects with a{" "}
                  <code className="text-primary">text</code> field.
                  <br />
                  Example: <code className="text-primary">{`["Fact 1", "Fact 2"]`}</code>
                </>
              )}
            </div>

            <Textarea
              value={importText}
              onChange={(e) => setImportText(e.target.value)}
              placeholder={
                importMode === "json"
                  ? `["{Name} can sneeze with their eyes open.", "{Name} counted to infinity — twice."]`
                  : "{Name} can sneeze with their eyes open.\n{Name} counted to infinity — twice."
              }
              className="flex-1 font-mono text-xs resize-none min-h-[220px]"
            />

            {importResult && (
              <div className={`flex items-start gap-2 text-sm px-3 py-2.5 rounded-sm ${
                importResult.type === "success"
                  ? "bg-green-500/10 text-green-400 border border-green-500/30"
                  : "bg-destructive/10 text-destructive border border-destructive/30"
              }`}>
                {importResult.type === "success"
                  ? <CheckCircle className="w-4 h-4 shrink-0 mt-0.5" />
                  : <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />}
                {importResult.message}
              </div>
            )}

            <Button onClick={handleImport} disabled={!importText.trim() || importing} className="w-full">
              {importing ? "Importing…" : "Import Facts"}
            </Button>

            <div className="border-t border-border pt-4 mt-1 flex flex-col gap-2">
              <h3 className="text-sm font-bold text-foreground uppercase tracking-wide flex items-center gap-2">
                <Brain className="w-4 h-4" /> Visual Taxonomy
              </h3>
              <p className="text-xs text-muted-foreground">
                Classify existing facts that have no enrichment yet (archetype, subtype, modifiers, hashtags). Runs in the background.
              </p>
              {enrichmentBackfillResult && (
                <div className={`flex items-start gap-2 text-sm px-3 py-2.5 rounded-sm ${
                  enrichmentBackfillResult.type === "success"
                    ? "bg-green-500/10 text-green-400 border border-green-500/30"
                    : "bg-destructive/10 text-destructive border border-destructive/30"
                }`}>
                  {enrichmentBackfillResult.type === "success"
                    ? <CheckCircle className="w-4 h-4 shrink-0 mt-0.5" />
                    : <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />}
                  {enrichmentBackfillResult.message}
                </div>
              )}
              <Button variant="outline" onClick={handleBackfillEnrichment} disabled={backfillingEnrichment} className="w-full">
                {backfillingEnrichment ? "Starting…" : "Backfill enrichment"}
              </Button>
            </div>
          </div>
        )}
      </div>
    </AdminLayout>
  );
}
