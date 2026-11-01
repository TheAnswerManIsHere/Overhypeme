/**
 * A stale Bearer token beside a valid session cookie (#799). The auth
 * middleware authenticates through the cookie when the Bearer is dead, so every
 * route that acts on "this session" must act on the session that authenticated
 * (`req.authSessionId`), never on whichever credential the raw headers name
 * first (`getSessionId`). The dev quick-login is what leaves such a Bearer
 * behind in a real browser.
 *
 * @purpose Proves, through the full app stack, that with a dead Bearer and a valid cookie the admin-mode toggle flips the cookie's session, the AI routes treat the visitor as signed in, an email-change verification updates the cookie's session rather than a dead one, and logout ends the cookie's session along with every other credential the browser presented.
 * @subsystem accounts-auth
 */
import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes, createHash } from "node:crypto";

import request from "supertest";

import { db } from "@workspace/db";
import { usersTable, sessionsTable, emailVerificationTokensTable } from "@workspace/db/schema";
import { eq, like } from "drizzle-orm";

import { createApp } from "../app.js";
import { createSession, getSession, SESSION_COOKIE, type SessionData } from "../lib/auth.js";
import { __setSuggestHashtagsForTest } from "../routes/ai.js";

const USER_PREFIX = "t_stalebearer_";
const ORIGIN = "https://app.example.com";
const CSRF = "stalebearer-csrf";

async function createUser(opts: { isAdmin?: boolean } = {}): Promise<string> {
  const id = `${USER_PREFIX}${randomUUID()}`;
  await db.insert(usersTable).values({
    id,
    email: `${id}@test.local`,
    isAdmin: opts.isAdmin ?? false,
    emailVerifiedAt: new Date(),
    onboardingCompletedAt: new Date(),
  });
  return id;
}

async function sessionFor(userId: string): Promise<string> {
  const data: SessionData = { user: { id: userId } as unknown as SessionData["user"], access_token: "t" };
  return createSession(data, userId);
}

async function sessionsOf(userId: string): Promise<string[]> {
  return (await db.select({ sid: sessionsTable.sid }).from(sessionsTable).where(eq(sessionsTable.userId, userId))).map((r) => r.sid);
}

/** A Bearer that names no session at all: what a dead dev quick-login token looks like. */
function deadBearer(): string {
  return randomBytes(32).toString("hex");
}

function withCredentials(req: request.Test, cookieSid: string, bearer: string): request.Test {
  return req
    .set("Origin", ORIGIN)
    .set("Cookie", [`csrf_token=${CSRF}`, `${SESSION_COOKIE}=${cookieSid}`])
    .set("X-CSRF-Token", CSRF)
    .set("Authorization", `Bearer ${bearer}`);
}

async function cleanup(): Promise<void> {
  await db.delete(usersTable).where(like(usersTable.id, `${USER_PREFIX}%`));
}

describe("a dead Bearer beside a valid cookie (#799)", () => {
  let savedOrigins: string | undefined;
  before(async () => {
    savedOrigins = process.env.ALLOWED_ORIGINS;
    process.env.ALLOWED_ORIGINS = ORIGIN;
    await cleanup();
  });
  after(async () => {
    if (savedOrigins === undefined) delete process.env.ALLOWED_ORIGINS;
    else process.env.ALLOWED_ORIGINS = savedOrigins;
    await cleanup();
  });
  afterEach(() => __setSuggestHashtagsForTest(null));

  it("toggle admin mode flips the cookie's session, the one that authenticated", async () => {
    const userId = await createUser({ isAdmin: true });
    const sid = await sessionFor(userId);

    const res = await withCredentials(request(createApp()).post("/api/auth/toggle-admin-mode"), sid, deadBearer());

    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.adminModeActive, false);
    assert.equal((await getSession(sid))?.adminModeDisabled, true);
  });

  it("an AI route treats the visitor as signed in", async () => {
    const userId = await createUser();
    const sid = await sessionFor(userId);
    __setSuggestHashtagsForTest(async () => ["legendary"]);

    const res = await withCredentials(request(createApp()).post("/api/ai/suggest-hashtags"), sid, deadBearer())
      .send({ text: "Mark can divide by zero." });

    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.hashtags, ["legendary"]);
  });

  it("an email-change verification updates the cookie's session and opens no new one", async () => {
    const userId = await createUser();
    const sid = await sessionFor(userId);
    const newEmail = `${userId}-new@test.local`;
    await db.update(usersTable).set({ pendingEmail: newEmail }).where(eq(usersTable.id, userId));
    const raw = randomBytes(32).toString("hex");
    await db.insert(emailVerificationTokensTable).values({
      userId,
      tokenHash: createHash("sha256").update(raw).digest("hex"),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      pendingEmail: newEmail,
    });

    const res = await withCredentials(request(createApp()).get(`/api/auth/verify-email?token=${raw}`), sid, deadBearer());

    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal((await getSession(sid))?.user.email, newEmail);
    assert.deepEqual(await sessionsOf(userId), [sid]);
  });

  it("logout ends the cookie's session too", async () => {
    const userId = await createUser();
    const sid = await sessionFor(userId);

    const res = await withCredentials(request(createApp()).post("/api/auth/logout"), sid, deadBearer());

    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(await sessionsOf(userId), []);
  });

  it("logout with two valid credentials ends both", async () => {
    const userId = await createUser();
    const bearer = await sessionFor(userId);
    const cookie = await sessionFor(userId);

    const res = await withCredentials(request(createApp()).post("/api/auth/logout"), cookie, bearer);

    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(await sessionsOf(userId), []);
  });
});
