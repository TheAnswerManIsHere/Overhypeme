/**
 * Tier-2 heuristics — turn flat detector output into a structured
 * `SourceImageAnalysis`.
 *
 * Deterministic scoring picks the dominant detection:
 *   score = confidence * boxAreaFraction * centralityWeight
 * Tier-2 also decides whether escalation to Tier-3 (AI vision) is warranted
 * via `shouldEscalate()`.
 *
 * NOTE on labels: open-vocab detectors (YOLO-World, Grounding-DINO) return
 * arbitrary text labels from the query vocabulary. We match labels against
 * lowercase keyword sets to bucket them into SourceSubjectKind. This is
 * intentionally lossy — Tier-2 only needs to be GOOD ENOUGH for routing;
 * Tier-3 rescues low-confidence cases.
 */

import {
  type SourceImageDetection,
  type SourceImageAnalysis,
  type SourceSubjectKind,
  type ClassificationConfidence,
  type SubjectRenderMode,
  SOURCE_IMAGE_ANALYZER_VERSION,
} from "@workspace/api-zod";

const HUMAN_FACE_LABELS = new Set(["face", "human face", "head", "headshot"]);
const PERSON_LABELS = new Set(["person", "human", "people", "man", "woman", "child", "boy", "girl"]);
const ANIMAL_LABELS = new Set([
  "cat", "kitten", "dog", "puppy", "bird", "horse", "cow", "sheep", "bear",
  "elephant", "zebra", "giraffe", "lion", "tiger", "fox", "deer", "rabbit",
  "hamster", "guinea pig", "parrot", "fish", "lizard", "snake", "frog",
]);
const VEHICLE_LABELS = new Set([
  "car", "truck", "motorcycle", "bicycle", "bus", "airplane", "boat", "train",
  "van", "suv", "vehicle", "scooter", "tractor",
]);
const MASCOT_LABELS = new Set([
  "toy", "stuffed animal", "mascot", "statue", "sculpture", "doll", "figurine", "robot",
]);
const OBJECT_LABELS_HINT = new Set([
  "bottle", "cup", "lamp", "phone", "laptop", "chair", "couch", "bag",
  "guitar", "ball", "bag", "skateboard", "surfboard", "kite", "umbrella",
  "appliance", "product",
]);

interface SubjectScore {
  index: number;
  detection: SourceImageDetection;
  score: number;
  areaFraction: number;
  centralityWeight: number;
  category: SourceSubjectKind;
}

const FACE_AREA_THRESHOLD = 0.02; // 2% of frame
const SUBJECT_AREA_THRESHOLD = 0.03;
const HIGH_CONFIDENCE_THRESHOLD = 0.55;
const LOW_CONFIDENCE_THRESHOLD = 0.30;
const MULTIPLE_SUBJECTS_RATIO = 0.7; // 2nd-place score must be > 70% of leader's

export interface Tier2Options {
  /** Used to compute area fraction; default 1 (unit square) when unknown. */
  imageWidth?: number;
  imageHeight?: number;
}

