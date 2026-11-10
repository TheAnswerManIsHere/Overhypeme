/**
 * @purpose Who started an image-prompt attempt and which producer it is, from named sources (plan PLAN_IMAGE_TRACING.md, "Who made it, from named sources"): a moderation render's admin from its review audit, an eval render's admin from its eval run, a product render's member from the attempt's owner. A null owner is never recorded as anonymous, and "system" only where the audit itself says the work was unattended.
 */
import { eq } from "drizzle-orm";
import { db, evalRunsTable, type ImagePromptAttempt, type GenerationProducer } from "@workspace/db";
import { actorForUser, SYSTEM_ACTOR, type ProvenanceActor } from "./records";

export async function attemptProvenanceContext(
  attempt: Pick<ImagePromptAttempt, "userId" | "evalRunId" | "renderControls">,
): Promise<{ producer: GenerationProducer; actor: ProvenanceActor }> {
  const audit = (attempt.renderControls as { reviewAudit?: { adminUserId?: string } } | null)?.reviewAudit;
  if (audit) {
    const admin = audit.adminUserId;
    return {
      producer: "review_render",
      actor: admin && admin !== "system" ? await actorForUser(admin, "admin") : SYSTEM_ACTOR,
    };
  }
  if (attempt.evalRunId != null) {
    const [run] = await db.select({ createdBy: evalRunsTable.createdBy }).from(evalRunsTable)
      .where(eq(evalRunsTable.id, attempt.evalRunId)).limit(1);
    return { producer: "eval_render", actor: run?.createdBy ? await actorForUser(run.createdBy, "admin") : SYSTEM_ACTOR };
  }
  return {
    producer: "product_render",
    actor: attempt.userId ? await actorForUser(attempt.userId, "member") : SYSTEM_ACTOR,
  };
}
