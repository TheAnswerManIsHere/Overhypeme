/**
 * Rendering tests for buildAbandonedEmailNotification.
 *
 * Covers the admin alert that fires when an outbox email is permanently
 * abandoned after exhausting all retry attempts. A regression here (e.g. a
 * wrong queue URL, missing outbox ID, or HTML-escaped recipient address)
 * would silently break a critical operational alert, so we pin down:
 *  - subject line includes the recipient address
 *  - the /admin/email-queue CTA URL appears in both plain-text and HTML bodies
 *  - the outbox ID and last error are present in both bodies
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

import {
  buildAbandonedEmailNotification,
  type AdminAbandonedEmailNotifyOpts,
} from "../lib/adminNotify.js";

const BASE_OPTS: AdminAbandonedEmailNotifyOpts = {
  outboxId: 4242,
  to: "user@example.com",
  subject: "Your weekly digest",
  lastError: "550 5.1.1 Recipient address rejected: User unknown",
};

const SITE_BASE_URL = "https://overhype.test";
let originalSiteBaseUrl: string | undefined;

before(() => {
  originalSiteBaseUrl = process.env.SITE_BASE_URL;
  process.env.SITE_BASE_URL = SITE_BASE_URL;
});

after(() => {
  if (originalSiteBaseUrl === undefined) {
    delete process.env.SITE_BASE_URL;
  } else {
    process.env.SITE_BASE_URL = originalSiteBaseUrl;
  }
});

describe("buildAbandonedEmailNotification – subject", () => {
  it("includes the recipient address", () => {
    const { subject } = buildAbandonedEmailNotification({
      ...BASE_OPTS,
      to: "alerts@customer.example",
    });
    assert.ok(
      subject.includes("alerts@customer.example"),
      `subject should include the recipient address: ${subject}`,
    );
  });

  it("flags the message as a permanent delivery failure", () => {
    const { subject } = buildAbandonedEmailNotification(BASE_OPTS);
    assert.match(
      subject,
      /failed permanently/i,
      `subject should signal permanent failure: ${subject}`,
    );
  });
});

describe("buildAbandonedEmailNotification – email queue CTA URL", () => {
  const expectedUrl = `${SITE_BASE_URL}/admin/email-queue`;

  it("appears in the plain-text body", () => {
    const { text } = buildAbandonedEmailNotification(BASE_OPTS);
    assert.ok(
      text.includes(expectedUrl),
      `text should contain the email queue URL (${expectedUrl}):\n${text}`,
    );
  });

  it("appears in the HTML body", () => {
    const { html } = buildAbandonedEmailNotification(BASE_OPTS);
    assert.ok(
      html.includes(expectedUrl),
      `html should contain the email queue URL (${expectedUrl})`,
    );
  });
});

describe("buildAbandonedEmailNotification – diagnostic fields", () => {
  it("includes the outbox ID in the plain-text body", () => {
    const { text } = buildAbandonedEmailNotification({
      ...BASE_OPTS,
      outboxId: 987654,
    });
    assert.ok(
      text.includes("987654"),
      `text should contain the outbox ID:\n${text}`,
    );
  });

  it("includes the outbox ID in the HTML body", () => {
    const { html } = buildAbandonedEmailNotification({
      ...BASE_OPTS,
      outboxId: 987654,
    });
    assert.ok(
      html.includes("987654"),
      "html should contain the outbox ID",
    );
  });

  it("includes the last error message in the plain-text body", () => {
    const { text } = buildAbandonedEmailNotification({
      ...BASE_OPTS,
      lastError: "421 4.7.0 Temporary failure, please try again later",
    });
    assert.ok(
      text.includes("421 4.7.0 Temporary failure, please try again later"),
      `text should contain the last error:\n${text}`,
    );
  });

  it("includes the last error message in the HTML body", () => {
    const { html } = buildAbandonedEmailNotification({
      ...BASE_OPTS,
      lastError: "421 4.7.0 Temporary failure, please try again later",
    });
    assert.ok(
      html.includes("421 4.7.0 Temporary failure, please try again later"),
      "html should contain the last error",
    );
  });
});
