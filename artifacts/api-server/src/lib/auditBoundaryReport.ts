/**
 * @purpose Every start states whether the NCMEC audit ledger's privilege boundary holds, and a bad state raises an explicit Sentry alert (Launch Phase 15, increment 5b; docs/plans/PLAN_PHASE15_5B_AUDIT_BOUNDARY.md, design item 3).
 *
 * Three moments:
 * - **Before migrations** — `ownershipDrift()`: objects in the application's schemas the
 *   connected role does not own (Replit's publish creates new tables as the database
 *   owner). Logged by name, so a start that then dies on ownership has its cause in the log.
 * - **A migration fails** — the same diagnostic beside the error, then the error is
 *   rethrown and the start aborts (Replit does not promote it; the previous release serves).
 * - **After `ensureSchema()`** — one structured `[audit-boundary]` line: the
 *   `ncmecAuditBoundaryStatus()` object and the drift count. It is the production quote
 *   the plan's oracle asks for, read from the deployment log.
 *
 * In a published deployment, three outcomes raise a Sentry event through the SDK's own
 * capture call — the Pino logger does not forward to Sentry (`instrument.ts` configures no
 * log integration): the boundary unenforced, non-zero drift, and a status query that
 * itself fails ("unable to establish"). **None of them stops the start** (David, Q15 → 1):
 * autoscale starts instances on demand, so a gate on database state would turn a
 * repairable permission slip into an outage. The audit item does not count as done while
 * such an alert stands.
 */
import * as Sentry from "@sentry/node";
import {
  ncmecAuditBoundaryStatus,
  ownershipDrift,
  type OwnershipDriftItem,
} from "@workspace/db";
import { logger } from "./logger";

type BoundaryStatus = Awaited<ReturnType<typeof ncmecAuditBoundaryStatus>>;

export interface AuditBoundaryReportDeps {
  status: () => Promise<BoundaryStatus>;
  drift: () => Promise<OwnershipDriftItem[]>;
  /** Raise one Sentry event; resolves once it is flushed (a failing start exits right after). */
  alert: (message: string, extra: Record<string, unknown>) => Promise<void>;
  log: Pick<typeof logger, "info" | "warn" | "error">;
  isDeployment: boolean;
}

/** The alert messages, fixed so a Sentry search finds every occurrence. */
export const AUDIT_BOUNDARY_ALERTS = {
  unenforced: "[audit-boundary] the NCMEC audit ledger's privilege boundary is NOT enforced",
  drift: "[audit-boundary] objects in the application's schemas are not owned by the application's login",
  unknown: "[audit-boundary] unable to establish the NCMEC audit ledger's privilege boundary",
  migrationFailed: "[audit-boundary] a migration failed; ownership diagnostic attached",
} as const;

const productionDeps = (): AuditBoundaryReportDeps => ({
  status: () => ncmecAuditBoundaryStatus(),
  drift: () => ownershipDrift(),
  alert: async (message, extra) => {
    Sentry.captureMessage(message, { level: "error", extra });
    await Sentry.flush(2000).catch(() => false);
  },
  log: logger,
  isDeployment: process.env.REPLIT_DEPLOYMENT === "1",
});

/** At most this many drift items are logged by name; the count is always exact. */
const DRIFT_NAMES_LOGGED = 50;

function driftSummary(items: OwnershipDriftItem[]) {
  return {
    ownershipDrift: items.length,
    driftObjects: items.slice(0, DRIFT_NAMES_LOGGED).map((i) => `${i.kind} ${i.name} (owner ${i.owner})`),
  };
}

/** Before migrations: name any object the connected login does not own, in the log. Never throws. */
export async function reportOwnershipBeforeMigrations(
  deps: AuditBoundaryReportDeps = productionDeps(),
): Promise<OwnershipDriftItem[] | null> {
  let items: OwnershipDriftItem[];
  try {
    items = await deps.drift();
  } catch (err) {
    deps.log.warn({ err }, "[audit-boundary] could not read object ownership before migrations");
    return null;
  }
  if (items.length === 0) {
    deps.log.info({ ownershipDrift: 0 }, "[audit-boundary] before migrations: the application's login owns every application object");
    return items;
  }
  const summary = driftSummary(items);
  deps.log.warn(
    summary,
    "[audit-boundary] before migrations: these objects are not owned by the application's login. A migration that alters them will fail; " +
      "the repair is docs/engineering/ncmec-audit-ledger-hardening.md, 'Repairing ownership after a publish'.",
  );
  // No alert here: a start that goes on to succeed alerts once from reportAuditBoundary,
  // and one that fails alerts from runMigrationsWithDiagnosis.
  return items;
}

/** Run the migrations; on failure, log and alert the ownership diagnostic beside the error, then rethrow. */
export async function runMigrationsWithDiagnosis(
  run: () => Promise<void>,
  deps: AuditBoundaryReportDeps = productionDeps(),
): Promise<void> {
  try {
    await run();
  } catch (err) {
    let summary: ReturnType<typeof driftSummary> | { ownershipDrift: "unknown" };
    try {
      summary = driftSummary(await deps.drift());
    } catch {
      summary = { ownershipDrift: "unknown" };
    }
    deps.log.error(
      { err, ...summary },
      "[audit-boundary] a migration failed. If it is a permission error on an object listed here, run the ownership repair " +
        "(docs/engineering/ncmec-audit-ledger-hardening.md, 'Repairing ownership after a publish') and publish again.",
    );
    if (deps.isDeployment) {
      await deps.alert(AUDIT_BOUNDARY_ALERTS.migrationFailed, {
        ...summary,
        error: String((err as Error)?.message ?? err).slice(0, 500),
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
  let status: BoundaryStatus | null = null;
  let items: OwnershipDriftItem[] | null = null;
  let failure: unknown = null;
  try {
    status = await deps.status();
    items = await deps.drift();
  } catch (err) {
    failure = err;
  }

  if (failure || !status || !items) {
    deps.log.error({ err: failure }, AUDIT_BOUNDARY_ALERTS.unknown);
    if (deps.isDeployment) {
      alerts.push(AUDIT_BOUNDARY_ALERTS.unknown);
      await deps.alert(AUDIT_BOUNDARY_ALERTS.unknown, { error: String((failure as Error)?.message ?? failure).slice(0, 500) });
    }
    return { status, ownershipDrift: items ? items.length : null, alerts };
  }

  const summary = driftSummary(items);
  const line = { auditBoundary: status, ...summary };
  const healthy = status.boundaryEnforced && items.length === 0;
  if (healthy) deps.log.info(line, "[audit-boundary]");
  else deps.log[deps.isDeployment ? "error" : "warn"](line, "[audit-boundary]");

  if (deps.isDeployment) {
    if (!status.boundaryEnforced) {
      alerts.push(AUDIT_BOUNDARY_ALERTS.unenforced);
      await deps.alert(AUDIT_BOUNDARY_ALERTS.unenforced, { ...line });
    }
    if (items.length > 0) {
      alerts.push(AUDIT_BOUNDARY_ALERTS.drift);
      await deps.alert(AUDIT_BOUNDARY_ALERTS.drift, { ...summary, when: "after start-up" });
    }
  }
  return { status, ownershipDrift: items.length, alerts };
}
