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
import { GuestPhotoSignupPanel } from "./GuestPhotoSignupPanel";
import { AdjustTextSheet } from "./AdjustTextSheet";
import { AdvancedOptionsSheet } from "./AdvancedOptionsSheet";
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
}: Props) {
  const [, navigate] = useLocation();
  const tier = viewerContext.tier;
  // Told, not derived — the same answer createMemeRecord will apply.
  const canSetPrivate = viewerContext.entitlements?.["meme_private_visibility"]?.allowed === true;

  const [upgradeOpen, setUpgradeOpen] = useState(false);
  const [upgradeContext, setUpgradeContext] = useState<UpgradeModalContext>("private-meme");
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
  const [selfUploadImage, setSelfUploadImage] = useState<MyImageSource | null>(
    state.source?.kind === "self-upload" ? state.source.image : null,
  );
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
    if (selfUploadImage) {
      dispatch({ type: "set-mode", mode: "self-upload" });
      dispatch({
        type: "set-source",
        source: { kind: "self-upload", image: selfUploadImage },
      });
    }
  }, [selfUploadImage, dispatch]);

  // Background URL for the live preview.
  const backgroundUrl = useMemo(() => {
    if (selfUploadImage) {
      return `/api/storage/objects${selfUploadImage.objectPath.replace(/^\/objects/, "")}`;
    }
    return null;
  }, [selfUploadImage]);

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

  const sourceSelected = !!selfUploadImage;

  const handleSelfUploadImageSelect = (next: MyImageSource) => {
    setSelfUploadImage(next);
  };

  const save = async () => {
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
    await save();
  };

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
          <AspectRatioToggle value={aspectRatio} onChange={setAspectRatio} />

          {tier === "unregistered" ? (
            <GuestPhotoSignupPanel />
          ) : (
            <SelfUploadSourcePanel
              selected={selfUploadImage}
              onSelect={handleSelfUploadImageSelect}
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

      <div>
        <WizardPrimaryAction
          label="Make my meme"
          onClick={handleMakeMyMeme}
          disabled={!sourceSelected}
          loading={saving}
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
    </div>
  );
}
