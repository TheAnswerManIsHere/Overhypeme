/**
 * The reading of a fact (plan docs/plans/PLAN_FACT_LIFECYCLE_REBUILD.md, 1B;
 * Issue #1018, increment 1.2c-ii): reference research from the fact, with web
 * lookup, then a draft humor note written from that research. Stored per run
 * on `fact_readings`; the Reading step shows the latest run, and an approved
 * note keeps the run it was written from.
 */
import { z } from "zod";
import { HUMOR_NOTE_MAX_CHARS } from "./visualConcepts";

/** One reference the fact makes, as the research found it. */
export const factReadingReferenceSchema = z.object({
  /** The words in the fact that make the reference. */
  phrase: z.string().trim().min(1).max(200),
  /** What the reference is and what it means in this fact, including the twist the fact gives it. */
  meaning: z.string().trim().min(1).max(1200),
  /** What it implies for a picture: what to show, and the misreading to avoid. */
  pictureImplication: z.string().trim().max(1200),
  /** Pages the web lookup found that confirm the meaning; empty when none helped. */
  sources: z.array(z.object({ title: z.string().trim().max(300), url: z.string().trim().max(2000) })).max(8),
});
export type FactReadingReference = z.infer<typeof factReadingReferenceSchema>;

/** The research of one run: every reference found (an empty list is a result). */
export const factReadingResearchSchema = z.object({
  references: z.array(factReadingReferenceSchema).max(12),
});
export type FactReadingResearch = z.infer<typeof factReadingResearchSchema>;

/** One run's whole answer, as the model returns it. */
export const factReadingResultSchema = factReadingResearchSchema.extend({
  humorNote: z.string().trim().min(1).max(HUMOR_NOTE_MAX_CHARS),
});
export type FactReadingResult = z.infer<typeof factReadingResultSchema>;

export const FACT_READING_STATUS_VALUES = ["pending", "ok", "failed"] as const;
export type FactReadingStatus = (typeof FACT_READING_STATUS_VALUES)[number];

/** A reading run as the moderation screen receives it. */
export interface FactReadingView {
  id: number;
  status: FactReadingStatus;
  research: FactReadingResearch | null;
  draftNote: string | null;
  /** Why the run failed, in words a moderator can act on. */
  error: string | null;
  createdAt: string;
  completedAt: string | null;
}

/** What the Reading step shows: the latest run, and the note approved from one, if any. */
export interface ReviewReadingView {
  /** The latest run; null when none was ever started (a review migrated into Reading). */
  latest: FactReadingView | null;
  /** The approved note and the run it was written from; null until approved. */
  approved: { text: string; readingId: number | null; approvedBy: string | null; approvedAt: string } | null;
}

/** Approve the reading: the note as the moderator leaves it (edited or not). */
export const approveReadingSchema = z.object({
  text: z.string().trim().min(1, "The humor note is empty").max(HUMOR_NOTE_MAX_CHARS, `The humor note is over ${HUMOR_NOTE_MAX_CHARS} characters`),
  /** The run the screen showed; the server refuses when a newer one exists. */
  readingId: z.number().int().positive(),
});
export type ApproveReading = z.infer<typeof approveReadingSchema>;
