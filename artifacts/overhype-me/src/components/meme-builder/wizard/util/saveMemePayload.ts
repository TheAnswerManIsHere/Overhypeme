/**
 * Translates wizard state into the POST /api/memes request body.
 *
 * One source maps to the server's discriminated `imageSource`:
 *
 *   Wizard               → Server imageSource
 *   ───────────────────    ─────────────────────
 *   mode="self-upload"   → { type:"upload", … }
 *
 * The stock mode went with Pexels (launch Phase 4, removal 6) and the
 * PuLID-stylised mode with PuLID (removal 3); this never produces a stock
 * `imageSource`.
 */
import { DEFAULT_BOTTOM_Y, DEFAULT_TOP_Y, type AspectRatio, type MemeTextOptions } from "../../types";
import type { WizardRuntimeState } from "../state/useWizardState";
import { withCaptionFont } from "../../captionFont";

export interface SaveMemePayload {
  factId: number;
  imageSource:
    | { type: "upload"; uploadKey: string }
    | { type: "identity" };
  name?: string;
  pronouns?: string;
  textOptions?: MemeTextOptions;
  framingTransform?: { offsetX: number; offsetY: number } | null;
  aspectRatio?: AspectRatio;
  /**
   * Gallery visibility. Always sent explicitly so the saved row reflects the
   * control the user actually saw, rather than relying on the server default.
   * A non-Legendary-level caller who sends `false` is rejected with a 403 —
   * the server never downgrades an explicit private request to public.
   */
  isPublic: boolean;
}

export interface BuildPayloadArgs {
  state: WizardRuntimeState;
  factId: number;
}

/**
 * A split caption is saved with the positions the preview drew it at, the
 * slider defaults when the user never moved them, so the saved meme places
 * each half where the preview showed it (#707). A caption that is not split
 * is sent unchanged.
 */
function withCaptionPositions(options: MemeTextOptions | undefined): MemeTextOptions | undefined {
  if (!options || options.topText === undefined || options.bottomText === undefined) return options;
  return {
    ...options,
    topY: options.topY ?? DEFAULT_TOP_Y,
    bottomY: options.bottomY ?? DEFAULT_BOTTOM_Y,
  };
}

export function buildSaveMemePayload(args: BuildPayloadArgs): SaveMemePayload | null {
  const { state, factId } = args;
  if (!state.source) return null;

  const base: Pick<
    SaveMemePayload,
    "factId" | "name" | "pronouns" | "textOptions" | "framingTransform" | "aspectRatio" | "isPublic"
  > = {
    factId,
    name: state.name,
    pronouns: state.pronouns,
    textOptions: withCaptionFont(withCaptionPositions(state.textOptions)),
    framingTransform: state.framingOffset
      ? { offsetX: state.framingOffset.x, offsetY: state.framingOffset.y }
      : null,
    aspectRatio: state.aspectRatio,
    isPublic: state.isPublic ?? true,
  };

  if (state.source.kind === "self-upload") {
    const image = state.source.image;
    if (image.kind === "library" || image.kind === "fresh") {
      return {
        ...base,
        imageSource: { type: "upload", uploadKey: image.objectPath },
      };
    }
  }

  return null;
}
