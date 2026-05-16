import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import type { AspectRatio, MemeTextOptions, MyImageSource, ViewerContext } from "../../types";
import type { StockImage } from "../../hooks/useStockImages";
import { UnifiedUpgradeModal } from "../../../upgrade/UnifiedUpgradeModal";
import { WizardPrimaryAction } from "../WizardPrimaryAction";
import type { PendingWizardState } from "../state/wizardStorage";
import type { WizardAction, WizardRuntimeState } from "../state/useWizardState";
import { LockedPreview } from "./LockedPreview";
import {
  pickDefaultSourceTab,
  SourceSegmentedControl,
  type SourceTab,
} from "./SourceSegmentedControl";
import { AspectRatioToggle } from "./AspectRatioToggle";
import { StockSourcePanel } from "./StockSourcePanel";
import { SelfUploadSourcePanel } from "./SelfUploadSourcePanel";
import { AiSourcePanel } from "./AiSourcePanel";
import { AdjustTextSheet } from "./AdjustTextSheet";
import { AdvancedOptionsSheet } from "./AdvancedOptionsSheet";
import { PulidLoadingTakeover } from "./PulidLoadingTakeover";
import { intelligentSplit } from "./sliders/splitLogic";
import { buildSaveMemePayload } from "../util/saveMemePayload";

interface Props {
  factId: string;
  factText: string;
  /** From `facts.split_token_index` when present — overrides the client-side `intelligentSplit` default. */
  factSplitTokenIndex?: number | null;
  viewerContext: ViewerContext;
  state: WizardRuntimeState;
  dispatch: (action: WizardAction) => void;
  /** Notify parent (wizard) when the save succeeds. */
  onSaved: (result: { memeId: string; permalinkUrl: string }) => void;
  /** Notify parent when the user requests signup (anonymous taps "Your photo"). */
  onRequestSignup: (pending: Partial<PendingWizardState>) => void;
}

interface PulidJobStartResponse {
  jobId: string;
}

interface SaveMemeResponse {
  memeId: number | string;
  permalinkSlug: string;
  permalinkUrl: string;
}

/**
 * Step 2 — image flow. Owns:
 *   - source tab + selection
 *   - aspect ratio, framing drag
 *   - name/pronouns inline fields
 *   - bottom-sheet drawers (adjust text, advanced)
 *   - "Make my meme" save flow (stock/upload direct; AI via PuLID job + poll)
 *
 * Live re-renders flow directly into `LockedPreview` — `LivePreview` coalesces
 * rapid prop changes via `requestAnimationFrame` so the canvas stays at 60fps
 * without us needing a state-level debounce.
 */
