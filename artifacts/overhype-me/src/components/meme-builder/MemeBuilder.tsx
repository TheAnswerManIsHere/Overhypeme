import { useCallback, useMemo, useState } from "react";
import type { ImageTransform, MemeBuilderProps } from "./types";
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
import { VisibilityToggle } from "./parts/VisibilityToggle";
import { UnifiedUpgradeModal } from "../upgrade/UnifiedUpgradeModal";
import { STYLIZE_TOGGLE_COPY } from "./copy";
import {
  currentSource,
  resolveBackgroundUrl,
  selfUploadObjectPath,
  toServerImageSource,
} from "./integration/sourceKinds";

/**
 * Phase-3 universal meme builder.
 *
 * Behavior is decided once via `resolveBehavior(mode, tier, entryFlow)`. The
 * rest of the component reads `cell.*` — there are no nested switches on the
 * raw tuple here.
 *
 * Persistence is delegated to API endpoints; this component never writes to
 * GCS, the DB, or fal.ai directly. Background-URL math and server-bound
 * imageSource construction are delegated to `integration/sourceKinds` so a
 * new source kind only needs to be added in one place — pickers, preview,
 * save, and download all pick it up.
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
  // Gallery visibility. Local rather than reducer state: it is Legendary-only,
  // and the pending-state capture exists for the signup resume path, which by
  // definition belongs to a tier that can't set it.
  const [isPublic, setIsPublic] = useState(true);
  const [privateUpsellOpen, setPrivateUpsellOpen] = useState(false);
  const [pulidOpen, setPulidOpen] = useState(false);
  const [pulidProgress, setPulidProgress] = useState(0);
  const [fallbackNotice, setFallbackNotice] = useState<string | null>(null);

  // Task #507: viewerCtx is now empty — the profile photo lives in the library
  // and is selected via the standard `kind:"library"` source. Kept as a stable
  // reference so memoization downstream still has a single object identity.
  const viewerCtx = useMemo(() => ({}), []);

  // Debounced background URL for the preview; raw selection state updates
  // immediately so the picker still feels responsive. The resolution lives
  // in one shared helper so each new source kind is added in one place.
  const source = useMemo(() => currentSource(state, mode), [state, mode]);
  const backgroundUrl = useMemo(() => resolveBackgroundUrl(source, viewerCtx), [source, viewerCtx]);
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

    let imageSource: Record<string, unknown> | null = toServerImageSource(source, viewerCtx);
    let imageTransform: ImageTransform = null;

    if (mode === "self-upload" && state.myImage) {
      // Stylize is the one self-upload branch that needs a side-effect (kicks
      // off PuLID via the existing AI generate route) before the imageSource
      // is finalised — so we override the projection here. Every other source
      // kind goes through `toServerImageSource`.
      const objectPath = selfUploadObjectPath(state.myImage, viewerCtx);
      if (!objectPath) {
        // The user clicked save without selecting a real image. Bail.
        return;
      }
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
      } else if (state.myImage.kind === "ai-styling") {
        // The user picked an existing styling — keep the analytics flag on the meme.
        imageTransform = "pulid";
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
        isPublic,
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
    const imageSource = toServerImageSource(source, viewerCtx);
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

      {/* Visibility sits with the save action — it's a choice about publishing,
          not about the canvas. Hidden when saving isn't on offer (anonymous
          download-only cells), since there'd be no row to apply it to. */}
      {cell.visibleActions.includes("save") && (
        <VisibilityToggle
          isPublic={isPublic}
          onChange={setIsPublic}
          tier={viewerContext.tier}
          // Deliberately NOT the `upgrade-required` completion signal used by
          // the AI upsell: hosts treat that as "leave the builder", which would
          // throw away an in-progress meme just because the user tapped
          // Private to see what it was.
          onRequestUpgrade={() => setPrivateUpsellOpen(true)}
        />
      )}

      <ActionBar
        visibleActions={cell.visibleActions}
        showTryAiUpsell={cell.showTryAiUpsell}
        saveDisabled={!source}
        downloadDisabled={!source}
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

      <UnifiedUpgradeModal
        open={privateUpsellOpen}
        onClose={() => setPrivateUpsellOpen(false)}
        context="private-meme"
      />
    </div>
  );
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
