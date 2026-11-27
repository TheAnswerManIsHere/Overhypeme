/**
 * @purpose Every start states the NCMEC audit ledger's protection as it is, and damage to that protection raises an operational alert (Launch Phase 15, 5c; docs/plans/PLAN_PHASE15_5C_OWNER_LOGIN.md, D2).
 *
 * After `ensureSchema()`, `reportAuditBoundary()` writes one structured `[audit-boundary]`
 * line carrying the full `ncmecAuditBoundaryStatus()` object, read from the deployment log.
 *
 * The app connects with the login Replit supplies, the database owner, which owns the
 * ledger. So `boundaryEnforced` reads false: David accepted that the ledger's guard is not
 * enforced against the application's own login (Q20 → 1, 2026-11-27). That accepted state
 * is logged at info and alerts nothing.
 *
 * What the guard itself depends on still alerts, in a published deployment, through the
 * `audit_boundary` operational alert (lib/operationalAlerts.ts, whose Sentry rule pushes to
 * David's phone):
 * - `triggersEnabled` false — a trigger dropped, disabled or rewired;
 * - `guardFunctionIntact` false — the guard function's body or definition changed;
 * - the status query failing ("unable to establish"), never read as the accepted state.
 *
 * None of them stops the start (Q15's reason holds): autoscale starts instances on demand,
 * and a gate on database state would turn a repairable change into an outage.
 */
import * as Sentry from "@sentry/node";
import { ncmecAuditBoundaryStatus } from "@workspace/db";
import { logger } from "./logger";
import { reportOperationalAlert } from "./operationalAlerts";

type BoundaryStatus = Awaited<ReturnType<typeof ncmecAuditBoundaryStatus>>;
type AlertDetail = Record<string, string | number | boolean | null>;

export interface AuditBoundaryReportDeps {
  status: () => Promise<BoundaryStatus>;
  /** Raise the audit_boundary alert; resolves once it is sent. */
  alert: (what: string, detail: AlertDetail) => Promise<void>;
  log: Pick<typeof logger, "info" | "error">;
  isDeployment: boolean;
}

/** What each alert says, in its `what` detail, so the Sentry issue's events read plainly. */
export const AUDIT_BOUNDARY_ALERTS = {
  guardDamaged: "the NCMEC audit ledger's append-only guard is damaged (a trigger or the guard function)",
  unknown: "unable to establish the NCMEC audit ledger's protection",
} as const;

const productionDeps = (): AuditBoundaryReportDeps => ({
  status: () => ncmecAuditBoundaryStatus(),
  alert: async (what, detail) => {
    reportOperationalAlert("audit_boundary", { what, ...detail });
    await Sentry.flush(2000).catch(() => false);
  },
  log: logger,
  isDeployment: process.env.REPLIT_DEPLOYMENT === "1",
});

const errText = (err: unknown) => String((err as Error)?.message ?? err).slice(0, 500);

export interface AuditBoundaryOutcome {
  status: BoundaryStatus | null;
  alerts: string[];
}

/** After `ensureSchema()`: the `[audit-boundary]` line, and the alerts. Never throws. */
export async function reportAuditBoundary(
  deps: AuditBoundaryReportDeps = productionDeps(),
): Promise<AuditBoundaryOutcome> {
  const alerts: string[] = [];
  const raise = async (what: string, detail: AlertDetail) => {
    if (!deps.isDeployment) return;
    alerts.push(what);
    await deps.alert(what, detail);
  };

  try {
    const status = await deps.status();
    const guardIntact = status.triggersEnabled && status.guardFunctionIntact;
    const line = { auditBoundary: status };
    if (guardIntact) {
      deps.log.info(line, "[audit-boundary]");
    } else {
      deps.log.error(line, `[audit-boundary] ${AUDIT_BOUNDARY_ALERTS.guardDamaged}`);
      await raise(AUDIT_BOUNDARY_ALERTS.guardDamaged, {
        triggersEnabled: status.triggersEnabled,
        guardFunctionIntact: status.guardFunctionIntact,
        applicationRole: status.applicationRole,
        tableOwner: status.tableOwner,
      });
    }
    return { status, alerts };
  } catch (err) {
    deps.log.error({ err }, `[audit-boundary] ${AUDIT_BOUNDARY_ALERTS.unknown}`);
    await raise(AUDIT_BOUNDARY_ALERTS.unknown, { error: errText(err) });
    return { status: null, alerts };
  }
}
