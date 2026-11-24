/**
 * One-time cutover for Issue #1212 (plan docs/plans/PLAN_SUSPENDED_MAIL.md,
 * item 5): label the billing and access notices an earlier release queued
 * with no kind, so the suspended-recipient rule lets them through (Q21: 1).
 * Writes only `payload.kind` on rows that can still be sent; keeps every
 * sending record and key; authorises no send. Idempotent.
 *
 * Usage, after the deploy, through the connector:
 *   pnpm --filter @workspace/api-server run classify:legacy-email-kinds
 */
import { installStdioGuard } from "../src/lib/stdioGuard";
installStdioGuard();

import { pool } from "@workspace/db";
import { classifyLegacyEmailKinds } from "../src/lib/email";

const counts = await classifyLegacyEmailKinds();
const total = Object.values(counts).reduce((a, b) => a + b, 0);
console.log(`[classify-legacy-email-kinds] labelled ${total} job(s):`, JSON.stringify(counts));
await pool.end();
