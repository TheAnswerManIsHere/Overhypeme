import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import type { AspectRatio, MemeTextOptions, MyImageSource, ViewerContext } from "../../types";
import {
  UnifiedUpgradeModal,
  type UpgradeModalContext,
} from "../../../upgrade/UnifiedUpgradeModal";
import { VisibilityToggle } from "../../parts/VisibilityToggle";
import { WizardPrimaryAction } from "../WizardPrimaryAction";
import type { PendingWizardState } from "../state/wizardStorage";
import type { WizardAction, WizardRuntimeState } from "../state/useWizardState";
import { LockedPreview } from "./LockedPreview";
import { AspectRatioToggle } from "./AspectRatioToggle";
import { SelfUploadSourcePanel } from "./SelfUploadSourcePanel";
import { AiPictureSelector } from "./AiPictureSelector";
import { GuestPhotoSignupPanel } from "./GuestPhotoSignupPanel";
import { AdjustTextSheet } from "./AdjustTextSheet";
import { useCaptionLayout } from "../../captionLayout";
import { AdvancedOptionsSheet } from "./AdvancedOptionsSheet";
import { intelligentSplit } from "./sliders/splitLogic";
import { buildSaveMemePayload } from "../util/saveMemePayload";
import { captionFontOf } from "../../captionFont";
import { CaptionFontStatus } from "../../parts/CaptionFontPicker";
import { useCaptionFont } from "@/lib/captionFontLoader";
import { track } from "@/lib/analytics";
import { useBuilderLayout } from "../../hooks/useWideBuilderLayout";

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
  /** Keeps the draft, with these latest values, as the member leaves for the picture flow. */
  onKeepForPictureFlow?: (latest: Partial<WizardRuntimeState>) => void;
}

interface SaveMemeResponse {
  memeId: number | string;
  permalinkSlug: string;
  permalinkUrl: string;
}

