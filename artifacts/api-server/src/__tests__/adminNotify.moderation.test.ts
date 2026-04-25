/**
 * Rendering tests for the moderation notification email builder.
 *
 * These tests pin down the per-type copy for `buildNotificationEmail`:
 *  - subject lines contain the distinguishing type label
 *  - the plain-text body opens with the matching headline and includes the submitter line
 *  - the review URL appears in both the text and HTML bodies
 *
 * If a future refactor accidentally collapses two types together or silently
 * changes a label, these assertions will fail loudly.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildNotificationEmail,
  type AdminNotifyType,
  type AdminNotifyOpts,
} from "../lib/adminNotify.js";

const BASE_OPTS: Omit<AdminNotifyOpts, "type"> = {
  submitterName: "Jane Doe",
  itemText: "This is the submitted content.",
  reviewUrl: "https://overhype.me/admin/moderation/item-42",
};

function build(overrides: Partial<AdminNotifyOpts> & { type: AdminNotifyType }) {
  return buildNotificationEmail({ ...BASE_OPTS, ...overrides });
}

describe("buildNotificationEmail – subject lines", () => {
  it("contains 'Fact Submission' for fact_review", () => {
    const { subject } = build({ type: "fact_review" });
    assert.match(
      subject,
      /Fact Submission/,
      `subject should contain 'Fact Submission': ${subject}`,
    );
  });

  it("contains 'Fact Submission (Grammar Review)' for fact_grammar", () => {
    const { subject } = build({ type: "fact_grammar" });
    assert.match(
      subject,
      /Fact Submission \(Grammar Review\)/,
      `subject should contain 'Fact Submission (Grammar Review)': ${subject}`,
    );
  });

  it("contains 'Comment' for comment", () => {
    const { subject } = build({ type: "comment" });
    assert.match(subject, /Comment/, `subject should contain 'Comment': ${subject}`);
  });

  it("emits a distinct subject line for every type", () => {
    const subjects = new Set([
      build({ type: "fact_review" }).subject,
      build({ type: "fact_grammar" }).subject,
      build({ type: "comment" }).subject,
    ]);
    assert.equal(subjects.size, 3, "each type must produce a unique subject");
  });
});

describe("buildNotificationEmail – plain-text body", () => {
  it("opens with the fact-submission headline for fact_review", () => {
    const { text } = build({ type: "fact_review" });
    assert.ok(
      text.startsWith("NEW FACT SUBMISSION NEEDS YOUR APPROVAL"),
      `text should start with the fact_review headline:\n${text}`,
    );
  });

  it("opens with the grammar-review headline for fact_grammar", () => {
    const { text } = build({ type: "fact_grammar" });
    assert.ok(
      text.startsWith("NEW FACT SUBMISSION (GRAMMAR REVIEW) NEEDS YOUR APPROVAL"),
      `text should start with the fact_grammar headline:\n${text}`,
    );
  });

  it("opens with the comment headline for comment", () => {
    const { text } = build({ type: "comment" });
    assert.ok(
      text.startsWith("NEW COMMENT NEEDS YOUR APPROVAL"),
      `text should start with the comment headline:\n${text}`,
    );
  });

  it("includes the submitter name for every type", () => {
    const TYPES: AdminNotifyType[] = ["fact_review", "fact_grammar", "comment"];
    for (const type of TYPES) {
      const { text } = build({ type });
      assert.ok(
        text.includes("Submitted by: Jane Doe"),
        `text for '${type}' should include the submitter line:\n${text}`,
      );
    }
  });
});

describe("buildNotificationEmail – review URL", () => {
  const TYPES: AdminNotifyType[] = ["fact_review", "fact_grammar", "comment"];
  const REVIEW_URL = BASE_OPTS.reviewUrl;

  for (const type of TYPES) {
    it(`includes the review URL in both text and HTML for ${type}`, () => {
      const { text, html } = build({ type });
      assert.ok(
        text.includes(REVIEW_URL),
        `text body for '${type}' should contain the review URL:\n${text}`,
      );
      assert.ok(
        html.includes(REVIEW_URL),
        `html body for '${type}' should contain the review URL`,
      );
    });
  }
});
