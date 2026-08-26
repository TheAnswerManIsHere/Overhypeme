/**
 * Tests 1, 3b, 4 and 6 at the level they actually matter: the REAL server
 * process.
 *
 * The property is positional, so it cannot be established in-process. A refusal
 * that is merely awaited-and-fatal — hoisted out of `initStripe()`'s `catch` and
 * out of its detached launch — still runs 106 lines after `app.listen()`, so a
 * mismatched deployment opens for traffic, can pass a health check, and only
 * then exits. On a platform that restarts it, that is a crash loop serving
 * requests in between. A test asserting "the process eventually exits" passes
 * against exactly that. **This asserts the port is never bound.**
 *
 * The fatal case exercised here is *credentials present, expected account id
 * absent*, which reaches the same fatal branch as a confirmed mismatch and
 * needs no Stripe call — so the placement is proven against the real
 * `index.ts` without a network fixture or a real key. The classification of a
 * confirmed mismatch as fatal is proven separately, in
 * `stripeAccountGuard.test.ts`; together they cover the claim. Nothing here
 * asserts anything about a mismatch, and nothing there asserts anything about
 * placement.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { connect } from "node:net";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const API_SERVER_DIR = resolve(HERE, "../..");

/** The listen callback logs this. Its absence is the port never having bound. */
const LISTENING_MARKER = "Server listening";
const REFUSAL_MARKER = "REFUSING TO START";

async function freePort(): Promise<number> {
  return await new Promise((resolveP, rejectP) => {
    const probe = createServer();
    probe.on("error", rejectP);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address === null || typeof address === "string") {
        probe.close(() => rejectP(new Error("could not obtain a port")));
        return;
      }
      const { port } = address;
      probe.close(() => resolveP(port));
    });
  });
}

async function portAccepts(port: number): Promise<boolean> {
  return await new Promise((resolveP) => {
    const socket = connect({ port, host: "127.0.0.1" });
    const settle = (accepted: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolveP(accepted);
    };
    socket.setTimeout(500);
    socket.once("connect", () => settle(true));
    socket.once("error", () => settle(false));
    socket.once("timeout", () => settle(false));
  });
}

interface BootResult {
  code: number | null;
  output: string;
  everAccepted: boolean;
}

/**
 * Boot the real `src/index.ts` in a child process and watch the port
 * throughout its life.
 */
async function bootServer(
  env: Record<string, string | undefined>,
  opts: { stopOnListening?: boolean; timeoutMs?: number } = {},
): Promise<BootResult> {
  const { stopOnListening = false, timeoutMs = 90_000 } = opts;
  const port = await freePort();
  const child = spawn(
    process.execPath,
    ["--import", "tsx/esm", resolve(API_SERVER_DIR, "src/index.ts")],
    {
      cwd: API_SERVER_DIR,
      env: {
        ...process.env,
        PORT: String(port),
        NODE_ENV: "test",
        // Off by default in this environment; named explicitly so a child that
        // dies for an unrelated reason is easy to spot in `output`.
        SENTRY_DSN: "",
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let output = "";
  let sawListening = false;
  const absorb = (chunk: Buffer) => {
    output += chunk.toString();
    if (stopOnListening && !sawListening && output.includes(LISTENING_MARKER)) {
      sawListening = true;
      // The property under test is settled the moment the port binds; a healthy
      // server would otherwise run until the kill timeout.
      child.kill("SIGTERM");
    }
  };
  child.stdout.on("data", absorb);
  child.stderr.on("data", absorb);

  let everAccepted = false;
  let watching = true;
  const watcher = (async () => {
    while (watching) {
      if (await portAccepts(port)) everAccepted = true;
      await new Promise((r) => setTimeout(r, 25));
    }
  })();

  const code = await new Promise<number | null>((resolveP) => {
    const killer = setTimeout(() => { child.kill("SIGKILL"); }, timeoutMs);
    child.once("exit", (exitCode) => { clearTimeout(killer); resolveP(exitCode); });
  });

  watching = false;
  await watcher;
  // One last look, in case the child bound and exited between polls.
  if (await portAccepts(port)) everAccepted = true;

  return { code, output, everAccepted };
}

const STRIPE_ENV_OFF = {
  STRIPE_SECRET_KEY_TEST: undefined,
  STRIPE_SECRET_KEY_LIVE: undefined,
  STRIPE_PUBLISHABLE_KEY_TEST: undefined,
  STRIPE_PUBLISHABLE_KEY_LIVE: undefined,
  STRIPE_ACCOUNT_ID_TEST: undefined,
  STRIPE_ACCOUNT_ID_LIVE: undefined,
} as const;

describe("the refusal precedes the port opening", () => {
  it("tests 1, 3b and 4 — credentials present with no declared account: the process exits and the port is NEVER bound", async () => {
    const result = await bootServer({
      ...STRIPE_ENV_OFF,
      STRIPE_SECRET_KEY_TEST: "sk_test_present_but_undeclared",
      STRIPE_PUBLISHABLE_KEY_TEST: "pk_test_present",
      // STRIPE_ACCOUNT_ID_TEST deliberately absent.
    });

    // Pinned to OUR refusal, so a child that died of something unrelated does
    // not pass this test vacuously.
    assert.match(result.output, new RegExp(REFUSAL_MARKER), `child output:\n${result.output.slice(-4000)}`);
    assert.notEqual(result.code, 0, "a refusal must be a non-zero exit");

    // The two independent observations of "never bound": the listen callback's
    // log line never appeared, and no connection was ever accepted.
    assert.doesNotMatch(
      result.output,
      new RegExp(LISTENING_MARKER),
      "the port was bound before the refusal — the refusal is in the wrong place",
    );
    assert.equal(result.everAccepted, false, "a connection was accepted before the refusal");

    // Test 4: the refusal is not swallowed. `initStripe()`'s try/catch and its
    // detached launch are both still in the file; neither absorbed this.
    assert.doesNotMatch(result.output, /continuing without payments/);
  });

  it("test 6 — with no Stripe credentials at all the server still boots and binds", async () => {
    // The negative test for the guard's own blast radius: the fix must not have
    // turned optional Stripe configuration into a fatal boot dependency.
    const result = await bootServer({ ...STRIPE_ENV_OFF }, { stopOnListening: true });

    assert.doesNotMatch(result.output, new RegExp(REFUSAL_MARKER), `child output:\n${result.output.slice(-4000)}`);
    assert.match(
      result.output,
      new RegExp(LISTENING_MARKER),
      `the server must still boot without Stripe:\n${result.output.slice(-4000)}`,
    );
    assert.equal(result.everAccepted, true, "the port should have been bound");
    // `code` is not asserted: this child is stopped deliberately once the port
    // binds, so its exit status describes the test's own SIGTERM, not the boot.
  });
});
