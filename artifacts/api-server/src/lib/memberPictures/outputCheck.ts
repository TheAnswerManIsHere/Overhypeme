/**
 * @purpose The output check on a member's finished AI picture, before it is stored or delivered (launch Phase 7, increment 2; plan PLAN_PHASE7_IMAGE_OFFERING.md §2): the same NSFW classifier and quarantine an upload passes. A refused picture is quarantined, never becomes a background, and returns its credit (the caller ends it).
 * @subsystem visual-pipeline
 */
import { randomUUID } from "node:crypto";
import { classifyAndDecide, DEFAULT_NSFW_ENDPOINT, isNsfwClassifierFailOpen } from "../moderation/nsfwClassifier";
import { quarantineImage } from "../moderation/quarantine";
import { getFalApiKey } from "../falClient";
import { logger } from "../logger";
import { gateMemberCall } from "./spend";
import { recordCost } from "../budgetGate";

type OutputCheckOutcome =
  | { outcome: "pass" }
  | { outcome: "refused" }
  /** The check could not run and is configured to fail closed: the caller retries. */
  | { outcome: "unavailable"; message: string };

type Classifier = (imageUrl: string) => ReturnType<typeof classifyAndDecide>;
const defaultClassify: Classifier = (url) => classifyAndDecide(url, { nsfwModeEnabled: false });
const defaultKeyPresent = (): boolean => Boolean(getFalApiKey());
let classify = defaultClassify;
let keyPresent = defaultKeyPresent;
/** Test seam: replace the classifier (null restores it); a replaced classifier runs as if a fal key were set. */
export function __setOutputClassifierForTest(fn: Classifier | null): void {
  classify = fn ?? defaultClassify;
  keyPresent = fn ? () => true : defaultKeyPresent;
}

/** The classifier's cost per call, for the gate and the ledger: a fraction of a cent, recorded as an estimate. */
const CLASSIFIER_CALL_USD = 0.001;

export async function checkMemberPictureOutput(args: {
  attemptId: number;
  userId: string;
  imageUrl: string;
  bytes: Buffer;
  mimeType: string;
}): Promise<OutputCheckOutcome> {
  // As for uploads: with no fal key there is no classifier (only a stand-in
  // engine can have drawn this picture then).
  if (!keyPresent()) {
    logger.warn({ attemptId: args.attemptId }, "[memberPictures] no fal key; the output check is skipped");
    return { outcome: "pass" };
  }
  await gateMemberCall(args.userId, { endpointId: DEFAULT_NSFW_ENDPOINT, estimatedCostUsdPerCall: CLASSIFIER_CALL_USD });
  const decision = await classify(args.imageUrl);
  if (decision.outcome !== "error") {
    await recordCost({
      userId: args.userId, jobType: "image", endpointId: DEFAULT_NSFW_ENDPOINT,
      unitPriceAtCreation: CLASSIFIER_CALL_USD, billingUnits: 1, computedCostUsd: CLASSIFIER_CALL_USD,
      pricingFetchedAt: new Date(), jobReferenceId: `check:output:${args.attemptId}:${randomUUID()}`, isEstimated: true,
    });
  }
  if (decision.outcome === "accept") return { outcome: "pass" };
  if (decision.outcome === "error") {
    if (await isNsfwClassifierFailOpen()) {
      logger.warn({ attemptId: args.attemptId, message: decision.message }, "[memberPictures] output check error; failing open by config");
      return { outcome: "pass" };
    }
    return { outcome: "unavailable", message: `the picture's safety check is unavailable right now (${decision.message})` };
  }
  // Quarantined under the existing rules. A failed quarantine write still
  // refuses the picture: nothing refused is ever delivered.
  try {
    await quarantineImage({
      source: "classifier",
      bytes: args.bytes,
      mimeType: args.mimeType,
      userId: args.userId,
      evidence: { source: "classifier", classifierScore: decision.score, classifierModel: decision.model, raw: decision.raw },
      reportToNcmec: false,
    });
  } catch (err) {
    logger.error({ err, attemptId: args.attemptId }, "[memberPictures] quarantine failed for a refused picture; it is refused regardless");
  }
  return { outcome: "refused" };
}
