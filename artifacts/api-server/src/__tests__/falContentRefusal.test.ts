/**
 * Issue #985: a render the image model refuses on content grounds read only
 * "fal submit failed: Unprocessable Entity", which does not tell a moderator
 * that the model refused the picture. These tests pin the classification of
 * fal's content-policy refusal, and the message the attempt records for it.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ApiError, ValidationError } from "@fal-ai/client";
import { falContentRefusal, falSubmitErrorMessage } from "../lib/falClient.js";

// The body fal returned for attempt 328 (request 01a1e6f2-a536-…), trimmed.
const REFUSAL_BODY = {
  detail: [
    {
      loc: ["body", "prompt"],
      msg: "The content could not be processed because it contained material flagged by a content checker.",
      type: "content_policy_violation",
      url: "https://docs.fal.ai/errors#content_policy_violation",
    },
  ],
};

describe("falContentRefusal", () => {
  it("recognises fal's 422 content_policy_violation and returns its reason", () => {
    const err = new ValidationError({ message: "Unprocessable Entity", status: 422, body: REFUSAL_BODY });
    assert.equal(
      falContentRefusal(err),
      "The content could not be processed because it contained material flagged by a content checker.",
    );
  });

  it("does not treat an ordinary validation error as a refusal", () => {
    const err = new ValidationError({
      message: "Unprocessable Entity",
      status: 422,
      body: { detail: [{ loc: ["body", "image_size"], msg: "bad size", type: "value_error" }] },
    });
    assert.equal(falContentRefusal(err), null);
  });

  it("does not treat other failures as a refusal", () => {
    assert.equal(falContentRefusal(new ApiError({ message: "Internal Server Error", status: 500, body: {} })), null);
    assert.equal(falContentRefusal(new Error("socket hang up")), null);
    assert.equal(falContentRefusal("nope"), null);
  });
});

describe("falSubmitErrorMessage", () => {
  it("names the engine and the content refusal, as a sentence", () => {
    const err = new ValidationError({ message: "Unprocessable Entity", status: 422, body: REFUSAL_BODY });
    const msg = falSubmitErrorMessage(err, "GPT Image 2.6 Sunburst (edit)");
    assert.doesNotMatch(msg, /^fal submit failed/, "a sentence, not the old prefix (Issue #1020)");
    assert.match(msg, /GPT Image 2\.6 Sunburst \(edit\) refused this picture under its content policy/);
    assert.match(msg, /flagged by a content checker/);
    assert.doesNotMatch(msg, /Unprocessable Entity/);
  });

  it("says the image service could not draw it, with its detail, for any other failure", () => {
    assert.equal(falSubmitErrorMessage(new Error("socket hang up"), "X"), "the image service could not draw this picture (socket hang up)");
    assert.equal(falSubmitErrorMessage("boom", "X"), "the image service could not draw this picture (boom)");
  });
});
