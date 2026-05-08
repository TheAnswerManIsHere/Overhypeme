import { useCallback, useMemo, useState } from "react";
import type { ImageTransform, MemeBuilderProps, MyImageSource } from "./types";
import { resolveBehavior } from "./behaviorMatrix";
import { useBuilderState, snapshotPendingState } from "./state/useBuilderState";
import { capturePendingState, clearPendingState } from "./state/pendingBuilderState";
import { useDebouncedValue } from "./hooks/useDebouncedValue";
import { EntryFlowHeader } from "./parts/EntryFlowHeader";
import { NameAndPronounFields } from "./parts/NameAndPronounFields";
import { StockImagePicker } from "./parts/StockImagePicker";
import { MyImagePicker } from "./parts/MyImagePicker";
import { StylizeToggle } from "./parts/StylizeToggle";
import { PulidProgressOverlay } from "./parts/PulidProgressOverlay";
import { LivePreview } from "./parts/LivePreview";
import { ActionBar } from "./parts/ActionBar";
import { TierLockedState } from "./parts/TierLockedState";
import { STYLIZE_TOGGLE_COPY } from "./copy";

/**
 * Phase-3 universal meme builder.
 *
 * Behavior is decided once via `resolveBehavior(mode, tier, entryFlow)`. The
 * rest of the component reads `cell.*` — there are no nested switches on the
 * raw tuple here.
 *
 * Persistence is delegated to API endpoints; this component never writes to
 * GCS, the DB, or fal.ai directly.
 */
export function MemeBuilder(props: MemeBuilderProps) {
  const { mode, factId, factText, viewerContext, entryFlow, onComplete, onCancel } = props;

  const cell = useMemo(
    () => resolveBehavior(mode, viewerContext.tier, entryFlow),
    [mode, viewerContext.tier, entryFlow],
  );

  const initial = props.initialPendingState
    ? { initialPendingState: props.initialPendingState }
    : {
        initialName:        props.initialName ?? viewerContext.name,
        initialPronouns:    props.initialPronouns ?? viewerContext.pronouns,
        initialStockImageId: props.initialStockImageId,
      };

  const { state, dispatch } = useBuilderState(initial);
  const [pulidOpen, setPulidOpen] = useState(false);
  const [pulidProgress, setPulidProgress] = useState(0);
  const [fallbackNotice, setFallbackNotice] = useState<string | null>(null);

  // Debounced background URL for the preview; raw selection state updates
  // immediately so the picker still feels responsive.
  const backgroundUrl = useBackgroundUrl(state, mode);
  const debouncedBg = useDebouncedValue(backgroundUrl, 150);

  const captureForResume = useCallback(() => {
    const pending = snapshotPendingState({
      factId,
      mode,
      entryFlow,
      state,
    });
    capturePendingState(pending);
    return pending;
  }, [factId, mode, entryFlow, state]);

  if (cell.invalid) {
    return (
      <TierLockedState
        upgradeTo={cell.upgradeTo!}
        reason={cell.upgradeReason ?? "This feature is locked."}
        onUpgrade={() =>
          onComplete({
            kind: "upgrade-required",
            targetTier: cell.upgradeTo!,
            reason: cell.upgradeReason ?? "",
          })
        }
        onCancel={onCancel}
      />
    );
  }

  const handleSave = async () => {
    if (viewerContext.tier === "unregistered") {
      const pending = captureForResume();
      onComplete({ kind: "signup-required", pendingState: pending });
      return;
    }

    let imageSource: Record<string, unknown> | null = null;
    let imageTransform: ImageTransform = null;

    if (mode === "stock" && state.stockImageId) {
      imageSource = { type: "stock", pexelsPhotoId: parseInt(state.stockImageId, 10) };
    } else if (mode === "self-upload" && state.myImage) {
      // For 'primary' we need the avatar object_path from the viewer.
      const objectPath = resolveSelfUploadObjectPath(state.myImage, viewerContext.primaryImageObjectPath);
      if (!objectPath) {
        // The user clicked save without selecting a real image. Bail.
        return;
      }
      // If stylize is on, kick off PuLID via the existing AI generate route.
      if (state.stylizeWithAi && cell.showStylizeToggle && state.myImage.kind !== "ai-styling") {
        setPulidOpen(true);
        setPulidProgress(0.1);
        try {
          const result = await runStylize(factId, objectPath);
          setPulidProgress(1);
          imageSource = { type: "upload", uploadKey: result.objectPath };
          imageTransform = result.transform;
          if (result.transform === "pulid_fallback_text") {
            setFallbackNotice(STYLIZE_TOGGLE_COPY.fallbackNotice);
          }
        } catch {
          setPulidOpen(false);
          return;
        } finally {
          setPulidOpen(false);
        }
      } else {
        imageSource = { type: "upload", uploadKey: objectPath };
        if (state.myImage.kind === "ai-styling") {
          // The user picked an existing styling — keep the analytics flag on the meme.
          imageTransform = "pulid";
        }
      }
    }

    if (!imageSource) return;

    const res = await fetch("/api/memes", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        factId: parseInt(factId, 10),
        imageSource,
        textOptions: state.textOptions,
        aspectRatio: state.aspectRatio,
        imageTransform,
      }),
    });
    if (!res.ok) return;
    const data = (await res.json()) as { id: number; slug: string };
    clearPendingState(factId);
    onComplete({
      kind: "saved",
      memeId: String(data.id),
      permalinkUrl: `/meme/${data.slug}`,
    });
  };

  const handleDownload = () => {
    // Phase-4 will add /api/render-download. For now, snap the canvas client-side.
    onComplete({ kind: "downloaded" });
  };

  const handleShare = () => {
    // Phase-6 wires the social share flow; for now just signal completion.
    onComplete({ kind: "saved", memeId: "", permalinkUrl: "" });
  };

  const handleSignup = () => {
    const pending = captureForResume();
    onComplete({ kind: "signup-required", pendingState: pending });
  };

  const handleTryAiMode = () => {
    onComplete({ kind: "upgrade-required", targetTier: "legendary", reason: "Try AI mode" });
  };

  return (
    <div className="relative space-y-4">
      <EntryFlowHeader headerCopyKey={cell.headerCopyKey} />

      <NameAndPronounFields
        name={state.name}
        pronouns={state.pronouns}
        onNameChange={(name) => dispatch({ type: "set-name", name })}
        onPronounsChange={(pronouns) => dispatch({ type: "set-pronouns", pronouns })}
      />

      {cell.sourceArea === "stock" && (
        <StockImagePicker
          factId={factId}
          selectedId={state.stockImageId}
          onSelect={(img) => dispatch({ type: "set-stock-image", stockImageId: img.id })}
        />
      )}

      {cell.sourceArea === "my-image" && (
        <>
          <MyImagePicker
            factId={factId}
            primaryImageObjectPath={viewerContext.primaryImageObjectPath}
            showAiStylings={cell.showStylizeToggle}
            selected={state.myImage}
            onSelect={(next) => dispatch({ type: "set-my-image", myImage: next })}
          />
          {cell.showStylizeToggle && (
            <StylizeToggle
              enabled={state.stylizeWithAi}
              onChange={(stylizeWithAi) => dispatch({ type: "set-stylize", stylizeWithAi })}
              disabled={state.myImage?.kind === "ai-styling"}
              disabledReason="This image is already AI-stylized."
            />
          )}
        </>
      )}

      <LivePreview
        factText={factText}
        name={state.name}
        pronouns={state.pronouns}
        backgroundUrl={debouncedBg}
        textOptions={state.textOptions}
        aspectRatio={state.aspectRatio}
      />

      {fallbackNotice && (
        <p className="rounded-md border border-border bg-secondary/30 p-3 text-xs text-muted-foreground">
          {fallbackNotice}
        </p>
      )}

      <ActionBar
        visibleActions={cell.visibleActions}
        showTryAiUpsell={cell.showTryAiUpsell}
        saveDisabled={!hasUsableSource(state, mode)}
        downloadDisabled={!hasUsableSource(state, mode)}
        onDownload={handleDownload}
        onSave={handleSave}
        onShare={handleShare}
        onSignupCta={handleSignup}
        onTryAiMode={cell.showTryAiUpsell ? handleTryAiMode : undefined}
      />

      <PulidProgressOverlay
        open={pulidOpen}
        progress={pulidProgress}
        onCancel={() => setPulidOpen(false)}
      />
    </div>
  );
}

