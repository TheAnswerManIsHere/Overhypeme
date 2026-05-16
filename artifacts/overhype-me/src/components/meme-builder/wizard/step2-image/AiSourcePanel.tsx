import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/utils";
import { useDesktopModality } from "../../hooks/useDesktopModality";
import { useMyImages } from "../../hooks/useMyImages";
import { MyImagePicker } from "../../parts/MyImagePicker";
import type { MyImageSource } from "../../types";
import { AI_STYLE_PRESETS, DEFAULT_AI_STYLE_ID } from "./aiStylePresets";

export type AiSubTab = "existing" | "create";

interface Props {
  factId: string;
  primaryImageObjectPath?: string;
  /** Active selection on the wizard — only "ai-styling" kinds are valid here. */
  selected: MyImageSource | null;
  /** Called when the user picks an existing AI styling tile. */
  onSelect: (next: MyImageSource) => void;
  /** Which sub-tab is active. Parent flips this to "existing" after Create succeeds. */
  subTab: AiSubTab;
  onSubTabChange: (next: AiSubTab) => void;
  /** Called when the user taps "Create" — parent kicks off the PuLID job. */
  onCreate: (args: { referenceImagePath: string; aiStyleId: string }) => void;
  /** True while a Create POST or PuLID job is in flight — disables the button. */
  creating?: boolean;
  /** Bumped by the parent after a Create completes; forces the existing-AI grid to refetch. */
  aiReloadKey: number;
}

/**
 * "AI you" panel — legendary-only. Two sub-flows:
 *
 *   - "Use existing AI image": grid of the user's prior AI stylings for this
 *     fact. Tapping a tile selects it for the meme.
 *   - "Create new AI image": pick a reference photo (primary / library /
 *     fresh upload), optionally tweak the AI style under Advanced options,
 *     then tap Create to kick off a PuLID job.
 *
 * Generation lifecycle is owned by the parent (Step2Image) — this panel only
 * collects inputs and emits the `onCreate` event.
 */
export function AiSourcePanel({
  factId,
  primaryImageObjectPath,
  selected,
  onSelect,
  subTab,
  onSubTabChange,
  onCreate,
  creating = false,
  aiReloadKey,
}: Props) {
  const [createReference, setCreateReference] = useState<MyImageSource | null>(null);
  const [aiStyleId, setAiStyleId] = useState<string>(DEFAULT_AI_STYLE_ID);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  return (
    <div className="space-y-3">
      <AiSubTabs active={subTab} onSelect={onSubTabChange} />

      {subTab === "existing" && (
        <ExistingAiImagesGrid
          factId={factId}
          reloadKey={aiReloadKey}
          selected={selected}
          onSelect={onSelect}
        />
      )}

      {subTab === "create" && (
        <div className="space-y-4">
          <div>
            <p className="mb-2 text-xs uppercase tracking-wider text-muted-foreground">
              Pick a reference photo
            </p>
            <MyImagePicker
              factId={factId}
              primaryImageObjectPath={primaryImageObjectPath}
              showAiStylings={false}
              hideTabs={["ai"]}
              selected={createReference}
              onSelect={setCreateReference}
            />
          </div>

          <AdvancedOptions
            open={advancedOpen}
            onToggle={() => setAdvancedOpen((p) => !p)}
            aiStyleId={aiStyleId}
            onChangeAiStyle={setAiStyleId}
          />

          <Button
            type="button"
            data-testid="ai-create-button"
            disabled={creating || !canCreate(createReference, primaryImageObjectPath)}
            onClick={() => {
              if (creating) return;
              const referenceImagePath = resolveReferencePath(
                createReference,
                primaryImageObjectPath,
              );
              if (!referenceImagePath) return;
              onCreate({ referenceImagePath, aiStyleId });
            }}
            className="w-full"
          >
            {creating ? "Creating…" : "Create"}
          </Button>
        </div>
      )}
    </div>
  );
}

function canCreate(
  ref: MyImageSource | null,
  primaryImageObjectPath: string | undefined,
): boolean {
  return !!resolveReferencePath(ref, primaryImageObjectPath);
}

function resolveReferencePath(
  ref: MyImageSource | null,
  primaryImageObjectPath: string | undefined,
): string | null {
  if (!ref) return null;
  if (ref.kind === "primary") return primaryImageObjectPath ?? null;
  if (ref.kind === "library" || ref.kind === "fresh" || ref.kind === "ai-styling") {
    return ref.objectPath;
  }
  return null;
}

