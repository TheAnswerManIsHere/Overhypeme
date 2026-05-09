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
  const backgroundUrl = useBackgroundUrl(state, mode, viewerContext.primaryImageObjectPath);
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
        } catch (stylizeErr) {
          const isPermissionErr =
            stylizeErr instanceof Error && stylizeErr.message.includes("403");
          setFallbackNotice(
            isPermissionErr
              ? "AI styling isn't available for your account right now. Your meme was saved without the AI effect."
              : "AI styling failed. Your meme was saved without the AI effect.",
          );
          imageSource = { type: "upload", uploadKey: objectPath };
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
        // Omit imageTransform when null — the server's Zod schema treats it
        // as `.optional()` (undefined-only) and would 400 on an explicit null.
        ...(imageTransform ? { imageTransform } : {}),
      }),
    });
    if (!res.ok) return;
    const data = (await res.json()) as { id: number; permalinkSlug: string };
    clearPendingState(factId);
    onComplete({
      kind: "saved",
      memeId: String(data.id),
      permalinkUrl: `/m/${data.permalinkSlug}`,
    });
  };

  const handleDownload = async () => {
    // Phase-4: server renders the bytes from the same composite path as
    // /api/memes so saved memes and downloaded memes are byte-identical for
    // identical inputs. Anonymous callers may only download stock-mode memes;
    // self-upload and pulid require a session (the server enforces this).
    const imageSource = buildImageSourceForRender(mode, state, viewerContext.primaryImageObjectPath);
    if (!imageSource) {
      onComplete({ kind: "downloaded" });
      return;
    }
    try {
      const res = await fetch("/api/render-download", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          factId: parseInt(factId, 10),
          imageSource,
          name: state.name,
          pronouns: state.pronouns,
          textOptions: state.textOptions,
          aspectRatio: state.aspectRatio,
        }),
      });
      if (!res.ok) {
        // Server-side render failed — fall through to the previous
        // canvas-snap fallback so the user is not left empty-handed.
        onComplete({ kind: "downloaded" });
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const disposition = res.headers.get("content-disposition") ?? "";
      const match = /filename="([^"]+)"/.exec(disposition);
      const filename = match?.[1] ?? `overhype-${factId}.jpg`;
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      onComplete({ kind: "downloaded" });
    } catch {
      onComplete({ kind: "downloaded" });
    }
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
          onSelect={(img) => dispatch({ type: "set-stock-image", stockImageId: img.id, stockImageUrl: img.url })}
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

/**
 * Builds the `imageSource` payload for /api/render-download from the current
 * builder state. Returns null when the state has no usable source — the
 * caller should bail rather than send an invalid request.
 */
function buildImageSourceForRender(
  mode: MemeBuilderProps["mode"],
  state: ReturnType<typeof useBuilderState>["state"],
  primaryImageObjectPath?: string,
): Record<string, unknown> | null {
  if (mode === "stock" && state.stockImageId) {
    return { type: "stock", pexelsPhotoId: parseInt(state.stockImageId, 10) };
  }
  if (mode === "self-upload" && state.myImage) {
    const objectPath = resolveSelfUploadObjectPath(state.myImage, primaryImageObjectPath);
    if (!objectPath) return null;
    return { type: "upload", uploadKey: objectPath };
  }
  return null;
}

function useBackgroundUrl(
  state: ReturnType<typeof useBuilderState>["state"],
  mode: MemeBuilderProps["mode"],
  primaryImageObjectPath?: string,
): string | null {
  return useMemo(() => {
    if (mode === "stock") {
      // The picker emits the image URL via onSelect and we store it on state
      // so the preview can render the photo immediately, before any server
      // round-trip. Falls back to null (dark canvas) when nothing is selected.
      return state.stockImageUrl;
    }
    if (state.myImage) {
      if (state.myImage.kind === "primary") {
        if (!primaryImageObjectPath) return null;
        return `/api/storage/objects${primaryImageObjectPath.replace(/^\/objects/, "")}`;
      }
      return `/api/storage/objects${state.myImage.objectPath.replace(/^\/objects/, "")}`;
    }
    return null;
  }, [mode, state.myImage, state.stockImageUrl, primaryImageObjectPath]);
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
  const data = await res.json() as { success: boolean; objectPath?: string | null };
  return { objectPath: data.objectPath ?? sourceObjectPath, transform: "pulid" };
}