/**
 * Step 2 — image flow. Owns:
 *   - photo selection (the user's own photo is the only source)
 *   - aspect ratio, framing drag
 *   - name/pronouns inline fields
 *   - bottom-sheet drawers (adjust text, advanced)
 *   - "Make my meme" save flow (saved directly)
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
  onKeepForPictureFlow,
}: Props) {
  const [, navigate] = useLocation();
  const tier = viewerContext.tier;
  // Told, not derived — the same answer createMemeRecord will apply.
  const canSetPrivate = viewerContext.entitlements?.["meme_private_visibility"]?.allowed === true;

  const [upgradeOpen, setUpgradeOpen] = useState(false);
  const [upgradeContext, setUpgradeContext] = useState<UpgradeModalContext>("private-meme");
  const [isPublic, setIsPublic] = useState(state.isPublic ?? true);
  const [aspectRatio, setAspectRatio] = useState<AspectRatio>(state.aspectRatio ?? "landscape");
  // Issue #850, amendment 1 (Q31: 1): whichever arrangement shows the picture
  // larger wins, for this screen and this shape.
  const wide = useBuilderLayout(aspectRatio) === "wide";
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
  const [selfUploadImage, setSelfUploadImage] = useState<MyImageSource | null>(
    state.source?.kind === "self-upload" ? state.source.image : null,
  );
  // One of the member's own AI pictures, when it is the background (launch Phase 7).
  const [aiPicture, setAiPicture] = useState<{ aiImageId: number; imageUrl: string } | null>(
    state.source?.kind === "ai-picture" ? { aiImageId: state.source.aiImageId, imageUrl: state.source.imageUrl } : null,
  );
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const defaultSplitIndex = useMemo(
    () => factSplitTokenIndex ?? intelligentSplit(factText),
    [factSplitTokenIndex, factText],
  );
  // Part of the draft, so leaving for the picture flow and coming back keeps it.
  const [splitIndex, setSplitIndex] = useState(state.splitIndex ?? defaultSplitIndex);

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
  useEffect(() => {
    dispatch({ type: "set-split-index", splitIndex });
  }, [splitIndex, dispatch]);

  // Task #507: previously this auto-picked `kind:"primary"` as the implicit
  // default. The profile photo is now just a tagged library entry, so the
  // MyImagePicker library tab auto-selects the first row (server sorts
  // is_profile DESC, created_at DESC) the moment it mounts — the parent
  // doesn't need to seed anything.

  // Persist the source selection.
  useEffect(() => {
    if (aiPicture) {
      dispatch({ type: "set-source", source: { kind: "ai-picture", ...aiPicture } });
      return;
    }
    if (selfUploadImage) {
      dispatch({ type: "set-mode", mode: "self-upload" });
      dispatch({
        type: "set-source",
        source: { kind: "self-upload", image: selfUploadImage },
      });
    }
  }, [selfUploadImage, aiPicture, dispatch]);

  // Background URL for the live preview.
  const backgroundUrl = useMemo(() => {
    if (aiPicture) return aiPicture.imageUrl;
    if (selfUploadImage) {
      return `/api/storage/objects${selfUploadImage.objectPath.replace(/^\/objects/, "")}`;
    }
    return null;
  }, [selfUploadImage, aiPicture]);

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

  // The layout the preview is drawing, for the position sliders (#1260).
  const captionLayout = useCaptionLayout({ factText, name, pronouns, textOptions: memeTextOptions, aspectRatio });

  const sourceSelected = !!selfUploadImage || !!aiPicture;
  // The tier comes from the live auth state on every render (the builder's
  // host passes `roleToIdentity(role)`), and the builder mounts only once auth
  // has resolved, so "unregistered" here means signed out now, including a
  // session that ended while the builder was open.
  const signedIn = tier !== "unregistered";
  // The meme is saved in the face the preview shows, so saving waits until
  // that face has loaded (names-and-fonts plan).
  const captionFontId = captionFontOf(textOptions);
  const captionFontReady = useCaptionFont(captionFontId).status === "ready";

  // Choosing a photo makes it the background again.
  const handleSelfUploadImageSelect = (next: MyImageSource) => {
    setAiPicture(null);
    setSelfUploadImage(next);
  };
  // The picker's own default pick never replaces an AI picture already used as the background.
  const handleSelfUploadImageAutoSelect = (next: MyImageSource) => {
    setSelfUploadImage(next);
  };

  // "Make an AI picture" opens its own flow with the builder's shape and
  // caption; the draft is kept exactly as it stands for the way back.
  const openPictureFlow = () => {
    onKeepForPictureFlow?.({ aspectRatio, framingOffset, name, pronouns, textOptions, isPublic, splitIndex });
    navigate(`/facts/${factId}/picture?from=builder`);
  };

  const save = async () => {
    // The create request carries the visitor's name and pronouns, so it goes
    // only from a resolved, signed-in session (#724). A selected photo is not
    // proof of sign-in: a draft restored after the session ended can hold one.
    if (!signedIn) {
      onRequestSignup({});
      return;
    }
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
      track("meme_made");
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
    if (!sourceSelected || saving || !captionFontReady) return;
    await save();
  };

  // The controls and the commit action are the same in both layouts; only
  // where they sit changes (Issue #850). Step2Image stays mounted across a
  // layout switch, so every choice held here carries over.
  const preview = (
    <LockedPreview
      factText={factText}
      name={name}
      pronouns={pronouns}
      backgroundUrl={backgroundUrl}
      textOptions={memeTextOptions}
      aspectRatio={aspectRatio}
      framingOffset={framingOffset}
      onFramingChange={setFramingOffset}
      fill={wide}
    />
  );

  const controls = (
    <>
      <AspectRatioToggle value={aspectRatio} onChange={setAspectRatio} />

      {tier === "unregistered" ? (
        <GuestPhotoSignupPanel />
      ) : (
        <>
          <SelfUploadSourcePanel
            selected={selfUploadImage}
            onSelect={handleSelfUploadImageSelect}
            onAutoSelect={handleSelfUploadImageAutoSelect}
          />
          <AiPictureSelector
            factId={factId}
            selectedAiImageId={aiPicture?.aiImageId ?? null}
            onPicture={setAiPicture}
            onMakePicture={openPictureFlow}
          />
        </>
      )}

      <AdjustTextSheet
        factText={factText}
        defaultSplitIndex={defaultSplitIndex}
        splitIndex={splitIndex}
        onSplitChange={setSplitIndex}
        textOptions={textOptions}
        onTextOptionsChange={setTextOptions}
        captionLayout={captionLayout}
      />

      <AdvancedOptionsSheet value={textOptions} onChange={setTextOptions} />

      {/* Saving waits for the caption face; when it is slow or fails, say
          so here, outside the collapsed Advanced options (Codex, PR #844). */}
      <CaptionFontStatus id={captionFontId} otherStylesHint="under Advanced options" />

      {saveError && (
        <p
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {saveError}
        </p>
      )}
    </>
  );

  const action = (
    <WizardPrimaryAction
      writes
      label="Make my meme"
      onClick={handleMakeMyMeme}
      disabled={!sourceSelected || !captionFontReady}
      loading={saving}
      placement={wide ? "inline" : "fixed"}
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
  );

  // One tree for both layouts: every element keeps its type and position, and
  // only classes change, so turning the screen rebuilds nothing — not the
  // photo panel mid-upload, not an open options panel (PR #1252's build report).
  return (
    <div className={wide ? "flex h-full flex-row" : "flex h-full flex-col"} data-layout={wide ? "wide" : "stacked"}>
      <h1 className="sr-only">Build your meme</h1>

      {/* Wide: the preview fills everything left of the controls column.
          Stacked: the preview is locked above the controls and never scrolls. */}
      <div
        className={wide ? "min-w-0 flex-1" : "shrink-0"}
        data-testid={wide ? "builder-preview-column" : undefined}
      >
        {preview}
      </div>

      {/* Wide: the controls scroll in their own column with the action in flow
          at its foot. Stacked: the controls scroll under the preview and the
          action bar is fixed to the bottom of the screen. */}
      <div
        className={wide ? "flex w-[420px] shrink-0 flex-col border-l border-white/10" : "flex min-h-0 flex-1 flex-col"}
        role={wide ? "complementary" : undefined}
        aria-label={wide ? "Meme options" : undefined}
        data-testid={wide ? "builder-controls-column" : undefined}
      >
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-y-none" data-testid="builder-controls-scroll">
          {/* Stacked: bottom padding must clear the fixed action bar, which grows by a
              row when the visibility control is present — otherwise the last
              control sits under it and can't be reached. Sized for the bar's
              TALLEST state (Private selected, whose helper line can wrap to
              two lines) rather than tracking each state separately — a control
              switching between Public/Private must never change whether the
              scroll area's last item is reachable. */}
          <div
            className={
              wide
                ? "space-y-4 px-4 pt-4 pb-6"
                : `mx-auto max-w-md space-y-4 px-4 pt-4 ${tier === "unregistered" ? "pb-24" : "pb-56"}`
            }
          >
            {controls}
          </div>
        </div>
        {action}
      </div>

      <UnifiedUpgradeModal
        open={upgradeOpen}
        onClose={() => setUpgradeOpen(false)}
        context={upgradeContext}
      />
    </div>
  );
}
