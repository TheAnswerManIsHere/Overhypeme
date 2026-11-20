/**
 * A reading's source links come from the AI, which reads text a stranger
 * submitted: only ordinary web addresses survive the schema, and one bad link
 * drops that link, never the paid reading (Issue #1018, carried from PR #1041's
 * build report).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { factReadingResultSchema, isWebUrl } from "@workspace/api-zod";

describe("a reading's source links", () => {
  it("accepts http and https addresses only", () => {
    for (const ok of ["https://en.wikipedia.org/wiki/Shark_Week", "http://example.com", "HTTPS://Example.com/a?b=c#d"]) assert.equal(isWebUrl(ok), true, ok);
    for (const bad of ["javascript:alert(1)", "data:text/html,<b>x</b>", "ftp://example.com", "example.com", "https://", "https://exa mple.com", ""]) assert.equal(isWebUrl(bad), false, bad);
  });

  it("drops a non-web link and keeps the reading and its other links", () => {
    const parsed = factReadingResultSchema.safeParse({
      humorNote: "Sharks watch Alex.",
      references: [{
        phrase: "Shark Week", meaning: "Annual shark programming.", pictureImplication: "Sharks as the audience.",
        sources: [{ title: "Bad", url: "javascript:alert(1)" }, { title: "Good", url: "https://en.wikipedia.org/wiki/Shark_Week" }],
      }],
    });
    assert.equal(parsed.success, true);
    assert.deepEqual(parsed.success && parsed.data.references[0]!.sources.map((s) => s.title), ["Good"]);
  });
});
