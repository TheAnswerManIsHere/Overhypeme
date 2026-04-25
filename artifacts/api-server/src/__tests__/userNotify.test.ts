/**
 * Unit tests for buildAccessRevokedEmail (Task #235).
 *
 * Locks in the user-facing copy that mirrors the in-app revocation banner and
 * verifies the security invariant that no Stripe identifiers, dispute IDs, or
 * billing amounts ever appear in either the plain-text or HTML body.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildAccessRevokedEmail,
  type AccessRevocationKind,
} from "../lib/userNotify.js";

const KINDS: AccessRevocationKind[] = ["refund", "dispute_opened", "dispute_lost"];

const SUPPORT_EMAIL = "overhypeme+support@gmail.com";

// Patterns that would indicate sensitive Stripe data has leaked into the
// email body. These should never appear in either the text or the HTML.
const STRIPE_LEAKAGE_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "stripe payment intent id", re: /\bpi_[a-zA-Z0-9]+/ },
  { name: "stripe dispute id", re: /\bdp_[a-zA-Z0-9]+/ },
  { name: "stripe charge id", re: /\bch_[a-zA-Z0-9]+/ },
  { name: "stripe customer id", re: /\bcus_[a-zA-Z0-9]+/ },
  { name: "stripe invoice id", re: /\bin_[a-zA-Z0-9]+/ },
  { name: "currency amount", re: /\$\s?\d/ },
  { name: "USD amount", re: /\d+\s*USD/i },
  { name: "cents amount", re: /\b\d{4,}\s*cents?\b/i },
];

describe("buildAccessRevokedEmail", () => {
  for (const kind of KINDS) {
    describe(kind, () => {
      const email = buildAccessRevokedEmail(kind);

      it("has a subject, plain text and html body", () => {
        assert.ok(email.subject.length > 0, "subject must be non-empty");
        assert.ok(email.text.length > 0, "text body must be non-empty");
        assert.ok(email.html.length > 0, "html body must be non-empty");
      });

      it("subject mentions Overhype.me and Legendary access", () => {
        assert.match(email.subject, /Overhype\.me/);
        assert.match(email.subject, /Legendary/);
      });

      it("includes the support contact email in both text and html", () => {
        assert.ok(
          email.text.includes(SUPPORT_EMAIL),
          "plain-text body must include support email",
        );
        assert.ok(
          email.html.includes(SUPPORT_EMAIL),
          "html body must include support email",
        );
        assert.match(
          email.html,
          new RegExp(`mailto:${SUPPORT_EMAIL.replace(/\+/g, "\\+")}`),
          "html body must contain a mailto: link to support",
        );
      });

      it("does not leak any Stripe identifiers or billing amounts", () => {
        for (const { name, re } of STRIPE_LEAKAGE_PATTERNS) {
          assert.equal(
            re.test(email.text),
            false,
            `text body must not contain ${name} (matched ${re})`,
          );
          assert.equal(
            re.test(email.html),
            false,
            `html body must not contain ${name} (matched ${re})`,
          );
        }
      });
    });
  }

  it("refund copy mirrors the in-app banner phrasing", () => {
    const { text } = buildAccessRevokedEmail("refund");
    assert.ok(
      text.includes("Your Legendary membership was refunded"),
      "refund body must mirror the banner copy",
    );
    assert.ok(
      text.includes("Legendary features are no longer available"),
      "refund body must mention loss of Legendary features",
    );
  });

  it("dispute_opened copy mirrors the in-app banner phrasing", () => {
    const { text } = buildAccessRevokedEmail("dispute_opened");
    assert.ok(
      text.includes("payment dispute was opened"),
      "dispute_opened body must mirror the banner copy",
    );
    assert.ok(
      text.includes("paused while the dispute is reviewed"),
      "dispute_opened body must mention the paused state",
    );
  });

  it("dispute_lost copy mirrors the in-app banner phrasing", () => {
    const { text } = buildAccessRevokedEmail("dispute_lost");
    assert.ok(
      text.includes("payment dispute"),
      "dispute_lost body must reference the payment dispute",
    );
    assert.ok(
      text.includes("Legendary features are no longer available"),
      "dispute_lost body must mention loss of Legendary features",
    );
  });

  it("renders distinct subjects for paused vs ended states", () => {
    const refund = buildAccessRevokedEmail("refund").subject;
    const opened = buildAccessRevokedEmail("dispute_opened").subject;
    const lost = buildAccessRevokedEmail("dispute_lost").subject;
    // Paused (dispute_opened) is meaningfully different from ended (refund/lost)
    assert.notEqual(opened, refund, "paused subject differs from refund subject");
    assert.notEqual(opened, lost, "paused subject differs from lost subject");
  });
});
