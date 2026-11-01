/**
 * The verified-actor gate (launch Phase 5, increment 3, #795; plan T1, T7).
 *
 * @purpose Proves, through the real app stack, that a signed-in account that is not yet eligible is refused every state-changing route with its state's code except the exception table's routes, that the inventoried mutating GET is refused and the public hero read keeps its read without its write, that anonymous requests are untouched, that photo uploads need an adult date of birth to the day, and that the middleware's exception table is the one this plan wrote.
 * @subsystem accounts-auth
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import request from "supertest";
import { db } from "@workspace/db";
import { usersTable, userFactPreferencesTable, factsTable } from "@workspace/db/schema";
import { eq, like } from "drizzle-orm";

import { createApp } from "../app.js";
import { createSession, type SessionData } from "../lib/auth.js";
import { GATE_EXCEPTIONS, MUTATING_GETS, ADULT_ONLY, REFUSAL_CODE } from "../middlewares/requireEligibleActor.js";

const USER_PREFIX = "t-p5gate-";
const ROUTES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "routes");

// The plan's exception table, written here from the plan rather than read
// from the middleware, so a change to either side is a visible decision.
const RECOVERY = [
  "POST /auth/register",
  "POST /auth/local-login",
  "POST /auth/forgot-password",
  "POST /auth/reset-password",
  "POST /auth/resend-verification",
  "POST /auth/logout",
  "POST /callback/apple",
  "POST /auth/dev-admin-login",
];
const PLAN_EXCEPTIONS = {
  suspended: ["POST /auth/logout"],
  deletion_pending: [...RECOVERY],
  unverified: [...RECOVERY],
  unonboarded: [...RECOVERY, "PUT /users/me/onboarding/draft", "POST /users/me/onboarding"],
};

type State = "unverified" | "unonboarded" | "eligible";

async function userIn(state: State, dateOfBirth: string | null = null): Promise<string> {
  const id = `${USER_PREFIX}${randomUUID()}`;
  await db.insert(usersTable).values({
    id,
    email: `${id}@test.local`,
    emailVerifiedAt: state === "unverified" ? null : new Date(),
    onboardingCompletedAt: state === "eligible" ? new Date() : null,
    dateOfBirth,
  });
  return id;
}

async function bearer(userId: string): Promise<string> {
  const data: SessionData = { user: { id: userId } as unknown as SessionData["user"], access_token: "t" };
  return createSession(data, userId);
}

/** Every unsafe route each router file declares, as `METHOD /path` with params filled. */
function declaredUnsafeRoutes(): Array<{ file: string; method: string; path: string; key: string }> {
  const out: Array<{ file: string; method: string; path: string; key: string }> = [];
  for (const file of readdirSync(ROUTES_DIR).filter((f) => f.endsWith(".ts"))) {
    const src = readFileSync(join(ROUTES_DIR, file), "utf8");
    for (const m of src.matchAll(/router\.(post|put|patch|delete)\(\s*"([^"]+)"/g)) {
      const method = m[1]!.toUpperCase();
      const key = `${method} ${m[2]}`;
      out.push({ file, method, path: m[2]!.replace(/:[A-Za-z_]+/g, "1").replace(/\*[A-Za-z_]+/g, "x"), key });
    }
  }
  return out;
}

async function cleanup(): Promise<void> {
  await db.delete(usersTable).where(like(usersTable.id, `${USER_PREFIX}%`));
}

before(cleanup);
after(cleanup);

describe("the gate's exception table is the plan's", () => {
  it("matches the copy written from the plan", () => {
    assert.deepEqual(
      Object.fromEntries(Object.entries(GATE_EXCEPTIONS).map(([k, v]) => [k, [...v].sort()])),
      Object.fromEntries(Object.entries(PLAN_EXCEPTIONS).map(([k, v]) => [k, [...v].sort()])),
    );
    assert.deepEqual([...MUTATING_GETS], ["GET /link/:provider"]);
    assert.deepEqual([...ADULT_ONLY].sort(), ["POST /storage/upload-avatar", "POST /storage/upload-meme"]);
  });

  it("every exception names a route some router declares", () => {
    const declared = new Set(declaredUnsafeRoutes().map((r) => r.key));
    for (const key of new Set(Object.values(GATE_EXCEPTIONS).flat())) {
      assert.ok(declared.has(key), `${key} is in the exception table but no router declares it`);
    }
  });
});

