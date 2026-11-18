/**
 * The retention schedule (launch Phase 14, increment 6;
 * `@workspace/db/retention-schedule`) names every table, and every job it
 * relies on exists in the daily maintenance run.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RETENTION_SCHEDULE, ACCOUNT_PURGE } from "@workspace/db/retention-schedule";
import { TABLE_CLASSIFICATION } from "@workspace/db/table-classification";
import { MAINTENANCE_JOB_NAMES } from "../lib/maintenance.js";
import { SEARCH_HISTORY_RETENTION_DAYS, GENERATION_COST_RETENTION_MONTHS, WEBHOOK_AUDIT_RETENTION_DAYS } from "../lib/dataLifecycle.js";
import { DELETION_COOLING_OFF_DAYS, NEVER_ONBOARDED_AFTER_DAYS } from "../lib/accountDeletion.js";

describe("the retention schedule", () => {
  it("names exactly the tables the schema has (the classification is held to the live database by its own test)", () => {
    assert.deepEqual(Object.keys(RETENTION_SCHEDULE).sort(), Object.keys(TABLE_CLASSIFICATION).sort());
  });

  it("every job it names is in the daily maintenance run", () => {
    const jobs = new Set<string>(MAINTENANCE_JOB_NAMES);
    for (const [table, entry] of Object.entries(RETENTION_SCHEDULE)) {
      for (const rule of entry.rules) {
        if (rule.kind === "job") assert.ok(jobs.has(rule.job), `${table} names job "${rule.job}", which the maintenance run does not have`);
      }
    }
  });

  it("every parent it names is a table it also names", () => {
    for (const [table, entry] of Object.entries(RETENTION_SCHEDULE)) {
      for (const rule of entry.rules) {
        if (rule.kind === "with-parent") assert.ok(rule.parent in RETENTION_SCHEDULE, `${table}'s parent ${rule.parent} is not in the schedule`);
      }
    }
  });

  it("every table has at least one rule, and every gap says what closes it", () => {
    for (const [table, entry] of Object.entries(RETENTION_SCHEDULE)) {
      assert.ok(entry.rules.length > 0, `${table} has no rule`);
      for (const rule of entry.rules) if (rule.kind === "gap") assert.ok(rule.closeBy.length > 20, `${table}'s gap names no remedy`);
    }
  });

  it("the search-history window it states is the one the job uses", () => {
    const rule = RETENTION_SCHEDULE.search_history!.rules.find((r) => r.kind === "job");
    assert.ok(rule && rule.kind === "job" && rule.window === `${SEARCH_HISTORY_RETENTION_DAYS} days`);
  });

  it("the account purge's timing it states is the deletion engine's", () => {
    assert.equal(ACCOUNT_PURGE.coolingOffDays, DELETION_COOLING_OFF_DAYS);
    assert.equal(ACCOUNT_PURGE.unfinishedSignUpAfterDays, NEVER_ONBOARDED_AFTER_DAYS);
    const rule = RETENTION_SCHEDULE.users!.rules.find((r) => r.kind === "job");
    assert.ok(rule && rule.kind === "job" && rule.job === "account-deletion");
  });

  it("the windows it states for picture costs and webhook audit rows are the ones the job uses (Q15)", () => {
    const window = (table: string) => {
      const rule = RETENTION_SCHEDULE[table]!.rules.find((r) => r.kind === "job");
      return rule && rule.kind === "job" ? `${rule.job}: ${rule.window}` : undefined;
    };
    assert.equal(window("user_generation_costs"), `retention-windows: ${GENERATION_COST_RETENTION_MONTHS} months`);
    assert.equal(window("stripe_webhook_audit"), `retention-windows: ${WEBHOOK_AUDIT_RETENTION_DAYS} days`);
    assert.equal(window("stripe_processed_events"), `retention-windows: ${WEBHOOK_AUDIT_RETENTION_DAYS} days`, "Q18");
  });
});
