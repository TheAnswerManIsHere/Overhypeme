/**
 * The member-picture API as the screens read it (launch Phase 7; plan
 * docs/plans/PLAN_PHASE7_AI_PICTURE_FLOW.md). One home for the shapes the
 * server returns (`artifacts/api-server/src/routes/memberPictures.ts`) and the
 * query keys the flow, the builder's selector and My content share, so a
 * picture that finishes in one place is re-read in the others.
 */
import type { AspectRatio } from "@/components/meme-builder/types";
import { toStorageUrl } from "@/components/meme-builder/integration/sourceKinds";

export interface GagOption {
  gagId: number;
  slot: number;
  /** The reviewed one-line description, tokens unrendered; null while there is none. */
  description: string | null;
  examples: { male: string | null; female: string | null; pet: string | null };
}

export interface PictureOptions {
  gags: GagOption[];
  choice: boolean;
  credits: number;
  nextIsFree: boolean;
}

export interface LookStyle {
  id: string;
  label: string;
  description: string;
  previewImagePath: string | null;
}

export interface MemberPictureState {
  attemptId: number;
  factId: number;
  status: "queued" | "drawing" | "done" | "failed";
  reason: string | null;
  creditReturned: boolean;
  aiImageId: number | null;
  imageUrl: string | null;
  /** The shape it was drawn in. Absent only on a state read before the server recorded it. */
  aspectRatio?: AspectRatio;
  /** The name its meme caption was meant to carry, and `chosen` when the member chose it; null for a picture made before it was recorded. */
  caption?: { name: string; pronouns: string | null; chosen?: true } | null;
  createdAt: string;
}

/** A picture still on its way: queued or drawing. */
export function isInFlight(p: Pick<MemberPictureState, "status">): boolean {
  return p.status === "queued" || p.status === "drawing";
}

export const STATUS_WORDS: Record<MemberPictureState["status"], string> = {
  queued: "Waiting to start drawing…",
  drawing: "Drawing your picture… this usually takes under a minute.",
  done: "Your picture is ready.",
  failed: "This picture couldn't be made.",
};

export const pictureKeys = {
  options: (factId: string) => ["member-pictures", "options", factId] as const,
  looks: ["member-pictures", "looks"] as const,
  list: ["member-pictures", "list"] as const,
  one: (attemptId: number | null) => ["member-pictures", "one", attemptId] as const,
  finished: (factId: string) => ["member-pictures", "finished", factId] as const,
  photoCheck: (uploadKey: string) => ["member-pictures", "photo-check", uploadKey] as const,
};

/** An error carrying the server's status and its message for the member. */
export class PictureRequestError extends Error {
  constructor(readonly status: number, readonly code: string | null, message: string) {
    super(message);
  }
}

async function readJson<T>(res: Response, fallback: string): Promise<T> {
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const b = body as { error?: string; message?: string } | null;
    throw new PictureRequestError(res.status, b?.error ?? null, b?.message ?? fallback);
  }
  return body as T;
}

export function fetchPictureOptions(factId: string): Promise<PictureOptions> {
  return fetch(`/api/facts/${encodeURIComponent(factId)}/picture-options`, { credentials: "include" })
    .then((r) => readJson<PictureOptions>(r, "We couldn't load this fact's pictures."));
}

export function fetchLookStyles(): Promise<LookStyle[]> {
  return fetch("/api/look-styles", { credentials: "include" })
    .then((r) => readJson<LookStyle[]>(r, "We couldn't load the styles."));
}

export function fetchMemberPictures(): Promise<{ pictures: MemberPictureState[]; credits: number }> {
  return fetch("/api/member-pictures", { credentials: "include" })
    .then((r) => readJson<{ pictures: MemberPictureState[]; credits: number }>(r, "We couldn't load your pictures."));
}

export function fetchMemberPicture(attemptId: number): Promise<{ picture: MemberPictureState; credits: number }> {
  return fetch(`/api/member-pictures/${attemptId}`, { credentials: "include" })
    .then((r) => readJson<{ picture: MemberPictureState; credits: number }>(r, "We couldn't read this picture."));
}

type PhotoSubject = "person" | "pet";

/**
 * Whether one of the member's own photos shows a person or a pet. Spends no
 * credit and queues nothing; 422 means the photo cannot be used (the message
 * says why), 503 `photo_check_failed` that the check could not run.
 */
export function checkPhoto(uploadKey: string): Promise<{ uploadKey: string; subject: PhotoSubject }> {
  return fetch("/api/member-pictures/photo-check", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ uploadKey }),
  }).then((r) => readJson<{ uploadKey: string; subject: PhotoSubject }>(r, "We couldn't check this photo — try again."));
}

/** The address of the picture flow for a fact (Phase 7 amendment), optionally from the builder or starting on a gag. */
export function pictureFlowPath(factId: string | number, opts: { fromBuilder?: boolean; gagId?: number } = {}): string {
  const q = new URLSearchParams();
  if (opts.fromBuilder) q.set("from", "builder");
  if (opts.gagId) q.set("gag", String(opts.gagId));
  const qs = q.toString();
  return `/facts/${factId}/picture${qs ? `?${qs}` : ""}`;
}

/** One of the member's finished pictures (`GET /users/me/ai-images`). */
export interface FinishedPicture {
  id: number;
  storagePath: string;
}

/** A page of the member's finished pictures of one fact, newest first. */
export function fetchFinishedPictures(factId: string, cursor: string | null): Promise<{ images: FinishedPicture[]; nextCursor: string | null }> {
  const q = new URLSearchParams({ imageType: "member_picture", factId });
  if (cursor) q.set("cursor", cursor);
  return fetch(`/api/users/me/ai-images?${q}`, { credentials: "include" })
    .then((r) => readJson<{ images: FinishedPicture[]; nextCursor: string | null }>(r, "We couldn't load your pictures."));
}

/** The URL a style's sample is shown from, or null when it has none. */
export function lookPreviewUrl(path: string | null): string | null {
  if (!path) return null;
  if (path.startsWith("/objects/")) return toStorageUrl(path);
  return path;
}

/** The server accepts only a simple pair (`she/her`) for a caption's or a pet's pronouns. */
export function simplePronouns(p: string | null | undefined): string | null {
  return p && /^\s*[a-z]+\/[a-z]+\s*$/i.test(p) ? p.trim().toLowerCase() : null;
}
