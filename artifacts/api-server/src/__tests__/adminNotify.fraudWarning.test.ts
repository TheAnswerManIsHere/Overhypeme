/**
 * URL tests for buildFraudWarningEmail.
 *
 * Verifies that the generated email HTML and plain-text body contain the
 * correct Stripe Radar early-fraud-warning dashboard URL for both live mode
 * and test mode. A bug that always emits the test-mode URL in live mode (or
 * vice-versa) would be caught here immediately.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildFraudWarningEmail,
  type AdminFraudWarningNotifyOpts,
} from "../lib/adminNotify.js";

const BASE_OPTS: AdminFraudWarningNotifyOpts = {
  warningId: "issfr_1AbcTEST",
  chargeId: "ch_1AbcTEST",
  amount: 2999, // $29.99
  currency: "usd",
  livemode: true,
};

describe("buildFraudWarningEmail – dashboard URL (live mode)", () => {
  it("text body links to live radar/early-fraud-warnings/<id>", () => {
    const { text } = buildFraudWarningEmail({
      ...BASE_OPTS,
      warningId: "issfr_LiveABC",
      livemode: true,
    });
    const expected = "https://dashboard.stripe.com/radar/early-fraud-warnings/issfr_LiveABC";
    assert.ok(text.includes(expected), `text should contain live URL:\n${text}`);
  });

  it("html body links to live radar/early-fraud-warnings/<id>", () => {
    const { html } = buildFraudWarningEmail({
      ...BASE_OPTS,
      warningId: "issfr_LiveABC",
      livemode: true,
    });
    const expected = "https://dashboard.stripe.com/radar/early-fraud-warnings/issfr_LiveABC";
    assert.ok(html.includes(expected), `html should contain live URL`);
  });

  it("live-mode link does not contain the /test/ segment", () => {
    const { text, html } = buildFraudWarningEmail({
      ...BASE_OPTS,
      warningId: "issfr_LiveABC",
      livemode: true,
    });
    assert.ok(
      !text.includes("/test/radar/"),
      "live-mode text must not contain /test/ segment",
    );
    assert.ok(
      !html.includes("/test/radar/"),
      "live-mode html must not contain /test/ segment",
    );
  });
});

describe("buildFraudWarningEmail – dashboard URL (test mode)", () => {
  it("text body links to test radar/early-fraud-warnings/<id>", () => {
    const { text } = buildFraudWarningEmail({
      ...BASE_OPTS,
      warningId: "issfr_TestXYZ",
      livemode: false,
    });
    const expected = "https://dashboard.stripe.com/test/radar/early-fraud-warnings/issfr_TestXYZ";
    assert.ok(text.includes(expected), `text should contain test URL:\n${text}`);
  });

  it("html body links to test radar/early-fraud-warnings/<id>", () => {
    const { html } = buildFraudWarningEmail({
      ...BASE_OPTS,
      warningId: "issfr_TestXYZ",
      livemode: false,
    });
    const expected = "https://dashboard.stripe.com/test/radar/early-fraud-warnings/issfr_TestXYZ";
    assert.ok(html.includes(expected), `html should contain test URL`);
  });
});

describe("buildFraudWarningEmail – dashboard URL uses the warning ID", () => {
  it("embeds the exact warningId in the URL (not the chargeId)", () => {
    const { text, html } = buildFraudWarningEmail({
      ...BASE_OPTS,
      warningId: "issfr_UniqueWarning99",
      chargeId: "ch_SomethingElse",
      livemode: true,
    });
    assert.ok(
      text.includes("issfr_UniqueWarning99"),
      "text URL must reference the warningId",
    );
    assert.ok(
      html.includes("issfr_UniqueWarning99"),
      "html URL must reference the warningId",
    );
    assert.ok(
      !text.includes(`/radar/early-fraud-warnings/ch_SomethingElse`),
      "URL path must use warningId, not chargeId",
    );
  });
});

describe("buildFraudWarningEmail – subject line", () => {
  it("includes 'Early fraud warning' and the formatted amount", () => {
    const { subject } = buildFraudWarningEmail({
      ...BASE_OPTS,
      amount: 4999,
      currency: "usd",
      livemode: true,
    });
    assert.match(subject, /early fraud warning/i, `subject should mention fraud warning: ${subject}`);
    assert.match(subject, /\$49\.99/, `subject should include formatted amount: ${subject}`);
  });
});
