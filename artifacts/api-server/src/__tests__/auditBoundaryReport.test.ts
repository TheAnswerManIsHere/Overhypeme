/**
 * The start-up audit-boundary report (Launch Phase 15, 5c; lib/auditBoundaryReport.ts):
 * the accepted state — the app's login owns the ledger, guard intact — logs the truth at
 * info and alerts nothing (Q20 → 1). In a deployment a damaged guard (a trigger off, the
 * guard function changed) and a status query that fails each alert; none stops the start.
 * Outside a deployment nothing alerts. Pure: the database and the alert are injected.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  AUDIT_BOUNDARY_ALERTS,
  reportAuditBoundary,
  type AuditBoundaryReportDeps,
} from "../lib/auditBoundaryReport.js";

type Status = Awaited<ReturnType<AuditBoundaryReportDeps["status"]>>;

const status = (over: Partial<Status>) =>
  ({
    applicationRole: "neondb_owner",
    tableOwner: "neondb_owner",
    boundaryEnforced: false,
    triggersEnabled: true,
    guardFunctionIntact: true,
    ...over,
  }) as unknown as Status;

function harness(over: Partial<AuditBoundaryReportDeps>) {
  const alerts: Array<{ message: string; extra: Record<string, unknown> }> = [];
  const lines: Array<{ level: string; obj: unknown; msg: string }> = [];
  const log = {
    info: (obj: unknown, msg: string) => lines.push({ level: "info", obj, msg }),
    error: (obj: unknown, msg: string) => lines.push({ level: "error", obj, msg }),
  } as unknown as AuditBoundaryReportDeps["log"];
  const deps: AuditBoundaryReportDeps = {
    status: async () => status({}),
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
  it("the accepted state (owner login, guard intact) logs the full status at info and raises nothing", async () => {
    const accepted = status({});
    const h = harness({ status: async () => accepted });
    const out = await reportAuditBoundary(h.deps);
    assert.deepEqual(out.alerts, []);
    assert.deepEqual(h.alerts, []);
    assert.equal(h.lines.length, 1);
    assert.equal(h.lines[0]!.level, "info");
    assert.equal(h.lines[0]!.msg, "[audit-boundary]");
    const reported = (h.lines[0]!.obj as { auditBoundary: Status }).auditBoundary;
    assert.equal(reported, accepted, "the line carries the status as read, boundaryEnforced included");
    assert.equal(reported.boundaryEnforced, false);
  });

  for (const [what, damaged] of [
    ["a trigger disabled or dropped", { triggersEnabled: false }],
    ["the guard function changed", { guardFunctionIntact: false }],
  ] as const) {
    it(`${what} alerts in a deployment, and the start goes on`, async () => {
      const h = harness({ status: async () => status(damaged) });
      const out = await reportAuditBoundary(h.deps);
      assert.deepEqual(out.alerts, [AUDIT_BOUNDARY_ALERTS.guardDamaged]);
      assert.equal(h.alerts.length, 1);
      assert.equal(h.alerts[0]!.message, AUDIT_BOUNDARY_ALERTS.guardDamaged);
      assert.equal(h.lines[0]!.level, "error");
      assert.ok(out.status, "the status is still returned");
    });
  }

  it("a status query that fails alerts 'unable to establish', never read as the accepted state", async () => {
    const h = harness({ status: async () => Promise.reject(new Error("connection reset")) });
    const out = await reportAuditBoundary(h.deps);
    assert.equal(out.status, null);
    assert.deepEqual(out.alerts, [AUDIT_BOUNDARY_ALERTS.unknown]);
    assert.match(String(h.alerts[0]!.extra.error), /connection reset/);
  });

  it("outside a deployment nothing alerts, whatever the state", async () => {
    for (const s of [async () => status({ triggersEnabled: false }), async () => Promise.reject(new Error("x"))]) {
      const h = harness({ status: s as AuditBoundaryReportDeps["status"], isDeployment: false });
      const out = await reportAuditBoundary(h.deps);
      assert.deepEqual(out.alerts, []);
      assert.deepEqual(h.alerts, []);
    }
  });
});
