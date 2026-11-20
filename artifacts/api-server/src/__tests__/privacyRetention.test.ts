/**
 * The Privacy page's retention table (launch Phase 14, increment 6b) is
 * rendered from `@workspace/db/privacy-retention`. These hold that every
 * store of personal data has a row, every row names stores that exist, and
 * the numbers it states match the constants that enforce them.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { RETENTION_SCHEDULE } from "@workspace/db/retention-schedule";
import { PRIVACY_RETENTION_ROWS, OFF_DATABASE_STORES, renderPrivacyRetentionTable } from "@workspace/db/privacy-retention";
import { SEARCH_HISTORY_RETENTION_DAYS, GENERATION_COST_RETENTION_MONTHS, WEBHOOK_AUDIT_RETENTION_DAYS } from "../lib/dataLifecycle.js";
import { DELETION_COOLING_OFF_DAYS, NEVER_ONBOARDED_AFTER_DAYS } from "../lib/accountDeletion.js";
import { GENERATED_OUTPUT_EXPIRY_SECONDS } from "../lib/falRetention.js";
import { CLASSIFIER_UPLOAD_LIFECYCLE } from "../lib/moderation/nsfwClassifier.js";

const covered = new Set(PRIVACY_RETENTION_ROWS.flatMap((r) => r.covers));
const row = (information: string) => {
  const r = PRIVACY_RETENTION_ROWS.find((x) => x.information === information);
  assert.ok(r, `no row "${information}"`);
  return r!.howLong;
};

describe("the Privacy page's retention table", () => {
  it("every database table holding personal data has a row", () => {
    const missing = Object.entries(RETENTION_SCHEDULE).filter(([t, e]) => e.personal !== null && !covered.has(t)).map(([t]) => t);
    assert.deepEqual(missing, [], `tables with personal data and no Privacy row: ${missing.join(", ")}`);
  });

  it("every store outside the database has a row", () => {
    const missing = Object.keys(OFF_DATABASE_STORES).filter((s) => !covered.has(s));
    assert.deepEqual(missing, []);
  });

  it("every row names only tables or stores that exist", () => {
    for (const r of PRIVACY_RETENTION_ROWS) {
      for (const c of r.covers) assert.ok(c in RETENTION_SCHEDULE || c in OFF_DATABASE_STORES, `"${r.information}" names unknown store ${c}`);
    }
  });

  it("the periods it states are the ones the code enforces", () => {
    assert.match(row("Your account"), new RegExp(`${DELETION_COOLING_OFF_DAYS} days after you ask`));
    assert.match(row("An account that never finished signing up"), new RegExp(`${NEVER_ONBOARDED_AFTER_DAYS} days old.*${DELETION_COOLING_OFF_DAYS} days later`));
    assert.equal(row("Your searches"), `${SEARCH_HISTORY_RETENTION_DAYS} days`);
    assert.match(row("What your pictures cost us"), new RegExp(`^${GENERATION_COST_RETENTION_MONTHS} months`));
    assert.match(row("Payment records"), new RegExp(`kept ${WEBHOOK_AUDIT_RETENTION_DAYS} days`));
    assert.match(row("Emails we send you"), /30 days after it was queued, except an alert to our staff/);
    assert.match(row("Abuse limits (your IP address, account, session or an email address you entered)"), /at most a day/);
    for (const r of ["Photos, memes and pictures you delete", "Your photos, memes and pictures when your account is deleted"]) {
      assert.doesNotMatch(row(r), /after they were made/, "backup retention is measured from removal, not from the copy");
    }
    assert.match(row("Photos, memes and pictures you delete"), /latest complete backup is kept until a newer one replaces it/);
    assert.match(row("Pictures made by AI, at fal.ai"), new RegExp(`each picture ${GENERATED_OUTPUT_EXPIRY_SECONDS / 86400} days`));
    assert.equal(CLASSIFIER_UPLOAD_LIFECYCLE.expiresIn, "1h");
    assert.match(row("Your photo, when we check it for safety at upload"), /within an hour/);
  });

  it("the published Privacy text carries exactly this table", async () => {
    const md = await readFile(new URL("../../../../docs/legal/privacy.md", import.meta.url), "utf8");
    assert.match(md, /^\{\{retention-table\}\}$/m, "privacy.md renders the table from the schedule, not by hand");
    const generated = await readFile(new URL("../../../overhype-me/src/generated/legal/privacy.ts", import.meta.url), "utf8");
    for (const r of PRIVACY_RETENTION_ROWS) assert.ok(generated.includes(r.information.replace(/"/g, "&#x22;").split(" (")[0]!.slice(0, 20)), `generated page lacks "${r.information}"`);
    assert.ok(renderPrivacyRetentionTable().startsWith("| Information | How long |"));
  });
});

describe("the table's cell escaping", () => {
  it("escapes a backslash before a pipe, and folds line breaks", () => {
    const md = renderPrivacyRetentionTable([{ information: "a\\|b", howLong: "x|y\r\nz", covers: [] }]);
    assert.equal(md.split("\n")[2], "| a\\\\\\|b | x\\|y z |");
  });
});
