import * as client from "openid-client";
import crypto from "crypto";
import { type Request, type Response } from "express";
import { db, sessionsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import type { AuthUser } from "@workspace/api-zod";

export const SESSION_COOKIE = "sid";
export const SESSION_TTL = 7 * 24 * 60 * 60 * 1000;

export interface SessionData {
  user: AuthUser;
  access_token: string;
  captchaVerified?: boolean;
  isAdmin?: boolean;
  adminModeDisabled?: boolean;
}

// The bootstrap admin email is always granted admin access regardless of the
// DB's is_admin flag. This ensures there is always at least one account that
// can log in and use the admin panel to grant access to other users.
export const BOOTSTRAP_ADMIN_EMAIL = "overhypeme+admin@gmail.com";

// Returns true when the given user id appears in the comma-separated
// ADMIN_USER_IDS env var. Lives here (rather than in a route module) so the
// auth middleware can import it without creating a route ↔ middleware cycle.
export function isAdminById(userId: string): boolean {
  const ids = process.env["ADMIN_USER_IDS"]?.split(",").map((s) => s.trim()) ?? [];
  return ids.includes(userId);
}

// Returns true when the given email matches the hardcoded bootstrap admin email.
// This is the fallback that guarantees at least one account always has admin
// access even if the DB is_admin flag has not been set yet.
export function isAdminByEmail(email: string | null | undefined): boolean {
  return !!email && email.toLowerCase() === BOOTSTRAP_ADMIN_EMAIL.toLowerCase();
}

// ── Google ────────────────────────────────────────────────────────────────────

let googleConfig: client.Configuration | null = null;

export async function getGoogleConfig(): Promise<client.Configuration> {
  if (!googleConfig) {
    googleConfig = await _discoveryFn(
      new URL("https://accounts.google.com"),
      process.env.GOOGLE_CLIENT_ID!,
      process.env.GOOGLE_CLIENT_SECRET!,
    );
  }
  return googleConfig;
}

// ── Apple ─────────────────────────────────────────────────────────────────────
// Apple requires a short-lived (max 6 month) ES256 JWT used as the OAuth client
// secret. We mint it on first use and refresh it 1 day before expiry.

let appleConfig: client.Configuration | null = null;
let appleSecretExpiresAt = 0;

// ── Test seam: replaceable discovery function ─────────────────────────────────
// Allows tests to stub the OIDC discovery HTTP call while still executing the
// real generateAppleClientSecret() / createPrivateKey() path.  Convention
// mirrors lib/email.ts → _resetResendAuthDisabledForTests().
type DiscoveryFn = typeof client.discovery;
let _discoveryFn: DiscoveryFn = client.discovery;
export function _setClientDiscoveryForTest(fn: DiscoveryFn): void {
  _discoveryFn = fn;
}
export function _resetClientDiscoveryForTest(): void {
  _discoveryFn = client.discovery;
}
export function _resetAppleConfigCacheForTest(): void {
  appleConfig = null;
  appleSecretExpiresAt = 0;
}
export function _resetGoogleConfigCacheForTest(): void {
  googleConfig = null;
}

function normalizeApplePrivateKeyPem(input: string): string {
  let s = input.replace(/\\n/g, "\n").replace(/\r\n?/g, "\n").trim();
  if (s.includes("\n")) return s;
  const m = s.match(
    /^(-----BEGIN [A-Z0-9 ]+-----)\s+([A-Za-z0-9+/=\s]+?)\s+(-----END [A-Z0-9 ]+-----)$/,
  );
  if (!m) return s;
  const body = m[2].replace(/\s+/g, "");
  const lines = body.match(/.{1,64}/g) || [body];
  return [m[1], ...lines, m[3]].join("\n") + "\n";
}

export function generateAppleClientSecret(): string {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + 15552000; // 180 days — Apple's max is 15,777,000 s; stay safely under

  const header = Buffer.from(
    JSON.stringify({ alg: "ES256", kid: process.env.APPLE_KEY_ID! }),
  ).toString("base64url");

  const payload = Buffer.from(
    JSON.stringify({
      iss: process.env.APPLE_TEAM_ID!,
      iat: now,
      exp,
      aud: "https://appleid.apple.com",
      sub: process.env.APPLE_CLIENT_ID!,
    }),
  ).toString("base64url");

  const signingInput = `${header}.${payload}`;
  const rawKey = normalizeApplePrivateKeyPem(process.env.APPLE_PRIVATE_KEY!);
  const privateKey = crypto.createPrivateKey({ key: rawKey, format: "pem" });

  const sig = crypto
    .sign("SHA256", Buffer.from(signingInput), { key: privateKey, dsaEncoding: "ieee-p1363" })
    .toString("base64url");

  appleSecretExpiresAt = exp;
  return `${signingInput}.${sig}`;
}

export async function getAppleConfig(): Promise<client.Configuration> {
  const now = Math.floor(Date.now() / 1000);
  if (!appleConfig || now >= appleSecretExpiresAt - 86400) {
    const clientSecret = generateAppleClientSecret();
    appleConfig = await _discoveryFn(
      new URL("https://appleid.apple.com"),
      process.env.APPLE_CLIENT_ID!,
      clientSecret,
    );
  }
  return appleConfig;
}

// ── Session helpers ───────────────────────────────────────────────────────────

export async function createSession(data: SessionData, userId?: string): Promise<string> {
  const sid = crypto.randomBytes(32).toString("hex");
  await db.insert(sessionsTable).values({
    sid,
    sess: data as unknown as Record<string, unknown>,
    expire: new Date(Date.now() + SESSION_TTL),
    userId: userId ?? null,
  });
  return sid;
}

export async function getSession(sid: string): Promise<SessionData | null> {
  const [row] = await db
    .select()
    .from(sessionsTable)
    .where(eq(sessionsTable.sid, sid));

  if (!row || row.expire < new Date()) {
    if (row) await deleteSession(sid);
    return null;
  }

  return row.sess as unknown as SessionData;
}

export async function updateSession(
  sid: string,
  data: SessionData,
): Promise<void> {
  await db
    .update(sessionsTable)
    .set({
      sess: data as unknown as Record<string, unknown>,
      expire: new Date(Date.now() + SESSION_TTL),
    })
    .where(eq(sessionsTable.sid, sid));
}

export async function deleteSession(sid: string): Promise<void> {
  await db.delete(sessionsTable).where(eq(sessionsTable.sid, sid));
}

export async function clearSession(
  res: Response,
  sid?: string,
): Promise<void> {
  if (sid) await deleteSession(sid);
  res.clearCookie(SESSION_COOKIE, { path: "/", sameSite: "none", secure: true });
}

export function getSessionId(req: Request): string | undefined {
  const authHeader = req.headers["authorization"];
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice(7);
  }
  return req.cookies?.[SESSION_COOKIE];
}
