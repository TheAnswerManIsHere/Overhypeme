/**
 * Read-only mode (launch Phase 16, increment 4; plan PLAN_PHASE16_ANALYTICS_OPERATIONS.md, design D, Acceptance).
 *
 * @purpose Proves, through the real app stack, that the classification table names every state-changing route a router declares, that every admin write is behind requireAdmin, that with the switch on each refused route answers READ_ONLY_MODE while signing in, admin actions, background jobs, rendering, bookkeeping and a name-and-pronouns save go through, that the switch turns off, and the switch's two failure cases: a confirmed pause stays in force when a refresh fails, and an older read never undoes a newer save.
 * @subsystem operations
 */
import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import request from "supertest";
import { db } from "@workspace/db";
import { usersTable, adminConfigTable } from "@workspace/db/schema";
import { eq, like } from "drizzle-orm";

import { createApp } from "../app.js";
import { createSession, type SessionData } from "../lib/auth.js";
import { READ_ONLY_ROUTES } from "../middlewares/readOnlyGate.js";
import { MUTATING_GETS } from "../middlewares/requireEligibleActor.js";
import {
  READ_ONLY_CODE,
  READ_ONLY_CONFIG_KEY,
  __acceptForTests,
  __resetReadOnlyForTests,
  __setReadOnlyReaderForTests,
  isReadOnly,
  readOnlyEnforcement,
  setReadOnly,
} from "../lib/readOnlyMode.js";

const USER_PREFIX = "t-p16ro-";
const ROUTES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "routes");

type Declared = { file: string; method: string; key: string; path: string; declaration: string };

