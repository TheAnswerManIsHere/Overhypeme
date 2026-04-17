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
  refresh_token?: string;
  expires_at?: number;
  captchaVerified?: boolean;
  isAdmin?: boolean;
  adminModeDisabled?: boolean;
}

// ── Google ────────────────────────────────────────────────────────────────────

let googleConfig: client.Configuration | null = null;

export async function getGoogleConfig(): Promise<client.Configuration> {
  if (!googleConfig) {
    googleConfig = await client.discovery(
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

function generateAppleClientSecret(): string {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + 15897600; // 6 months

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
  const privateKey = process.env.APPLE_PRIVATE_KEY!.replace(/\\n/g, "\n");

  const sign = crypto.createSign("SHA256");
  sign.update(signingInput);
  const sig = sign.sign({ key: privateKey, format: "pem" }, "base64url");

  appleSecretExpiresAt = exp;
  return `${signingInput}.${sig}`;
}

export async function getAppleConfig(): Promise<client.Configuration> {
  const now = Math.floor(Date.now() / 1000);
  if (!appleConfig || now >= appleSecretExpiresAt - 86400) {
    const clientSecret = generateAppleClientSecret();
    appleConfig = await client.discovery(
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
