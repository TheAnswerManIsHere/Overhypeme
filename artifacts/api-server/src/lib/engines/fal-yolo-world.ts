import type { EngineDefinition } from "./types";

/**
 * fal-ai/yolo-world — open-vocabulary object detector.
 *
 * Phase 2 default Tier-1 source-image classifier. Takes an image URL + a list
 * of class names (open-vocab text queries; the model is COCO-trained but
 * accepts arbitrary nouns) and returns detections with class label, score,
 * and bounding box. The Phase 2 source-image analyzer maps detections →
 * `SourceSubjectKind` (human_face / animal_subject / vehicle_subject / ...).
 *
 * Schema notes (verify against fal's live docs at integration time):
 *   - input: { image_url: string, classes?: string, ... }
 *   - output: { detections: Array&lt;{ label, score, box: { x, y, w, h } }&gt; }
 *
 * Cost: ~$0.001-0.005 per image (rough; verify in preflight). Latency: 1-2s p50.
 *
 * The source-image analyzer calls `engineById(getImageClassifierEngineId())`,
 * and that id is set in code (decisions.md 2026-11-14: AI call settings live in code). To swap
 * detectors, add the engine to the catalogue and change the constant.
 */
export const FAL_YOLO_WORLD: EngineDefinition = {
  id: "fal-yolo-world",
  provider: "fal",
  endpointId: "fal-ai/yolo-world",
  label: "YOLO-World (open-vocab detector)",
  description:
    "Phase 2 default source-image classifier. Open-vocabulary object detector; queries by class names and returns labels + bounding boxes + scores.",
  kind: "utility",
  tierRequirement: "legendary",
  // NOT a kind="utility" catalogue default — auto-subtitle already holds that slot.
  // The active source-image classifier is `DEFAULT_IMAGE_CLASSIFIER_ENGINE_ID`
  // in `imagePromptConfig.ts`, set in code.
  isActive: true,
  sortOrder: 250,
  featureFlagRequired: null,

  allowedResolutions: null,
  defaultResolution: null,
  allowedAspectRatios: null,
  defaultAspectRatio: null,

  paramSchema: {
    params: [
      { name: "image_url", from: "imageUrl", type: "string", required: true },
      // Comma-separated class names. The Phase 2 analyzer queries the core
      // subject taxonomy (person, face, cat, dog, ..., car, truck, ...).
      {
        name: "classes",
        from: "classes",
        type: "string",
        default:
          "person, face, cat, dog, bird, horse, cow, sheep, bear, elephant, zebra, giraffe, car, truck, motorcycle, bicycle, bus, airplane, boat, toy, stuffed animal, statue, mascot, sculpture, robot, vehicle",
      },
      {
        name: "confidence",
        from: "confidenceThreshold",
        type: "float",
        default: 0.2,
        range: { min: 0, max: 1, policy: "clamp" },
      },
      {
        name: "iou_threshold",
        from: "iouThreshold",
        type: "float",
        default: 0.5,
        range: { min: 0, max: 1, policy: "clamp" },
      },
      // Optional max-detections cap; omitted defers to fal default.
      { name: "max_detections", from: "maxDetections", type: "int" },
    ],
  },

  expectedRunMs: 1500,
  estimatedCostUsdPerCall: 0.003,
};
