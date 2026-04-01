import { useEffect, useRef, useState } from "react";
import { AdminLayout } from "@/components/admin/AdminLayout";
import { Button } from "@/components/ui/Button";
import { Textarea, Input } from "@/components/ui/Input";
import { Trash2, Upload, Search, AlertCircle, CheckCircle, Pencil, X, Save } from "lucide-react";

interface Fact {
  id: number;
  text: string;
  upvotes: number;
  downvotes: number;
  score: number;
  wilsonScore: number;
  commentCount: number;
  submittedById: string | null;
  createdAt: string;
  updatedAt: string;
}

interface FactsResponse {
  facts: Fact[];
  total: number;
  page: number;
  limit: number;
}

type ImportMode = "json" | "csv" | "lines";

type EditDraft = Omit<Fact, "id" | "createdAt" | "updatedAt">;

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

  const [selectedFact, setSelectedFact] = useState<Fact | null>(null);
  const [draft, setDraft] = useState<EditDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveResult, setSaveResult] = useState<{ type: "success" | "error"; message: string } | null>(null);

  const [importMode, setImportMode] = useState<ImportMode>("lines");
  const [importText, setImportText] = useState("");
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

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
  }, [page, debouncedSearch]);

  function selectFact(fact: Fact) {
    setSelectedFact(fact);
    setDraft({
      text: fact.text,
      upvotes: fact.upvotes,
      downvotes: fact.downvotes,
      score: fact.score,
      wilsonScore: fact.wilsonScore ?? 0,
      commentCount: fact.commentCount ?? 0,
      submittedById: fact.submittedById ?? "",
    });
    setSaveResult(null);
  }

  function clearSelection() {
    setSelectedFact(null);
    setDraft(null);
    setSaveResult(null);
  }

  async function saveFact() {
    if (!selectedFact || !draft) return;
    setSaving(true);
    setSaveResult(null);
    try {
      const body = {
        text: draft.text,
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

  async function deleteFact(id: number) {
    if (!confirm("Delete this fact permanently?")) return;
    await fetch(`/api/admin/facts/${id}`, { method: "DELETE", credentials: "include" });
    setFacts((prev) => prev.filter((f) => f.id !== id));
    setTotal((t) => t - 1);
    if (selectedFact?.id === id) clearSelection();
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
            <span className="text-sm text-muted-foreground whitespace-nowrap">
              {total} fact{total !== 1 ? "s" : ""}
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
                    }`}
                  >
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-foreground leading-snug line-clamp-2">{fact.text}</p>
                      <div className="flex gap-3 mt-1 text-xs text-muted-foreground">
                        <span className="font-mono">#{fact.id}</span>
                        <span>↑{fact.upvotes} ↓{fact.downvotes}</span>
                        <span>W:{(fact.wilsonScore ?? 0).toFixed(3)}</span>
                        <span>{new Date(fact.createdAt).toLocaleDateString()}</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <Pencil className={`w-3.5 h-3.5 transition-opacity ${isSelected ? "text-primary opacity-100" : "text-muted-foreground opacity-0 group-hover:opacity-100"}`} />
                      <button
                        onClick={(e) => { e.stopPropagation(); deleteFact(fact.id); }}
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
              <Button
                variant="danger"
                onClick={() => deleteFact(selectedFact.id)}
                title="Delete this fact"
              >
                <Trash2 className="w-4 h-4" />
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
                  ? `["Chuck Norris can sneeze with his eyes open.", "Chuck Norris counted to infinity — twice."]`
                  : "Chuck Norris can sneeze with his eyes open.\nChuck Norris counted to infinity — twice."
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
