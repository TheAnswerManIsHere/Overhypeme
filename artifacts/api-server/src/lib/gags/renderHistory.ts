/**
 * @purpose A gag's render history: every render drawn for it, newest first and paged, each with its full record — who, the gag as drawn, which picture and reference, the engine and the exact prompt, the outcome, whether it was approved, and what fal billed.
 * @subsystem visual-pipeline
 *
 * Plan docs/plans/PLAN_RENDER_HISTORY.md D1, D4 and D5 (Issue #1304). Read
 * only; renders are already kept (no server code deleted them before D6), so
 * the history is a view over stored renders. Removed gags keep their history,
 * grouped by the gag's own id, never its slot.
 *
 * Approval (D4; David, Q51; Astra C1): "approved" when the render is, or was,
 * a pick — a current pick of the gag at either stage, a retained pick on the
 * gag's legacy columns, or a `gag_render_approval` record naming it. With no
 * such evidence, a render drawn before every approval was recorded with its
 * pick (the release boundary, lib/renderApprovalAudit.ts) reads "not
 * recorded"; one drawn after it, "not approved".
 */
import { and, desc, eq, inArray, isNotNull, lt, or, sql } from "drizzle-orm";
import {
  db,
  adminActionsTable,
  factGagExamplesTable,
  factGagsTable,
  imageGenerationRequestsTable,
  imagePromptAttemptsTable,
  usersTable,
  type ImagePromptAttempt,
} from "@workspace/db";
import {
  GAG_EXAMPLE_KINDS,
  SCENARIO_FOR_KIND,
  kindForScenario,
  type RemovedGagHistory,
  type RenderApproval,
  type RenderCost,
  type RenderHistoryEntry,
  type RenderHistoryPage,
  type RenderRequestRecord,
  type RenderRole,
} from "@workspace/api-zod";
import { deriveScenarioStatus } from "../factRenderScenarios";
import { buildRenderStatusPayload } from "../imagePromptAttempts";
import { switchedFallbackOf } from "../engineFallback";
import { renderProgressByAttempt } from "../renderProgress";
import { gagRenderImageUrl } from "../reviewRenderScenarios";
import { renderApprovalAuditBoundary } from "../renderApprovalAudit";
import { billingKeySet } from "../renderBilling";
import { drewGagOf } from "./gagStore";
import { loadGagExamples } from "./examples";
import { normaliseGagContent } from "./resolver";

/** Entries on one page (D3: 50 at a time, with "Load older"). */
export const HISTORY_PAGE_SIZE = 50;

/** The paging cursor: the last entry's time and id, so renders made in one instant still page in order. */
function encodeCursor(a: { createdAt: Date; id: number }): string {
  return `${a.createdAt.toISOString()}|${a.id}`;
}
export function decodeCursor(raw: string | undefined): { at: Date; id: number } | null {
  if (!raw) return null;
  const [at, id] = raw.split("|");
  const when = new Date(at ?? "");
  const n = Number(id);
  return Number.isNaN(when.getTime()) || !Number.isInteger(n) ? null : { at: when, id: n };
}

/** The roles each render of a gag holds now (D1), by attempt id. */
async function rolesOf(gagId: number): Promise<Map<number, RenderRole[]>> {
  const keys = GAG_EXAMPLE_KINDS.map((k) => SCENARIO_FOR_KIND[k]);
  const [set, newest] = await Promise.all([
    loadGagExamples(gagId),
    db.selectDistinctOn([imagePromptAttemptsTable.reviewRenderScenarioKey], { id: imagePromptAttemptsTable.id })
      .from(imagePromptAttemptsTable)
      .where(and(eq(imagePromptAttemptsTable.gagId, gagId), inArray(imagePromptAttemptsTable.reviewRenderScenarioKey, keys)))
      .orderBy(imagePromptAttemptsTable.reviewRenderScenarioKey, desc(imagePromptAttemptsTable.createdAt), desc(imagePromptAttemptsTable.id)),
  ]);
  const out = new Map<number, RenderRole[]>();
  const add = (id: number, role: RenderRole) => out.set(id, [...(out.get(id) ?? []), role]);
  for (const kind of GAG_EXAMPLE_KINDS) {
    const live = set.approved[kind]?.attemptId;
    const next = set.pending[kind]?.attemptId;
    if (live != null) add(live, "live");
    if (next != null && next !== live) add(next, "approved_next");
  }
  for (const r of newest) add(r.id, "working");
  return out;
}

