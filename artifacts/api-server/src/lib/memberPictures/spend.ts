/**
 * @purpose What a member's AI picture costs Overhype.me in engine dollars (launch Phase 7, increment 2; plan PLAN_PHASE7_IMAGE_OFFERING.md §2): the budget gate at every new paid submission (the first draw, the styled fallback, a redraw recovery makes on purpose, the photo check and the output check), and the cost of each engine request recorded once in the cost ledger however often it is collected.
 * @subsystem visual-pipeline
 *
 * Credits are what the member pays (one per picture, `lib/credits/pictures.ts`);
 * these dollars are what the engines charged us. Neither is computed from the
 * other. The gate's ceiling follows the credits an account was granted
 * (`budgetGate.ts`), so it is a backstop, never the member's balance.
 */
import { eq } from "drizzle-orm";
import { db } from "@workspace/db";
import { falPricingCacheTable } from "@workspace/db/schema";
import { BudgetExceededError, checkBudget, recordCost } from "../budgetGate";
import { falCallPrice } from "../falClient";
import { perCallBoundUsd, perImagePrice, type PriceModel } from "../engines";
import { logger } from "../logger";

/** The gate refused a paid call for this account: the picture ends "temporarily unavailable" and its credit returns. */
export class MemberSpendRefusedError extends Error {
  readonly code = "spend_backstop";
  constructor(readonly endpointId: string) {
    super("Pictures are temporarily unavailable for this account. Your credit was returned.");
    this.name = "MemberSpendRefusedError";
  }
}

/** The fields of an engine this needs. */
export interface PricedEngine {
  endpointId: string;
  priceModel?: unknown;
  estimatedCostUsdPerCall?: string | number | null;
}

/**
 * What one call is expected to cost: the price model's typical figure, else
 * the configured estimate, else the model's worst case. The gate charges the
 * expectation, not the worst case: Nano Banana 2.1's token ceiling is $0.33
 * (measured from the catalogue, 2026-11-25) against a typical $0.045, and
 * gating on the ceiling would refuse a free account's styled picture before
 * anything was spent. Null when nothing prices it.
 */
export function expectedCallUsd(engine: PricedEngine): number | null {
  const typical = engine.priceModel ? perImagePrice(engine.priceModel as PriceModel)?.usd ?? null : null;
  if (typical != null) return typical;
  const est = engine.estimatedCostUsdPerCall != null ? Number(engine.estimatedCostUsdPerCall) : NaN;
  if (Number.isFinite(est)) return est;
  return engine.priceModel ? perCallBoundUsd(engine.priceModel as PriceModel) : null;
}

/** When nothing prices an endpoint at all, the gate still runs, against this. */
const UNPRICED_CALL_BOUND_USD = 0.25;

/**
 * The budget gate for one new paid call made for `userId`. Throws
 * `MemberSpendRefusedError` when the account's backstop refuses; lets
 * `BudgetGateError` (the check itself could not run) through, which callers
 * treat as retryable, never as a refusal.
 */
export async function gateMemberCall(userId: string, engine: PricedEngine): Promise<void> {
  const status = await checkBudget(userId, async () => expectedCallUsd(engine) ?? UNPRICED_CALL_BOUND_USD);
  if (!status.allowed) {
    logger.warn({ userId, endpointId: engine.endpointId, status }, "[memberPictures] the spend backstop refused a paid call");
    throw new MemberSpendRefusedError(engine.endpointId);
  }
}

/** Re-export for callers that tell the two refusals apart. */
export { BudgetExceededError };

/** The ledger reference for one engine request: unique, so a request is recorded once. */
export const generationRequestCostRef = (generationRequestId: number): string => `genreq:${generationRequestId}`;

const PRICE_FRESH_MS = 60 * 60_000;

/**
 * Record what one engine request cost, once. The price is fal's published
 * rate from the pricing cache the `pricing_refresh` task keeps when it holds a
 * fresh row for the endpoint (`isEstimated: false`), else the engine
 * catalogue's figure (`isEstimated: true`). Never throws (`recordCost`), and
 * never calls the pricing API from inside a render.
 */
export async function recordEngineRequestCost(args: {
  userId: string;
  engine: PricedEngine;
  input: Record<string, unknown>;
  generationRequestId: number;
  megapixels: number;
}): Promise<void> {
  const ref = generationRequestCostRef(args.generationRequestId);
  let cached: { unitPrice: string; unit: string; fetchedAt: Date } | undefined;
  try {
    [cached] = await db.select({ unitPrice: falPricingCacheTable.unitPrice, unit: falPricingCacheTable.unit, fetchedAt: falPricingCacheTable.fetchedAt })
      .from(falPricingCacheTable).where(eq(falPricingCacheTable.endpointId, args.engine.endpointId)).limit(1);
  } catch (err) {
    logger.warn({ err, endpointId: args.engine.endpointId }, "[memberPictures] pricing cache unreadable; recording the catalogue figure");
  }
  const published = cached && Date.now() - cached.fetchedAt.getTime() <= PRICE_FRESH_MS
    ? falCallPrice({ prices: [{ endpoint_id: args.engine.endpointId, unit_price: Number(cached.unitPrice), unit: cached.unit }] }, args.engine.endpointId, args.input)
    : null;
  if (published != null) {
    await recordCost({
      userId: args.userId, jobType: "image", endpointId: args.engine.endpointId,
      unitPriceAtCreation: Number(cached!.unitPrice), billingUnits: /megapixel/i.test(cached!.unit) ? Math.ceil(args.megapixels) : 1,
      computedCostUsd: published, pricingFetchedAt: cached!.fetchedAt, jobReferenceId: ref, isEstimated: false,
    });
  } else {
    const usd = expectedCallUsd(args.engine) ?? UNPRICED_CALL_BOUND_USD;
    await recordCost({
      userId: args.userId, jobType: "image", endpointId: args.engine.endpointId,
      unitPriceAtCreation: usd, billingUnits: 1, computedCostUsd: usd,
      pricingFetchedAt: new Date(), jobReferenceId: ref, isEstimated: true,
    });
  }
}
