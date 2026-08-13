import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
import type { AspectRatio, MemeTextOptions, MyImageSource, ViewerContext } from "../../types";
import type { StockImage } from "../../hooks/useStockImages";
import {
  UnifiedUpgradeModal,
  type UpgradeModalContext,
} from "../../../upgrade/UnifiedUpgradeModal";
import { VisibilityToggle } from "../../parts/VisibilityToggle";
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
import { GuestPhotoSignupPanel } from "./GuestPhotoSignupPanel";
import { AiSourcePanel } from "./AiSourcePanel";
import type { AiSubTab } from "./AiSourcePanel";
import { AdjustTextSheet } from "./AdjustTextSheet";
import { AdvancedOptionsSheet } from "./AdvancedOptionsSheet";
import { PulidLoadingTakeover } from "./PulidLoadingTakeover";
import { NoFaceFallbackModal } from "./NoFaceFallbackModal";
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
  // Told, not derived — the same answer createMemeRecord will apply.
  const canSetPrivate = viewerContext.entitlements?.["meme_private_visibility"]?.allowed === true;
  const canPulidStylize = viewerContext.entitlements?.["meme_pulid_stylize"]?.allowed === true;

  const [tab, setTab] = useState<SourceTab>(() => {
    // For unregistered users, never inherit a cached AI or self-upload source
    // from a previous (possibly different) logged-in session. Always pick the
    // default for their tier so they land on "Your photo" with the signup CTA.
    if (tier !== "unregistered") {
      if (state.source?.kind === "stock") return "stock";
      if (state.source?.kind === "self-upload") {
        return state.source.stylizeWithAi ? "ai-you" : "self-upload";
      }
    }
    return pickDefaultSourceTab(tier);
  });
  const [upgradeOpen, setUpgradeOpen] = useState(false);
  const [upgradeContext, setUpgradeContext] = useState<UpgradeModalContext>("ai-tab");
  const [isPublic, setIsPublic] = useState(state.isPublic ?? true);
  const [aspectRatio, setAspectRatio] = useState<AspectRatio>(state.aspectRatio ?? "landscape");
  const [framingOffset, setFramingOffset] = useState<{ x: number; y: number }>(
    state.framingOffset ?? { x: 0, y: 0 },
  );
  // Prefer the wizard state's name/pronouns over viewerContext: the wizard
  // state is seeded from `initialName`/`initialPronouns` (which callers wire
  // up from `usePersonName` for guest users), while `viewerContext.name` is
  // only populated for logged-in users via the auth profile.
  const [name, setName] = useState(state.name ?? viewerContext.name ?? "");
  const [pronouns, setPronouns] = useState(state.pronouns ?? viewerContext.pronouns ?? "he/him");
  const [textOptions, setTextOptions] = useState<MemeTextOptions>(state.textOptions ?? {});
  const [stockSelectedId, setStockSelectedId] = useState<string | null>(
    state.source?.kind === "stock" ? state.source.stockImageId : null,
  );
  const [stockSelectedUrl, setStockSelectedUrl] = useState<string | null>(null);
  // Per-tab selection memory. The wizard reducer only stores ONE source at a
  // time (whatever tab is currently active), so we keep separate component
  // state for each tab. When the user switches tabs the previous selection
  // stays put and the dispatch-on-tab effect re-publishes whichever one
  // belongs to the new active tab.
  const [selfUploadImage, setSelfUploadImage] = useState<MyImageSource | null>(
    state.source?.kind === "self-upload" && !state.source.stylizeWithAi ? state.source.image : null,
  );
  const [aiStylingImage, setAiStylingImage] = useState<MyImageSource | null>(
    state.source?.kind === "self-upload" && state.source.stylizeWithAi ? state.source.image : null,
  );
  const myImage: MyImageSource | null =
    tab === "ai-you" ? aiStylingImage : tab === "self-upload" ? selfUploadImage : null;
  const [pulidJobId, setPulidJobId] = useState<string | null>(null);
  // When the server parks the PuLID job at no_face_review, the loading takeover
  // unmounts and this flag drives the no-face modal. The jobId is preserved
  // separately so the modal's actions can target it.
  const [noFaceJobId, setNoFaceJobId] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [creatingAi, setCreatingAi] = useState(false);
  // "AI you" sub-tab state. Generation lifecycle lives here in the parent so
  // the loading takeover can be rendered alongside (and unmount the sub-tab
  // UI). After a Create completes we flip to "existing" and bump the reload
  // key so the newly-forged image appears in the grid.
  const [aiSubTab, setAiSubTab] = useState<AiSubTab>("existing");
  const [aiReloadKey, setAiReloadKey] = useState(0);

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
  useEffect(() => {
    dispatch({ type: "set-is-public", isPublic });
  }, [isPublic, dispatch]);

  // Task #507: previously this auto-picked `kind:"primary"` as the implicit
  // default. The profile photo is now just a tagged library entry, so the
  // MyImagePicker library tab auto-selects the first row (server sorts
  // is_profile DESC, created_at DESC) the moment it mounts — the parent
  // doesn't need to seed anything.

  // Persist the source selection.
  useEffect(() => {
    if (tab === "stock" && stockSelectedId) {
      dispatch({ type: "set-mode", mode: "stock" });
      dispatch({
        type: "set-source",
        source: { kind: "stock", stockImageId: stockSelectedId },
      });
    } else if (tab === "self-upload" && selfUploadImage) {
      dispatch({ type: "set-mode", mode: "self-upload" });
      dispatch({
        type: "set-source",
        source: { kind: "self-upload", image: selfUploadImage, stylizeWithAi: false },
      });
    } else if (tab === "ai-you" && aiStylingImage) {
      dispatch({ type: "set-mode", mode: "self-upload" });
      dispatch({
        type: "set-source",
        source: { kind: "self-upload", image: aiStylingImage, stylizeWithAi: true },
      });
    }
  }, [tab, stockSelectedId, selfUploadImage, aiStylingImage, dispatch]);

  // Background URL for the live preview.
  const backgroundUrl = useMemo(() => {
    if (tab === "stock" && stockSelectedUrl) return stockSelectedUrl;
    if (tab === "self-upload" || tab === "ai-you") {
      if (myImage && (myImage.kind === "library" || myImage.kind === "fresh" || myImage.kind === "ai-styling")) {
        return `/api/storage/objects${myImage.objectPath.replace(/^\/objects/, "")}`;
      }
    }
    return null;
  }, [tab, stockSelectedUrl, myImage]);

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

  // For AI you, only an "ai-styling" selection counts — a reference photo
  // picked inside the Create sub-flow is not a meme-ready selection until
  // the user clicks Create and the PuLID job finishes. Also gate against an
  // in-flight Create/PuLID job: while creating we don't want "Make my meme"
  // to consume a stale previous selection.
  const sourceSelected =
    (tab === "stock" && !!stockSelectedId) ||
    (tab === "self-upload" && !!selfUploadImage) ||
    // "Create new AI image" sub-tab = user is building, not selecting — CTA
    // stays disabled until they finish and flip back to "existing".
    (tab === "ai-you" && aiStylingImage?.kind === "ai-styling" && !creatingAi && !pulidJobId && aiSubTab !== "create");

  const handleSourceTab = (next: SourceTab) => {
    setTab(next);
  };

  const handleStockSelect = (image: StockImage) => {
    setStockSelectedId(image.id);
    setStockSelectedUrl(image.url);
  };

  const handleSelfUploadImageSelect = (next: MyImageSource) => {
    setSelfUploadImage(next);
  };

  const handleAiStylingSelect = (next: MyImageSource) => {
    setAiStylingImage(next);
  };

  const handleAiCreate = async ({
    referenceImagePath,
    aiStyleId,
  }: {
    referenceImagePath: string;
    aiStyleId: string;
  }) => {
    // Guard against duplicate taps and re-entry while a job is already
    // running. Without this, repeated clicks would start parallel PuLID
    // jobs and the last response would silently win.
    if (creatingAi || pulidJobId) return;
    setCreatingAi(true);
    setSaveError(null);
    try {
      const res = await fetch("/api/memes/pulid-jobs", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          factId: Number(factId),
          referenceImagePath,
          styleId: aiStyleId,
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
    } finally {
      setCreatingAi(false);
    }
  };

  const wizardPrimaryActionRef = useRef<HTMLDivElement | null>(null);
  // Dedicated ref to the primary CTA itself. Deliberately not
  // `wizardPrimaryActionRef.current.querySelector("button")`: the visibility
  // toggle above the CTA renders its own buttons, so DOM order alone can't
  // tell "Make my meme" apart from "Public"/"Private".
  const primaryButtonRef = useRef<HTMLButtonElement | null>(null);

  const handlePulidJobComplete = (generatedObjectPath: string) => {
    setPulidJobId(null);
    // The new PuLID derivative now exists at generatedObjectPath. Swap it
    // into the AI tab's selection, flip the AI sub-tab to "Use existing AI
    // image" so it appears highlighted in the grid, and bump the reload key
    // so the grid refetches and includes the new row.
    setAiStylingImage({ kind: "ai-styling", objectPath: generatedObjectPath });
    setAiSubTab("existing");
    setAiReloadKey((k) => k + 1);
    // Ensure the "Make my meme" CTA — now active — is visible to the user.
    // The footer is fixed at the bottom of the viewport but mobile browsers
    // and tall content can still hide it under address bars or scroll state.
    // Defer until after React commits so the disabled→enabled transition is
    // already applied and screen readers announce the focus change correctly.
    requestAnimationFrame(() => {
      wizardPrimaryActionRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
      primaryButtonRef.current?.focus({ preventScroll: true });
    });
  };

  const handlePulidJobError = (errorCode: string, message?: string) => {
    setPulidJobId(null);
    if (errorCode === "budget_exceeded") {
      setSaveError("You've out-legended your monthly budget. Come back wilder.");
    } else if (errorCode === "moderation") {
      setSaveError("That image can't be used. It violates our content policy.");
    } else if (errorCode === "no_face") {
      // Belt-and-suspenders fallback: the server's new no_face_review phase
      // routes through handlePulidNoFaceReview before this fires, but if both
      // the face attempt AND the abstract fallback fail downstream we still
      // surface a generic message.
      setSaveError("We couldn't generate that image. Try a different photo.");
    } else {
      setSaveError(message ?? "Our servers couldn't handle that much legend at once. Try again shortly.");
    }
  };

  // Called when the PuLID job parks at no_face_review. The takeover unmounts
  // and we surface the choice modal.
  const handlePulidNoFaceReview = () => {
    const jobId = pulidJobId;
    setPulidJobId(null);
    setNoFaceJobId(jobId);
  };

  const handleNoFaceTryDifferentPhoto = async () => {
    const jobId = noFaceJobId;
    setNoFaceJobId(null);
    // Reset the AI selection so the user is back on the picker.
    setAiStylingImage(null);
    setAiSubTab("create");
    if (!jobId) return;
    try {
      await fetch(`/api/memes/pulid-jobs/${encodeURIComponent(jobId)}`, {
        method: "DELETE",
        credentials: "include",
      });
    } catch {
      // Best-effort cleanup — server-side TTL will GC the job state regardless.
    }
  };

  const handleNoFaceUseAbstract = async () => {
    const jobId = noFaceJobId;
    if (!jobId) return;
    try {
      const res = await fetch(
        `/api/memes/pulid-jobs/${encodeURIComponent(jobId)}/proceed-with-no-face-fallback`,
        { method: "POST", credentials: "include" },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // Re-mount the loading takeover; it'll poll the same jobId until completion.
      setNoFaceJobId(null);
      setPulidJobId(jobId);
    } catch (err) {
      setNoFaceJobId(null);
      setSaveError(
        err instanceof Error
          ? err.message
          : "We couldn't switch to the abstract image. Try a different photo.",
      );
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
          isPublic,
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

    // AI you tab: the AI image has already been forged by the Create button,
    // so there's no second PuLID job. Pass the styling's objectPath as the
    // pulidGeneratedUploadKey so the meme is persisted with imageTransform="pulid".
    if (tab === "ai-you" && aiStylingImage?.kind === "ai-styling") {
      await save(aiStylingImage.objectPath);
      return;
    }

    // Direct save (stock / self-upload).
    await save();
  };

  if (pulidJobId) {
    return (
      <PulidLoadingTakeover
        jobId={pulidJobId}
        onComplete={handlePulidJobComplete}
        onError={handlePulidJobError}
        onNoFaceReview={handlePulidNoFaceReview}
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
      <div className="flex-1 overflow-y-auto overscroll-y-none">
        {/* Bottom padding must clear the fixed action bar, which grows by a
            row when the visibility control is present — otherwise the last
            control sits under it and can't be reached. Sized for the bar's
            TALLEST state (Private selected, whose helper line can wrap to
            two lines) rather than tracking each state separately — a control
            switching between Public/Private must never change whether the
            scroll area's last item is reachable. */}
        <div
          className={`mx-auto max-w-md space-y-4 px-4 pt-4 ${
            tier === "unregistered" ? "pb-24" : "pb-56"
          }`}
        >
          <SourceSegmentedControl
            active={tab}
            canPulidStylize={canPulidStylize}
            onSelect={handleSourceTab}
            onRequestUpgrade={() => {
              setUpgradeContext("ai-tab");
              setUpgradeOpen(true);
            }}
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

          {tab === "self-upload" && tier === "unregistered" && (
            <GuestPhotoSignupPanel
              onUseStock={() => setTab("stock")}
            />
          )}

          {tab === "self-upload" && tier !== "unregistered" && (
            <SelfUploadSourcePanel
              factId={factId}
              selected={selfUploadImage}
              onSelect={handleSelfUploadImageSelect}
            />
          )}

          {tab === "ai-you" && (
            <AiSourcePanel
              factId={factId}
              selected={aiStylingImage}
              onSelect={handleAiStylingSelect}
              subTab={aiSubTab}
              onSubTabChange={setAiSubTab}
              onCreate={handleAiCreate}
              creating={creatingAi}
              aiReloadKey={aiReloadKey}
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

      <div ref={wizardPrimaryActionRef}>
        <WizardPrimaryAction
          label="Make my meme"
          onClick={handleMakeMyMeme}
          disabled={!sourceSelected}
          loading={saving}
          buttonRef={primaryButtonRef}
          aboveAction={
            // Unregistered viewers can't save at all (the CTA routes them to
            // signup), so the visibility choice would be premature noise.
            tier === "unregistered" ? undefined : (
              <VisibilityToggle
                isPublic={isPublic}
                onChange={setIsPublic}
                canSetPrivate={canSetPrivate}
                onRequestUpgrade={() => {
                  setUpgradeContext("private-meme");
                  setUpgradeOpen(true);
                }}
              />
            )
          }
        />
      </div>

      <UnifiedUpgradeModal
        open={upgradeOpen}
        onClose={() => setUpgradeOpen(false)}
        context={upgradeContext}
      />

      <NoFaceFallbackModal
        open={noFaceJobId !== null}
        onPickDifferentPhoto={handleNoFaceTryDifferentPhoto}
        onUseAbstract={handleNoFaceUseAbstract}
        onDismiss={handleNoFaceTryDifferentPhoto}
      />
    </div>
  );
}
