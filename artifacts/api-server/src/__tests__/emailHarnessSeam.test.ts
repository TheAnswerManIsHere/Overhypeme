/**
 * The email test-harness seam in lib/email.ts.
 *
 * The production-mode launcher replaces the email transport below the queue:
 * the job handler and `deliverFromOutbox` run unchanged and only the final send
 * goes to the installed transport. Two properties matter:
 *
 * 1. With no Resend key and a transport installed, delivery goes through the
 *    transport (and nowhere else), and a second install is refused.
 * 2. In a process where a Resend client exists, the installer refuses — so a
 *    harness can never send part of a run through the real vendor.
 *
 * (1) runs in a child process because this runner shares one process and sets
 * a dummy Resend key in it; (2) is exactly that shared process.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.RESEND_API_KEY = process.env.RESEND_API_KEY ?? "re_test_dummy";

import { installEmailTransportForTestHarness, isEnabled } from "../lib/email.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

describe("email test-harness seam", () => {
  it("refuses to install a transport when a Resend client is configured", () => {
    assert.equal(isEnabled(), true, "this runner sets a dummy Resend key before email.ts loads");
    assert.throws(
      () => installEmailTransportForTestHarness({ async send() { return { error: null }; } }),
      /Resend API key is configured/,
    );
  });

  it("delivers through the installed transport, below the queue, in a process with no Resend key", () => {
    const env = { ...process.env };
    delete env.RESEND_API_KEY;
    delete env.RESEND_API_KEY_DEV;
    delete env.RESEND_API_KEY_PROD;
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx/esm", path.join(HERE, "fixtures/emailHarnessProbe.ts")],
      { env, encoding: "utf8", timeout: 60_000 },
    );
    assert.equal(result.status, 0, `probe exited ${result.status}: ${result.stderr}`);
    const line = result.stdout.trim().split("\n").filter((l) => l.startsWith("{")).pop();
    assert.ok(line, `probe printed no JSON: ${result.stdout}`);
    const probe = JSON.parse(line);

    assert.equal(probe.enabledBefore, false, "no key and no transport: email is disabled");
    assert.equal(probe.enabledAfter, true, "an installed transport enables delivery");
    assert.match(probe.unavailableBefore ?? "", /not configured/, "the worker defers email while nothing can send it");
    assert.equal(probe.unavailableAfter, null, "and runs it once a transport is installed");
    assert.equal(probe.secondInstallRefused, true);
    assert.deepEqual(probe.direct, { ok: true });
    assert.deepEqual(probe.viaHandler, { ok: true });
    assert.deepEqual(
      probe.captured.map((m: { to: string; subject: string }) => [m.to, m.subject]),
      [["probe-direct@example.test", "direct"], ["probe-job@example.test", "job"]],
    );
    const job = probe.captured[1];
    assert.equal(job.html, "<p>job body</p>");
    assert.ok(job.from, "the sender address is resolved as in production");
  });
});
