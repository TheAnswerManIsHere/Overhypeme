/**
 * Child-process probe for `emailHarnessSeam.test.ts`. The test runner shares
 * one process across files and sets a dummy Resend key in it, which (by
 * design) makes the test-harness installer refuse. This probe runs in a clean
 * process with no Resend key, installs a capturing transport, sends through
 * the real delivery path, and prints what happened as one JSON line.
 */
import { installEmailTransportForTestHarness, deliverFromOutbox, emailJobHandler, isEnabled } from "../../lib/email.js";
import type { OutgoingEmail } from "../../lib/email.js";

const captured: OutgoingEmail[] = [];
const enabledBefore = isEnabled();
const unavailableBefore = emailJobHandler.unavailableReason?.() ?? null;
installEmailTransportForTestHarness({
  async send(message) {
    captured.push(message);
    return { error: null };
  },
});

let secondInstallRefused = false;
try {
  installEmailTransportForTestHarness({ async send() { return { error: null }; } });
} catch {
  secondInstallRefused = true;
}

const direct = await deliverFromOutbox({ to: "probe-direct@example.test", subject: "direct", text: "body", html: null });
const jobPayload = { to: "probe-job@example.test", subject: "job", text: "job body", html: "<p>job body</p>", kind: null };
// The handler only reads its payload; the row argument is unused by the email queue.
const viaHandler = await emailJobHandler.run(jobPayload, {} as Parameters<typeof emailJobHandler.run>[1]);

process.stdout.write(
  JSON.stringify({ enabledBefore, unavailableBefore, unavailableAfter: emailJobHandler.unavailableReason?.() ?? null, enabledAfter: isEnabled(), secondInstallRefused, direct, viaHandler, captured }) + "\n",
);
process.exit(0);
