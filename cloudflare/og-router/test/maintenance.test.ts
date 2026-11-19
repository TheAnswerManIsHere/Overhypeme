// The daily maintenance caller (src/maintenance.ts), with a stubbed fetch.
// Run by `pnpm --filter @workspace/og-router test` (node --test, type stripping).
import { test } from "node:test";
import assert from "node:assert/strict";
import { callDailyMaintenance, DEFAULT_MAINTENANCE_URL, RETRY_DELAY_MS } from "../src/maintenance.ts";

const okBody = { ok: true, startedAt: "x", finishedAt: "y", jobs: [{ job: "expired-sessions", ok: true, ms: 3, result: { deleted: 1 } }] };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const noSleep = async () => {};

function recorder(...answers: Array<Response | Error>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const a = answers.shift();
    if (!a) throw new Error("no more answers");
    if (a instanceof Error) throw a;
    return a;
  };
  return { calls, fetchImpl };
}

test("a clean run: one POST to the configured URL with the secret, redirects not followed", async () => {
  const { calls, fetchImpl } = recorder(json(200, okBody));
  const r = await callDailyMaintenance({ CRON_SECRET: "s3", MAINTENANCE_URL: "https://example.test/api/jobs/maintenance" }, fetchImpl, noSleep);
  assert.equal(r.attempts, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://example.test/api/jobs/maintenance");
  assert.equal(calls[0].init.method, "POST");
  assert.equal((calls[0].init.headers as Record<string, string>)["x-cron-secret"], "s3");
  assert.equal(calls[0].init.redirect, "manual");
  assert.deepEqual(r.jobs, [{ job: "expired-sessions", ok: true, ms: 3 }], "a job's result is not carried into the log");
});

test("with no MAINTENANCE_URL it calls the canonical host", async () => {
  const { calls, fetchImpl } = recorder(json(200, okBody));
  await callDailyMaintenance({ CRON_SECRET: "s" }, fetchImpl, noSleep);
  assert.equal(calls[0].url, DEFAULT_MAINTENANCE_URL);
});

test("no secret: nothing is called and the invocation fails", async () => {
  const { calls, fetchImpl } = recorder(json(200, okBody));
  await assert.rejects(callDailyMaintenance({}, fetchImpl, noSleep), /CRON_SECRET is not set/);
  assert.equal(calls.length, 0);
});

test("a cold start (503, or unreachable) is retried once after the delay", async () => {
  for (const first of [json(503, {}), new Error("connection reset")]) {
    const waits: number[] = [];
    const { calls, fetchImpl } = recorder(first, json(200, okBody));
    const r = await callDailyMaintenance({ CRON_SECRET: "s" }, fetchImpl, async (ms) => { waits.push(ms); });
    assert.equal(r.attempts, 2);
    assert.equal(calls.length, 2);
    assert.deepEqual(waits, [RETRY_DELAY_MS]);
  }
});

test("two cold-start answers in a row fail, and no third call is made", async () => {
  const { calls, fetchImpl } = recorder(json(502, {}), json(504, {}), json(200, okBody));
  await assert.rejects(callDailyMaintenance({ CRON_SECRET: "s" }, fetchImpl, noSleep), /not run after 2 attempts: the app answered 504/);
  assert.equal(calls.length, 2);
});

test("a redirect (the country rule's /unavailable) fails and is not retried", async () => {
  const { calls, fetchImpl } = recorder(new Response(null, { status: 302, headers: { location: "https://overhype.me/unavailable" } }));
  await assert.rejects(callDailyMaintenance({ CRON_SECRET: "s" }, fetchImpl, noSleep), /redirected \(302 to https:\/\/overhype\.me\/unavailable\)/);
  assert.equal(calls.length, 1);
});

test("a refused secret fails naming the mismatch", async () => {
  const { fetchImpl } = recorder(json(403, { error: "Forbidden" }));
  await assert.rejects(callDailyMaintenance({ CRON_SECRET: "s" }, fetchImpl, noSleep), /CRON_SECRET does not match/);
});

test("a run with a failed job fails, naming the job and its reason", async () => {
  const body = { ok: false, jobs: [{ job: "expired-sessions", ok: true }, { job: "content-purge", ok: false, error: "could not purge 2 photos" }] };
  const { fetchImpl } = recorder(json(500, body));
  await assert.rejects(callDailyMaintenance({ CRON_SECRET: "s" }, fetchImpl, noSleep), /content-purge \(could not purge 2 photos\)/);
});

test("a 200 that is not the run's answer fails closed", async () => {
  for (const res of [
    new Response("<!doctype html><html></html>", { status: 200, headers: { "content-type": "text/html" } }),
    json(200, { ok: true }),
    json(200, { ok: true, jobs: [{ job: "x" }] }),
    json(200, { ok: false, jobs: [{ job: "x", ok: true }] }),
    json(200, { jobs: [{ job: "x", ok: false }], ok: true }),
  ]) {
    const { fetchImpl } = recorder(res);
    await assert.rejects(callDailyMaintenance({ CRON_SECRET: "s" }, fetchImpl, noSleep));
  }
});
