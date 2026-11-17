import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AdminLayout } from "@/components/admin/AdminLayout";
import { RuntimePromptPreview } from "@/components/admin/RuntimePromptPreview";
import { Button } from "@/components/ui/Button";
import { Textarea, Input } from "@/components/ui/Input";
import { Trash2, Upload, Search, AlertCircle, CheckCircle, Pencil, X, Save, Brain, EyeOff, Loader2, Sparkles, ChevronRight, ChevronDown } from "lucide-react";
import type { FactEnrichment, FactGagsView } from "@workspace/api-zod";
import { EnrichmentEditor } from "@/components/admin/EnrichmentEditor";
import { GagsPanel } from "@/components/admin/gags/GagsPanel";
import { LiveGagIdeas } from "@/components/admin/gags/LiveGagIdeas";
import { DEFAULT_SUBJECT_EXAMPLE_NAMES } from "@/components/admin/subjectExampleNames";
import { FactEnrichmentVersionHistory, type EnrichmentVersionInfo } from "@/components/admin/FactEnrichmentVersionHistory";
import { useDraftForm, CommitInterruption } from "@/components/admin/useDraftForm";
import { patchFactDraft } from "@/components/admin/patchFactDraft";
import { FactTextEditHistory } from "@/components/admin/FactTextEditHistory";
import {
  useFactEnrichmentEditing,
  type EnrichmentSaveResponse,
} from "@/components/admin/useFactEnrichmentEditing";

interface Fact {
  id: number;
  text: string;
  canonicalText: string | null;
  isActive: boolean;
  hasEmbedding: boolean;
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
  hasEnrichmentOverrides?: boolean;
  enrichmentBaselineChanged?: boolean;
}

interface FactsResponse {
  facts: Fact[];
  total: number;
  page: number;
  limit: number;
}

type ImportMode = "json" | "csv" | "lines";
type FactsTab = "facts" | "utilities";
type FactVisibilityFilter = "active" | "inactive" | "both";

type EditDraft = Omit<Fact, "id" | "createdAt" | "updatedAt" | "hasEmbedding" | "splitTokenIndex">;

