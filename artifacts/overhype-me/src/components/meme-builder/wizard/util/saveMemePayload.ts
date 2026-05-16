/**
 * Translates wizard state into the POST /api/memes request body.
 *
 * Three source modes map to the server's discriminated `imageSource`:
 *
 *   Wizard                                            → Server imageSource         imageTransform
 *   ──────────────────────────────────────────────────  ──────────────────────────  ───────────────
 *   mode="stock"                                      → { type:"stock", … }        undefined
 *   mode="self-upload", source.stylizeWithAi=false    → { type:"upload", … }       undefined
 *   mode="self-upload", source.stylizeWithAi=true     → { type:"upload", … }       "pulid"
 *   AI tab + source.image.kind="primary"              → { type:"identity" }        "pulid"
 *
 * The PuLID flow (last two rows) does NOT POST directly to /api/memes — it
 * first kicks off a job via /api/memes/pulid-jobs and uses the returned
 * `generatedObjectPath` as the upload key when saving.
 */
import type { AspectRatio, MemeTextOptions } from "../../types";
import type { WizardRuntimeState } from "../state/useWizardState";

export interface SaveMemePayload {
  factId: number;
  imageSource:
    | { type: "stock"; pexelsPhotoId: number; photoUrl?: string; photographerName?: string }
    | { type: "upload"; uploadKey: string }
    | { type: "identity" };
  name?: string;
  pronouns?: string;
  textOptions?: MemeTextOptions;
  framingTransform?: { offsetX: number; offsetY: number } | null;
  aspectRatio?: AspectRatio;
  imageTransform?: "pulid" | "pulid_fallback_text";
}

export interface BuildPayloadArgs {
  state: WizardRuntimeState;
  factId: number;
  pulidGeneratedUploadKey?: string;
}

export function buildSaveMemePayload(args: BuildPayloadArgs): SaveMemePayload | null {
  const { state, factId, pulidGeneratedUploadKey } = args;
  if (!state.source) return null;

  const base: Pick<SaveMemePayload, "factId" | "name" | "pronouns" | "textOptions" | "framingTransform" | "aspectRatio"> = {
    factId,
    name: state.name,
    pronouns: state.pronouns,
    textOptions: state.textOptions,
    framingTransform: state.framingOffset
      ? { offsetX: state.framingOffset.x, offsetY: state.framingOffset.y }
      : null,
    aspectRatio: state.aspectRatio,
  };

  if (state.source.kind === "stock") {
    const numericId = Number(state.source.stockImageId);
    if (!Number.isFinite(numericId) || numericId <= 0) return null;
    return {
      ...base,
      imageSource: { type: "stock", pexelsPhotoId: numericId },
    };
  }

  if (state.source.kind === "self-upload") {
    const image = state.source.image;
    const stylize = state.source.stylizeWithAi;

    // When stylize is on, the client must have already completed a PuLID job
    // and is now persisting the resulting derivative as an upload.
    if (stylize) {
      if (!pulidGeneratedUploadKey) return null;
      return {
        ...base,
        imageSource: { type: "upload", uploadKey: pulidGeneratedUploadKey },
        imageTransform: "pulid",
      };
    }

    // Identity (user's primary photo) collapses to `type:"identity"` when not
    // stylized — the server resolves the avatar.
    if (image.kind === "primary") {
      return { ...base, imageSource: { type: "identity" } };
    }
    if (image.kind === "library" || image.kind === "fresh" || image.kind === "ai-styling") {
      return {
        ...base,
        imageSource: { type: "upload", uploadKey: image.objectPath },
      };
    }
  }

  return null;
}
