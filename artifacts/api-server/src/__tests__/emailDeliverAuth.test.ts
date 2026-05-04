/**
 * Tests for the Resend auth-failure shut-off behaviour in
 * `deliverFromOutbox` (artifacts/api-server/src/lib/email.ts).
 *
 * The production code intentionally treats a Resend HTTP 401 / authentication
 * error as a fatal, process-wide configuration problem:
 *
 *   1. The first 401 sets a module-private `resendAuthDisabled` flag and logs
 *      via `console.error` (NOT pino — see the long comment in email.ts about
 *      the pino-pretty crash this guards against).
 *   2. While the flag is set, every subsequent call short-circuits without
 *      ever invoking the Resend client.
 *   3. `_resetResendAuthDisabledForTests()` clears the flag so the next call
 *      hits Resend again.
 *
 * These tests stub the underlying network call by mocking
 * `Resend.prototype.post` — `Emails.send -> Emails.create -> resend.post(...)`.
 * Because `post` lives on the Resend prototype, replacing it intercepts the
 * call regardless of which instance email.ts created at module-load time.
 *
 * console.error is silenced for the duration of each test that is expected
 * to trigger the fatal-config log line, so the test output stays clean.
 */

import { describe, it, before, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";

import { Resend } from "resend";

import {
  deliverFromOutbox,
  _resetResendAuthDisabledForTests,
  isEnabled,
} from "../lib/email.js";

const SAMPLE_ROW = {
  to:      "auth-test@example.com",
  subject: "Auth test subject",
  text:    "Auth test body",
  html:    "<p>Auth test body</p>",
} as const;

describe("deliverFromOutbox — Resend auth-failure shut-off", () => {
  before(() => {
    // The deliverFromOutbox path requires a non-null module-private resend
    // client, which is only constructed when RESEND_API_KEY is set at the
    // moment email.ts is first imported. Every other api-server test file
    // sets this same dummy key, so under the sharded test runner the key is
    // already present by the time this file loads — but assert it explicitly
    // so a future change to the test runner surfaces a clear failure rather
    // than a confusing TypeError when `resend!.emails.send` is called.
    assert.equal(
      isEnabled(),
      true,
      "RESEND_API_KEY must be set before this suite runs so email.ts " +
      "constructs its internal Resend client (see emailOutbox.test.ts for " +
      "the same pre-condition).",
    );
  });

  beforeEach(() => {
    _resetResendAuthDisabledForTests();
    // Silence the deliberate console.error written when a 401 trips the
    // shut-off — without this, every test that exercises case 1 would dump
    // a noisy "[email] Resend rejected RESEND_API_KEY ..." line to stdout.
    mock.method(console, "error", () => { /* swallow */ });
  });

  afterEach(() => {
    mock.restoreAll();
    _resetResendAuthDisabledForTests();
  });

  it("flips the flag and returns { ok: false, error } on a Resend 401", async () => {
    const postMock = mock.method(Resend.prototype, "post", async () => ({
      data:  null,
      error: {
        name:       "restricted_api_key",
        message:    "API key is invalid",
        statusCode: 401,
      },
    }));

    const result = await deliverFromOutbox(SAMPLE_ROW);

    assert.equal(result.ok, false, "401 response must produce ok:false");
    assert.equal(
      result.error,
      "API key is invalid",
      "Returned error must echo the Resend error message verbatim",
    );
    assert.equal(
      postMock.mock.callCount(),
      1,
      "The first call must reach Resend (post) exactly once",
    );

    // Sanity-check that the flag was actually flipped by attempting a
    // second call: it should short-circuit without calling post again.
    const second = await deliverFromOutbox(SAMPLE_ROW);
    assert.equal(second.ok, false);
    assert.match(
      second.error ?? "",
      /Resend disabled this process/,
      "After the flag flips, subsequent calls must return the disabled-process error",
    );
    assert.equal(
      postMock.mock.callCount(),
      1,
      "post must NOT be invoked a second time once the flag is set",
    );
  });

  it("once the flag is set, subsequent calls short-circuit without invoking Resend", async () => {
    // Step 1 — trip the flag with a 401.
    const postMock = mock.method(Resend.prototype, "post", async () => ({
      data:  null,
      error: { name: "auth_error", message: "API key is invalid", statusCode: 401 },
    }));
    await deliverFromOutbox(SAMPLE_ROW);
    assert.equal(postMock.mock.callCount(), 1, "Flag-tripping call must reach post once");

    // Step 2 — replace the mock with one that throws if called. Any
    // invocation now would mean deliverFromOutbox failed to short-circuit.
    mock.restoreAll();
    // Restore the silenced console.error mock that mock.restoreAll() just
    // wiped, so the short-circuit path's (absence of) logging stays quiet.
    mock.method(console, "error", () => { /* swallow */ });
    const exploding = mock.method(Resend.prototype, "post", async () => {
      throw new Error("Resend.post must not be called once the auth-disabled flag is set");
    });

    const result = await deliverFromOutbox(SAMPLE_ROW);

    assert.equal(result.ok, false);
    assert.match(
      result.error ?? "",
      /Resend disabled this process/,
      "Short-circuit error message must mention the disabled process",
    );
    assert.match(
      result.error ?? "",
      /HTTP 401/,
      "Short-circuit error message must reference the underlying 401 cause",
    );
    assert.equal(
      exploding.mock.callCount(),
      0,
      "Resend.post must not be invoked after the flag is set",
    );
  });

  it("_resetResendAuthDisabledForTests() clears the flag so the next call hits Resend again", async () => {
    // Step 1 — set the flag via a 401.
    mock.method(Resend.prototype, "post", async () => ({
      data:  null,
      error: { name: "restricted_api_key", message: "API key is invalid", statusCode: 401 },
    }));
    const tripped = await deliverFromOutbox(SAMPLE_ROW);
    assert.equal(tripped.ok, false);
    assert.equal(tripped.error, "API key is invalid");

    // Confirm the flag is set: a second call short-circuits.
    const stillTripped = await deliverFromOutbox(SAMPLE_ROW);
    assert.match(stillTripped.error ?? "", /Resend disabled this process/);

    // Step 2 — reset the flag.
    _resetResendAuthDisabledForTests();

    // Step 3 — swap the mock for a successful response and verify Resend
    // is consulted again (the short-circuit branch must NOT trigger).
    mock.restoreAll();
    mock.method(console, "error", () => { /* swallow */ });
    const successMock = mock.method(Resend.prototype, "post", async () => ({
      data:  { id: "msg_test_ok" },
      error: null,
    }));

    const recovered = await deliverFromOutbox(SAMPLE_ROW);

    assert.equal(recovered.ok, true, "After reset, a successful Resend response yields ok:true");
    assert.equal(recovered.error, undefined);
    assert.equal(
      successMock.mock.callCount(),
      1,
      "After the reset, deliverFromOutbox must call Resend again exactly once",
    );
  });
});