export function classifyTier2(
  detections: SourceImageDetection[],
  opts: Tier2Options = {},
): {
  analysis: Omit<SourceImageAnalysis, "classificationMethod" | "analyzerVersion" | "sourceImageSha256">;
  shouldEscalate: boolean;
  dominantScore?: SubjectScore;
} {
  const W = opts.imageWidth && opts.imageWidth > 0 ? opts.imageWidth : 1;
  const H = opts.imageHeight && opts.imageHeight > 0 ? opts.imageHeight : 1;

  const scored: SubjectScore[] = detections.map((det, index) => {
    const category = categorize(det.label);
    const box = det.box;
    const areaFraction = box ? (box.width * box.height) / (W * H) : 0.05;
    const centralityWeight = box ? centralityFromBox(box, W, H) : 0.5;
    const conf = clamp01(det.score);
    const score = conf * (areaFraction || 0.05) * centralityWeight;
    return { index, detection: det, score, areaFraction, centralityWeight, category };
  });

  scored.sort((a, b) => b.score - a.score);
  const dominant = scored[0];

  // No detections at all → no clear subject.
  if (!dominant) {
    return {
      analysis: {
        subjectKind: "scene_no_clear_subject",
        confidence: "high",
        hasUsableHumanFace: false,
        hasUsableSubject: false,
        subjectCount: 0,
        subjectDescription: undefined,
        detections: [],
        suggestedRenderMode: "t2i_fallback",
        warnings: ["No detectable subject in this image."],
      },
      shouldEscalate: false,
    };
  }

  // Special-case: a usable human face wins regardless of dominance ranking.
  // (We separately scan for face labels first.)
  const faceDet = scored.find(
    (s) => HUMAN_FACE_LABELS.has(s.detection.label.toLowerCase()) &&
      s.detection.score >= HIGH_CONFIDENCE_THRESHOLD &&
      s.areaFraction >= FACE_AREA_THRESHOLD,
  );
  const personDet = scored.find(
    (s) => PERSON_LABELS.has(s.detection.label.toLowerCase()) &&
      s.detection.score >= LOW_CONFIDENCE_THRESHOLD &&
      s.areaFraction >= SUBJECT_AREA_THRESHOLD,
  );

  if (faceDet) {
    return {
      analysis: {
        subjectKind: "human_face",
        confidence: confidenceFromScore(faceDet.detection.score),
        hasUsableHumanFace: true,
        hasUsableSubject: true,
        subjectCount: countDistinctSubjects(scored),
        subjectDescription: `Clear human face (confidence ${faceDet.detection.score.toFixed(2)})`,
        detections,
        suggestedRenderMode: "human_identity_i2i",
        warnings: [],
      },
      shouldEscalate: false,
      dominantScore: faceDet,
    };
  }

  // Person visible but no usable face → distinct from "no face at all".
  if (personDet) {
    return {
      analysis: {
        subjectKind: "human_subject_no_usable_face",
        confidence: confidenceFromScore(personDet.detection.score),
        hasUsableHumanFace: false,
        hasUsableSubject: false, // route to t2i fallback per the warning copy
        subjectCount: countDistinctSubjects(scored),
        subjectDescription: `Person visible (${personDet.detection.label}) without a usable face`,
        detections,
        suggestedRenderMode: "t2i_fallback",
        warnings: [
          "We see a person in this photo but the face isn't clear enough for likeness preservation.",
        ],
      },
      shouldEscalate: false,
      dominantScore: personDet,
    };
  }

  // Use the dominant non-face/non-person detection.
  const second = scored[1];
  const isMultiple = !!second && second.score >= dominant.score * MULTIPLE_SUBJECTS_RATIO
    && second.category !== "ambiguous"
    && dominant.category !== "ambiguous";

  if (isMultiple) {
    return {
      analysis: {
        subjectKind: "multiple_subjects",
        confidence: confidenceFromScore(dominant.detection.score),
        hasUsableHumanFace: false,
        hasUsableSubject: dominant.detection.score >= LOW_CONFIDENCE_THRESHOLD,
        subjectCount: countDistinctSubjects(scored),
        subjectDescription: `Multiple comparable subjects: ${dominant.detection.label}, ${second.detection.label}`,
        detections,
        suggestedRenderMode: "t2i_fallback",
        warnings: ["Multiple comparable subjects detected — the result may not preserve the one you wanted."],
      },
      shouldEscalate: false,
      dominantScore: dominant,
    };
  }

  // Single dominant subject case.
  const confidence = confidenceFromScore(dominant.detection.score);
  const lowSize = dominant.areaFraction < SUBJECT_AREA_THRESHOLD;
  const usable = !lowSize && dominant.detection.score >= LOW_CONFIDENCE_THRESHOLD;

  // Ambiguous: dominant category is "ambiguous" OR confidence is low.
  if (dominant.category === "ambiguous" || confidence === "low") {
    return {
      analysis: {
        subjectKind: confidence === "low" ? "ambiguous" : dominant.category,
        confidence,
        hasUsableHumanFace: false,
        hasUsableSubject: usable,
        subjectCount: countDistinctSubjects(scored),
        subjectDescription: usable
          ? `${dominant.detection.label} (low confidence)`
          : "Subject unclear",
        detections,
        suggestedRenderMode: usable ? "nonhuman_subject_i2i" : "t2i_fallback",
        warnings: ["Subject classification uncertain — consider Tier-3 AI vision."],
      },
      shouldEscalate: true,
      dominantScore: dominant,
    };
  }

  // Dominant non-human subject (animal / vehicle / mascot / object).
  return {
    analysis: {
      subjectKind: dominant.category,
      confidence,
      hasUsableHumanFace: false,
      hasUsableSubject: usable,
      subjectCount: countDistinctSubjects(scored),
      subjectDescription: dominant.detection.label,
      detections,
      suggestedRenderMode: usable ? "nonhuman_subject_i2i" : "t2i_fallback",
      warnings: usable ? [] : ["Subject is small or low-confidence; consider a different upload."],
    },
    shouldEscalate: !usable,
    dominantScore: dominant,
  };
}

function categorize(label: string): SourceSubjectKind {
  const lc = label.toLowerCase().trim();
  if (HUMAN_FACE_LABELS.has(lc)) return "human_face";
  if (PERSON_LABELS.has(lc)) return "human_subject_no_usable_face"; // upgraded by faceDet check above
  if (ANIMAL_LABELS.has(lc)) return "animal_subject";
  if (VEHICLE_LABELS.has(lc)) return "vehicle_subject";
  if (MASCOT_LABELS.has(lc)) return "mascot_or_character_subject";
  if (OBJECT_LABELS_HINT.has(lc)) return "object_subject";
  // Heuristic fallback: anything not matched is "object_subject" if it has
  // any score; the analyzer's confidence handling demotes truly weak ones
  // to "ambiguous". This is intentionally permissive — Tier-3 can re-classify.
  if (lc.length > 0) return "object_subject";
  return "ambiguous";
}

function centralityFromBox(box: { x: number; y: number; width: number; height: number }, W: number, H: number): number {
  const cx = (box.x + box.width / 2) / W;
  const cy = (box.y + box.height / 2) / H;
  const dx = Math.abs(cx - 0.5);
  const dy = Math.abs(cy - 0.5);
  const dist = Math.min(1, Math.sqrt(dx * dx + dy * dy) / 0.5);
  return 1 - 0.5 * dist; // [0.5, 1.0]
}

function confidenceFromScore(score: number): ClassificationConfidence {
  if (score >= HIGH_CONFIDENCE_THRESHOLD) return "high";
  if (score >= LOW_CONFIDENCE_THRESHOLD) return "medium";
  return "low";
}

function countDistinctSubjects(scored: SubjectScore[]): number {
  return scored.filter((s) => s.detection.score >= LOW_CONFIDENCE_THRESHOLD).length;
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

// Re-export for the resolver.
export { SOURCE_IMAGE_ANALYZER_VERSION };
export type { SubjectRenderMode };