/** Which of these renders were ever approved, by the evidence D4 names. */
async function approvedIds(gagId: number, ids: number[]): Promise<Set<number>> {
  if (ids.length === 0) return new Set();
  const [picks, legacy, records] = await Promise.all([
    db.select({ id: factGagExamplesTable.attemptId }).from(factGagExamplesTable)
      .where(inArray(factGagExamplesTable.attemptId, ids)),
    db.select({ a: factGagsTable.approvedExampleAttemptId, p: factGagsTable.pendingExampleAttemptId }).from(factGagsTable)
      .where(eq(factGagsTable.id, gagId)),
    db.select({ id: sql<string>`${adminActionsTable.detail} ->> 'attemptId'` }).from(adminActionsTable)
      .where(and(
        eq(adminActionsTable.action, "gag_render_approval"),
        inArray(sql`(${adminActionsTable.detail} ->> 'attemptId')`, ids.map(String)),
      )),
  ]);
  const out = new Set<number>();
  for (const r of picks) out.add(r.id);
  for (const r of legacy) for (const v of [r.a, r.p]) if (v != null) out.add(Number(v));
  for (const r of records) out.add(Number(r.id));
  return out;
}

/** A render's cost from its requests' stored bills (D5); no fal call. */
export function costOf(requests: { vendorRequestId: string | null; billedUsd: string | null; billingCheckedAt: Date | null }[], keySet: boolean): RenderCost {
  const sent = requests.filter((r) => r.vendorRequestId != null);
  if (sent.length === 0) return { state: "never_sent" };
  const billed = sent.filter((r) => r.billedUsd != null);
  if (billed.length > 0) {
    const usd = billed.reduce((sum, r) => sum + Number(r.billedUsd), 0);
    return { state: "billed", usd: Math.round(usd * 10_000) / 10_000, unbilledRequests: sent.length - billed.length };
  }
  if (!keySet) return { state: "billing_key_not_set" };
  return sent.some((r) => r.billingCheckedAt == null) ? { state: "not_checked" } : { state: "no_bill_found" };
}

export function approvalOf(attempt: { id: number; createdAt: Date }, approved: Set<number>, boundary: Date | null): RenderApproval {
  if (approved.has(attempt.id)) return "approved";
  return boundary != null && attempt.createdAt >= boundary ? "not_approved" : "not_recorded";
}

function adminOf(a: ImagePromptAttempt): string | null {
  return (a.renderControls as { reviewAudit?: { adminUserId?: string } } | null)?.reviewAudit?.adminUserId ?? null;
}

/**
 * One page of a gag's history, newest first. Only renders of this fact are
 * read, so a gag id from another fact reads nothing.
 */
