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
 * Bench: classifies as "image-classifier" via engineBenchType() because it
 * takes `imageUrl` but no `prompt`. Shows up next to image/video benches at
 * /admin/engines for IO testing.
 *
 * Cost: ~$0.001-0.005 per image (rough; verify in preflight). Latency: 1-2s p50.
 *
 * Swappable via admin config: the source-image analyzer calls
 * `loadEngine(getImageClassifierEngineId())` so admins can flip the active
 * detector without code changes. Add additional detector engines as separate
 * files and seed their ids into the same admin_config key.
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
  // The active source-image classifier is selected by admin_config key
  // `fact_source_classifier_engine_id`, which defaults to "fal-yolo-world"
  // in `factSourceClassifierConfig.ts`.
  isDefault: false,
  isActive: true,
  sortOrder: 250,
  featureFlagRequired: null,

  allowedDurationsSec: null,
  defaultDurationSec: null,
  allowedResolutions: null,
  defaultResolution: null,
  allowedAspectRatios: null,
  defaultAspectRatio: null,
  supportedModes: [],
  defaultMode: null,

  audioHandling: "none",
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
  estimatedCostUsdPerSecond: null,
};