/* ───────────────────────────────────────────────────────────────────────── */

interface AiSubTabsProps {
  active: AiSubTab;
  onSelect: (next: AiSubTab) => void;
}

function AiSubTabs({ active, onSelect }: AiSubTabsProps) {
  const tabs: { value: AiSubTab; label: string }[] = [
    { value: "existing", label: "Use existing AI image" },
    { value: "create", label: "Create new AI image" },
  ];
  return (
    <div className="flex gap-1 rounded-md bg-secondary/40 p-1" role="tablist" aria-label="AI image source">
      {tabs.map((t) => (
        <button
          key={t.value}
          type="button"
          role="tab"
          aria-selected={active === t.value}
          data-testid={`ai-sub-tab-${t.value}`}
          onClick={() => onSelect(t.value)}
          className={cn(
            "flex-1 rounded px-3 py-1.5 text-xs font-mono uppercase tracking-widest transition",
            active === t.value
              ? "bg-background text-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

/* ───────────────────────────────────────────────────────────────────────── */

interface ExistingAiImagesGridProps {
  factId: string;
  reloadKey: number;
  selected: MyImageSource | null;
  onSelect: (next: MyImageSource) => void;
}

function ExistingAiImagesGrid({
  factId,
  reloadKey,
  selected,
  onSelect,
}: ExistingAiImagesGridProps) {
  const isDesktop = useDesktopModality();
  const stylings = useMyImages({ enabled: true, transform: "ai", factId, reloadKey });

  if (stylings.isLoading) {
    return <div className="h-32 animate-pulse rounded-md bg-secondary/40" />;
  }
  if (stylings.isError) {
    return <p className="text-sm text-destructive">Could not load AI images.</p>;
  }
  if (stylings.rows.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No AI images yet — tap "Create new AI image" to forge one.
      </p>
    );
  }

  const isSelected = (objectPath: string) =>
    selected?.kind === "ai-styling" && selected.objectPath === objectPath;

  return (
    <div
      className={cn(
        isDesktop
          ? "grid grid-cols-3 gap-2 sm:grid-cols-4"
          : "flex snap-x snap-mandatory gap-2 overflow-x-auto pb-1",
      )}
      role="radiogroup"
      aria-label="AI image"
    >
      {stylings.rows.map((row) => {
        const url = `/api/storage/objects${row.objectPath.replace(/^\/objects/, "")}`;
        const selectedNow = isSelected(row.objectPath);
        return (
          <button
            key={row.objectPath}
            type="button"
            role="radio"
            aria-checked={selectedNow}
            data-testid={`ai-existing-thumb-${row.objectPath}`}
            onClick={() => onSelect({ kind: "ai-styling", objectPath: row.objectPath })}
            className={cn(
              "relative shrink-0 snap-start overflow-hidden rounded-md border-2 transition",
              isDesktop ? "aspect-square" : "h-24 w-32",
              selectedNow ? "border-primary" : "border-transparent hover:border-secondary",
            )}
          >
            <img src={url} alt="" loading="lazy" className="h-full w-full object-cover" />
          </button>
        );
      })}
    </div>
  );
}

/* ───────────────────────────────────────────────────────────────────────── */

interface AdvancedOptionsProps {
  open: boolean;
  onToggle: () => void;
  aiStyleId: string;
  onChangeAiStyle: (next: string) => void;
}

function AdvancedOptions({ open, onToggle, aiStyleId, onChangeAiStyle }: AdvancedOptionsProps) {
  return (
    <div className="rounded-md border border-border">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        data-testid="ai-advanced-toggle"
        className="flex w-full items-center justify-between px-3 py-2 text-left text-xs font-mono uppercase tracking-widest text-muted-foreground hover:text-foreground"
      >
        <span>Advanced options</span>
        <span aria-hidden>{open ? "−" : "+"}</span>
      </button>
      {open && (
        <div className="border-t border-border px-3 py-3">
          <label className="block text-xs uppercase tracking-wider text-muted-foreground">
            AI style
          </label>
          <select
            value={aiStyleId}
            onChange={(e) => onChangeAiStyle(e.target.value)}
            data-testid="ai-style-select"
            className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
          >
            {AI_STYLE_PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}
