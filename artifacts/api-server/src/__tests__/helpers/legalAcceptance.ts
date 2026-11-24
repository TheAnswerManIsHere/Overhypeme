/**
 * @purpose Gives a test account what every account onboarded since launch Phase 14 holds: an acceptance of the current Terms and Privacy versions, recorded by the product's own write, so a test of something else is not refused by the verified-actor gate's Terms check.
 * @subsystem accounts-auth
 */
import { db } from "@workspace/db";
import { recordLegalAcceptance } from "../../lib/legalAcceptance.js";

export async function acceptCurrentLegal(...userIds: string[]): Promise<void> {
  for (const userId of userIds) await recordLegalAcceptance(db, userId);
}
