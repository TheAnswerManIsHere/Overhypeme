/**
 * @purpose The opaque, engine-free name a comparison cell's picture is served under in blind judging. Its own module so the judging view and the runner (which records the token in the picture's provenance) share it without importing each other.
 */
import { createHash } from "node:crypto";
import type { ComparisonPanel } from "@workspace/db/schema";

/** The opaque, engine-free name of a cell in the blind view. */
export function blindToken(panel: Pick<ComparisonPanel, "shuffleSeed">, cellId: number): string {
  return createHash("sha256").update(`comparison-blind:${panel.shuffleSeed}:${cellId}`).digest("hex").slice(0, 16);
}
