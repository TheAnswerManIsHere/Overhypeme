import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, AlertTriangle, ImageIcon, Sparkles, Play } from "lucide-react";
import {
  type FactEnrichment,
  type RenderScenarioKey,
  type RenderScenarioCard,
} from "@workspace/api-zod";
import { CollapsibleSection } from "@/components/CollapsibleSection";
import { ModerationPexelsPanel } from "./ModerationPexelsPanel";
import { useFactRenderScenarios } from "./useFactRenderScenarios";
import { FactRenderScenarioTile } from "./FactRenderScenarioTile";
import { FinalHashtagsEditor } from "./FinalHashtagsEditor";

/**
 * Step-2 "Visual review" surface for the moderation wizard. Output-first: the
 * moderator sees the auto-generated test renders (the scenario grid) plus a
 * plain-English summary of how the AI interpreted the fact. The technical
 * enrichment/prompt machinery lives in Advanced Options (rendered by the modal,
 * not here).
 *
 * Pieces:
 *   (a) AI interpretation summary — built locally from the enrichment prop. No
 *       network call, no raw JSON.
 *   (b) The scenario grid of tiles (per-item live status, rule 8).
 *   (c) Checkboxes + "Run selected" → POST scenarios.
 *   (d) Aggregate tally line from grid.tally.
 *   (e) ModerationPexelsPanel as a secondary collapsed section below the grid.
 */

// ── (a) AI interpretation summary, in plain English ──────────────────────────

function humanize(s: string): string {
  return s.replace(/_/g, " ");
}

