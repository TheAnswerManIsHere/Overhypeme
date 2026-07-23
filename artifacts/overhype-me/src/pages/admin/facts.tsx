import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AdminLayout } from "@/components/admin/AdminLayout";
import { RuntimePromptPreview } from "@/components/admin/RuntimePromptPreview";
import { Button } from "@/components/ui/Button";
import { Textarea, Input } from "@/components/ui/Input";
import { Trash2, Upload, Search, AlertCircle, CheckCircle, Pencil, X, Save, GitBranch, Plus, Brain, EyeOff, RefreshCw, ImageIcon, Loader2, Sparkles, ChevronRight, ChevronDown } from "lucide-react";
import type { FactEnrichment } from "@workspace/api-zod";
import { EnrichmentEditor } from "@/components/admin/EnrichmentEditor";
import { VisualConceptCard } from "@/components/admin/VisualConceptCard";
import { DEFAULT_SUBJECT_EXAMPLE_NAMES } from "@/components/admin/subjectExampleNames";
import { GoldenToggle } from "@/components/admin/GoldenToggle";
import { SendBackToReviewModal } from "@/components/admin/SendBackToReviewModal";
import { sendFactBackToReview } from "@/components/admin/sendBackToReview";
import { PexelsImageGallery, emptyPexelsImages, pexelsImageTotals, type PexelsGender, type PexelsThumb } from "@/components/admin/PexelsImageGallery";
import { FactEnrichmentVersionHistory, type EnrichmentVersionInfo } from "@/components/admin/FactEnrichmentVersionHistory";
import { useDraftForm, CommitInterruption } from "@/components/admin/useDraftForm";
import { patchFactDraft } from "@/components/admin/patchFactDraft";
import { ApprovedFactTextEditModal } from "@/components/admin/ApprovedFactTextEditModal";
import { FactTextEditHistory } from "@/components/admin/FactTextEditHistory";
import type { ApprovedFactTextEditImpact, ConfirmTextEdit } from "@workspace/api-zod";
import {
  useFactEnrichmentEditing,
  type EnrichmentSaveResponse,
} from "@/components/admin/useFactEnrichmentEditing";

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
  hasEnrichmentOverrides?: boolean;
  enrichmentBaselineChanged?: boolean;
  /** Eval harness (Slice 2B): golden-set membership. */
  evalGolden?: boolean;
  evalGoldenReason?: string | null;
  // Root facts carry their variants nested (the list paginates by root). When
  // searching, this holds only the variants that matched. Absent on variant rows.
  variants?: Fact[];
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
type FactsTab = "facts" | "utilities";
type FactVisibilityFilter = "active" | "inactive" | "both";

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


interface FactPexelsResponse {
  pexelsStatus: "pending" | "ok" | "failed" | null;
  factType: "action" | "abstract" | null;
  keywords: Record<PexelsGender, string> | null;
  images: Record<PexelsGender, PexelsThumb[]>;
}

