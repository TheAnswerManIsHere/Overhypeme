/**
 * The start-up audit-boundary report (Launch Phase 15, 5b; lib/auditBoundaryReport.ts):
 * in a deployment, an unenforced boundary, ownership drift and a status query that fails
 * each raise an explicit alert; none of them stops the start (Q15 → 1); outside a
 * deployment nothing alerts; a failing migration gets the ownership diagnostic beside it
 * and is rethrown. Pure: the database and the alert are injected (in production the
 * alert is lib/operationalAlerts.ts's audit_boundary source).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  AUDIT_BOUNDARY_ALERTS,
  reportAuditBoundary,
  runMigrationsReporting,
  type AuditBoundaryReportDeps,
} from "../lib/auditBoundaryReport.js";

type Status = Awaited<ReturnType<AuditBoundaryReportDeps["status"]>>;

const enforced = { applicationRole: "overhype_app", boundaryEnforced: true } as unknown as Status;
const unenforced = { applicationRole: "neondb_owner", boundaryEnforced: false } as unknown as Status;
const drifted = [{ kind: "relation" as const, name: "public.new_table", owner: "neondb_owner" }];

function harness(over: Partial<AuditBoundaryReportDeps>) {
  const alerts: Array<{ message: string; extra: Record<string, unknown> }> = [];
  const lines: Array<{ level: string; obj: unknown; msg: string }> = [];
  const log = {
    info: (obj: unknown, msg: string) => lines.push({ level: "info", obj, msg }),
    warn: (obj: unknown, msg: string) => lines.push({ level: "warn", obj, msg }),
    error: (obj: unknown, msg: string) => lines.push({ level: "error", obj, msg }),
  } as unknown as AuditBoundaryReportDeps["log"];
  const deps: AuditBoundaryReportDeps = {
    status: async () => enforced,
    drift: async () => [],
    alert: async (message, extra) => {
      alerts.push({ message, extra });
    },
    log,
    isDeployment: true,
    ...over,
  };
  return { deps, alerts, lines };
}

describe("reportAuditBoundary", () => {
  it("a healthy deployment logs one [audit-boundary] line and raises nothing", async () => {
    const h = harness({});
    const out = await reportAuditBoundary(h.deps);
    assert.deepEqual(out.alerts, []);
    assert.deepEqual(h.alerts, []);
    const line = h.lines.find((l) => l.msg === "[audit-boundary]");
    assert.equal(line?.level, "info");
    assert.deepEqual((line?.obj as { auditBoundary: Status }).auditBoundary, enforced);
    assert.equal((line?.obj as { ownershipDrift: number }).ownershipDrift, 0);
  });

  it("an unenforced boundary alerts, and the start goes on", async () => {
    const h = harness({ status: async () => unenforced });
    const out = await reportAuditBoundary(h.deps);
    assert.deepEqual(h.alerts.map((a) => a.message), [AUDIT_BOUNDARY_ALERTS.unenforced]);
    assert.deepEqual(out.alerts, [AUDIT_BOUNDARY_ALERTS.unenforced]);
  });

  it("ownership drift alerts, naming the objects", async () => {
    const h = harness({ drift: async () => drifted });
    await reportAuditBoundary(h.deps);
    assert.deepEqual(h.alerts.map((a) => a.message), [AUDIT_BOUNDARY_ALERTS.drift]);
    assert.equal(h.alerts[0]!.extra.driftObjects, "relation public.new_table (owner neondb_owner)");
    assert.equal(h.alerts[0]!.extra.ownershipDrift, 1);
  });

  it("a status query that fails alerts as 'unable to establish', and does not throw", async () => {
    const h = harness({ status: async () => Promise.reject(new Error("connection reset")) });
    const out = await reportAuditBoundary(h.deps);
    assert.deepEqual(h.alerts.map((a) => a.message), [AUDIT_BOUNDARY_ALERTS.unknown]);
    assert.equal(out.status, null);
  });

  it("outside a deployment nothing alerts, whatever the state", async () => {
    for (const over of [
      { status: async () => unenforced },
      { drift: async () => drifted },
      { status: async () => Promise.reject(new Error("x")) },
    ]) {
      const h = harness({ ...over, isDeployment: false });
      await reportAuditBoundary(h.deps);
      assert.deepEqual(h.alerts, []);
    }
  });
});

describe("runMigrationsReporting", () => {
  it("names drift before the run in the log, without alerting", async () => {
    const h = harness({ drift: async () => drifted });
    await runMigrationsReporting(async () => {}, h.deps);
    assert.deepEqual(h.alerts, []);
    assert.ok(h.lines.some((l) => l.level === "warn" && /not owned by the application's login/.test(l.msg)));
  });

  it("goes on to run the migrations when the ownership read itself fails", async () => {
    const h = harness({ drift: async () => Promise.reject(new Error("x")) });
    let ran = false;
    await runMigrationsReporting(async () => {
      ran = true;
    }, h.deps);
    assert.ok(ran);
  });

  it("rethrows a failing migration with the ownership diagnostic logged and alerted beside it", async () => {
    const h = harness({ drift: async () => drifted });
    const failure = new Error("must be owner of table new_table");
    await assert.rejects(runMigrationsReporting(async () => Promise.reject(failure), h.deps), (err) => err === failure);
    const line = h.lines.find((l) => l.level === "error");
    assert.match(line!.msg, /a migration failed/);
    assert.equal((line!.obj as { ownershipDrift: number }).ownershipDrift, 1);
    assert.deepEqual(h.alerts.map((a) => a.message), [AUDIT_BOUNDARY_ALERTS.migrationFailed]);
  });

  it("passes a successful run through untouched", async () => {
    const h = harness({});
    let ran = false;
    await runMigrationsReporting(async () => {
      ran = true;
    }, h.deps);
    assert.ok(ran);
    assert.deepEqual(h.alerts, []);
  });
});
