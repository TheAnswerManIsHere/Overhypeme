/**
 * The hash of a fact's raw text, used to tell whether a stored classification
 * was made from the wording the fact holds now.
 */

import crypto from "node:crypto";

export function hashFactText(text: string): string {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}
