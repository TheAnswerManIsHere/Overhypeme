import { useCallback, useMemo } from "react";
import type { MemeBuilderProps } from "./types";
import { resolveBehavior } from "./behaviorMatrix";
import { useBuilderState, snapshotPendingState } from "./state/useBuilderState";
import { capturePendingState, clearPendingState } from "./state/pendingBuilderState";
import { useDebouncedValue } from "./hooks/useDebouncedValue";
import { EntryFlowHeader } from "./parts/EntryFlowHeader";
import { NameAndPronounFields } from "./parts/NameAndPronounFields";
import { StockImagePicker } from "./parts/StockImagePicker";
import { MyImagePicker } from "./parts/MyImagePicker";
import { LivePreview } from "./parts/LivePreview";
import { ActionBar } from "./parts/ActionBar";
import { TierLockedState } from "./parts/TierLockedState";
import {
  currentSource,
  resolveBackgroundUrl,
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

    const imageSource = toServerImageSource(source, viewerCtx);
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
    // self-upload requires a session (the server enforces this).
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
        <MyImagePicker
          selected={state.myImage}
          onSelect={(next) => dispatch({ type: "set-my-image", myImage: next })}
        />
      )}

      <LivePreview
        factText={factText}
        name={state.name}
        pronouns={state.pronouns}
        backgroundUrl={debouncedBg}
        textOptions={state.textOptions}
        aspectRatio={state.aspectRatio}
      />

      <ActionBar
        visibleActions={cell.visibleActions}
        saveDisabled={!source}
        downloadDisabled={!source}
        onDownload={handleDownload}
        onSave={handleSave}
        onShare={handleShare}
        onSignupCta={handleSignup}
      />
    </div>
  );
}