function AdminFactPexelsGallery({ factId, refreshNonce }: { factId: number; refreshNonce: number }) {
  const [expanded, setExpanded] = useState(false);
  const [data, setData] = useState<FactPexelsResponse | null>(null);
  const [loaded, setLoaded] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/admin/facts/${factId}/pexels-images`, { credentials: "include" });
      if (!res.ok) return;
      const next = (await res.json()) as FactPexelsResponse;
      setData(next);
      setLoaded(true);
    } catch {
      setLoaded(true);
    }
  }, [factId]);

  useEffect(() => { setLoaded(false); void load(); }, [load, refreshNonce]);

  // While the image pipeline is running (pexelsStatus "pending"), poll at ~1s
  // with no timeout so the gallery fills in live instead of relying on a
  // fixed-delay guess at when the background job finishes.
  useEffect(() => {
    const clear = () => { if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; } };
    if (data?.pexelsStatus === "pending") {
      if (!timerRef.current) timerRef.current = setInterval(() => { void load(); }, 1000);
    } else {
      clear();
    }
    return clear;
  }, [data?.pexelsStatus, load]);

  const images = data?.images ?? emptyPexelsImages();
  const totals = pexelsImageTotals(images);
  const status = data?.pexelsStatus ?? null;

  return (
    <div className="rounded-sm border border-border bg-muted/20">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center justify-between gap-2 p-3 text-left"
      >
        <span className="text-xs font-bold text-muted-foreground uppercase tracking-wide flex items-center gap-1.5">
          <ImageIcon className="w-3.5 h-3.5" /> Pexels thumbnails
          <span className="font-normal normal-case text-[10px] text-muted-foreground">
            {status === "pending" && <span className="inline-flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" /> seeding…</span>}
            {status !== "pending" && (!loaded ? "loading…" : `${totals.total} total · male ${totals.male} · female ${totals.female} · neutral ${totals.neutral}`)}
          </span>
        </span>
        {expanded ? <ChevronDown className="w-4 h-4 text-muted-foreground" /> : <ChevronRight className="w-4 h-4 text-muted-foreground" />}
      </button>

      {expanded && (
        <div className="px-3 pb-3 space-y-2">
          {!loaded && (
            <p className="text-[11px] text-muted-foreground flex items-center gap-1.5">
              <Loader2 className="w-3 h-3 animate-spin" /> Loading Pexels images…
            </p>
          )}
          {loaded && status === "pending" && (
            <p className="text-[11px] text-muted-foreground flex items-center gap-1.5">
              <Loader2 className="w-3 h-3 animate-spin" /> Seeding stock images — this view updates live; no refresh needed.
            </p>
          )}
          {loaded && status !== "pending" && totals.total === 0 && (
            <p className="text-[11px] text-muted-foreground italic">
              No Pexels images are currently stored for this fact.
            </p>
          )}
          {loaded && totals.total > 0 && (
            <PexelsImageGallery data={{ keywords: data?.keywords ?? null, images }} />
          )}
        </div>
      )}
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
    vsoTokenizing, vsoTokenizeErrors, tokenizeAndSaveVisualOverride,
  } = useFactEnrichmentEditing({
      target: { kind: "fact", factId: fact.id },
      enabled: true,
      initialStatus: fact.enrichmentStatus ?? null,
      onSaved,
    });

  const busy = draft.loading || draft.committing || jobs.loading || jobs.rerunBusy || disabled || vsoTokenizing;
  const [expanded, setExpanded] = useState(false);

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
                {vsoTokenizing ? (
                  <span className="flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" />Tokenizing and saving…</span>
                ) : draft.committing ? (
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
                  disabled={vsoTokenizing}
                  className="text-xs text-primary underline hover:opacity-80 disabled:opacity-50 disabled:no-underline"
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
          {/* Visual Concept — the single prominent scene surface (the scene field
              was removed from the Advanced Options panel below). Required + blocking. */}
          <VisualConceptCard
            value={enrichment?.visualPromptStrategyOverride}
            disabled={disabled || vsoTokenizing || draft.committing || draft.loading || !enrichment}
            tokenizeError={vsoTokenizeErrors["coreSceneOverride"]}
            onChange={(next) => { if (!disabled && enrichment) draft.setValue({ ...enrichment, visualPromptStrategyOverride: next }); }}
          />
          <EnrichmentEditor
            value={enrichment}
            status={enrichmentStatus}
            factText={fact.text}
            onChange={(next) => { if (!disabled) draft.setValue(next); }}
            onSave={
              !disabled && draft.hasUncommittedChanges
                ? () => void tokenizeAndSaveVisualOverride([...DEFAULT_SUBJECT_EXAMPLE_NAMES])
                : undefined
            }
            onRerun={disabled ? undefined : rerunWithConfirm}
            busy={busy}
            rerunBusy={jobs.rerunBusy}
            overrideContext={disabled ? undefined : overrideContext}
            vsoTokenizing={vsoTokenizing}
            vsoTokenizeErrors={vsoTokenizeErrors}
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
              disabled={!draft.hasUncommittedChanges || draft.committing || vsoTokenizing}
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

/**
 * One row in the Facts list. Used for both root facts and (indented) variants.
 * Root rows with variants get a chevron toggle + count; variant rows are
 * indented and never carry their own chevron.
 */
function FactListRow({
  fact,
  isSelected,
  indented = false,
  variantCount = 0,
  expanded = false,
  onToggleExpand,
  onSelect,
  onDelete,
}: {
  fact: Fact;
  isSelected: boolean;
  indented?: boolean;
  variantCount?: number;
  expanded?: boolean;
  onToggleExpand?: () => void;
  onSelect: () => void;
  onDelete: () => void;
}) {
  return (
    <div
      onClick={onSelect}
      className={`flex items-start gap-2 px-4 py-3 cursor-pointer group transition-colors ${
        isSelected ? "bg-primary/10 border-l-2 border-primary" : "hover:bg-muted/40 border-l-2 border-transparent"
      } ${!fact.isActive ? "opacity-50" : ""} ${indented ? "pl-10 bg-muted/20" : ""}`}
    >
      {/* Chevron toggle (root rows with variants) or a tree guide (variant rows). */}
      {variantCount > 0 ? (
        <button
          onClick={(e) => { e.stopPropagation(); onToggleExpand?.(); }}
          className="mt-0.5 shrink-0 text-muted-foreground hover:text-foreground"
          title={expanded ? "Collapse variants" : "Expand variants"}
          aria-label={expanded ? "Collapse variants" : "Expand variants"}
        >
          {expanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        </button>
      ) : (
        <span className="w-4 shrink-0" aria-hidden />
      )}
      <div className="mt-1 shrink-0">
        <div className={`w-2 h-2 rounded-full ${fact.isActive ? "bg-green-500" : "bg-red-500"}`} title={fact.isActive ? "Active" : "Inactive"} />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm text-foreground leading-snug line-clamp-2">{fact.text}</p>
        <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-1 text-xs text-muted-foreground">
          <span className="font-mono">#{fact.id}</span>
          {indented && <span className="inline-flex items-center gap-1 text-muted-foreground"><GitBranch className="inline w-3 h-3" />variant</span>}
          {!indented && variantCount > 0 && (
            <span className="inline-flex items-center gap-1 text-muted-foreground" title={`${variantCount} variant${variantCount === 1 ? "" : "s"}`}>
              <GitBranch className="inline w-3 h-3" />{variantCount}
            </span>
          )}
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
  const [expandedRoots, setExpandedRoots] = useState<Set<number>>(new Set());
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
  const [variants, setVariants] = useState<FactVariant[]>([]);
  const [loadingVariants, setLoadingVariants] = useState(false);
  const [newVariantText, setNewVariantText] = useState("");
  const [addingVariant, setAddingVariant] = useState(false);
  const [showAddVariant, setShowAddVariant] = useState(false);
  const [saveResult, setSaveResult] = useState<{ type: "success" | "error"; message: string } | null>(null);

  // Approved-fact-text lock: the confirmation modal + the pending confirmation
  // the commit re-runs with. The commit callback owns opening/closing the modal.
  const pendingConfirmationRef = useRef<ConfirmTextEdit | null>(null);
  const [textEditModal, setTextEditModal] = useState<{ impact: ApprovedFactTextEditImpact } | null>(null);
  const [textEditModalError, setTextEditModalError] = useState<string | null>(null);
  const [textEditModalBusy, setTextEditModalBusy] = useState(false);

  const [importMode, setImportMode] = useState<ImportMode>("lines");
  const [importText, setImportText] = useState("");
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [deleteModal, setDeleteModal] = useState<null | "choose" | "confirm-hard">(null);
  const [deleting, setDeleting] = useState(false);

  // Stale-fact refresh: the selected fact's version history + in-flight cycle
  // (drives the send-back button state and the live-editor freeze notice).
  const [versionInfo, setVersionInfo] = useState<EnrichmentVersionInfo | null>(null);
  const [versionInfoLoading, setVersionInfoLoading] = useState(false);
  const [sendBackModal, setSendBackModal] = useState(false);
  const [sendingBack, setSendingBack] = useState(false);

  // Image pipeline state
  const [pipelineRunning, setPipelineRunning] = useState(false);
  const [pipelineResult, setPipelineResult] = useState<{ type: "success" | "info" | "error"; message: string } | null>(null);
  const [pexelsGalleryRefreshNonce, setPexelsGalleryRefreshNonce] = useState(0);

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
      // Delta PATCH: only send `text` when it actually differs from the server
      // baseline, so a score/use-case-only save never trips the approved-fact
      // confirmation gate. The server compares normalized-vs-stored regardless.
      const body: Record<string, unknown> = {
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
      if (v.text !== sf.text) body.text = v.text;

      // Consume any pending confirmation (set by the modal's Confirm).
      const confirmation = pendingConfirmationRef.current ?? undefined;
      pendingConfirmationRef.current = null;

      const result = await patchFactDraft<Fact>(sf.id, body, confirmation);
      switch (result.kind) {
        case "saved": {
          setFacts((prev) => prev.map((f) => (f.id === result.fact.id ? result.fact : f)));
          setSelectedFact(result.fact);
          setTextEditModal(null);
          setTextEditModalError(null);
          let message = "Saved successfully.";
          if (result.prepDispatch) message = "Saved. Prep restarted — enrichment and images are regenerating; re-approve the concept when ready.";
          else if (result.affectedVariantCount && result.affectedVariantCount > 0) message = `Saved. ${result.affectedVariantCount} variant${result.affectedVariantCount === 1 ? "" : "s"} marked stale for review.`;
          setSaveResult({ type: "success", message });
          // Adopt the server-normalized row as the new baseline (kills a phantom
          // "unsaved change" from normalization).
          return factToEditDraft(result.fact);
        }
        case "confirmation_required":
          setTextEditModal({ impact: result.impact });
          setTextEditModalError(null);
          throw new CommitInterruption();
        case "stale_baseline":
          // The stored wording moved under us. Rebase the baseline to the new
          // server text C (Discard now returns to C), keep the draft B, and
          // re-open the modal on the fresh C→B diff.
          editForm.rebaseBaseline({ ...factToEditDraft(sf), text: result.impact.currentStoredText });
          setSelectedFact({ ...sf, text: result.impact.currentStoredText });
          setTextEditModal({ impact: result.impact });
          setTextEditModalError(confirmation ? "The stored text changed since you opened this — review the updated diff and confirm again." : null);
          throw new CommitInterruption();
        case "dependent_variant_in_progress":
          setTextEditModal(null);
          setSaveResult({ type: "error", message: `Can't re-word this parent: ${result.affectedVariantCount} variant${result.affectedVariantCount === 1 ? " is" : "s are"} mid-review (e.g. fact #${result.blockingVariants[0]?.factId}). Resolve or finish those first.` });
          throw new CommitInterruption();
        case "staging_prep_in_progress":
          setTextEditModal(null);
          setSaveResult({ type: "error", message: "Prep is still running for this fact. Wait for it to finish, then edit." });
          throw new CommitInterruption();
        case "error":
          throw new Error(result.message);
      }
    },
  });
  const draft = editForm.value;

  // Modal Confirm → stash the envelope + re-run the commit (which sends it and
  // owns the outcome: close on success, re-open on a fresh stale baseline).
  const handleTextEditConfirm = useCallback(async (confirmation: ConfirmTextEdit) => {
    pendingConfirmationRef.current = confirmation;
    setTextEditModalBusy(true);
    setTextEditModalError(null);
    try {
      await editForm.save();
    } finally {
      setTextEditModalBusy(false);
    }
  }, [editForm]);

  const handleTextEditCancel = useCallback(() => {
    pendingConfirmationRef.current = null;
    setTextEditModal(null);
    setTextEditModalError(null);
  }, []);

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
          // While searching, results are grouped under their parent — auto-expand
          // roots that have matching variants so the matches are visible without a
          // click. While browsing, start collapsed.
          setExpandedRoots(
            debouncedSearch
              ? new Set(data.facts.filter((f) => (f.variants?.length ?? 0) > 0).map((f) => f.id))
              : new Set(),
          );
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [page, debouncedSearch, visibilityFilter, onlyOverridden, onlyBaselineChanged, refreshNonce]);

  function selectFact(fact: Fact) {
    setSelectedFact(fact);
    setSaveResult(null);
    setShowAddVariant(false);
    setNewVariantText("");
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
        // The gallery itself polls while the pipeline is "pending" (see
        // AdminFactPexelsGallery), so just kick off its first fetch now rather
        // than guessing a fixed delay for when the background job finishes.
        setFacts((prev) => prev.map((f) => f.id === factId ? { ...f, hasPexelsImages: true } : f));
        if (selectedFact?.id === factId) {
          setSelectedFact((f) => f ? { ...f, hasPexelsImages: true } : f);
          setPexelsGalleryRefreshNonce((n) => n + 1);
        }
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
        body: JSON.stringify({ text: newVariantText.trim() }),
      });
      const data = (await res.json()) as { success?: boolean; queued?: boolean; reviewId?: number; error?: string };
      if (!res.ok) throw new Error(data.error ?? "Failed to add variant");
      // A variant is now a normal moderated submission: it enters the triage
      // queue instead of appearing immediately, and shows up nested under its
      // parent only once it's approved through moderation. use_case has no home
      // pre-moderation (createTriageReview carries no such field, and the fact
      // doesn't exist yet) — set it via the normal fact editor once approved.
      setNewVariantText("");
      setShowAddVariant(false);
      alert("Variant queued for review. It'll appear under this fact once it's approved through moderation. Set its use case afterward from the fact editor.");
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
    setRefreshNonce((n) => n + 1); // refresh the list so the removed variant drops out of the hierarchy
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

  // ── Stale-fact refresh: version info + send-back ────────────────────────────

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
    setSendBackModal(false);
    if (selectedFact?.id != null) void loadVersionInfo(selectedFact.id);
    // Refetch only when the SELECTED FACT changes — mutations refetch explicitly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedFact?.id, loadVersionInfo]);

  async function sendBackToReview(clearOverrides: boolean) {
    if (!selectedFact) return;
    const factId = selectedFact.id;
    setSendingBack(true);
    try {
      const result = await sendFactBackToReview(factId, { clearOverrides });
      if (result.success) {
        setSendBackModal(false);
        setSaveResult({
          type: "success",
          message: `Sent back to review — Review #${result.reviewId} is preparing a refresh candidate. The fact stays live; approve or reject the refresh from the Moderation queue.`,
        });
        // The send-back flips the live pill to "classifying…" — mirror it locally.
        setFacts((prev) => prev.map((f) => (f.id === factId ? { ...f, enrichmentStatus: "pending" } : f)));
        setSelectedFact((prev) => (prev && prev.id === factId ? { ...prev, enrichmentStatus: "pending" } : prev));
      } else {
        setSendBackModal(false);
        setSaveResult({ type: "error", message: result.error ?? "Send back failed" });
      }
      // Either way the in-flight state may have changed (success, or a
      // REFRESH_ALREADY_IN_PROGRESS race) — refetch so the button/notice track it.
      void loadVersionInfo(factId);
    } finally {
      setSendingBack(false);
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
      {/* Approved-fact text-edit confirmation (dire-warning) modal */}
      {textEditModal && (
        <ApprovedFactTextEditModal
          impact={textEditModal.impact}
          busy={textEditModalBusy}
          error={textEditModalError}
          onConfirm={(c) => void handleTextEditConfirm(c)}
          onCancel={handleTextEditCancel}
        />
      )}

      {/* Send Back to Review (stale-fact refresh) confirm modal */}
      {sendBackModal && selectedFact && (
        <SendBackToReviewModal
          factId={selectedFact.id}
          factText={selectedFact.text}
          busy={sendingBack}
          onCancel={() => setSendBackModal(false)}
          onConfirm={(clearOverrides) => void sendBackToReview(clearOverrides)}
        />
      )}

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
              facts.map((root) => {
                const variants = root.variants ?? [];
                const expanded = expandedRoots.has(root.id);
                return (
                  <Fragment key={root.id}>
                    <FactListRow
                      fact={root}
                      isSelected={selectedFact?.id === root.id}
                      variantCount={variants.length}
                      expanded={expanded}
                      onToggleExpand={() =>
                        setExpandedRoots((prev) => {
                          const next = new Set(prev);
                          if (next.has(root.id)) next.delete(root.id);
                          else next.add(root.id);
                          return next;
                        })
                      }
                      onSelect={() => selectFact(root)}
                      onDelete={() => { selectFact(root); setDeleteModal("choose"); }}
                    />
                    {expanded && variants.map((v) => (
                      <FactListRow
                        key={v.id}
                        fact={v}
                        isSelected={selectedFact?.id === v.id}
                        indented
                        onSelect={() => selectFact(v)}
                        onDelete={() => { selectFact(v); setDeleteModal("choose"); }}
                      />
                    ))}
                  </Fragment>
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
              {/* Eval golden-set membership (Slice 2B). Keyed by fact id so it
                  re-initializes when the moderator switches facts. */}
              <GoldenToggle
                key={selectedFact.id}
                factId={selectedFact.id}
                isActive={selectedFact.isActive}
                initialGolden={!!selectedFact.evalGolden}
                onChange={(golden) => {
                  setSelectedFact((f) => (f ? { ...f, evalGolden: golden } : f));
                  setFacts((prev) => prev.map((f) => (f.id === selectedFact.id ? { ...f, evalGolden: golden } : f)));
                }}
              />
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
                      <Button size="sm" onClick={addVariant} isLoading={addingVariant} disabled={!newVariantText.trim()}>
                        Add
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => { setShowAddVariant(false); setNewVariantText(""); }}>
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
                  <AdminFactPexelsGallery factId={selectedFact.id} refreshNonce={pexelsGalleryRefreshNonce} />
                </div>
              </div>
            )}

            {/* Visual Taxonomy Enrichment — the shared editor (same as moderation).
                Edit + autosave the metadata, regenerate the visual preview, or
                re-run classification to tune a fact rendering bad images/videos.
                Collapsible; starts closed. */}
            {/* Refresh in review: the live enrichment is frozen (server-enforced);
                the notice + disabled editor make that visible instead of 409s. */}
            {versionInfo?.inFlight && (
              <div
                className="flex items-start gap-2 rounded-sm border border-amber-500/50 bg-amber-500/10 px-3 py-2.5"
                data-testid="refresh-in-flight-notice"
              >
                <RefreshCw className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
                <p className="text-sm text-amber-700 dark:text-amber-300">
                  <strong>Refresh in review</strong> — this fact's enrichment is frozen while review
                  {versionInfo.inFlight.reviewId != null ? ` #${versionInfo.inFlight.reviewId}` : ""} is in progress.
                  Edit the refresh candidate from the{" "}
                  <a href="/admin/moderation" className="underline hover:opacity-80">Moderation queue</a>, or approve/reject
                  it there to unfreeze this editor. The live fact keeps serving its current enrichment meanwhile.
                </p>
              </div>
            )}

            <div className="border-t border-border pt-3">
              <FactEnrichmentPanel
                key={selectedFact.id}
                fact={selectedFact}
                onSaved={(resp) => applyEnrichmentSave(selectedFact.id, resp)}
                disabled={Boolean(versionInfo?.inFlight)}
                disabledReason="Read-only: a refresh is in review for this fact. Edit the candidate from the Moderation queue."
              />
            </div>

            {/* Enrichment version history (read-only; stale-fact refresh) */}
            <div className="border-t border-border pt-3">
              <FactEnrichmentVersionHistory info={versionInfo} loading={versionInfoLoading} />
            </div>

            {/* Approved-fact text-edit audit history (read-only) */}
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

            {/* Send back to review (stale-fact refresh) — live facts only. */}
            {selectedFact.isActive && (
              <div className="border-t border-border pt-3">
                <Button
                  variant="outline"
                  onClick={() => setSendBackModal(true)}
                  disabled={Boolean(versionInfo?.inFlight) || versionInfoLoading}
                  className="w-full text-blue-600 dark:text-blue-400 border-blue-500/30 hover:bg-blue-500/10 hover:border-blue-500/60 gap-2"
                  data-testid="send-back-button"
                >
                  <RefreshCw className="w-4 h-4" />
                  {versionInfo?.inFlight ? "Refresh in review" : "Send Back to Review"}
                </Button>
                <p className="text-xs text-muted-foreground mt-1.5">
                  Re-runs enrichment with the current pipeline as a refresh candidate for moderator approval. The fact
                  stays live throughout.
                </p>
              </div>
            )}

            <div className="border-t border-border pt-3">
              <Button
                variant="outline"
                onClick={() => setDeleteModal("choose")}
                className="w-full text-destructive border-destructive/30 hover:bg-destructive/10 hover:border-destructive/60"
              >
                <Trash2 className="w-4 h-4" /> Delete Fact
              </Button>
            </div>

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
