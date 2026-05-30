/**
 * User-facing warning copy for the pre-generate confirmation modal.
 *
 * Per subjectKind, surfaces a short message + button choices. Verbatim text
 * from the Phase 2 update doc's "User-facing behavior" section. The frontend
 * imports these strings so the modal stays in sync with what the server
 * decides about the upload.
 */

import type { SourceSubjectKind } from "@workspace/api-zod";

export interface SubjectWarningMessage {
  /** Short headline for the modal title. */
  title: string;
  /** Body text explaining what we found. */
  body: string;
  /** Whether the modal needs an explicit confirm tap (true) or can auto-proceed. */
  requiresConfirmation: boolean;
  /** Choice labels rendered as buttons. */
  options: SubjectWarningOption[];
  /** Sentinel for advanced/experimental subjects (object/vehicle/mascot). */
  experimentalTag?: boolean;
}

export type SubjectWarningOption =
  | { kind: "proceed_human"; label: string }
  | { kind: "proceed_nonhuman"; label: string }
  | { kind: "proceed_t2i_fallback"; label: string }
  | { kind: "upload_different"; label: string };

const PROCEED_T2I: SubjectWarningOption = {
  kind: "proceed_t2i_fallback",
  label: "Generate a person instead",
};
const UPLOAD_DIFFERENT: SubjectWarningOption = {
  kind: "upload_different",
  label: "Upload a different image",
};
const GENERATE_WITHOUT_IMAGE: SubjectWarningOption = {
  kind: "proceed_t2i_fallback",
  label: "Generate without this image",
};

export function getSubjectWarning(kind: SourceSubjectKind): SubjectWarningMessage {
  switch (kind) {
    case "human_face":
      return {
        title: "Face detected",
        body: "We found a clear face. We'll use this photo as the identity source.",
        requiresConfirmation: false,
        options: [
          { kind: "proceed_human", label: "Use this face" },
          UPLOAD_DIFFERENT,
        ],
      };

    case "human_subject_no_usable_face":
      return {
        title: "Face not usable",
        body:
          "We can see a person in this photo but the face isn't usable for likeness preservation (back-facing, blurry, or occluded). We'll generate without face preservation — or upload a clearer headshot.",
        requiresConfirmation: true,
        options: [
          { kind: "proceed_t2i_fallback", label: "Generate without face preservation" },
          UPLOAD_DIFFERENT,
        ],
      };

    case "animal_subject":
      return {
        title: "Animal detected",
        body:
          "This looks like an animal rather than a person. You can still use it as the star of the meme. Some facts may get surreal, but it can be funny.",
        requiresConfirmation: true,
        options: [
          { kind: "proceed_nonhuman", label: "Use this animal as the protagonist" },
          PROCEED_T2I,
          UPLOAD_DIFFERENT,
        ],
      };

    case "object_subject":
    case "vehicle_subject":
    case "mascot_or_character_subject":
      return {
        title: "Object detected",
        body:
          "This looks like an object rather than a person. Experimental mode can use it as the protagonist, but some facts may not make visual sense.",
        requiresConfirmation: true,
        experimentalTag: true,
        options: [
          { kind: "proceed_nonhuman", label: "Use this object anyway" },
          PROCEED_T2I,
          UPLOAD_DIFFERENT,
        ],
      };

    case "multiple_subjects":
      return {
        title: "Multiple subjects",
        body:
          "We found multiple possible subjects. The result may not preserve the person or subject you intended.",
        requiresConfirmation: true,
        options: [
          { kind: "proceed_nonhuman", label: "Use image anyway" },
          GENERATE_WITHOUT_IMAGE,
          UPLOAD_DIFFERENT,
        ],
      };

    case "scene_no_clear_subject":
      return {
        title: "No clear subject",
        body: "We couldn't find a clear subject in this image.",
        requiresConfirmation: true,
        options: [GENERATE_WITHOUT_IMAGE, UPLOAD_DIFFERENT],
      };

    case "ambiguous":
    case "detection_failed":
    default:
      return {
        title: "Subject unclear",
        body:
          "We couldn't confidently identify the main subject in this image. We can still try, or generate without it.",
        requiresConfirmation: true,
        options: [
          { kind: "proceed_nonhuman", label: "Use image anyway" },
          GENERATE_WITHOUT_IMAGE,
          UPLOAD_DIFFERENT,
        ],
      };
  }
}
