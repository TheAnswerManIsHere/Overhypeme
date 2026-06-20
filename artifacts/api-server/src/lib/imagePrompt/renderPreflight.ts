/**
 * Approval-time renderability preflight.
 *
 * Replaces the retired enrichment-time `visualPromptPreview` approval gate with
 * a NON-PERSISTENT check that runs the real render-time pipeline once, over a
 * neutral canonical subject, to confirm the fact can actually be turned into a
 * coherent image before it is approved.
 *
 * It shares the EXACT runtime path the RuntimePromptPreview uses
 * (`assembleImagePromptForPreview` → planner → Nano Banana compiler), so the
 * moderator override, `resolveRenderPolicy`, cultural references, and semantic
 * entities all flow through identically to render time. It persists NOTHING and
 * introduces no new preview-like field/status.
 *
 * SCOPE: this gate validates ONLY the canonical `human_identity_i2i` path (a
 * synthetic `human_face` source analysis) — the primary and hardest render
 * mode. The t2i fallback path is NOT gated here, and error copy must not imply
 * that every style/mode was validated.
 */

import {
  defaultIdentityPolicyForRenderMode,
  SOURCE_IMAGE_ANALYZER_VERSION,
  type FactEnrichment,
  type RenderControls,
  type SourceImageAnalysis,
  type SubjectRenderMode,
} from "@workspace/api-zod";
import { renderPersonalized } from "../renderCanonical";
import { assembleImagePromptForPreview } from "./preview";

// Neutral canonical subject for the preflight — deliberately NOT the brand
// protagonist ("David") so the check can't pass/fail on a fixed-David bias. The
// fact text is rendered for this subject and the planner sees them as the
// person in the (synthetic) reference image.
export const CANONICAL_RENDER_PREFLIGHT_SUBJECT = "Alex Jordan";
export const CANONICAL_RENDER_PREFLIGHT_PRONOUNS = "they/them";

const PREFLIGHT_SUBJECT_RENDER_MODE: SubjectRenderMode = "human_identity_i2i";

// Bounded deadline so a stalled provider call can never hang the approval
// request. One retry on timeout only (never on a valid "poor" result or a
// thrown planner/compiler error). Overridable via env so tests can use a short
// deadline instead of waiting the full production timeout.
const PREFLIGHT_TIMEOUT_MS = Number(process.env["RENDER_PREFLIGHT_TIMEOUT_MS"]) || 20_000;

export type RenderPreflightResult =
  | { ok: true }
  | { ok: false; kind: "unrenderable"; message: string }
  | { ok: false; kind: "preflight_failed"; retryable: boolean; detail: string };

/** Synthetic human_face source analysis — mirrors what adminImagePrompt builds. */
function syntheticHumanFaceAnalysis(): SourceImageAnalysis {
  return {
    subjectKind: "human_face",
    confidence: "high",
    hasUsableHumanFace: true,
    hasUsableSubject: true,
    subjectCount: 1,
    detections: [],
    suggestedRenderMode: PREFLIGHT_SUBJECT_RENDER_MODE,
    warnings: [],
    classificationMethod: "not_analyzed",
    analyzerVersion: SOURCE_IMAGE_ANALYZER_VERSION,
  };
}

class PreflightTimeoutError extends Error {
  constructor() {
    super("render preflight timed out");
    this.name = "PreflightTimeoutError";
  }
}

async function runOnce(factText: string, enrichment: FactEnrichment): Promise<RenderPreflightResult> {
  const renderedFactText = renderPersonalized(
    factText,
    CANONICAL_RENDER_PREFLIGHT_SUBJECT,
    CANONICAL_RENDER_PREFLIGHT_PRONOUNS,
  );

  const renderControls: RenderControls = {
    aspectRatio: "portrait",
    contentMode: "sfw",
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new PreflightTimeoutError()), PREFLIGHT_TIMEOUT_MS);
  });

  try {
    const assembled = await Promise.race([
      assembleImagePromptForPreview({
        renderedFactText,
        enrichment,
        sourceImageAnalysis: syntheticHumanFaceAnalysis(),
        subjectRenderMode: PREFLIGHT_SUBJECT_RENDER_MODE,
        userSelectedSubjectRenderMode: null,
        identityPolicy: defaultIdentityPolicyForRenderMode(PREFLIGHT_SUBJECT_RENDER_MODE),
        renderControls,
        stylePrompt: "",
        referenceImageUrl: null,
        renderedSubject: {
          name: CANONICAL_RENDER_PREFLIGHT_SUBJECT,
          pronouns: CANONICAL_RENDER_PREFLIGHT_PRONOUNS,
        },
        requestId: `approval-preflight-${crypto.randomUUID()}`,
      }),
      deadline,
    ]);

    const rating = assembled.output.visualPlan.subjectFactCompatibility?.rating;
    if (rating === "poor") {
      const reason = assembled.output.visualPlan.subjectFactCompatibility?.reason ?? "";
      return {
        ok: false,
        kind: "unrenderable",
        message:
          "This fact doesn't render coherently as an image-to-image meme of a human subject" +
          (reason ? `: ${reason}` : ".") +
          " Edit the fact or its enrichment so the visual is achievable before approving.",
      };
    }
    return { ok: true };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Run the canonical human_identity_i2i render preflight for a fact + enrichment.
 * Persists nothing.
 *
 * Result mapping:
 *  - planner succeeds and `subjectFactCompatibility.rating === "poor"`
 *      → `{ ok: false, kind: "unrenderable" }` (content problem; actionable).
 *  - the check times out → `{ ok: false, kind: "preflight_failed", retryable: true }`
 *      (transient; review state should be left unchanged and the admin asked to retry).
 *  - any other thrown error (ImagePromptError / compiler / schema) →
 *      `{ ok: false, kind: "preflight_failed", retryable: false }` (logged with detail).
 */
export async function assertFactPassesCanonicalRenderPreflight(
  factText: string,
  enrichment: FactEnrichment,
): Promise<RenderPreflightResult> {
  try {
    return await runOnce(factText, enrichment);
  } catch (err) {
    if (err instanceof PreflightTimeoutError) {
      // One retry on timeout only.
      try {
        return await runOnce(factText, enrichment);
      } catch (retryErr) {
        if (retryErr instanceof PreflightTimeoutError) {
          return {
            ok: false,
            kind: "preflight_failed",
            retryable: true,
            detail: "render preflight timed out after retry",
          };
        }
        return {
          ok: false,
          kind: "preflight_failed",
          retryable: false,
          detail: retryErr instanceof Error ? retryErr.message : String(retryErr),
        };
      }
    }
    return {
      ok: false,
      kind: "preflight_failed",
      retryable: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}
