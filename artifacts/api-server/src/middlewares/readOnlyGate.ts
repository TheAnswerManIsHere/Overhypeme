/**
 * @purpose Read-only mode's one gate (launch Phase 16, increment 4, plan design D): while the switch is on, refuses every state-changing request a visitor or member makes on purpose, with one code the web app recognises, by one classification table that names every state-changing route as refused or allowed. Admin routes and signing in are let through before the switch is looked up, so David can always turn it off.
 * @subsystem operations
 */
import type { Request, Response, NextFunction } from "express";
import { apiPath, isStateChanging, matcher, type RouteKey } from "./requireEligibleActor";
import { isReadOnly, READ_ONLY_CODE, READ_ONLY_MESSAGE } from "../lib/readOnlyMode";

/**
 * Every state-changing route outside `/admin`, with what read-only mode does
 * to it and why. A route a router declares that is missing here fails CI
 * (`phase16.readOnlyMode.test.ts`), so a new write is a visible decision.
 * Every `/admin/...` route is allowed by the prefix rule below and the test
 * checks each one is behind `requireAdmin`.
 */
/** `beforeLookup`: let through without reading the switch, so it can always be turned off. */
export const READ_ONLY_ROUTES: Readonly<Record<RouteKey, { allowed: boolean; why: string; beforeLookup?: true }>> = {
  // Signing in and out, and recovering a sign-in (plan D: "signing in and out").
  "POST /auth/local-login": { allowed: true, why: "signing in", beforeLookup: true },
  "POST /auth/logout": { allowed: true, why: "signing out", beforeLookup: true },
  "POST /callback/apple": { allowed: true, why: "signing in with Apple", beforeLookup: true },
  "POST /auth/dev-admin-login": { allowed: true, why: "signing in (dev admin)", beforeLookup: true },
  "POST /auth/forgot-password": { allowed: true, why: "recovering a sign-in, so an admin can reach the switch", beforeLookup: true },
  "POST /auth/reset-password": { allowed: true, why: "recovering a sign-in, so an admin can reach the switch", beforeLookup: true },
  // Behind real admin privilege, checked in the handler.
  "POST /auth/toggle-admin-mode": { allowed: true, why: "admin only", beforeLookup: true },
  "POST /ai/tokenize-enrichment": { allowed: true, why: "admin only (requireAdmin)" },
  // Background jobs keep running (Q3: 1); each needs the cron secret.
  "POST /jobs/fact-of-the-day": { allowed: true, why: "background job" },
  "POST /jobs/data-retention": { allowed: true, why: "background job" },
  "POST /jobs/maintenance": { allowed: true, why: "background job" },
  // Personalising stays up: these render an image and write nothing.
  "POST /render-preview": { allowed: true, why: "renders a personalised image; writes nothing" },
  "POST /render-download": { allowed: true, why: "renders a personalised image; writes nothing" },
  // Bookkeeping a page or a share makes on its own (plan D: not a database freeze).
  "POST /users/me/search-history": { allowed: true, why: "bookkeeping a search makes" },
  "POST /activity-feed/mark-read": { allowed: true, why: "bookkeeping opening the activity feed makes" },
  "POST /facts/:factId/share": { allowed: true, why: "the share count opening the share sheet bumps" },
  "POST /share-intents": { allowed: true, why: "the record of which way a meme was shared" },
  // Q11: 1 — a member may save a name and pronouns, and nothing else (checked on the body below).
  "PATCH /users/me": { allowed: true, why: "a name and pronouns only (Q11); any other field is refused" },

  // Refused: what visitors and members do on purpose.
  "POST /auth/register": { allowed: false, why: "creates an account" },
  "POST /auth/resend-verification": { allowed: false, why: "part of creating an account" },
  "POST /auth/set-password": { allowed: false, why: "changes an account" },
  "DELETE /auth/unlink-provider": { allowed: false, why: "changes an account" },
  "GET /link/:provider": { allowed: false, why: "links a sign-in provider to an account" },
  "PUT /users/me/onboarding/draft": { allowed: false, why: "account set-up" },
  "POST /users/me/onboarding": { allowed: false, why: "account set-up" },
  "POST /users/me/deletion": { allowed: false, why: "schedules an account deletion" },
  "POST /users/me/deletion/cancel": { allowed: false, why: "changes a scheduled deletion" },
  "PATCH /users/me/notifications": { allowed: false, why: "changes a profile setting" },
  "POST /users/me/profile-image": { allowed: false, why: "changes a profile" },
  "DELETE /users/me/uploads": { allowed: false, why: "deletes uploads" },
  "POST /users/me/uploads/restore": { allowed: false, why: "restores uploads" },
  "DELETE /users/me/ai-images/:id": { allowed: false, why: "deletes an image" },
  "POST /users/me/ai-images/:id/restore": { allowed: false, why: "restores an image" },
  "POST /storage/upload-avatar": { allowed: false, why: "uploads a photo" },
  "POST /storage/upload-meme": { allowed: false, why: "uploads a photo" },
  "POST /ai/check-duplicate": { allowed: false, why: "part of submitting a fact" },
  "POST /ai/tokenize-fact": { allowed: false, why: "part of submitting a fact" },
  "POST /ai/suggest-pronouns": { allowed: false, why: "part of submitting a fact" },
  "POST /ai/suggest-hashtags": { allowed: false, why: "part of submitting a fact" },
  "POST /facts/submit-review": { allowed: false, why: "submits a fact" },
  "POST /facts/:factId/rating": { allowed: false, why: "rates a fact" },
  "POST /facts/:factId/comments": { allowed: false, why: "posts a comment" },
  "POST /comments/:id/heart": { allowed: false, why: "hearts a comment" },
  "POST /memes": { allowed: false, why: "makes a meme" },
  "POST /memes/:id/heart": { allowed: false, why: "hearts a meme" },
  "DELETE /memes/:slug": { allowed: false, why: "deletes a meme" },
  "POST /memes/:slug/restore": { allowed: false, why: "restores a meme" },
  "POST /share/invite": { allowed: false, why: "sends an invitation email" },
  "POST /stripe/checkout": { allowed: false, why: "starts a purchase" },
  "POST /stripe/checkout/confirm": { allowed: false, why: "confirms a purchase in the browser; the payment webhook still grants it" },
  "POST /stripe/portal": { allowed: false, why: "opens billing management" },
  "POST /stripe/subscription/cancel": { allowed: false, why: "changes a subscription" },
  "POST /stripe/subscription/reactivate": { allowed: false, why: "changes a subscription" },
  "POST /stripe/subscription/switch-plan": { allowed: false, why: "changes a subscription" },
};

