/**
 * Rendering tests for the dispute alert email builder.
 *
 * These tests pin down the per-kind copy for `buildDisputeNotificationEmail`:
 *  - subject lines stay distinct (and contain the distinguishing phrase)
 *  - the plain-text body opens with the right intro line
 *  - the Stripe dashboard link points at `disputes/<id>` (with `/test` for non-livemode)
 *
 * If a future refactor accidentally collapses two kinds together or swaps a
 * CTA / amount label, these assertions should fail loudly.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildDisputeNotificationEmail,
  type AdminDisputeAlertKind,
  type AdminDisputeNotifyOpts,
} from "../lib/adminNotify.js";

const BASE_OPTS: Omit<AdminDisputeNotifyOpts, "kind"> = {
  disputeId: "dp_1AbcXYZ",
  amount: 4999, // $49.99
  currency: "usd",
  livemode: true,
};

function build(overrides: Partial<AdminDisputeNotifyOpts> & { kind: AdminDisputeAlertKind }) {
  return buildDisputeNotificationEmail({ ...BASE_OPTS, ...overrides });
}

describe("buildDisputeNotificationEmail – subject lines", () => {
  it("uses 'opened' for the created kind", () => {
    const { subject } = build({ kind: "created" });
    assert.match(subject, /opened/i, `subject should mention 'opened': ${subject}`);
  });

  it("uses 'deadline in <N>h' style phrasing for deadline_approaching", () => {
    const { subject } = build({ kind: "deadline_approaching", hoursUntilDue: 12 });
    assert.match(
      subject,
      /deadline in 12 hours/i,
      `subject should mention the hour count: ${subject}`,
    );
  });

  it("singularises 'hour' when exactly 1 hour remains", () => {
    const { subject } = build({ kind: "deadline_approaching", hoursUntilDue: 1 });
    assert.match(subject, /deadline in 1 hour\b/i, `subject should singularise: ${subject}`);
    assert.doesNotMatch(subject, /1 hours/i);
  });

  it("uses 'funds withdrawn' for funds_withdrawn", () => {
    const { subject } = build({ kind: "funds_withdrawn" });
    assert.match(subject, /funds withdrawn/i, `subject should mention 'funds withdrawn': ${subject}`);
  });

  it("uses 'funds reinstated' for funds_reinstated", () => {
    const { subject } = build({ kind: "funds_reinstated" });
    assert.match(
      subject,
      /funds reinstated/i,
      `subject should mention 'funds reinstated': ${subject}`,
    );
  });

  it("emits a distinct subject line for every kind", () => {
    const subjects = new Set([
      build({ kind: "created" }).subject,
      build({ kind: "deadline_approaching", hoursUntilDue: 12 }).subject,
      build({ kind: "funds_withdrawn" }).subject,
      build({ kind: "funds_reinstated" }).subject,
    ]);
    assert.equal(subjects.size, 4, "each kind must produce a unique subject");
  });
});

describe("buildDisputeNotificationEmail – plain-text intro lines", () => {
  it("opens with the dispute-opened intro for created", () => {
    const { text } = build({ kind: "created" });
    assert.ok(
      text.startsWith("URGENT: A STRIPE DISPUTE HAS BEEN OPENED."),
      `text should start with the created intro:\n${text}`,
    );
  });

  it("opens with the deadline intro (including hours) for deadline_approaching", () => {
    const { text } = build({ kind: "deadline_approaching", hoursUntilDue: 6 });
    assert.ok(
      text.startsWith("URGENT: STRIPE DISPUTE DEADLINE IN 6 HOURS."),
      `text should start with the deadline intro:\n${text}`,
    );
  });

  it("opens with the funds-withdrawn intro for funds_withdrawn", () => {
    const { text } = build({ kind: "funds_withdrawn" });
    assert.ok(
      text.startsWith("STRIPE HAS WITHDRAWN FUNDS FOR A DISPUTE."),
      `text should start with the withdrawn intro:\n${text}`,
    );
  });

  it("opens with the funds-reinstated intro for funds_reinstated", () => {
    const { text } = build({ kind: "funds_reinstated" });
    assert.ok(
      text.startsWith("STRIPE HAS REINSTATED FUNDS FOR A DISPUTE."),
      `text should start with the reinstated intro:\n${text}`,
    );
  });
});

describe("buildDisputeNotificationEmail – dashboard link", () => {
  const KINDS: AdminDisputeAlertKind[] = [
    "created",
    "deadline_approaching",
    "funds_withdrawn",
    "funds_reinstated",
  ];

  for (const kind of KINDS) {
    it(`points at disputes/<id> in livemode for ${kind}`, () => {
      const { text, html } = build({
        kind,
        disputeId: "dp_LiveCase123",
        livemode: true,
        hoursUntilDue: 5,
      });
      const expected = "https://dashboard.stripe.com/disputes/dp_LiveCase123";
      assert.ok(text.includes(expected), `text body should link to ${expected}:\n${text}`);
      assert.ok(html.includes(expected), `html body should link to ${expected}`);
      assert.ok(
        !text.includes("/test/disputes/"),
        "livemode link must not contain the /test/ segment",
      );
    });

    it(`points at /test/disputes/<id> in non-livemode for ${kind}`, () => {
      const { text, html } = build({
        kind,
        disputeId: "dp_TestCase456",
        livemode: false,
        hoursUntilDue: 5,
      });
      const expected = "https://dashboard.stripe.com/test/disputes/dp_TestCase456";
      assert.ok(text.includes(expected), `text body should link to ${expected}:\n${text}`);
      assert.ok(html.includes(expected), `html body should link to ${expected}`);
    });
  }
});
