/**
 * PuLID expected-run-time EMA.
 *
 * Drives the asymptotic progress curve in the wizard's "Forging your likeness"
 * loading takeover. The EMA is updated after every successful PuLID generation
 * so the curve converges on the actual server timing as the model performance
 * drifts over time.
 *
 *   progress(elapsed) = 0.30 + 0.65 * (1 - exp(-elapsed / expectedRunMs))
 */
import { db } from "@workspace/db";
import { adminConfigTable } from "@workspace/db/schema";
import { getConfigInt, bustConfigCache } from "./adminConfig";
import { logger } from "./logger";

const KEY = "pulid_expected_run_ms_ema";
const DEFAULT_MS = 18_000;
const EMA_ALPHA = 0.2;
const MIN_MS = 3_000;
const MAX_MS = 120_000;

export async function getPulidExpectedRunMs(): Promise<number> {
  const v = await getConfigInt(KEY, DEFAULT_MS);
  if (!Number.isFinite(v) || v < MIN_MS) return DEFAULT_MS;
  if (v > MAX_MS) return MAX_MS;
  return v;
}

export async function updatePulidExpectedRunMs(actualMs: number): Promise<void> {
  if (!Number.isFinite(actualMs) || actualMs < MIN_MS || actualMs > MAX_MS) return;
  try {
    const prev = await getPulidExpectedRunMs();
    const next = Math.round(prev * (1 - EMA_ALPHA) + actualMs * EMA_ALPHA);
    await db
      .insert(adminConfigTable)
      .values({
        key: KEY,
        value: String(next),
        dataType: "integer",
        label: "PuLID expected run time EMA (ms)",
        description:
          "Exponential moving average of PuLID server run duration. Updated automatically after each successful generation.",
      })
      .onConflictDoUpdate({
        target: adminConfigTable.key,
        set: { value: String(next), updatedAt: new Date() },
      });
    bustConfigCache();
  } catch (err) {
    logger.warn({ err, actualMs }, "[pulidExpectedRunMs] EMA update failed — non-fatal");
  }
}
