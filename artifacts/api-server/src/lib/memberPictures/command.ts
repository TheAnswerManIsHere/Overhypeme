/**
 * @purpose A verified member's "make an AI picture" command (launch Phase 7, increment 2; plan PLAN_PHASE7_IMAGE_OFFERING.md §2): one command makes one picture. Checks the member's own photo, the fact's offered gag and the look, freezes who the picture is of, and commits the attempt, its first job and its one-credit spend together; a resent command returns the picture it already made and spends nothing more.
 * @subsystem visual-pipeline
 *
 * The member supplies ids only: a fact, optionally one of its gags, optionally
 * a look, and one of their own uploads. No text from the member reaches a
 * prompt except the name and pronouns of the subject, which go through the
 * same personalisation and prompt-name reduction every render uses.
 */
import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db, factsTable, imagePromptAttemptsTable, usersTable } from "@workspace/db";
import { defaultIdentityPolicyForRenderMode, type GagRenderInput, type SourceImageAnalysis } from "@workspace/api-zod";
import { GagNotAvailableError, gagRenderInput, resolveOfferedGag } from "../gags/resolver";
import { NoUsablePhotoError, resolveRenderReviewInput } from "../imagePrompt/resolveRenderReviewInput";
import { buildAndEnqueueImagePromptAttempt, TooManyPicturesInProgressError } from "../imagePromptAttempts";
import { RenderStyleRefusedError } from "../imagePrompt/styleResolution";
import { analyzeSourceImage } from "../sourceImageAnalysis";
import { userOwnsUpload } from "../uploadOwnership";
import { clampPronouns, PROMPT_IDENTITY_SNAPSHOT_VERSION, reducePromptName, type PromptIdentitySnapshot } from "../imagePrompt/promptIdentity";
import { creditBalance } from "../credits/ledger";
import { NoCreditError } from "../credits/pictures";
import { getConfigInt } from "../adminConfig";
import { gateMemberCall, MemberSpendRefusedError } from "./spend";
import { recordCost } from "../budgetGate";
import { uploadMemberReference } from "./reference";
import { logger } from "../logger";

type MemberPictureErrorCode =
  | "request_reused"
  | "upload_not_owned"
  | "fact_unavailable"
  | "gag_unavailable"
  | "look_unavailable"
  | "photo_unusable"
  | "photo_subject_mismatch"
  | "photo_check_failed"
  | "no_credit"
  | "too_many_in_progress"
  | "temporarily_unavailable";

/** A request refused with a reason a person can act on. `status` is the HTTP status a route sends. */
export class MemberPictureError extends Error {
  constructor(readonly code: MemberPictureErrorCode, message: string, readonly status: number) {
    super(message);
    this.name = "MemberPictureError";
  }
}

/** The shape a member's picture is drawn in: the meme builder's three. */
export type MemberPictureShape = "landscape" | "square" | "portrait";

export interface MemberPictureCommand {
  userId: string;
  /** The client's stable id for this command: a resend with it returns the same picture. */
  requestId: string;
  factId: number;
  /** One of the fact's offered gags; null draws the default gag. */
  gagId: number | null;
  /** One of the member's own uploads (`/objects/…`). */
  uploadKey: string;
  /** A look style id; null is photoreal. */
  lookStyleId: string | null;
  /** Who the picture stars: the member, or their pet (named by the member). */
  subject: { kind: "me" } | { kind: "pet"; name: string; pronouns: string | null };
  aspectRatio: MemberPictureShape;
  /**
   * The name and pronouns the meme's caption is meant to carry (plan
   * PLAN_PHASE7_AI_PICTURE_FLOW.md): recorded on the attempt and read back by
   * the picture's state. Never used to draw: the picture's identity is the
   * subject's. Absent from older clients. `chosen` is present, and true,
   * only when the member chose this name or pronouns themselves rather than
   * leaving them to follow the subject; it is stored and returned and decides
   * nothing here (Codex, PR #1340, round 2).
   */
  caption?: { name: string; pronouns: string | null; chosen?: true } | null;
}

export interface MemberPictureHandle {
  attemptId: number;
  renderJobId: string;
  /** False when the command was already carried out: nothing was spent this time. */
  created: boolean;
}

/** The most pictures one account may have drawing at once (`admin_config`). */
const DEFAULT_MAX_IN_PROGRESS = 3;
/** The photo check's cost per call, for the gate: a vision call, a fraction of a cent. */
const PHOTO_CHECK_ENDPOINT = { endpointId: "openai/vision-photo-check", estimatedCostUsdPerCall: 0.002 };