function AiInterpretationSummary({ enrichment }: { enrichment: FactEnrichment | null }) {
  const lines = useMemo(() => {
    if (!enrichment) return null;
    const warnings: string[] = [];
    if (enrichment.taxonomyConfidence < 0.75) warnings.push("Low classification confidence — sanity-check it.");
    if (enrichment.overhypeFit === "questionable") warnings.push("Overhype fit is questionable.");
    if (enrichment.overhypeFit === "reject") warnings.push("Flagged as a likely reject / rewrite.");
    if (enrichment.adultSuitability === "requires_review") warnings.push("Adult suitability needs review.");
    if (enrichment.visualComplexity === "high") warnings.push("Hard to visualize (high complexity).");

    const entities = (enrichment.semanticEntities ?? []).filter((e) => e.materiallyAffectsVisualPrompt);
    const culturalReview = (enrichment.culturalReferences ?? []).filter((r) => r.requiresAdminReview);

    return { warnings, entities, culturalReview };
  }, [enrichment]);

  if (!enrichment || !lines) {
    return (
      <div className="rounded-sm border border-border bg-muted/20 p-4">
        <p className="text-sm text-muted-foreground italic">
          No AI interpretation yet — enrichment hasn't produced a classification for this fact.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-sm border border-border bg-muted/20 p-4 space-y-2" data-testid="ai-interpretation-summary">
      <p className="text-xs font-bold text-muted-foreground uppercase tracking-wide flex items-center gap-1.5">
        <Sparkles className="w-3.5 h-3.5" /> How the AI read this fact
      </p>
      <p className="text-sm text-foreground leading-relaxed">
        Classified as a <strong>{humanize(enrichment.primaryArchetype)}</strong>
        {enrichment.subtype && <> ({humanize(enrichment.subtype)})</>}.
        {enrichment.modifiers.length > 0 && (
          <> Modifiers: <span className="text-muted-foreground">{enrichment.modifiers.map(humanize).join(", ")}</span>.</>
        )}{" "}
        Visual treatment: <span className="text-muted-foreground">{humanize(enrichment.visualLiteralness)}</span>,{" "}
        <span className="text-muted-foreground">{humanize(enrichment.visualComplexity)}</span> complexity.
      </p>

      {lines.entities.length > 0 && (
        <p className="text-xs text-foreground">
          <span className="text-muted-foreground">Key visual elements: </span>
          {lines.entities
            .map((e) => (e.visualReferent ? `${e.surfaceText} → ${e.visualReferent}` : e.surfaceText))
            .join("; ")}
        </p>
      )}

      {lines.culturalReview.length > 0 && (
        <p className="text-xs text-amber-700 dark:text-amber-300 flex items-start gap-1.5">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          Cultural reference needs review: {lines.culturalReview.map((r) => `"${r.sourcePhrase}"`).join(", ")}
        </p>
      )}

      {lines.warnings.length > 0 && (
        <div className="space-y-0.5 pt-1">
          {lines.warnings.map((w) => (
            <p key={w} className="text-xs text-amber-700 dark:text-amber-300 flex items-start gap-1.5">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" /> {w}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

// ── (c) Run-selected checkbox controls ───────────────────────────────────────

/** The four checkbox groups. "Non-human" targets whichever non-human card shows. */
type RunGroup = "generic_t2i" | "i2i_male_default" | "i2i_female_default" | "nonhuman";

const RUN_GROUP_LABELS: { id: RunGroup; label: string }[] = [
  { id: "generic_t2i", label: "Generic (t2i)" },
  { id: "i2i_male_default", label: "Male (i2i)" },
  { id: "i2i_female_default", label: "Female (i2i)" },
  { id: "nonhuman", label: "Non-human (i2i)" },
];

/** Resolve the non-human card currently shown in the grid (animal or object/vehicle). */
function nonHumanCard(cards: RenderScenarioCard[]): RenderScenarioCard | undefined {
  return cards.find(
    (c) => c.key === "i2i_nonhuman_animal" || c.key === "i2i_nonhuman_object_vehicle",
  );
}

export function FactVisualReviewGrid({
  reviewId,
  enrichment,
  enabled = true,
  reloadKey = 0,
  finalHashtags = [],
  onFinalHashtagsChange,
  hideFinalHashtags = false,
  onRunScenarios,
}: {
  reviewId: number;
  enrichment: FactEnrichment | null;
  enabled?: boolean;
  /** Bumped by the parent (e.g. after saving enrichment) to force a grid re-fetch
   *  so tiles recompute staleness against the newly-saved staging-fact enrichment. */
  reloadKey?: number;
  /** The moderator-curated final discovery tags (what ships on approval), owned
   *  by the modal. Rendered as a first-class section between the AI-interpretation
   *  summary and the render controls. */
  finalHashtags?: string[];
  onFinalHashtagsChange?: (tags: string[]) => void;
  /** REFRESH reviews hide the curation section — refresh approval never touches
   *  the live fact's discovery tags. */
  hideFinalHashtags?: boolean;
  /** Fired after a run/re-run is enqueued so the parent list can refresh + show
   *  a "renders working…" row pill and start polling (CLAUDE.md rule 8). */
  onRunScenarios?: () => void;
}) {
  const { grid, loading, error, runScenarios, refresh } = useFactRenderScenarios(reviewId, { enabled });
  const [selected, setSelected] = useState<Set<RunGroup>>(new Set());

  // Any run (checkbox batch or per-tile re-run) also nudges the parent list, so a
  // review sitting in production_review lights up its render pill immediately.
  const runAndNotify = useCallback(
    async (keys: RenderScenarioKey[], force?: boolean) => {
      await runScenarios(keys, force);
      onRunScenarios?.();
    },
    [runScenarios, onRunScenarios],
  );

  // Re-fetch when the parent signals a saved enrichment. The hook's poll loop is
  // idle once every tile is terminal, so a stale-recompute needs this nudge.
  useEffect(() => {
    if (reloadKey > 0) void refresh();
  }, [reloadKey, refresh]);

  const cards = grid?.cards ?? [];
  const nhCard = nonHumanCard(cards);

  const toggle = (g: RunGroup) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(g)) next.delete(g);
      else next.add(g);
      return next;
    });

  // Map checkbox groups → concrete scenario keys. Non-human maps to whichever
  // non-human card the grid currently shows; force=true so a skipped/non-applicable
  // scenario still runs on explicit request.
  const runSelected = () => {
    const keys: RenderScenarioKey[] = [];
    let force = false;
    for (const g of selected) {
      if (g === "nonhuman") {
        if (nhCard) {
          keys.push(nhCard.key);
          if (nhCard.status === "skipped") force = true;
        }
      } else {
        keys.push(g);
      }
    }
    if (keys.length > 0) {
      void runAndNotify(keys, force);
      setSelected(new Set());
    }
  };

  const tally = grid?.tally;

  return (
    <div className="space-y-4" data-testid="fact-visual-review-grid">
      {/* (a) AI interpretation summary */}
      <AiInterpretationSummary enrichment={enrichment} />

      {/* (a2) Final discovery hashtags — first-class, between the AI summary and
          the render controls (was buried in Advanced Options). Hidden for
          REFRESH reviews: refresh approval never attaches or rewrites the live
          fact's discovery tags, so curation here would be a dead control. */}
      {!hideFinalHashtags && (
        <FinalHashtagsEditor
          finalHashtags={finalHashtags}
          onFinalHashtagsChange={onFinalHashtagsChange ?? (() => {})}
          aiSuggestions={enrichment?.suggestedHashtags ?? []}
        />
      )}

      {/* (c) Run controls */}
      <div className="rounded-sm border border-border bg-card p-3 space-y-2">
        <p className="text-xs font-bold text-muted-foreground uppercase tracking-wide">Run test renders</p>
        <div className="flex flex-wrap items-center gap-3">
          {RUN_GROUP_LABELS.map((g) => (
            <label key={g.id} className="flex items-center gap-1.5 text-xs text-foreground">
              <input
                type="checkbox"
                checked={selected.has(g.id)}
                onChange={() => toggle(g.id)}
                disabled={g.id === "nonhuman" && !nhCard}
                data-testid={`run-checkbox-${g.id}`}
              />
              {g.label}
            </label>
          ))}
          <button
            type="button"
            onClick={runSelected}
            disabled={selected.size === 0}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-sm bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50"
            data-testid="run-selected"
          >
            <Play className="w-3.5 h-3.5" /> Run selected
          </button>
        </div>
      </div>

      {/* (d) Aggregate tally */}
      {tally && (
        <p className="text-xs font-mono text-muted-foreground" data-testid="render-scenario-tally">
          Rendered {tally.done} of {tally.requested}
          {tally.rendering > 0 ? ` · ${tally.rendering} rendering` : ""}
          {tally.queued > 0 ? ` · ${tally.queued} queued` : ""}
          {tally.failed > 0 ? ` · ${tally.failed} failed` : ""}
          {tally.blocked > 0 ? ` · ${tally.blocked} blocked` : ""}
          {tally.skipped > 0 ? ` · ${tally.skipped} skipped` : ""}
          {tally.stale > 0 ? ` · ${tally.stale} stale` : ""}
        </p>
      )}

      {/* (b) The grid */}
      {loading && !grid && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-6">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading test renders…
        </div>
      )}

      {error && (
        <div className="flex items-start gap-2 rounded-sm border border-destructive/50 bg-destructive/10 px-3 py-2">
          <AlertTriangle className="w-4 h-4 text-destructive shrink-0 mt-0.5" />
          <p className="text-sm text-destructive">{error}</p>
        </div>
      )}

      {grid && cards.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3" data-testid="render-scenario-cards">
          {cards.map((card) => (
            <FactRenderScenarioTile key={card.key} reviewId={reviewId} card={card} onRun={runAndNotify} />
          ))}
        </div>
      )}

      {grid && cards.length === 0 && !loading && (
        <p className="text-sm text-muted-foreground italic">No render scenarios available for this fact yet.</p>
      )}

      {/* (e) Pexels panel — secondary, collapsed by default */}
      <CollapsibleSection
        title="Stock images (Pexels)"
        icon={<ImageIcon className="w-4 h-4 text-muted-foreground" />}
        description="Seeded stock backgrounds the meme builder can fall back to — secondary to the AI renders above."
        storageKey={`overhype:moderation:visual-review:pexels:${reviewId}`}
      >
        <ModerationPexelsPanel reviewId={reviewId} />
      </CollapsibleSection>
    </div>
  );
}