export function Step2Image({
  factId,
  factText,
  factSplitTokenIndex,
  viewerContext,
  state,
  dispatch,
  onSaved,
  onRequestSignup,
}: Props) {
  const [, navigate] = useLocation();
  const tier = viewerContext.tier;
  const hasPrimaryPhoto = !!viewerContext.primaryImageObjectPath;

  const [tab, setTab] = useState<SourceTab>(() => {
    if (state.source?.kind === "stock") return "stock";
    if (state.source?.kind === "self-upload") {
      return state.source.stylizeWithAi ? "ai-you" : "self-upload";
    }
    return pickDefaultSourceTab(tier, hasPrimaryPhoto);
  });
  const [upgradeOpen, setUpgradeOpen] = useState(false);
  const [aspectRatio, setAspectRatio] = useState<AspectRatio>(state.aspectRatio ?? "landscape");
  const [framingOffset, setFramingOffset] = useState<{ x: number; y: number }>(
    state.framingOffset ?? { x: 0, y: 0 },
  );
  const [name, setName] = useState(viewerContext.name ?? "");
  const [pronouns, setPronouns] = useState(viewerContext.pronouns ?? "he/him");
  const [textOptions, setTextOptions] = useState<MemeTextOptions>(state.textOptions ?? {});
  const [stockSelectedId, setStockSelectedId] = useState<string | null>(
    state.source?.kind === "stock" ? state.source.stockImageId : null,
  );
  const [stockSelectedUrl, setStockSelectedUrl] = useState<string | null>(null);
  const [myImage, setMyImage] = useState<MyImageSource | null>(
    state.source?.kind === "self-upload" ? state.source.image : null,
  );
  const [pulidJobId, setPulidJobId] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const defaultSplitIndex = useMemo(
    () => factSplitTokenIndex ?? intelligentSplit(factText),
    [factSplitTokenIndex, factText],
  );
  const [splitIndex, setSplitIndex] = useState(defaultSplitIndex);

  // Sync local state into the wizard reducer so sessionStorage stays current.
  useEffect(() => {
    dispatch({ type: "set-aspect-ratio", aspectRatio });
  }, [aspectRatio, dispatch]);
  useEffect(() => {
    dispatch({ type: "set-framing-offset", framingOffset });
  }, [framingOffset, dispatch]);
  useEffect(() => {
    dispatch({ type: "set-name", name });
  }, [name, dispatch]);
  useEffect(() => {
    dispatch({ type: "set-pronouns", pronouns });
  }, [pronouns, dispatch]);
  useEffect(() => {
    dispatch({ type: "set-text-options", textOptions });
  }, [textOptions, dispatch]);

  // Persist the source selection.
  useEffect(() => {
    if (tab === "stock" && stockSelectedId) {
      dispatch({ type: "set-mode", mode: "stock" });
      dispatch({
        type: "set-source",
        source: { kind: "stock", stockImageId: stockSelectedId },
      });
    } else if ((tab === "self-upload" || tab === "ai-you") && myImage) {
      dispatch({ type: "set-mode", mode: "self-upload" });
      dispatch({
        type: "set-source",
        source: { kind: "self-upload", image: myImage, stylizeWithAi: tab === "ai-you" },
      });
    }
  }, [tab, stockSelectedId, myImage, dispatch]);

  // Background URL for the live preview.
  const backgroundUrl = useMemo(() => {
    if (tab === "stock" && stockSelectedUrl) return stockSelectedUrl;
    if (tab === "self-upload" || tab === "ai-you") {
      if (myImage?.kind === "primary" && viewerContext.primaryImageObjectPath) {
        return `/api/storage/objects${viewerContext.primaryImageObjectPath.replace(/^\/objects/, "")}`;
      }
      if (myImage && (myImage.kind === "library" || myImage.kind === "fresh" || myImage.kind === "ai-styling")) {
        return `/api/storage/objects${myImage.objectPath.replace(/^\/objects/, "")}`;
      }
    }
    return null;
  }, [tab, stockSelectedUrl, myImage, viewerContext.primaryImageObjectPath]);

  // Map split index into top/bottom text via the existing fact-text words.
  const memeTextOptions: MemeTextOptions = useMemo(() => {
    const words = factText.split(/\s+/).filter((w) => w);
    const safeSplit = Math.min(Math.max(splitIndex, 0), words.length);
    return {
      ...textOptions,
      topText: words.slice(0, safeSplit).join(" "),
      bottomText: words.slice(safeSplit).join(" "),
    };
  }, [textOptions, factText, splitIndex]);

  const sourceSelected =
    (tab === "stock" && !!stockSelectedId) ||
    ((tab === "self-upload" || tab === "ai-you") && !!myImage);

  const handleSourceTab = (next: SourceTab) => {
    setTab(next);
  };

  const handleStockSelect = (image: StockImage) => {
    setStockSelectedId(image.id);
    setStockSelectedUrl(image.url);
  };

  const handleMyImageSelect = (next: MyImageSource) => {
    setMyImage(next);
  };

  const handlePulidJobComplete = async (generatedObjectPath: string) => {
    setPulidJobId(null);
    // The PuLID derivative now sits at generatedObjectPath. Persist the meme
    // recipe with imageTransform="pulid" and an upload-shaped source.
    await save(generatedObjectPath);
  };

  const handlePulidJobError = (errorCode: string, message?: string) => {
    setPulidJobId(null);
    if (errorCode === "budget_exceeded") {
      setSaveError("You've out-legended your monthly budget. Come back wilder.");
    } else if (errorCode === "moderation") {
      setSaveError("That image can't be used. It violates our content policy.");
    } else if (errorCode === "no_face") {
      setSaveError("No face detected — we'll skip face-matching and use a text fallback.");
      // The server returns an upload-shaped source for the no-face fallback via
      // imageTransform="pulid_fallback_text". TODO MBFO-4: wire that path.
    } else {
      setSaveError(message ?? "Our servers couldn't handle that much legend at once. Try again shortly.");
    }
  };

  const save = async (pulidGeneratedUploadKey?: string) => {
    setSaving(true);
    setSaveError(null);
    try {
      const payload = buildSaveMemePayload({
        state: {
          ...state,
          aspectRatio,
          framingOffset,
          name,
          pronouns,
          textOptions: memeTextOptions,
        } as WizardRuntimeState,
        factId: Number(factId),
        pulidGeneratedUploadKey,
      });
      if (!payload) {
        setSaving(false);
        setSaveError("Pick a photo first.");
        return;
      }
      const res = await fetch("/api/memes", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        if (res.status === 401) {
          setSaving(false);
          onRequestSignup({});
          return;
        }
        const errBody = await res.json().catch(() => ({}));
        throw new Error(errBody.error ?? `HTTP ${res.status}`);
      }
      const body = (await res.json()) as SaveMemeResponse;
      setSaving(false);
      onSaved({
        memeId: String(body.memeId),
        permalinkUrl: body.permalinkUrl,
      });
      navigate(body.permalinkUrl);
    } catch (err) {
      setSaving(false);
      setSaveError(
        err instanceof Error
          ? err.message
          : "We couldn't save your meme. Try saving again.",
      );
    }
  };

  const handleMakeMyMeme = async () => {
    if (!sourceSelected || saving) return;

    // PuLID path: kick off the job, then this component renders the loading
    // takeover until the job completes.
    if (tab === "ai-you" && myImage) {
      setSaveError(null);
      try {
        // Resolve the reference path: identity = user's profile photo, else
        // the chosen image's object_path.
        let referenceImagePath: string | null = null;
        if (myImage.kind === "primary") {
          referenceImagePath = viewerContext.primaryImageObjectPath ?? null;
        } else if (
          myImage.kind === "library" ||
          myImage.kind === "fresh" ||
          myImage.kind === "ai-styling"
        ) {
          referenceImagePath = myImage.objectPath;
        }
        if (!referenceImagePath) {
          setSaveError("Pick a photo first.");
          return;
        }
        // If the user picked an existing AI styling, no job is needed — just save.
        if (myImage.kind === "ai-styling") {
          await save(myImage.objectPath);
          return;
        }
        const res = await fetch("/api/memes/pulid-jobs", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            factId: Number(factId),
            referenceImagePath,
          }),
        });
        if (!res.ok) {
          const errBody = await res.json().catch(() => ({}));
          throw new Error(errBody.error ?? `HTTP ${res.status}`);
        }
        const { jobId } = (await res.json()) as PulidJobStartResponse;
        setPulidJobId(jobId);
      } catch (err) {
        setSaveError(
          err instanceof Error
            ? err.message
            : "Our servers couldn't handle that much legend at once. Try again shortly.",
        );
      }
      return;
    }

    // Direct save (stock / non-stylized upload).
    await save();
  };

  if (pulidJobId) {
    return (
      <PulidLoadingTakeover
        jobId={pulidJobId}
        onComplete={handlePulidJobComplete}
        onError={handlePulidJobError}
      />
    );
  }

  return (
    <div className="flex h-full flex-col">
      <h1 className="sr-only">Build your meme</h1>

      {/* Preview is locked outside the scroll container — it never scrolls. */}
      <LockedPreview
        factText={factText}
        name={name}
        pronouns={pronouns}
        backgroundUrl={backgroundUrl}
        textOptions={memeTextOptions}
        aspectRatio={aspectRatio}
        framingOffset={framingOffset}
        onFramingChange={setFramingOffset}
      />

      {/* Controls scroll under the preview; flex-1 fills whatever height remains. */}
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-md space-y-4 px-4 pt-4 pb-24">
          <SourceSegmentedControl
            active={tab}
            tier={tier}
            onSelect={handleSourceTab}
            onRequestSignup={() => onRequestSignup({})}
            onRequestUpgrade={() => setUpgradeOpen(true)}
          />

          <AspectRatioToggle value={aspectRatio} onChange={setAspectRatio} />

          {tab === "stock" && (
            <StockSourcePanel
              factId={factId}
              pronouns={pronouns}
              selectedId={stockSelectedId}
              onSelect={handleStockSelect}
            />
          )}

          {tab === "self-upload" && (
            <SelfUploadSourcePanel
              factId={factId}
              primaryImageObjectPath={viewerContext.primaryImageObjectPath}
              selected={myImage}
              onSelect={handleMyImageSelect}
            />
          )}

          {tab === "ai-you" && (
            <AiSourcePanel
              factId={factId}
              primaryImageObjectPath={viewerContext.primaryImageObjectPath}
              selected={myImage}
              onSelect={handleMyImageSelect}
            />
          )}

          <AdjustTextSheet
            factText={factText}
            defaultSplitIndex={defaultSplitIndex}
            splitIndex={splitIndex}
            onSplitChange={setSplitIndex}
            textOptions={textOptions}
            onTextOptionsChange={setTextOptions}
          />

          <AdvancedOptionsSheet value={textOptions} onChange={setTextOptions} />

          {saveError && (
            <p
              role="alert"
              className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              {saveError}
            </p>
          )}
        </div>
      </div>

      <WizardPrimaryAction
        label="Make my meme"
        onClick={handleMakeMyMeme}
        disabled={!sourceSelected}
        loading={saving}
      />

      <UnifiedUpgradeModal
        open={upgradeOpen}
        onClose={() => setUpgradeOpen(false)}
        context="ai-tab"
      />
    </div>
  );
}
