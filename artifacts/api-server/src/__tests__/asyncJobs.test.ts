import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { db } from "@workspace/db";
import { adminConfigTable, asyncJobsTable } from "@workspace/db/schema";
import { eq, inArray, like } from "drizzle-orm";

import {
  __resetHandlersForTest,
  asyncJobsTick,
  enqueueJob,
  registerJobHandler,
} from "../lib/asyncJobs.js";
import { bustConfigCache } from "../lib/adminConfig.js";

const QUEUE_PREFIX = "test_async_jobs_";

async function cleanupQueues(): Promise<void> {
  await db.delete(asyncJobsTable).where(like(asyncJobsTable.queue, `${QUEUE_PREFIX}%`));
}

async function cleanupJobs(ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  await db.delete(asyncJobsTable).where(inArray(asyncJobsTable.id, ids));
}

async function cleanupConfig(keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  await db.delete(adminConfigTable).where(inArray(adminConfigTable.key, keys));
  bustConfigCache();
}

async function setConfigInt(key: string, value: number): Promise<void> {
  await db
    .insert(adminConfigTable)
    .values({
      key,
      value: String(value),
      dataType: "integer",
      label: `${key} (test override)`,
    })
    .onConflictDoUpdate({
      target: adminConfigTable.key,
      set: { value: String(value) },
    });
  bustConfigCache();
}

function clearResendEnv(): Record<string, string | undefined> {
  const previous = {
    RESEND_API_KEY: process.env.RESEND_API_KEY,
    RESEND_API_KEY_DEV: process.env.RESEND_API_KEY_DEV,
    RESEND_API_KEY_PROD: process.env.RESEND_API_KEY_PROD,
  };
  delete process.env.RESEND_API_KEY;
  delete process.env.RESEND_API_KEY_DEV;
  delete process.env.RESEND_API_KEY_PROD;
  return previous;
}

function restoreEnv(previous: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

async function getJob(id: number) {
  const [row] = await db.select().from(asyncJobsTable).where(eq(asyncJobsTable.id, id)).limit(1);
  assert.ok(row, `Expected async job ${id} to exist`);
  return row;
}

describe("asyncJobs worker", () => {
  const configKeys: string[] = [];
  const jobIds: number[] = [];
  const envStack: Array<Record<string, string | undefined>> = [];

  afterEach(async () => {
    __resetHandlersForTest();
    await cleanupJobs(jobIds.splice(0));
    await cleanupQueues();
    await cleanupConfig(configKeys.splice(0));
    while (envStack.length > 0) restoreEnv(envStack.pop()!);
  });

  it("leaves queued email pending when delivery is not configured", async () => {
    envStack.push(clearResendEnv());
    const queue = "email";
    let called = false;
    registerJobHandler(queue, {
      async run() {
        called = true;
        return { ok: true };
      },
    });

    const [row] = await db
      .insert(asyncJobsTable)
      .values({
        queue,
        payload: { to: "test@example.com", subject: "Test", text: "Body" },
        status: "pending",
        attempts: 2,
        maxAttempts: 0,
        nextAttemptAt: new Date(Date.now() - 1000),
      })
      .returning();
    assert.ok(row);
    jobIds.push(row.id);

    await asyncJobsTick(db);

    const after = await getJob(row.id);
    assert.equal(called, false, "email handler should not run when delivery is disabled");
    assert.equal(after.status, "pending");
    assert.equal(after.attempts, 2, "disabled delivery must not burn a retry attempt");
    assert.match(after.lastError ?? "", /not configured/);
  });

  it("uses the queue-level max-attempts config when no per-job override is set", async () => {
    const queue = `${QUEUE_PREFIX}${randomUUID()}`;
    const configKey = `async_job_${queue}_max_attempts`;
    configKeys.push(configKey);
    await setConfigInt(configKey, 2);

    registerJobHandler(queue, {
      async run() {
        return { ok: false, error: "simulated failure" };
      },
    });

    await enqueueJob({ queue, payload: {} });
    const [inserted] = await db
      .select()
      .from(asyncJobsTable)
      .where(eq(asyncJobsTable.queue, queue))
      .limit(1);
    assert.ok(inserted);
    jobIds.push(inserted.id);

    await db
      .update(asyncJobsTable)
      .set({ attempts: 1, nextAttemptAt: new Date(Date.now() - 1000) })
      .where(eq(asyncJobsTable.id, inserted.id));

    await asyncJobsTick(db);

    const after = await getJob(inserted.id);
    assert.equal(after.maxAttempts, 0, "0 sentinel should mean queue config, not a hard-coded override");
    assert.equal(after.attempts, 2);
    assert.equal(after.status, "failed");
  });
});
