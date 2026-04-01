import { useEffect, useRef, useState } from "react";
import { AdminLayout } from "@/components/admin/AdminLayout";
import { Button } from "@/components/ui/Button";
import { Textarea, Input } from "@/components/ui/Input";
import { Trash2, Upload, Search, AlertCircle, CheckCircle, Pencil, X, Save, GitBranch, Plus, Brain, EyeOff, Eye } from "lucide-react";

const USE_CASE_SUGGESTIONS = ["default", "one_line", "two_line", "short", "long", "meme_caption", "shirt_print", "social_media", "title_case"];

interface Fact {
  id: number;
  text: string;
  canonicalText: string | null;
  parentId: number | null;
  useCase: string | null;
  isActive: boolean;
  hasEmbedding: boolean;
  upvotes: number;
  downvotes: number;
  score: number;
  wilsonScore: number;
  commentCount: number;
  submittedById: string | null;
  createdAt: string;
  updatedAt: string;
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

type EditDraft = Omit<Fact, "id" | "createdAt" | "updatedAt" | "hasEmbedding">;

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

export default function AdminFacts() {
  const [facts, setFacts] = useState<Fact[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [showInactive, setShowInactive] = useState(false);

  const [selectedFact, setSelectedFact] = useState<Fact | null>(null);
  const [draft, setDraft] = useState<EditDraft | null>(null);
  const [saving, setSaving] = useState(false);
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
    setDraft({
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
      submittedById: fact.submittedById ?? "",
    });
    setSaveResult(null);
    setShowAddVariant(false);
    setNewVariantText("");
    setNewVariantUseCase("");
    // Fetch variants for this fact (only if it's a root fact)
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
    setDraft(null);
    setSaveResult(null);
    setVariants([]);
    setShowAddVariant(false);
  }

  async function saveFact() {
    if (!selectedFact || !draft) return;
    setSaving(true);
    setSaveResult(null);
    try {
      const body = {
        text: draft.text,
        parentId: draft.parentId !== null && draft.parentId !== undefined && String(draft.parentId) !== "" ? Number(draft.parentId) : null,
        useCase: draft.useCase || null,
        isActive: draft.isActive,
        upvotes: Number(draft.upvotes),
        downvotes: Number(draft.downvotes),
        score: Number(draft.score),
        wilsonScore: Number(draft.wilsonScore),
        commentCount: Number(draft.commentCount),
        submittedById: draft.submittedById || null,
      };
      const res = await fetch(`/api/admin/facts/${selectedFact.id}`, {
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
    } catch (err) {
      setSaveResult({ type: "error", message: err instanceof Error ? err.message : "Save failed" });
    } finally {
      setSaving(false);
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
      onChange={(e) => setDraft((d) => d ? { ...d, [key]: e.target.value } : d)}
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
              <button onClick={clearSelection} className="p-1 text-muted-foreground hover:text-foreground transition-colors" title="Close">
                <X className="w-5 h-5" />
              </button>
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
            <div className="grid grid-cols-3 gap-3">
              <ReadOnlyField label="ID" value={selectedFact.id} />
              <ReadOnlyField label="Created At" value={new Date(selectedFact.createdAt).toLocaleDateString()} />
              <ReadOnlyField label="Updated At" value={new Date(selectedFact.updatedAt).toLocaleDateString()} />
            </div>

            {/* Text */}
            <div>
              <FieldLabel>Text</FieldLabel>
              <textarea
                value={draft.text}
                onChange={(e) => setDraft((d) => d ? { ...d, text: e.target.value } : d)}
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
                onClick={() => setDraft((d) => d ? { ...d, isActive: !d.isActive } : d)}
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
                  onChange={(e) => setDraft((d) => d ? { ...d, wilsonScore: parseFloat(e.target.value) || 0 } : d)}
                  className="h-9 w-full px-3 bg-background border border-border rounded-sm text-sm font-mono focus:outline-none focus:border-primary"
                />
              </div>
              <div>
                <FieldLabel>Comment Count</FieldLabel>
                {numField("commentCount")}
              </div>
              <div>
                <FieldLabel>Submitted By ID</FieldLabel>
                <input
                  type="text"
                  value={draft.submittedById ?? ""}
                  onChange={(e) => setDraft((d) => d ? { ...d, submittedById: e.target.value } : d)}
                  placeholder="user UUID or blank"
                  className="h-9 w-full px-3 bg-background border border-border rounded-sm text-sm font-mono focus:outline-none focus:border-primary"
                />
              </div>
            </div>

            {/* Variant fields */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <FieldLabel>Parent ID (blank = root fact)</FieldLabel>
                <input
                  type="number"
                  value={draft.parentId !== null && draft.parentId !== undefined ? String(draft.parentId) : ""}
                  onChange={(e) => setDraft((d) => d ? { ...d, parentId: e.target.value ? Number(e.target.value) : null } : d)}
                  placeholder="blank for root"
                  className="h-9 w-full px-3 bg-background border border-border rounded-sm text-sm font-mono focus:outline-none focus:border-primary"
                />
              </div>
              <div>
                <FieldLabel>Use Case</FieldLabel>
                <input
                  list="use-case-options"
                  value={draft.useCase ?? ""}
                  onChange={(e) => setDraft((d) => d ? { ...d, useCase: e.target.value || null } : d)}
                  placeholder="e.g. one_line, meme_caption…"
                  className="h-9 w-full px-3 bg-background border border-border rounded-sm text-sm font-mono focus:outline-none focus:border-primary"
                />
                <datalist id="use-case-options">
                  {USE_CASE_SUGGESTIONS.map(s => <option key={s} value={s} />)}
                </datalist>
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
                    <button onClick={() => setShowAddVariant(true)} className="p-1 text-primary hover:text-primary/80 transition-colors" title="Add variant">
                      <Plus className="w-4 h-4" />
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
                          className="shrink-0 p-1 opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive transition-all"
                          title="Delete variant"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}

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
              <Button onClick={saveFact} isLoading={saving} className="flex-1">
                <Save className="w-4 h-4" /> Save Changes
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
          </div>
        )}
      </div>
    </AdminLayout>
  );
}