/** Blank baseline used by the edit form while no fact is selected. */
const EMPTY_EDIT_DRAFT: EditDraft = {
  text: "",
  canonicalText: null,
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
function FactEnrichmentPanel({
  fact,
  onSaved,
  disabled = false,
  disabledReason,
}: {
  fact: Fact;
  onSaved: (resp: EnrichmentSaveResponse) => void;
  /** Read-only mode while a refresh is in review: the editor stays mounted so
   *  the ACTIVE enrichment is inspectable, but every write path (save, per-field
   *  overrides, re-run) is withheld — the backend REFRESH_IN_REVIEW 409s remain
   *  the backstop for stale tabs. */
  disabled?: boolean;
  disabledReason?: string;
}) {
  // ALL editing machinery (localStorage draft + per-field override tracking +
  // re-run wiring) lives in the shared useFactEnrichmentEditing hook — the same
  // engine the moderation ReviewModal mounts, so the two screens stay in
  // lockstep by construction.
  const {
    enrichment, enrichmentStatus, draft, overrideContext, jobs, rerunWithConfirm, overrideError,
  } = useFactEnrichmentEditing({
      target: { kind: "fact", factId: fact.id },
      enabled: true,
      initialStatus: fact.enrichmentStatus ?? null,
      onSaved,
    });

  const busy = draft.loading || draft.committing || jobs.loading || jobs.rerunBusy || disabled;
  const [expanded, setExpanded] = useState(false);
  // The Gags panel and Draft more gags (plan PLAN_THREE_GAGS.md, increment 2):
  // the panel reports its view and unsaved edits; an idea used on a gag
  // reloads the panel, and the panel waits while it saves.
  const [gagsView, setGagsView] = useState<FactGagsView | null>(null);
  const [gagsReloadKey, setGagsReloadKey] = useState(0);
  const [gagsUnsaved, setGagsUnsaved] = useState(false);
  const [ideaSaving, setIdeaSaving] = useState(false);
  const onIdeaApplied = useCallback((view: FactGagsView) => {
    setGagsView(view);
    setGagsReloadKey((k) => k + 1);
  }, []);

  return (
    <div className="rounded-sm border border-border bg-muted/20" data-testid="fact-enrichment-panel">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center justify-between gap-2 p-3 text-left"
      >
        <span className="text-xs font-bold text-muted-foreground uppercase tracking-wide flex items-center gap-1.5">
          <Sparkles className="w-3.5 h-3.5 text-primary" /> Visual Taxonomy Enrichment
        </span>
        {expanded ? <ChevronDown className="w-4 h-4 text-muted-foreground" /> : <ChevronRight className="w-4 h-4 text-muted-foreground" />}
      </button>

      {expanded && (
        <div className="px-3 pb-3 space-y-2">
          {disabled && disabledReason && (
            <p className="text-xs text-amber-700 dark:text-amber-300" data-testid="enrichment-panel-disabled">
              {disabledReason}
            </p>
          )}
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
                  <span className="text-destructive">Save refused</span>
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
                 
                  className="text-xs text-primary underline hover:opacity-80 disabled:opacity-50 disabled:no-underline"
                >
                  Discard changes
                </button>
              )}
            </div>
          </div>

          {/* A refused save's reason can be several sentences (the prompt-budget
              refusal carries one per violated cap, #685), so it gets its own
              wrapping box below the header — the header's status slot cannot
              shrink and would push the sentence past the panel edge. */}
          {draft.commitError && (
            <div className="flex items-start gap-2 rounded-sm border border-destructive/50 bg-destructive/10 px-3 py-2" data-testid="enrichment-commit-error">
              <AlertCircle className="w-4 h-4 text-destructive shrink-0 mt-0.5" />
              <p className="text-sm text-destructive min-w-0 break-words">{draft.commitError}</p>
            </div>
          )}
          {draft.loading && !enrichment && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="w-3 h-3 animate-spin" /> Loading enrichment…
            </div>
          )}
          {/* The fact's gags (plans PLAN_THREE_GAGS.md and PLAN_GAG_EXAMPLES.md):
              each with its examples, editor and male, female and pet test
              renders; a change reaches users once all three are approved.
              Read-only while a refresh is open. */}
          <GagsPanel
            factId={fact.id}
            characters={enrichment?.characters}
            reviewId={null}
            rendersEnabled
            subjectNames={[...DEFAULT_SUBJECT_EXAMPLE_NAMES]}
            reloadKey={gagsReloadKey}
            onView={setGagsView}
            onUnsavedChange={(names) => setGagsUnsaved(names.length > 0)}
            disabled={disabled || ideaSaving}
          />
          {/* Draft more gags (plan increment 2): the gag writer on a live
              fact, outside any review; hidden while a review is open. */}
          <LiveGagIdeas
            factId={fact.id}
            gagsView={gagsView}
            onApplied={onIdeaApplied}
            unsavedGagEdits={gagsUnsaved}
            onSavingChange={setIdeaSaving}
            disabled={disabled}
          />
          {/* The taxonomy lives here only (plan PLAN_GAG_DIRECT_RENDER.md, F;
              David, Q2: 1): the AI's classification of the fact, kept for AI
              and code to use. The gags above are what shapes a picture. */}
          <section className="space-y-1" data-testid="ai-classification">
            <h3 className="text-sm font-bold text-foreground">AI classification</h3>
            <p className="text-xs text-muted-foreground">
              How the AI classified this fact. It is used by AI and code (finding similar facts, filtering); the gags above,
              not this, decide what a picture shows.
            </p>
          </section>
          <EnrichmentEditor
            value={enrichment}
            status={enrichmentStatus}
            factText={fact.text}
            onChange={(next) => { if (!disabled) draft.setValue(next); }}
            onSave={
              !disabled && draft.hasUncommittedChanges
                ? () => void draft.save()
                : undefined
            }
            onRerun={disabled ? undefined : rerunWithConfirm}
            busy={busy}
            rerunBusy={jobs.rerunBusy}
            overrideContext={disabled ? undefined : overrideContext}
          />
          {overrideError && !disabled && (
            <div className="flex items-start gap-2 rounded-sm border border-destructive/50 bg-destructive/10 px-3 py-2">
              <AlertCircle className="w-4 h-4 text-destructive shrink-0 mt-0.5" />
              <p className="text-sm text-destructive">{overrideError}</p>
            </div>
          )}
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
      )}
    </div>
  );
}