/** The profile fields a member may save while read-only mode is on (Q11: 1). */
export const READ_ONLY_PROFILE_FIELDS: readonly string[] = ["displayName", "pronouns"];

const allowedKeys = (Object.keys(READ_ONLY_ROUTES) as RouteKey[]).filter((k) => READ_ONLY_ROUTES[k].allowed);
const isAllowed = matcher(allowedKeys);
const isBeforeLookup = matcher(allowedKeys.filter((k) => READ_ONLY_ROUTES[k].beforeLookup));
const isNameSave = matcher(["PATCH /users/me"]);

/** A profile save names only the fields Q11 allows. */
function isNameOnlyProfileSave(req: Request): boolean {
  const body = req.body as Record<string, unknown> | undefined;
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const keys = Object.keys(body);
  return keys.length > 0 && keys.every((k) => READ_ONLY_PROFILE_FIELDS.includes(k));
}

function refuse(res: Response): void {
  res.status(503).json({ error: READ_ONLY_MESSAGE, code: READ_ONLY_CODE });
}

export async function readOnlyGate(req: Request, res: Response, next: NextFunction): Promise<void> {
  const path = apiPath(req);
  if (path === null) return next();
  const requested = req.method.toUpperCase();
  const method = requested === "HEAD" ? "GET" : requested;
  if (!isStateChanging(method, path)) return next();
  // Admin routes and signing in never wait on the switch, so it can always be turned off.
  if (/^\/admin(\/|$)/i.test(path) || isBeforeLookup(method, path)) return next();
  if (!(await isReadOnly())) return next();
  if (isNameSave(method, path)) return isNameOnlyProfileSave(req) ? next() : refuse(res);
  if (isAllowed(method, path)) return next();
  refuse(res);
}
