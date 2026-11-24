/**
 * @purpose The fact sheet's wire shape and the plain words for each needs-attention reason, shared by the Facts list and the sheet.
 * @subsystem moderation
 *
 * Mirrors `factSheet()` in api-server lib/factSheet.ts (GET
 * /admin/facts/:id/sheet). The reasons are api-zod's ATTENTION_REASONS, which
 * the server's checks share; this file only words them, so a new reason
 * fails the build here until it has words.
 */
import { ATTENTION_REASONS, type AttentionReason, type GagExampleKind, type ReviewReadingView } from "@workspace/api-zod";
import { readError } from "@/components/admin/readError";

/** Each reason as a short label (the list's chips) and a sentence (the sheet). */
export const ATTENTION_WORDS: Record<AttentionReason, { label: string; sentence: string }> = {
  taxonomy_missing: { label: "Taxonomy missing", sentence: "It has no stored AI taxonomy." },
  example_stale: { label: "Example stale", sentence: "One of its example pictures was drawn by an older engine or prompt." },
  example_missing: { label: "Example missing", sentence: "A gag is missing one of its male, female or pet examples." },
  fingerprint_missing: { label: "No fingerprint", sentence: "It has no duplicate fingerprint yet, so the duplicate check can't find it." },
  pictures_failing: { label: "Pictures failing", sentence: "Several of its most recent pictures failed or were refused." },
};

/** The reasons a row carries, in display order (a string this build does not know is left out). */
export function knownReasons(reasons: readonly string[] | undefined): AttentionReason[] {
  return ATTENTION_REASONS.filter((r) => reasons?.includes(r));
}

export interface FactSheetGagPictures {
  gagId: number;
  slot: number;
  approvedKinds: GagExampleKind[];
  missingKinds: GagExampleKind[];
}

export interface FactSheetView {
  id: number;
  text: string;
  canonicalText: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  splitTokenIndex: number | null;
  submittedById: string | null;
  submittedByName: string | null;
  approvedAt: string;
  approvalSource: "moderator" | "legacy" | null;
  approvedByName: string | null;
  upvotes: number;
  downvotes: number;
  score: number;
  wilsonScore: number;
  commentCount: number;
  shareCount: number;
  enrichmentStatus: string | null;
  suggestedHashtags: string[];
  hasEmbedding: boolean;
  attention: string[];
  /** The draft differs from the published set: "Publish changes" or "Discard changes" (plan 3B). */
  hasUnpublishedChanges: boolean;
  reviewId: number | null;
  hashtags: string[];
  usage: { memes: number; aiPictures: number };
  pictures: FactSheetGagPictures[];
  reading: ReviewReadingView & { approvedByName: string | null };
}

export async function loadFactSheet(factId: number): Promise<FactSheetView> {
  const r = await fetch(`/api/admin/facts/${factId}/sheet`, { credentials: "include" });
  if (!r.ok) throw new Error(r.status === 404 ? "This fact isn't on the Facts page: it was never approved." : await readError(r));
  return (await r.json()) as FactSheetView;
}

async function put<T>(url: string, body: unknown, fallback: string): Promise<T> {
  const r = await fetch(url, {
    method: "PUT",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error((await readError(r)) || fallback);
  return (await r.json()) as T;
}

export async function saveHashtags(factId: number, hashtags: string[]): Promise<string[]> {
  const res = await put<{ hashtags: string[] }>(`/api/admin/facts/${factId}/hashtags`, { hashtags }, "Could not save the hashtags.");
  return res.hashtags;
}

export async function saveHumorNote(factId: number, text: string): Promise<{ text: string; approvedAt: string | null }> {
  const res = await put<{ humorNote: { text: string; approvedAt: string | null } }>(`/api/admin/facts/${factId}/humor-note`, { text }, "Could not save the humor note.");
  return res.humorNote;
}

/** An approved fact's lifecycle actions (api-server lib/factLifecycle.ts). */
export type FactLifecycleAction = "publish" | "discard" | "deactivate" | "reactivate";

/** Run one; throws the server's refusal in words (a go-live gap names the gag and the renders it needs). */
export async function runFactAction(factId: number, action: FactLifecycleAction): Promise<void> {
  const r = await fetch(`/api/admin/facts/${factId}/${action}`, { method: "POST", credentials: "include" });
  if (!r.ok) throw new Error((await readError(r)) || "That didn't work. Nothing was changed.");
}