export async function gagRenderHistory(factId: number, gagId: number, before?: string): Promise<RenderHistoryPage> {
  const cursor = decodeCursor(before);
  const a = imagePromptAttemptsTable;
  const rows = await db.select().from(a)
    .where(and(
      eq(a.factId, factId),
      eq(a.gagId, gagId),
      cursor ? or(lt(a.createdAt, cursor.at), and(eq(a.createdAt, cursor.at), lt(a.id, cursor.id))) : undefined,
    ))
    .orderBy(desc(a.createdAt), desc(a.id))
    .limit(HISTORY_PAGE_SIZE + 1);
  const page = rows.slice(0, HISTORY_PAGE_SIZE);
  const ids = page.map((r) => r.id);
  const adminIds = [...new Set(page.map(adminOf).filter((v): v is string => v != null))];
  const [roles, approved, boundary, requests, admins, progress] = await Promise.all([
    rolesOf(gagId),
    approvedIds(gagId, ids),
    renderApprovalAuditBoundary(),
    ids.length === 0 ? [] : db.select().from(imageGenerationRequestsTable)
      .where(inArray(imageGenerationRequestsTable.attemptId, ids)).orderBy(imageGenerationRequestsTable.id),
    adminIds.length === 0 ? [] : db.select({
      id: usersTable.id,
      name: sql<string | null>`coalesce(${usersTable.displayName}, ${usersTable.firstName}, ${usersTable.email})`,
    }).from(usersTable).where(inArray(usersTable.id, adminIds)),
    renderProgressByAttempt(page.filter((r) => !r.generatedImageObjectPath).map((r) => r.id)),
  ]);
  const keySet = billingKeySet();
  const nameOf = new Map(admins.map((u) => [u.id, u.name]));
  const requestsOf = new Map<number, typeof requests>();
  for (const r of requests) requestsOf.set(r.attemptId!, [...(requestsOf.get(r.attemptId!) ?? []), r]);

  const entries: RenderHistoryEntry[] = page.map((r) => {
    const status = deriveScenarioStatus(r, progress.get(r.id) ?? null);
    const reqs = requestsOf.get(r.id) ?? [];
    const fallback = switchedFallbackOf(r);
    const adminId = adminOf(r) ?? reqs[0]?.actorUserId ?? null;
    return {
      attemptId: r.id,
      kind: kindForScenario(r.reviewRenderScenarioKey),
      createdAt: r.createdAt.toISOString(),
      drawnBy: { userId: adminId, name: adminId ? nameOf.get(adminId) ?? null : null },
      roles: roles.get(r.id) ?? [],
      status,
      error: status === "failed" ? r.error : status === "blocked" ? buildRenderStatusPayload(r).blockReason ?? null : null,
      imageUrl: status === "done" && r.renderJobId ? gagRenderImageUrl(gagId, r.renderJobId) : null,
      gag: normaliseGagContent(drewGagOf(r.factEnrichmentSnapshot)),
      reference: { identityType: r.reviewReferenceIdentityType, assetVersion: r.reviewReferenceAssetVersion },
      engine: {
        engineId: r.actualImageEngineId,
        fallback: fallback ? { refusedEngineId: fallback.routedEngineId, reason: fallback.reason, drawnByEngineId: fallback.fallbackEngineId } : null,
      },
      prompt: {
        compiled: r.compiledPrompt,
        requests: reqs.map((q): RenderRequestRecord => ({
          id: q.id, endpointId: q.endpointId, engineId: q.engineId, createdAt: q.createdAt.toISOString(),
          request: q.request, billedUsd: q.billedUsd == null ? null : Number(q.billedUsd),
        })),
      },
      approval: approvalOf(r, approved, boundary),
      cost: costOf(reqs, keySet),
    };
  });
  const last = page[page.length - 1];
  return { gagId, entries, nextBefore: rows.length > HISTORY_PAGE_SIZE && last ? encodeCursor(last) : null };
}

/**
 * A fact's removed gags that still have renders (D3, "Removed gags"): a gag
 * removed from the fact, or one whose row is gone, grouped by its own id.
 */
export async function removedGagHistories(factId: number): Promise<RemovedGagHistory[]> {
  const a = imagePromptAttemptsTable;
  const rows = await db.select({
    gagId: a.gagId,
    renders: sql<number>`count(*)::int`,
    last: sql<Date>`max(${a.createdAt})`,
  }).from(a)
    .where(and(
      eq(a.factId, factId),
      isNotNull(a.gagId),
      sql`NOT EXISTS (SELECT 1 FROM fact_gags g WHERE g.id = ${a.gagId} AND g.removed_at IS NULL)`,
    ))
    .groupBy(a.gagId)
    .orderBy(desc(sql`max(${a.createdAt})`));
  return rows.map((r) => ({ gagId: r.gagId!, renders: r.renders, lastRenderAt: new Date(r.last).toISOString() }));
}