/** Every unsafe route each router file declares, with its declaration's text up to the handler. */
function declaredUnsafeRoutes(): Declared[] {
  const out: Declared[] = [];
  for (const file of readdirSync(ROUTES_DIR).filter((f) => f.endsWith(".ts"))) {
    const src = readFileSync(join(ROUTES_DIR, file), "utf8");
    for (const m of src.matchAll(/router\.(post|put|patch|delete)\(\s*[`"]([^`"]+)[`"]/g)) {
      const method = m[1]!.toUpperCase();
      // The declaration's middleware: up to its handler, or the next route.
      const rest = src.slice(m.index! + m[0].length, m.index! + m[0].length + 400);
      const end = rest.search(/async\b|\(req\b|router\./);
      out.push({
        file,
        method,
        key: `${method} ${m[2]}`,
        path: m[2]!.replace(/\$\{[^}]+\}/g, "x").replace(/:[A-Za-z_]+/g, "1").replace(/\*[A-Za-z_]+/g, "x"),
        declaration: end === -1 ? rest : rest.slice(0, end),
      });
    }
  }
  return out;
}

async function member(isAdmin = false): Promise<string> {
  const id = `${USER_PREFIX}${randomUUID()}`;
  await db.insert(usersTable).values({
    id,
    email: `${id}@test.local`,
    emailVerifiedAt: new Date(),
    onboardingCompletedAt: new Date(),
    isAdmin,
    dateOfBirth: "1990-01-01", // adult: photo uploads reach the read-only gate
  });
  return id;
}

async function bearer(userId: string): Promise<string> {
  const data: SessionData = { user: { id: userId } as unknown as SessionData["user"], access_token: "t" };
  return createSession(data, userId);
}

async function cleanup(): Promise<void> {
  await db.delete(adminConfigTable).where(eq(adminConfigTable.key, READ_ONLY_CONFIG_KEY));
  await db.delete(usersTable).where(like(usersTable.id, `${USER_PREFIX}%`));
}

before(async () => {
  await cleanup();
  __resetReadOnlyForTests();
});
afterEach(() => __setReadOnlyReaderForTests(null));
after(async () => {
  await cleanup();
  __resetReadOnlyForTests();
});

describe("the classification table", () => {
  it("names every state-changing route outside /admin, and nothing no router declares", () => {
    const declared = declaredUnsafeRoutes().filter((r) => !r.path.startsWith("/admin"));
    const named = new Set(Object.keys(READ_ONLY_ROUTES));
    assert.ok(declared.length > 40, `expected the full inventory, found ${declared.length}`);
    for (const r of declared) assert.ok(named.has(r.key), `${r.key} (${r.file}) is not in READ_ONLY_ROUTES: decide refused or allowed`);
    for (const g of MUTATING_GETS) assert.ok(named.has(g), `${g} (a GET that writes) is not in READ_ONLY_ROUTES`);
    const declaredKeys = new Set([...declared.map((r) => r.key), ...MUTATING_GETS]);
    for (const key of named) assert.ok(declaredKeys.has(key), `${key} is in READ_ONLY_ROUTES but no router declares it`);
  });

  it("every admin write, let through by prefix, is behind requireAdmin or the admin API key", () => {
    const admin = declaredUnsafeRoutes().filter((r) => r.path.startsWith("/admin"));
    assert.ok(admin.length > 50, `expected the admin inventory, found ${admin.length}`);
    for (const r of admin) assert.match(r.declaration, /requireAdmin|requireApiKey/, `${r.key} (${r.file}) is not behind requireAdmin or the admin API key`);
  });
});

describe("with the switch on", () => {
  let sid = "";
  let adminSid = "";
  let memberId = "";
  before(async () => {
    memberId = await member();
    sid = await bearer(memberId);
    adminSid = await bearer(await member(true));
    await setReadOnly(true, null);
  });
  after(async () => {
    await setReadOnly(false, null);
  });

  it("refuses every refused route with the read-only code", async () => {
    const app = createApp();
    const refused = declaredUnsafeRoutes().filter((r) => READ_ONLY_ROUTES[r.key as keyof typeof READ_ONLY_ROUTES]?.allowed === false);
    assert.ok(refused.length > 30, `found ${refused.length}`);
    for (const r of refused) {
      const res = await request(app)[r.method.toLowerCase() as "post"](`/api${r.path}`).set("authorization", `Bearer ${sid}`).send({});
      assert.equal(res.status, 503, `${r.key} answered ${res.status}`);
      assert.equal(res.body.code, READ_ONLY_CODE, r.key);
    }
    const linked = await request(app).get("/api/link/google").set("authorization", `Bearer ${sid}`);
    assert.equal(linked.body.code, READ_ONLY_CODE, "the GET that links a provider");
  });

  it("refuses through a mixed-case path, which Express routes the same", async () => {
    const res = await request(createApp()).post("/API/Memes").set("authorization", `Bearer ${sid}`).send({});
    assert.equal(res.body.code, READ_ONLY_CODE);
  });

  it("lets every allowed route reach its handler", async () => {
    const app = createApp();
    for (const [key, v] of Object.entries(READ_ONLY_ROUTES)) {
      if (!v.allowed || key === "PATCH /users/me" || key === "POST /auth/logout") continue;
      const [method, path] = key.split(" ") as [string, string];
      const res = await request(app)[method.toLowerCase() as "post"](`/api${path.replace(/:[A-Za-z_]+/g, "1")}`)
        .set("authorization", `Bearer ${sid}`).send({});
      assert.notEqual(res.body?.code, READ_ONLY_CODE, `${key} was refused`);
    }
  });

  it("a member may save a name and pronouns, and nothing else on the profile (Q11)", async () => {
    const app = createApp();
    const ok = await request(app).patch("/api/users/me").set("authorization", `Bearer ${sid}`).send({ displayName: "Ada", pronouns: "she/her" });
    assert.notEqual(ok.body?.code, READ_ONLY_CODE);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const [row] = await db.select({ displayName: usersTable.displayName }).from(usersTable).where(eq(usersTable.id, memberId));
    assert.equal(row?.displayName, "Ada");
    for (const body of [{ displayName: "Ada", firstName: "Ada" }, { email: "x@test.local" }, {}]) {
      const res = await request(app).patch("/api/users/me").set("authorization", `Bearer ${sid}`).send(body);
      assert.equal(res.body?.code, READ_ONLY_CODE, JSON.stringify(body));
    }
  });

  it("an admin action and the switch itself still work; reads are untouched", async () => {
    const app = createApp();
    const ops = await request(app).get("/api/admin/operations").set("authorization", `Bearer ${adminSid}`);
    assert.equal(ops.status, 200);
    assert.equal(ops.body.readOnly.enforcing, "on");
    const read = await request(app).get("/api/facts").set("authorization", `Bearer ${sid}`);
    assert.notEqual(read.body?.code, READ_ONLY_CODE);
    const config = await request(app).get("/api/config");
    assert.equal(config.body.readOnlyMode, true);
  });

  it("the Stripe webhook is not refused", async () => {
    const res = await request(createApp()).post("/api/stripe/webhook").set("content-type", "application/json").send("{}");
    assert.notEqual(res.body?.code, READ_ONLY_CODE);
  });

  it("turns off from the Operations page, and the refused routes open again", async () => {
    const app = createApp();
    const member403 = await request(app).put("/api/admin/operations/read-only").set("authorization", `Bearer ${sid}`).send({ on: false });
    assert.equal(member403.status, 403, "a member cannot turn it off");
    const off = await request(app).put("/api/admin/operations/read-only").set("authorization", `Bearer ${adminSid}`).send({ on: false });
    assert.equal(off.status, 200, JSON.stringify(off.body));
    assert.equal(off.body.readOnly.enforcing, "off");
    const res = await request(app).post("/api/memes").set("authorization", `Bearer ${sid}`).send({});
    assert.notEqual(res.body?.code, READ_ONLY_CODE);
    const on = await request(app).put("/api/admin/operations/read-only").set("authorization", `Bearer ${adminSid}`).send({ on: true });
    assert.equal(on.body.readOnly.enforcing, "on");
  });
});

describe("the switch's cache", () => {
  it("a confirmed pause stays in force when a refresh fails, and is reported stale", async () => {
    __resetReadOnlyForTests({ on: true, updatedAt: 1000, confirmedAt: 0 });
    __setReadOnlyReaderForTests(() => Promise.reject(new Error("database unavailable")));
    assert.equal(await isReadOnly(), true);
    const view = await readOnlyEnforcement();
    assert.equal(view.enforcing, "on");
    assert.equal(view.status, "stale");
  });

  it("a confirmed 'off' also holds through a failed refresh", async () => {
    __resetReadOnlyForTests({ on: false, updatedAt: 1000, confirmedAt: 0 });
    __setReadOnlyReaderForTests(() => Promise.reject(new Error("database unavailable")));
    assert.equal(await isReadOnly(), false);
  });

  it("with nothing ever confirmed and the store unreadable, writes are refused", async () => {
    __resetReadOnlyForTests(null);
    __setReadOnlyReaderForTests(() => Promise.reject(new Error("database unavailable")));
    assert.equal(await isReadOnly(), true);
    assert.equal((await readOnlyEnforcement()).status, "unavailable");
  });

  it("an older read never undoes a newer save", async () => {
    __resetReadOnlyForTests(null);
    await setReadOnly(true, null);
    // A read that started before the save and answered after it.
    __acceptForTests({ on: false, updatedAt: 1, confirmedAt: Date.now() });
    assert.equal(await isReadOnly(), true);
    // The same race through the store read itself.
    const [saved] = await db.select({ updatedAt: adminConfigTable.updatedAt }).from(adminConfigTable).where(eq(adminConfigTable.key, READ_ONLY_CONFIG_KEY));
    __resetReadOnlyForTests({ on: true, updatedAt: saved!.updatedAt.getTime(), confirmedAt: 0 }); // due for a refresh
    __setReadOnlyReaderForTests(async () => ({ on: false, updatedAt: saved!.updatedAt.getTime() - 1, confirmedAt: Date.now() }));
    assert.equal(await isReadOnly(), true);
    assert.equal((await readOnlyEnforcement()).status, "ok", "the older read still proves the store answers");
    __setReadOnlyReaderForTests(null);
    await setReadOnly(false, null);
  });

  it("a missing row is a confirmed 'off'", async () => {
    await db.delete(adminConfigTable).where(eq(adminConfigTable.key, READ_ONLY_CONFIG_KEY));
    __resetReadOnlyForTests(null);
    assert.equal(await isReadOnly(), false);
    assert.equal((await readOnlyEnforcement()).status, "ok");
  });
});