/** A hash of everything the command asks for, so a reused request id is recognised as the same picture or refused. */
function fingerprintOf(cmd: MemberPictureCommand): string {
  const { userId: _u, requestId: _r, ...asked } = cmd;
  const parts: unknown[] = [asked.factId, asked.gagId, asked.uploadKey, asked.lookStyleId, asked.subject, asked.aspectRatio];
  // Appended only when sent, so a command from a client that predates the
  // caption keeps the fingerprint it had.
  if (asked.caption) parts.push(asked.caption);
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

async function existingHandle(cmd: MemberPictureCommand): Promise<MemberPictureHandle | null> {
  const [row] = await db.select({
    id: imagePromptAttemptsTable.id,
    renderJobId: imagePromptAttemptsTable.renderJobId,
    fingerprint: imagePromptAttemptsTable.memberRequestFingerprint,
  }).from(imagePromptAttemptsTable)
    .where(and(eq(imagePromptAttemptsTable.userId, cmd.userId), eq(imagePromptAttemptsTable.memberRequestId, cmd.requestId)))
    .limit(1);
  if (!row) return null;
  if (row.fingerprint !== fingerprintOf(cmd)) {
    throw new MemberPictureError("request_reused", "This request id was already used for a different picture.", 409);
  }
  return { attemptId: row.id, renderJobId: row.renderJobId ?? "", created: false };
}

const noCredit = (balance: number) => new MemberPictureError("no_credit", new NoCreditError(balance).message, 402);

function identityFor(cmd: MemberPictureCommand, member: { displayName: string | null; pronouns: string | null }): PromptIdentitySnapshot {
  const name = cmd.subject.kind === "pet" ? cmd.subject.name : (member.displayName ?? "");
  const pronouns = cmd.subject.kind === "pet" ? cmd.subject.pronouns : member.pronouns;
  return {
    version: PROMPT_IDENTITY_SNAPSHOT_VERSION,
    name: reducePromptName({ displayName: name.trim() || "Alex" }),
    pronouns: clampPronouns(pronouns),
    source: "user",
  };
}

export async function requestMemberPicture(cmd: MemberPictureCommand): Promise<MemberPictureHandle> {
  const again = await existingHandle(cmd);
  if (again) return again;

  if (!(await userOwnsUpload(cmd.uploadKey, cmd.userId))) {
    throw new MemberPictureError("upload_not_owned", "Choose one of your own photos.", 403);
  }

  // The fact and gag first: only an offered gag can be drawn, never quietly another.
  const [fact] = await db.select({ id: factsTable.id, text: factsTable.text, enrichment: factsTable.enrichment })
    .from(factsTable).where(and(eq(factsTable.id, cmd.factId), eq(factsTable.isActive, true))).limit(1);
  if (!fact) throw new MemberPictureError("fact_unavailable", "This fact is not available for pictures.", 404);
  let gag;
  try {
    gag = await resolveOfferedGag(cmd.factId, cmd.gagId);
  } catch (err) {
    if (err instanceof GagNotAvailableError) {
      throw cmd.gagId == null
        ? new MemberPictureError("fact_unavailable", "This fact has no picture to draw yet.", 409)
        : new MemberPictureError("gag_unavailable", "That gag is no longer available on this fact. Pick another.", 409);
    }
    throw err;
  }

  // Cheap refusals before any paid call: no credit, nothing to pay with. The
  // credit may be gone because this same command's first copy just spent it,
  // so its identity is read again before refusing.
  const balance = await creditBalance(cmd.userId);
  if (balance < 1) {
    const first = await existingHandle(cmd);
    if (first) return first;
    throw noCredit(balance);
  }

  const [member] = await db.select({ displayName: usersTable.displayName, pronouns: usersTable.pronouns })
    .from(usersTable).where(eq(usersTable.id, cmd.userId)).limit(1);

  const { referenceImageUrl, analysis, subject: photoSubject } = await checkMemberPhoto(cmd.userId, cmd.uploadKey);
  if ((cmd.subject.kind === "pet") !== (photoSubject === "pet")) {
    throw new MemberPictureError("photo_subject_mismatch", cmd.subject.kind === "pet"
      ? "This photo looks like a person, not a pet. Choose a photo of your pet."
      : "This photo looks like a pet, not a person. Choose a photo of yourself, or pick \"My pet\".", 422);
  }

  const identity = identityFor(cmd, member ?? { displayName: null, pronouns: null });
  const enrichment = gagRenderInput(fact.enrichment as never, gag.content) as GagRenderInput;
  let resolved;
  try {
    resolved = await resolveRenderReviewInput(fact.text, enrichment, {
      sourceImageAnalysis: analysis,
      referenceImageUrl,
      lookStyleId: cmd.lookStyleId,
      previewName: identity.name,
      previewPronouns: identity.pronouns ?? undefined,
      renderControls: { aspectRatio: cmd.aspectRatio },
    });
  } catch (err) {
    if (err instanceof NoUsablePhotoError) throw new MemberPictureError("photo_unusable", err.message, 422);
    if (err instanceof RenderStyleRefusedError) throw new MemberPictureError("look_unavailable", "That look is not available. Pick another.", 409);
    throw err;
  }

  const maxInProgress = await getConfigInt("member_pictures_max_in_progress", DEFAULT_MAX_IN_PROGRESS);
  try {
    const { attemptId, renderJobId } = await buildAndEnqueueImagePromptAttempt({
      factId: fact.id,
      userId: cmd.userId,
      enrichment,
      renderedFactText: resolved.renderedFactText,
      analysis: resolved.analysis,
      subjectRenderMode: resolved.subjectRenderMode,
      identityPolicy: resolved.identityPolicy ?? defaultIdentityPolicyForRenderMode(resolved.subjectRenderMode),
      renderControls: { ...resolved.renderControls, promptIdentity: identity } as never,
      requestId: `member-picture:${cmd.userId}:${cmd.requestId}`,
      gagId: gag.gagId,
      memberPicture: { requestId: cmd.requestId, fingerprint: fingerprintOf(cmd), maxInProgress, caption: cmd.caption ?? null },
    });
    return { attemptId, renderJobId, created: true };
  } catch (err) {
    // The same command sent twice at once: the second is refused for the
    // credit or the place its own first copy just took, or its insert meets
    // the first's unique (account, request id). Either way it re-reads its
    // identity first and answers with the first's picture (Codex review,
    // PR #1300); a different command still gets the refusal.
    const sameCommand = err instanceof NoCreditError || err instanceof TooManyPicturesInProgressError
      || (err as { code?: string }).code === "23505" || /UQ_ipa_member_request/.test(String((err as Error).message));
    if (sameCommand) {
      const first = await existingHandle(cmd);
      if (first) return first;
    }
    if (err instanceof NoCreditError) throw noCredit(err.balance);
    if (err instanceof TooManyPicturesInProgressError) throw new MemberPictureError("too_many_in_progress", err.message, 429);
    throw err;
  }
}

/** What a member's photo shows, as the existing person-or-pet check reads it. */
export type MemberPhotoSubject = "person" | "pet";

/**
 * The person-or-pet check on one of the member's own photos, shared by the
 * picture command and the flow's photo preparation (plan
 * PLAN_PHASE7_AI_PICTURE_FLOW.md, *Photo preparation*). Spends no picture
 * credit and queues nothing. The check is paid, so it passes the gate; every
 * call actually made records its own cost (a per-call reference), and the
 * upload's cached result records none. Requests that overlap on an unchecked
 * photo each pay, so each is counted and the backstop sees them (Codex review,
 * PR #1300).
 *
 * Refuses with `photo_unusable` when the photo shows neither one clear person
 * nor a pet, and with `photo_check_failed` when the check could not run
 * (`classificationMethod: "not_analyzed"`): that is a reason to try again,
 * never a verdict on the photo.
 */
export async function checkMemberPhoto(userId: string, uploadKey: string): Promise<{
  subject: MemberPhotoSubject;
  analysis: SourceImageAnalysis;
  referenceImageUrl: string;
}> {
  // The member's photo, at the size the engines are priced for, where the
  // photo check and the engine can fetch it.
  let referenceImageUrl: string;
  try {
    referenceImageUrl = await uploadMemberReference(uploadKey);
  } catch (err) {
    logger.warn({ err, userId }, "[memberPictures] the photo could not be prepared for drawing");
    throw new MemberPictureError("temporarily_unavailable", "Your photo could not be prepared right now. Try again shortly.", 503);
  }
  let analysis: SourceImageAnalysis;
  try {
    await gateMemberCall(userId, PHOTO_CHECK_ENDPOINT);
    analysis = await analyzeSourceImage({ uploadedObjectPath: uploadKey, imageUrl: referenceImageUrl }, {
      onPaidCheck: () => recordCost({
        userId, jobType: "image", endpointId: PHOTO_CHECK_ENDPOINT.endpointId,
        unitPriceAtCreation: PHOTO_CHECK_ENDPOINT.estimatedCostUsdPerCall, billingUnits: 1,
        computedCostUsd: PHOTO_CHECK_ENDPOINT.estimatedCostUsdPerCall, pricingFetchedAt: new Date(),
        jobReferenceId: `check:photo:${createHash("sha256").update(uploadKey).digest("hex")}:${randomUUID()}`, isEstimated: true,
      }),
    });
  } catch (err) {
    if (err instanceof MemberSpendRefusedError) throw new MemberPictureError("temporarily_unavailable", "Pictures are temporarily unavailable for this account.", 503);
    throw err;
  }
  if (analysis.classificationMethod === "not_analyzed") {
    throw new MemberPictureError("photo_check_failed", "We couldn't check this photo right now. Try again.", 503);
  }
  const isPet = analysis.suggestedRenderMode === "nonhuman_subject_i2i";
  const isPerson = analysis.suggestedRenderMode === "human_identity_i2i";
  if (!isPet && !isPerson) {
    throw new MemberPictureError("photo_unusable", `This photo cannot be used${analysis.warnings?.length ? `: ${analysis.warnings.join("; ")}` : ""}. Use a photo with one clear face or pet.`, 422);
  }
  return { subject: isPet ? "pet" : "person", analysis, referenceImageUrl };
}
