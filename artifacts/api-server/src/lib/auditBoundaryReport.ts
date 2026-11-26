/**
 * @purpose Every start states whether the NCMEC audit ledger's privilege boundary holds, and a bad state raises an operational alert (Launch Phase 15, increment 5b; docs/plans/PLAN_PHASE15_5B_AUDIT_BOUNDARY.md, design item 3).
 *
 * Two moments:
 * - **Around migrations** — `runMigrationsReporting()`: before the runner, `ownershipDrift()`
 *   names any object in the application's schemas the connected role does not own (Replit's
 *   publish creates new tables as the database owner); if the runner then fails, the same
 *   diagnostic is logged and alerted beside the error, which is rethrown so the start aborts
 *   (Replit does not promote it; the previous release serves).
 * - **After `ensureSchema()`** — `reportAuditBoundary()`: one structured `[audit-boundary]`
 *   line, the `ncmecAuditBoundaryStatus()` object and the drift count. It is the production
 *   quote the plan's oracle asks for, read from the deployment log.
 *
 * In a published deployment, three outcomes raise the `audit_boundary` operational alert
 * (lib/operationalAlerts.ts, whose Sentry rule pushes to David's phone): the boundary
 * unenforced, non-zero drift, and a status query that itself fails ("unable to establish").
 * **None of them stops the start** (David, Q15 → 1): autoscale starts instances on demand,
 * so a gate on database state would turn a repairable permission slip into an outage. The
 * audit item does not count as done while such an alert stands.
 */
import * as Sentry from "@sentry/node";
import {
  ncmecAuditBoundaryStatus,
  ownershipDrift,
  type OwnershipDriftItem,
} from "@workspace/db";
import { isPublishedDeployment } from "@workspace/db/connection";
import { logger } from "./logger";
import { reportOperationalAlert } from "./operationalAlerts";

type BoundaryStatus = Awaited<ReturnType<typeof ncmecAuditBoundaryStatus>>;
type AlertDetail = Record<string, string | number | boolean | null>;

export interface AuditBoundaryReportDeps {
  status: () => Promise<BoundaryStatus>;
  drift: () => Promise<OwnershipDriftItem[]>;
  /** Raise the audit_boundary alert; resolves once it is sent (a failing start exits right after). */
  alert: (what: string, detail: AlertDetail) => Promise<void>;
  log: Pick<typeof logger, "info" | "warn" | "error">;
  isDeployment: boolean;
}

/** What each alert says, in its `what` detail, so the Sentry issue's events read plainly. */
export const AUDIT_BOUNDARY_ALERTS = {
  unenforced: "the NCMEC audit ledger's privilege boundary is NOT enforced",
  drift: "objects in the application's schemas are not owned by the application's login",
  unknown: "unable to establish the NCMEC audit ledger's privilege boundary",
  migrationFailed: "a migration failed; ownership diagnostic attached",
} as const;

const productionDeps = (): AuditBoundaryReportDeps => ({
  status: () => ncmecAuditBoundaryStatus(),
  drift: () => ownershipDrift(),
  alert: async (what, detail) => {
    reportOperationalAlert("audit_boundary", { what, ...detail });
    await Sentry.flush(2000).catch(() => false);
  },
  log: logger,
  isDeployment: isPublishedDeployment(),
});

/** At most this many drift items are named; the count is always exact. */
const DRIFT_NAMES_LOGGED = 50;

function driftSummary(items: OwnershipDriftItem[]) {
  return {
    ownershipDrift: items.length,
    driftObjects: items.slice(0, DRIFT_NAMES_LOGGED).map((i) => `${i.kind} ${i.name} (owner ${i.owner})`),
  };
}

/** An alert's detail holds flat values only (lib/operationalAlerts.ts). */
function driftDetail(items: OwnershipDriftItem[]): AlertDetail {
  const { ownershipDrift, driftObjects } = driftSummary(items);
  return { ownershipDrift, driftObjects: driftObjects.join("; ").slice(0, 2000) };
}

const errText = (err: unknown) => String((err as Error)?.message ?? err).slice(0, 500);

/**
 * Run the migrations, naming any object the app's login does not own first, and beside a
 * failure; the failure is logged, alerted in a deployment, and rethrown.
 */
export async function runMigrationsReporting(
  run: () => Promise<void>,
  deps: AuditBoundaryReportDeps = productionDeps(),
): Promise<void> {
  let before: OwnershipDriftItem[] | null = null;
  try {
    before = await deps.drift();
    if (before.length === 0) {
      deps.log.info({ ownershipDrift: 0 }, "[audit-boundary] before migrations: the application's login owns every application object");
    } else {
      // No alert here: a start that goes on to succeed alerts once from reportAuditBoundary.
      deps.log.warn(
        driftSummary(before),
        "[audit-boundary] before migrations: these objects are not owned by the application's login. A migration that alters them will fail; " +
          "the repair is docs/engineering/ncmec-audit-ledger-hardening.md, 'Repairing ownership after a publish'.",
      );
    }
  } catch (err) {
    deps.log.warn({ err }, "[audit-boundary] could not read object ownership before migrations");
  }

  try {
    await run();
  } catch (err) {
    deps.log.error(
      { err, ...(before ? driftSummary(before) : { ownershipDrift: "unknown" }) },
      "[audit-boundary] a migration failed. If it is a permission error on an object listed here, run the ownership repair " +
        "(docs/engineering/ncmec-audit-ledger-hardening.md, 'Repairing ownership after a publish') and publish again.",
    );
    if (deps.isDeployment) {
      await deps.alert(AUDIT_BOUNDARY_ALERTS.migrationFailed, {
        ...(before ? driftDetail(before) : { ownershipDrift: null }),
        error: errText(err),
      });
    }
    throw err;
  }
}

export interface AuditBoundaryOutcome {
  status: BoundaryStatus | null;
  ownershipDrift: number | null;
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
    const [status, items] = await Promise.all([deps.status(), deps.drift()]);
    const summary = driftSummary(items);
    const line = { auditBoundary: status, ...summary };
    if (status.boundaryEnforced && items.length === 0) deps.log.info(line, "[audit-boundary]");
    else deps.log[deps.isDeployment ? "error" : "warn"](line, "[audit-boundary]");

    if (!status.boundaryEnforced) {
      await raise(AUDIT_BOUNDARY_ALERTS.unenforced, {
        applicationRole: status.applicationRole,
        tableOwner: status.tableOwner,
        ...driftDetail(items),
      });
    }
    if (items.length > 0) await raise(AUDIT_BOUNDARY_ALERTS.drift, driftDetail(items));
    return { status, ownershipDrift: items.length, alerts };
  } catch (err) {
    deps.log.error({ err }, `[audit-boundary] ${AUDIT_BOUNDARY_ALERTS.unknown}`);
    await raise(AUDIT_BOUNDARY_ALERTS.unknown, { error: errText(err) });
    return { status: null, ownershipDrift: null, alerts };
  }
}
