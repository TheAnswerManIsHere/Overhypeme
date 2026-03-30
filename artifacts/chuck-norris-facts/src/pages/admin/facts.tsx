import { useEffect, useRef, useState } from "react";
import { AdminLayout } from "@/components/admin/AdminLayout";
import { Button } from "@/components/ui/Button";
import { Textarea, Input } from "@/components/ui/Input";
import { Trash2, Upload, Search, AlertCircle, CheckCircle } from "lucide-react";

interface Fact {
  id: number;
  text: string;
  upvotes: number;
  downvotes: number;
  score: number;
  createdAt: string;
}

interface FactsResponse {
  facts: Fact[];
  total: number;
  page: number;
  limit: number;
}

type ImportMode = "json" | "csv" | "lines";

export default function AdminFacts() {
  const [facts, setFacts] = useState<Fact[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [loading, setLoading] = useState(false);

  const [importMode, setImportMode] = useState<ImportMode>("lines");
  const [importText, setImportText] = useState("");
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const LIMIT = 25;

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 400);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    setPage(1);
  }, [debouncedSearch]);

  useEffect(() => {
    setLoading(true);
    const params = new URLSearchParams({
      page: String(page),
      limit: String(LIMIT),
      ...(debouncedSearch ? { search: debouncedSearch } : {}),
    });
    fetch(`/api/admin/facts?${params}`, { credentials: "include" })
      .then((r) => r.json())
      .then((data: FactsResponse) => {
        setFacts(data.facts);
        setTotal(data.total);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [page, debouncedSearch]);

  async function deleteFact(id: number) {
    if (!confirm("Delete this fact permanently?")) return;
    await fetch(`/api/admin/facts/${id}`, {
      method: "DELETE",
      credentials: "include",
    });
    setFacts((prev) => prev.filter((f) => f.id !== id));
    setTotal((t) => t - 1);
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
        let facts: string[];
        if (importMode === "json") {
          facts = JSON.parse(importText) as string[];
          if (!Array.isArray(facts)) throw new Error("JSON must be an array");
        } else {
          facts = importText.split("\n").map((l) => l.trim()).filter(Boolean);
        }
        body = JSON.stringify({ facts });
      }

      const res = await fetch(url, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body,
      });
      const data = (await res.json()) as { imported?: number; error?: string };
      if (!res.ok) throw new Error(data.error ?? "Import failed");
      setImportResult({
        type: "success",
        message: `Successfully imported ${data.imported} fact(s).`,
      });
      setImportText("");
      setPage(1);
      setDebouncedSearch("");
    } catch (err: unknown) {
      setImportResult({
        type: "error",
        message: err instanceof Error ? err.message : "Import failed",
      });
    } finally {
      setImporting(false);
    }
  }

  function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result as string;
      setImportText(text);
      setImportMode(file.name.endsWith(".json") ? "json" : "csv");
    };
    reader.readAsText(file);
  }

  const totalPages = Math.ceil(total / LIMIT);

  return (
    <AdminLayout title="Facts Management">
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
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
              facts.map((fact) => (
                <div key={fact.id} className="flex items-start gap-3 px-4 py-3 hover:bg-muted/40 group">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-foreground leading-snug">{fact.text}</p>
                    <div className="flex gap-3 mt-1 text-xs text-muted-foreground">
                      <span>#{fact.id}</span>
                      <span>↑{fact.upvotes} ↓{fact.downvotes}</span>
                      <span>{new Date(fact.createdAt).toLocaleDateString()}</span>
                    </div>
                  </div>
                  <button
                    onClick={() => deleteFact(fact.id)}
                    className="shrink-0 p-1.5 text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100 transition-all"
                    title="Delete fact"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              ))
            )}
          </div>

          {totalPages > 1 && (
            <div className="p-3 border-t border-border flex items-center justify-between">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page === 1}
              >
                Previous
              </Button>
              <span className="text-xs text-muted-foreground">
                Page {page} of {totalPages}
              </span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page === totalPages}
              >
                Next
              </Button>
            </div>
          )}
        </div>

        <div className="bg-card border border-border rounded-lg p-5 flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <h2 className="font-display font-bold text-foreground uppercase tracking-wide">
              Bulk Import
            </h2>
            <label className="cursor-pointer">
              <input
                ref={fileInputRef}
                type="file"
                accept=".txt,.csv,.json"
                className="hidden"
                onChange={handleFileUpload}
              />
              <span className="flex items-center gap-1.5 text-xs text-primary hover:underline">
                <Upload className="w-3.5 h-3.5" />
                Upload file
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
            {importMode === "lines" && (
              <>Paste one fact per line. Empty lines are ignored.</>
            )}
            {importMode === "csv" && (
              <>Paste CSV data. Each line becomes a fact. Surrounding quotes are stripped.</>
            )}
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
            <div
              className={`flex items-start gap-2 text-sm px-3 py-2.5 rounded-sm ${
                importResult.type === "success"
                  ? "bg-green-500/10 text-green-400 border border-green-500/30"
                  : "bg-destructive/10 text-destructive border border-destructive/30"
              }`}
            >
              {importResult.type === "success" ? (
                <CheckCircle className="w-4 h-4 shrink-0 mt-0.5" />
              ) : (
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              )}
              {importResult.message}
            </div>
          )}

          <Button
            onClick={handleImport}
            disabled={!importText.trim() || importing}
            className="w-full"
          >
            {importing ? "Importing…" : "Import Facts"}
          </Button>
        </div>
      </div>
    </AdminLayout>
  );
}