for (const state of ["unverified", "unonboarded"] as const) {
  describe(`a signed-in ${state} account`, () => {
    let userId = "";
    let sid = "";
    before(async () => {
      userId = await userIn(state);
      sid = await bearer(userId);
    });

    it("is refused every unsafe route outside its exceptions, with its state's code", async () => {
      const app = createApp();
      const allowed = new Set<string>(GATE_EXCEPTIONS[state]);
      const routes = declaredUnsafeRoutes().filter((r) => !allowed.has(r.key));
      assert.ok(routes.length > 100, `expected the full inventory, found ${routes.length}`);
      const files = new Set<string>();
      for (const r of routes) {
        const res = await request(app)[r.method.toLowerCase() as "post"](`/api${r.path}`)
          .set("authorization", `Bearer ${sid}`)
          .send({});
        assert.equal(res.status, 403, `${r.key} (${r.file}) answered ${res.status}`);
        assert.equal(res.body.code, REFUSAL_CODE[state], `${r.key} (${r.file})`);
        files.add(r.file);
      }
      assert.ok(files.size >= 20, `one route per router file at least; covered ${files.size}`);
    });

    it("reaches the handler of every exception route", async () => {
      const app = createApp();
      for (const key of GATE_EXCEPTIONS[state]) {
        const [method, path] = key.split(" ") as [string, string];
        // A fresh session each time: logout, one of the exceptions, ends it.
        const own = await bearer(userId);
        const res = await request(app)[method.toLowerCase() as "post"](`/api${path}`)
          .set("authorization", `Bearer ${own}`)
          .send({});
        assert.notEqual(res.body?.code, REFUSAL_CODE[state], `${key} was refused by the gate`);
      }
    });

    it("is refused through a mixed-case path, which Express routes the same", async () => {
      const own = await bearer(userId);
      const res = await request(createApp()).patch("/API/Users/Me").set("authorization", `Bearer ${own}`).send({ pronouns: "she/her" });
      assert.equal(res.status, 403);
      assert.equal(res.body.code, REFUSAL_CODE[state]);
    });

    it("is refused the inventoried mutating GET sent as HEAD, which Express runs as the GET", async () => {
      const own = await bearer(userId);
      const res = await request(createApp()).head("/api/link/google").set("authorization", `Bearer ${own}`);
      assert.equal(res.status, 403);
    });

    it("is refused the inventoried mutating GET", async () => {
      const own = await bearer(userId);
      const res = await request(createApp()).get("/api/link/google").set("authorization", `Bearer ${own}`);
      assert.equal(res.status, 403);
      assert.equal(res.body.code, REFUSAL_CODE[state]);
    });
  });
}

describe("the public hero read keeps its read and skips its write for an account that cannot act", () => {
  it("answers with a fact and writes no preference row", async () => {
    const [fact] = await db.select({ id: factsTable.id }).from(factsTable).limit(1);
    if (!fact) return; // the shard's database carries no facts; the write is covered by routes.facts.hero for eligible accounts
    const userId = await userIn("unonboarded");
    const sid = await bearer(userId);
    const res = await request(createApp()).get("/api/facts/hero").set("authorization", `Bearer ${sid}`);
    assert.notEqual(res.status, 403);
    await new Promise((r) => setTimeout(r, 100));
    const rows = await db.select().from(userFactPreferencesTable).where(eq(userFactPreferencesTable.userId, userId));
    assert.equal(rows.length, 0);
  });
});

describe("anonymous requests are untouched", () => {
  it("an unsafe route reaches its handler with no gate code", async () => {
    const res = await request(createApp()).post("/api/auth/logout").send({});
    assert.notEqual(res.body?.code, "EMAIL_VERIFICATION_REQUIRED");
    assert.notEqual(res.body?.code, "ONBOARDING_REQUIRED");
  });
});

describe("photo uploads need an adult date of birth (plan S12, T7)", () => {
  function isoYearsAgo(years: number, dayOffset: number): string {
    const d = new Date();
    d.setUTCFullYear(d.getUTCFullYear() - years);
    d.setUTCDate(d.getUTCDate() + dayOffset);
    return d.toISOString().slice(0, 10);
  }

  for (const path of ["/api/storage/upload-avatar", "/api/storage/upload-meme"]) {
    it(`${path}: refused the day before the 18th birthday, admitted on it`, async () => {
      const app = createApp();
      const minor = await bearer(await userIn("eligible", isoYearsAgo(18, 1)));
      const refused = await request(app).post(path).set("authorization", `Bearer ${minor}`).set("content-type", "image/jpeg").send(Buffer.from([0xff]));
      assert.equal(refused.status, 403);
      assert.equal(refused.body.code, "ADULT_REQUIRED");

      const adult = await bearer(await userIn("eligible", isoYearsAgo(18, 0)));
      const admitted = await request(app).post(path).set("authorization", `Bearer ${adult}`).set("content-type", "image/jpeg").send(Buffer.from([0xff]));
      assert.notEqual(admitted.body?.code, "ADULT_REQUIRED");
    });
  }

  it("an eligible account with no date of birth is refused (asked at onboarding, never assumed adult)", async () => {
    const sid = await bearer(await userIn("eligible", null));
    const res = await request(createApp()).post("/api/storage/upload-avatar").set("authorization", `Bearer ${sid}`).set("content-type", "image/jpeg").send(Buffer.from([0xff]));
    assert.equal(res.body.code, "ADULT_REQUIRED");
  });
});
