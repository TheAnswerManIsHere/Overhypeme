/**
 * @purpose The codes a member's AI picture can end with, and the words a member reads for each (launch Phase 7, increment 2): one table, beside the codes, so a code added without its words is a type error rather than a silent "something went wrong".
 * @subsystem visual-pipeline
 */
import { ENGINE_REFUSED_ERROR_CODE } from "../imagePromptAttempts";

/** The output check refused the finished picture: quarantined, never delivered, its credit returned. */
export const OUTPUT_REFUSED_ERROR_CODE = "output_refused";
/** The spend backstop refused a paid call: "temporarily unavailable", its credit returned. */
export const SPEND_BACKSTOP_ERROR_CODE = "spend_backstop";
/** The recovery pass found the picture stranded or past its deadline. */
export const STRANDED_ERROR_CODE = "member_picture_stranded";
/** It finished after the recovery pass had stopped it and returned its credit. */
export const LATE_AFTER_RETURN_ERROR_CODE = "member_picture_returned";

const WORDS: Readonly<Record<string, string>> = {
  [ENGINE_REFUSED_ERROR_CODE]: "The image engine would not draw this scene from this photo. Try another photo, look or gag.",
  [OUTPUT_REFUSED_ERROR_CODE]: "This picture didn't pass our content check, so it can't be used.",
  [SPEND_BACKSTOP_ERROR_CODE]: "Pictures are temporarily unavailable for this account.",
  [STRANDED_ERROR_CODE]: "This picture took too long to draw, so it was stopped.",
  [LATE_AFTER_RETURN_ERROR_CODE]: "This picture took too long to draw, so it was stopped.",
  render_input_invalid: "This picture could not be drawn from what was saved for it.",
  vendor_request_rejected: "The image engine rejected the request for this picture.",
};

/** A failed picture's reason, in words a member can act on; never an engine's internals. */
export function memberFailureWords(code: string | null): string {
  return (code && WORDS[code]) ?? "Something went wrong while drawing this picture.";
}