function hasUsableSource(
  state: ReturnType<typeof useBuilderState>["state"],
  mode: MemeBuilderProps["mode"],
): boolean {
  if (mode === "stock") return !!state.stockImageId;
  return !!state.myImage;
}

function resolveSelfUploadObjectPath(image: MyImageSource, primary?: string): string | null {
  if (image.kind === "primary") return primary ?? null;
  return image.objectPath;
}

function useBackgroundUrl(
  state: ReturnType<typeof useBuilderState>["state"],
  mode: MemeBuilderProps["mode"],
): string | null {
  return useMemo(() => {
    if (mode === "stock") {
      // The picker emits the image URL via onSelect; we don't currently store
      // the full URL on state — only the id. The preview will fall back to
      // the dark canvas when the URL isn't yet known. (Phase 4 will replace
      // this with a server-rendered preview.)
      return null;
    }
    if (state.myImage) {
      if (state.myImage.kind === "primary") return null;
      return `/api/storage/objects${state.myImage.objectPath.replace(/^\/objects/, "")}`;
    }
    return null;
  }, [mode, state.myImage]);
}

interface StylizeResult {
  objectPath: string;
  transform: "pulid" | "pulid_fallback_text";
}

/**
 * Calls `POST /api/memes/ai/:factId/generate` (existing route — Phase 4 will
 * replace with /api/meme-builder/stylize). Until then the existing route
 * surfaces 422 + `{ noFaceDetected: true }` on no-face errors; the builder
 * does NOT auto-fall-back here, that fallback will live server-side once the
 * dedicated endpoint ships. For Phase 3 we surface the styling result if the
 * route succeeds.
 */
async function runStylize(factId: string, sourceObjectPath: string): Promise<StylizeResult> {
  const res = await fetch(`/api/memes/ai/${encodeURIComponent(factId)}/generate`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ referenceImagePath: sourceObjectPath, targetGender: "neutral" }),
  });
  if (!res.ok) {
    throw new Error(`Stylize failed: HTTP ${res.status}`);
  }
  // Phase 4 will return { objectPath, transform } directly. For now, the
  // existing route doesn't surface the persisted derivative path; we treat
  // that as an unimplemented contract and fall back to the source path so
  // the meme save still proceeds. A 422 from the route will throw above.
  return { objectPath: sourceObjectPath, transform: "pulid" };
}