/** One row in the Facts list. */
function FactListRow({
  fact,
  isSelected,
  onSelect,
  onDelete,
}: {
  fact: Fact;
  isSelected: boolean;
  onSelect: () => void;
  onDelete: () => void;
}) {
  return (
    <div
      onClick={onSelect}
      className={`flex items-start gap-2 px-4 py-3 cursor-pointer group transition-colors ${
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
          {fact.hasEnrichmentOverrides && (
            fact.enrichmentBaselineChanged ? (
              <span className="inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-semibold bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/30" title="A manual override's AI baseline has changed — needs review">
                override needs review
              </span>
            ) : (
              <span className="inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-semibold bg-primary/10 text-primary border border-primary/30" title="This fact has manual taxonomy overrides">
                overridden
              </span>
            )
          )}
          <span>{new Date(fact.createdAt).toLocaleDateString()}</span>
        </div>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <Pencil className={`w-3.5 h-3.5 transition-opacity ${isSelected ? "text-primary opacity-100" : "text-muted-foreground opacity-0 group-hover:opacity-100"}`} />
        <button
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
          className="p-1 text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100 transition-all"
          title="Delete fact"
        >
          <Trash2 className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}

export default function AdminFacts() {
  const [facts, setFacts] = useState<Fact[]>([]);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<FactsTab>("facts");
  const [visibilityFilter, setVisibilityFilter] = useState<FactVisibilityFilter>("active");
  const [onlyOverridden, setOnlyOverridden] = useState(false);
  const [onlyBaselineChanged, setOnlyBaselineChanged] = useState(false);

  const [selectedFact, setSelectedFact] = useState<Fact | null>(null);
  const selectedFactRef = useRef<Fact | null>(null);
  selectedFactRef.current = selectedFact;
  const [saveResult, setSaveResult] = useState<{ type: "success" | "error"; message: string } | null>(null);

  const [importMode, setImportMode] = useState<ImportMode>("lines");
  const [importText, setImportText] = useState("");
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // The selected fact's enrichment version history (read-only).
  const [versionInfo, setVersionInfo] = useState<EnrichmentVersionInfo | null>(null);
  const [versionInfoLoading, setVersionInfoLoading] = useState(false);

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

  // The fact edit form follows the universal local-draft model:
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
      // A fact's wording is locked once accepted (plan PLAN_THREE_GAGS.md,
      // increment 3): the editor shows it read-only and never sends it.
      const body: Record<string, unknown> = {
        isActive: v.isActive,
        upvotes: Number(v.upvotes),
        downvotes: Number(v.downvotes),
        score: Number(v.score),
        wilsonScore: Number(v.wilsonScore),
        commentCount: Number(v.commentCount),
        shareCount: Number(v.shareCount),
        submittedById: v.submittedById || null,
      };
      const result = await patchFactDraft<Fact>(sf.id, body);
      switch (result.kind) {
        case "saved":
          setFacts((prev) => prev.map((f) => (f.id === result.fact.id ? result.fact : f)));
          setSelectedFact(result.fact);
          setSaveResult({ type: "success", message: "Saved successfully." });
          // Adopt the server-normalized row as the new baseline (kills a phantom
          // "unsaved change" from normalization).
          return factToEditDraft(result.fact);
        case "wording_locked":
          setSaveResult({ type: "error", message: result.message });
          throw new CommitInterruption();
        case "error":
          throw new Error(result.message);
      }
    },
  });
  const draft = editForm.value;

  const LIMIT = 25;

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 400);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => { setPage(1); }, [debouncedSearch, visibilityFilter]);

  useEffect(() => {
    setLoading(true);
    const params = new URLSearchParams({
      page: String(page),
      limit: String(LIMIT),
      ...(debouncedSearch ? { search: debouncedSearch } : {}),
      ...(visibilityFilter !== "active" ? { visibility: visibilityFilter } : {}),
      ...(onlyOverridden ? { hasOverrides: "true" } : {}),
      ...(onlyBaselineChanged ? { baselineChanged: "true" } : {}),
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
  }, [page, debouncedSearch, visibilityFilter, onlyOverridden, onlyBaselineChanged, refreshNonce]);

  function selectFact(fact: Fact) {
    setSelectedFact(fact);
    setSaveResult(null);
  }

  function clearSelection() {
    setSelectedFact(null);
    setSaveResult(null);
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

  // Deactivate: the only removal until the fact sheet's guarded delete (plan
  // PLAN_FACT_LIFECYCLE_REBUILD.md, 1F). Members' memes, pictures and
  // comments stay.
  async function deleteFact() {
    if (!selectedFact) return;
    setDeleting(true);
    try {
      const url = `/api/admin/facts/${selectedFact.id}`;
      const res = await fetch(url, { method: "DELETE", credentials: "include" });
      const data = (await res.json()) as { success?: boolean; error?: string };
      if (!res.ok) throw new Error(data.error ?? "Delete failed");
      setFacts((prev) => prev.filter((f) => f.id !== selectedFact.id));
      setTotal((t) => t - 1);
      clearSelection();
      setShowDeleteModal(false);
    } catch (err) {
      setSaveResult({ type: "error", message: err instanceof Error ? err.message : "Delete failed" });
      setShowDeleteModal(false);
    } finally {
      setDeleting(false);
    }
  }

  // ── Enrichment version history ──────────────────────────────────────────────

  const loadVersionInfo = useCallback(async (factId: number) => {
    setVersionInfoLoading(true);
    try {
      const res = await fetch(`/api/admin/facts/${factId}/enrichment-versions`, { credentials: "include" });
      if (res.ok && selectedFactRef.current?.id === factId) {
        setVersionInfo((await res.json()) as EnrichmentVersionInfo);
      }
    } catch {
      /* best-effort; the panel just shows no history */
    } finally {
      setVersionInfoLoading(false);
    }
  }, []);

  useEffect(() => {
    setVersionInfo(null);
    if (selectedFact?.id != null) void loadVersionInfo(selectedFact.id);
    // Refetch only when the SELECTED FACT changes — mutations refetch explicitly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedFact?.id, loadVersionInfo]);

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
      const data = (await res.json()) as { queued?: number; skipped?: number; error?: string };
      if (!res.ok) throw new Error(data.error ?? "Import failed");
      // Bulk import now LOADS the moderation queue — facts appear only after they
      // pass triage → enrichment → activation, not immediately.
      const skippedNote = data.skipped ? ` (${data.skipped} skipped as duplicates)` : "";
      setImportResult({ type: "success", message: `Queued ${data.queued ?? 0} fact(s) for moderation${skippedNote}. They'll appear after review.` });
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
      {showDeleteModal && selectedFact && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="bg-card border border-border rounded-lg w-full max-w-sm p-6 flex flex-col gap-5 shadow-xl">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-destructive/10 flex items-center justify-center shrink-0">
                <EyeOff className="w-5 h-5 text-destructive" />
              </div>
              <div>
                <h2 className="font-display font-bold text-foreground uppercase tracking-wide">Deactivate Fact</h2>
                <p className="text-xs text-muted-foreground mt-0.5">#{selectedFact.id}</p>
              </div>
            </div>
            <p className="text-sm text-muted-foreground line-clamp-2 italic">"{selectedFact.text}"</p>
            <p className="text-sm text-muted-foreground">
              Takes the fact off the site. Members' memes, pictures and comments are kept.
            </p>
            <div className="flex gap-3">
              <Button onClick={() => void deleteFact()} isLoading={deleting} className="flex-1" data-testid="deactivate-fact-confirm">
                <EyeOff className="w-4 h-4" /> Deactivate
              </Button>
              <Button variant="outline" onClick={() => setShowDeleteModal(false)} className="flex-1" disabled={deleting}>
                Cancel
              </Button>
            </div>
          </div>
        </div>
      )}

      <div className="mb-4 flex gap-2 border-b border-border">
        <button
          type="button"
          onClick={() => setActiveTab("facts")}
          className={`px-4 py-2 text-sm font-bold uppercase tracking-wide border-b-2 transition-colors ${activeTab === "facts" ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground"}`}
        >
          Facts
        </button>
        <button
          type="button"
          onClick={() => setActiveTab("utilities")}
          className={`px-4 py-2 text-sm font-bold uppercase tracking-wide border-b-2 transition-colors ${activeTab === "utilities" ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground"}`}
        >
          Utilities
        </button>
      </div>

      {activeTab === "facts" ? (
      <div className={`grid grid-cols-1 gap-6 xl:items-start ${selectedFact ? "xl:grid-cols-2" : ""}`}>

        {/* Left — fact list */}
        <div className="bg-card border border-border rounded-lg overflow-hidden flex flex-col xl:h-[calc(100dvh-7rem)]">
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
            <label className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground shrink-0">
              <span>Show</span>
              <select
                value={visibilityFilter}
                onChange={(e) => setVisibilityFilter(e.target.value as FactVisibilityFilter)}
                className="h-9 rounded-sm border border-border bg-background px-2 text-xs font-medium text-foreground focus:outline-none focus:border-primary"
                aria-label="Show facts"
              >
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
                <option value="both">Both</option>
              </select>
            </label>
            <button
              onClick={() => { setOnlyOverridden((v) => !v); setPage(1); }}
              className={`flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium border rounded-sm transition-colors shrink-0 ${
                onlyOverridden
                  ? "bg-primary/10 text-primary border-primary/30"
                  : "text-muted-foreground border-border hover:border-primary/40 hover:text-foreground"
              }`}
              title="Show only facts with manual taxonomy overrides"
            >
              <Sparkles className="w-3.5 h-3.5" />
              Overridden
            </button>
            <button
              onClick={() => { setOnlyBaselineChanged((v) => !v); setPage(1); }}
              className={`flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium border rounded-sm transition-colors shrink-0 ${
                onlyBaselineChanged
                  ? "bg-amber-500/10 text-amber-600 border-amber-500/30"
                  : "text-muted-foreground border-border hover:border-primary/40 hover:text-foreground"
              }`}
              title="Show only overrides whose AI baseline has changed (needs review)"
            >
              <AlertCircle className="w-3.5 h-3.5" />
              Needs review
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
              facts.map((fact) => (
                <FactListRow
                  key={fact.id}
                  fact={fact}
                  isSelected={selectedFact?.id === fact.id}
                  onSelect={() => selectFact(fact)}
                  onDelete={() => { selectFact(fact); setShowDeleteModal(true); }}
                />
              ))
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
          <div className="bg-card border border-border rounded-lg flex flex-col xl:h-[calc(100dvh-7rem)] xl:overflow-y-auto">
            {/* Header — sticky within the scrolling panel */}
            <div className="flex items-center justify-between sticky top-0 bg-card z-10 px-5 pt-5 pb-4 border-b border-border shrink-0">
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

            {/* Scrollable body */}
            <div className="p-5 flex flex-col gap-4">

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
              <p data-testid="fact-wording" className="text-sm bg-muted/30 rounded-sm px-3 py-2 border border-border whitespace-pre-wrap">
                {selectedFact.text}
              </p>
              <p data-testid="fact-wording-locked-note" className="text-xs text-muted-foreground mt-1">
                A fact&apos;s wording can&apos;t be changed once it&apos;s accepted. If the wording is wrong, deactivate this fact and submit the corrected wording as a new fact.
              </p>
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

            {/* Active toggle — deactivate-only. Activation is moderation-only
                (Phase 2 fact-lifecycle closure): the server rejects any
                false→true PATCH, so this toggle can only ever turn a fact off,
                never back on — disabled + explained rather than a control that
                always errors. */}
            <div className="flex items-center justify-between py-2 border border-border rounded-md px-3">
              <div>
                <p className="text-sm font-medium">Active</p>
                <p className="text-xs text-muted-foreground">
                  {draft.isActive
                    ? "Inactive facts are hidden from the public."
                    : "Deactivated facts can only go live again through moderation."}
                </p>
              </div>
              <button
                type="button"
                disabled={!draft.isActive}
                onClick={() => draft.isActive && editForm.setValue((d) => d ? { ...d, isActive: false } : d)}
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none ${
                  draft.isActive ? "bg-green-500" : "bg-muted-foreground/30 cursor-not-allowed opacity-60"
                }`}
                title={draft.isActive ? "Click to deactivate" : "Deactivated — re-moderate to reactivate"}
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

            {/* Identity fields */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
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

            {/* Visual Taxonomy Enrichment — the shared editor (same as moderation).
                Edit + autosave the metadata, regenerate the visual preview, or
                re-run classification to tune a fact rendering bad images.
                Collapsible; starts closed. */}
            <div className="border-t border-border pt-3">
              <FactEnrichmentPanel
                key={selectedFact.id}
                fact={selectedFact}
                onSaved={(resp) => applyEnrichmentSave(selectedFact.id, resp)}
              />
            </div>

            {/* Enrichment version history (read-only) */}
            <div className="border-t border-border pt-3">
              <FactEnrichmentVersionHistory info={versionInfo} loading={versionInfoLoading} />
            </div>

            {/* Wording edits made before the wording lock (read-only history) */}
            <div className="border-t border-border pt-3">
              <FactTextEditHistory key={selectedFact.id} factId={selectedFact.id} />
            </div>

            {/* Runtime Compiled Prompt Preview (Phase 2C) — the ACTUAL render-time
                engine prompt for a chosen render context. Distinct from the
                enrichment editor's preview-only example prompts below. Shown for
                any selected fact; it reads the fact's saved enrichment by id. The
                component renders its own collapsible bordered header. */}
            <div className="border-t border-border pt-3">
              <RuntimePromptPreview factId={selectedFact.id} />
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

            {selectedFact.isActive && (
              <div className="border-t border-border pt-3">
                <Button
                  variant="outline"
                  onClick={() => setShowDeleteModal(true)}
                  className="w-full text-destructive border-destructive/30 hover:bg-destructive/10 hover:border-destructive/60"
                  data-testid="deactivate-fact-button"
                >
                  <EyeOff className="w-4 h-4" /> Deactivate Fact
                </Button>
              </div>
            )}

            </div>{/* end scrollable body */}
          </div>
        ) : null}
      </div>
      ) : (
          <div className="bg-card border border-border rounded-lg p-5 flex flex-col gap-4 xl:min-h-[calc(100dvh-7rem)]">
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
              className="font-mono text-xs resize-y min-h-[320px]"
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
    </AdminLayout>
  );
}
