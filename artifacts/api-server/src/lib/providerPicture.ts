/**
 * @purpose Google sign-in's picture becomes the member's first photo (plan docs/plans/PLAN_PHOTO_IS_YOUR_PICTURE.md, David's Q13): when a member signing in with Google holds an adult date of birth and has no profile photo, the picture is fetched from Google's image host at a larger size, put through the same upload pipeline every photo meets (type and size, the moderation scans, rate limit), stored as a first-party object and made their profile photo. The raw provider URL is never stored or served. Any failure leaves the member photo-less and never affects the sign-in.
 * @subsystem accounts-auth
 */
import type { Request, Response } from "express";
import { db } from "@workspace/db";
import { usersTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";

import { logger } from "./logger";
import { processAndStoreUserUpload } from "./userImageUpload";
import { makeProfilePhoto } from "./profilePhoto";
import { profilePictureUrl } from "./profilePicture";
import { ageInYears, ADULT_AGE, eligibilityOf } from "./eligibility";
import { userLeaving } from "./contentVisibility";
import { effectiveTierForRow } from "./membershipState";
import { isAdminById } from "./auth";

/** The most a provider picture may weigh: the photo upload route's own cap. */
export const PROVIDER_PICTURE_MAX_BYTES = 5 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 5_000;
/** Google serves a 96px picture by default; this asks for a usable size. */
const GOOGLE_SIZE = "s1024-c";

export type CopyOutcome =
  | "copied"
  | "has_photo"
  | "not_eligible"
  | "not_adult"
  | "no_picture"
  | "refused_url"
  | "fetch_failed"
  | "rejected"
  | "failed";

/**
 * Only Google's own image host, over https, is ever fetched: the URL comes
 * from the provider's claims, and the server fetching it must not become a
 * way to reach anywhere else.
 */
export function googlePictureUrl(raw: unknown): URL | null {
  if (typeof raw !== "string" || !raw) return null;
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
  const host = url.hostname.toLowerCase();
  if (host !== "googleusercontent.com" && !host.endsWith(".googleusercontent.com")) return null;
  url.pathname = url.pathname.replace(/=s\d+(-c)?$/, `=${GOOGLE_SIZE}`);
  return url;
}

export type PictureFetcher = (url: URL) => Promise<{ bytes: Buffer; contentType: string } | null>;

/** Fetches the picture with no redirects, a timeout and a size cap; null on any failure. */
export const fetchPicture: PictureFetcher = async (url) => {
  const res = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) return null;
  const contentType = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (!contentType.startsWith("image/")) return null;
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > PROVIDER_PICTURE_MAX_BYTES) return null;
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length === 0 || bytes.length > PROVIDER_PICTURE_MAX_BYTES) return null;
  return { bytes, contentType };
};

/**
 * The upload pipeline answers a person over HTTP; here nobody is waiting, so
 * its request is the member's and its response only records whether it
 * refused.
 */
function pipelineContext(user: typeof usersTable.$inferSelect): { req: Request; res: Response; refused: () => number | null } {
  let status: number | null = null;
  const child = logger.child({ route: "provider-picture", userId: user.id });
  const req = {
    isAuthenticated: () => true,
    user: { id: user.id, membershipTier: effectiveTierForRow(user), isRealAdmin: user.isAdmin || isAdminById(user.id) },
    ip: null,
    headers: {},
    originalUrl: "/auth/provider-picture",
    log: child,
  } as unknown as Request;
  const res = {
    status(code: number) { status = code; return res; },
    json() { return res; },
    setHeader() { return res; },
  } as unknown as Response;
  return { req, res, refused: () => status };
}

export async function copyProviderPictureIn(
  userId: string,
  rawPicture: unknown,
  fetcher: PictureFetcher = fetchPicture,
): Promise<CopyOutcome> {
  try {
    const [row] = await db
      .select({ user: usersTable, deletionPending: userLeaving() })
      .from(usersTable)
      .where(eq(usersTable.id, userId))
      .limit(1);
    if (!row) return "failed";
    const { user } = row;
    if (profilePictureUrl(user.profileImageUrl)) return "has_photo";
    // Signing in does not make an account able to add media: one awaiting
    // deletion, suspended, unverified or not yet onboarded gets nothing, by
    // the same rule the verified-actor gate enforces.
    if (eligibilityOf({ ...user, deletionPending: row.deletionPending }) !== "eligible") return "not_eligible";
    // Photo uploads are for members 18 and over (plan S12); this is one.
    const age = ageInYears(user.dateOfBirth);
    if (age == null || age < ADULT_AGE) return "not_adult";
    if (rawPicture == null || rawPicture === "") return "no_picture";
    const url = googlePictureUrl(rawPicture);
    if (!url) return "refused_url";

    const picture = await fetcher(url).catch(() => null);
    if (!picture) return "fetch_failed";

    const { req, res, refused } = pipelineContext(user);
    const stored = await processAndStoreUserUpload(req, res, picture.bytes, picture.contentType, { variant: "avatar" });
    if (!stored) {
      logger.info({ userId, status: refused() }, "[provider-picture] the upload pipeline refused the provider picture");
      return "rejected";
    }
    // Set only if the member still has no photo: one they chose while this
    // was being fetched wins (plan Q13: the default lasts until they choose).
    const set = await makeProfilePhoto(userId, stored.objectPath, { onlyIfNone: true });
    return set ? "copied" : "has_photo";
  } catch (err) {
    logger.warn({ err, userId }, "[provider-picture] copying the provider picture in failed");
    return "failed";
  }
}
