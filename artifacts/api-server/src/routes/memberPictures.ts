/**
 * @purpose A verified member's AI pictures (launch Phase 7, increment 2; plan PLAN_PHASE7_IMAGE_OFFERING.md §2): what a fact offers to draw (its gags with their examples, and the member's credits), the command that makes one picture, and each picture's progress, its failure in words with its credit returned, and its image to its owner alone.
 * @subsystem visual-pipeline
 *
 *   GET  /api/facts/:factId/picture-options              the gags offered, their examples, the balance
 *   GET  /api/member-pictures/examples/:attemptId/image  an offered gag's approved example
 *   POST /api/facts/:factId/member-pictures              make one picture (one credit)
 *   GET  /api/member-pictures                            the member's pictures not yet finished, and recent ones
 *   GET  /api/member-pictures/:attemptId                 one picture's state
 *
 * A finished picture is served through `GET /api/memes/ai-user/image`, which
 * checks the caller's live `user_ai_images` row. Signed-in, verified members
 * only: `requireEligibleActor` refuses a state-changing request from anyone
 * else, and every route here checks the session itself.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";
import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { creditLedgerTable, db, imagePromptAttemptsTable, imageGenerationRequestsTable, userAiImagesTable } from "@workspace/db";
import { availableGags } from "../lib/gags/resolver";
import { creditBalance, openLots } from "../lib/credits/ledger";
import { returnedPictures } from "../lib/credits/pictures";
import { MEMBER_PICTURE_IN_PROGRESS } from "../lib/imagePromptAttempts";
import { MemberPictureError, requestMemberPicture } from "../lib/memberPictures/command";
import { memberFailureWords } from "../lib/memberPictures/failures";
import { liveContent } from "../lib/contentVisibility";
import { ObjectNotFoundError, ObjectStorageService } from "../lib/objectStorage";
import { sendStorageBody } from "../lib/sendStorageBody";
import { setNoStore } from "../lib/cacheHeaders";

const router: IRouter = Router();
const storage = new ObjectStorageService();

const idParam = z.coerce.number().int().positive();

const commandBody = z.object({
  requestId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
  gagId: z.number().int().positive().nullable().optional(),
  uploadKey: z.string().regex(/^\/objects\//).max(500),
  lookStyleId: z.string().max(64).nullable().optional(),
  subject: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("me") }),
    z.object({
      kind: z.literal("pet"),
      name: z.string().trim().min(1).max(40),
      pronouns: z.string().regex(/^\s*[a-z]+\/[a-z]+\s*$/i).nullable().optional(),
    }),
  ]),
  aspectRatio: z.enum(["landscape", "square", "portrait"]).optional(),
});

/** A picture's state as the member sees it (`docs/ai-context/async-ui-status.md`). */
export interface MemberPictureState {
  attemptId: number;
  factId: number;
  status: "queued" | "drawing" | "done" | "failed";
  /** In words, when failed. */
  reason: string | null;
  /** True once a failed picture's credit is back on the balance. */
  creditReturned: boolean;
  /** The finished picture, when done. */
  aiImageId: number | null;
  imageUrl: string | null;
  createdAt: string;
}

async function statesFor(userId: string, attemptIds: number[] | null, limit = 20): Promise<MemberPictureState[]> {
  const columns = {
    id: imagePromptAttemptsTable.id,
    factId: imagePromptAttemptsTable.factId,
    error: imagePromptAttemptsTable.error,
    errorCode: imagePromptAttemptsTable.errorCode,
    compiledPrompt: imagePromptAttemptsTable.compiledPrompt,
    generatedImageObjectPath: imagePromptAttemptsTable.generatedImageObjectPath,
    createdAt: imagePromptAttemptsTable.createdAt,
  };
  const mine = and(eq(imagePromptAttemptsTable.userId, userId), isNotNull(imagePromptAttemptsTable.memberRequestId));
  let rows;
  if (attemptIds) {
    rows = await db.select(columns).from(imagePromptAttemptsTable)
      .where(and(mine, inArray(imagePromptAttemptsTable.id, attemptIds)));
  } else {
    // The list: every picture still in progress (at most the in-progress cap),
    // however many newer ones there are, plus the most recently changed ones,
    // so a picture that finished or failed late is shown on the member's next
    // visit (Issue #1299, the recorded gap from PR #1300's review).
    const [inProgress, recent] = await Promise.all([
      db.select(columns).from(imagePromptAttemptsTable).where(and(mine, MEMBER_PICTURE_IN_PROGRESS)),
      db.select(columns).from(imagePromptAttemptsTable).where(mine)
        .orderBy(desc(imagePromptAttemptsTable.updatedAt), desc(imagePromptAttemptsTable.id)).limit(limit),
    ]);
    const byId = new Map([...inProgress, ...recent].map((r) => [r.id, r]));
    rows = [...byId.values()];
  }
  rows.sort((a, b) => b.id - a.id);
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const [delivered, submitted, returned] = await Promise.all([
    db.select({ id: userAiImagesTable.id, attemptId: userAiImagesTable.attemptId, storagePath: userAiImagesTable.storagePath, isLive: liveContent(userAiImagesTable) })
      .from(userAiImagesTable).where(inArray(userAiImagesTable.attemptId, ids)),
    db.select({ attemptId: imageGenerationRequestsTable.attemptId })
      .from(imageGenerationRequestsTable).where(inArray(imageGenerationRequestsTable.attemptId, ids)),
    returnedPictures(ids, db),
  ]);
  const deliveredBy = new Map(delivered.map((d) => [d.attemptId, d]));
  const drawing = new Set(submitted.map((s) => s.attemptId));
  const out: MemberPictureState[] = [];
  for (const r of rows) {
    const d = deliveredBy.get(r.id);
    const base = { attemptId: r.id, factId: r.factId, createdAt: r.createdAt.toISOString(), aiImageId: null, imageUrl: null, reason: null, creditReturned: false };
    if (d) {
      out.push({ ...base, status: "done", aiImageId: d.id, imageUrl: d.isLive ? `/api/memes/ai-user/image?storagePath=${encodeURIComponent(d.storagePath)}` : null });
    } else if (r.generatedImageObjectPath) {
      // Delivered, and the member's copy since removed (deleted and purged):
      // still finished, with nothing to show. Delivery is the attempt's record,
      // never the presence of the member's copy (Codex review, PR #1300).
      out.push({ ...base, status: "done" });
    } else if (r.error || returned.has(r.id)) {
      // A returned picture reads failed whatever its error column holds.
      out.push({ ...base, status: "failed", reason: memberFailureWords(r.errorCode), creditReturned: returned.has(r.id) });
    } else {
      out.push({ ...base, status: r.compiledPrompt && drawing.has(r.id) ? "drawing" : "queued" });
    }
  }
  return out;
}

async function nextPictureIsFree(userId: string): Promise<boolean> {
  const [oldest] = await openLots(userId, db);
  if (!oldest) return false;
  const [lot] = await db.select({ kind: creditLedgerTable.kind }).from(creditLedgerTable).where(eq(creditLedgerTable.id, oldest.lotId)).limit(1);
  return lot?.kind === "free_grant";
}

router.get("/facts/:factId/picture-options", async (req: Request, res: Response) => {
  setNoStore(res);
  if (!req.isAuthenticated()) { res.status(401).json({ error: "Unauthorized" }); return; }
  const factId = idParam.safeParse(req.params["factId"]);
  if (!factId.success) { res.status(400).json({ error: "Invalid fact" }); return; }
  const [gags, credits, nextIsFree] = await Promise.all([availableGags(factId.data), creditBalance(req.user.id), nextPictureIsFree(req.user.id)]);
  res.json({
    gags: gags.map((g) => ({
      gagId: g.gagId,
      slot: g.slot,
      examples: {
        male: g.examples.male != null ? `/api/member-pictures/examples/${g.examples.male}/image` : null,
        female: g.examples.female != null ? `/api/member-pictures/examples/${g.examples.female}/image` : null,
        pet: g.examples.pet != null ? `/api/member-pictures/examples/${g.examples.pet}/image` : null,
      },
    })),
    // The picker offers a choice only where there is one (plan §2).
    choice: gags.length > 1,
    credits,
    // The next picture draws the oldest lot: "your free picture" when that is the free credit.
    nextIsFree,
  });
});

router.get("/member-pictures/examples/:attemptId/image", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) { res.status(401).json({ error: "Unauthorized" }); return; }
  const attemptId = idParam.safeParse(req.params["attemptId"]);
  if (!attemptId.success) { res.status(400).json({ error: "Invalid example" }); return; }
  const [attempt] = await db.select({ factId: imagePromptAttemptsTable.factId, path: imagePromptAttemptsTable.generatedImageObjectPath })
    .from(imagePromptAttemptsTable).where(eq(imagePromptAttemptsTable.id, attemptId.data)).limit(1);
  // Served only while it is an offered gag's approved example right now.
  const offered = attempt ? (await availableGags(attempt.factId)).some((g) => Object.values(g.examples).includes(attemptId.data)) : false;
  if (!attempt?.path || !offered) { res.status(404).json({ error: "Example not found" }); return; }
  try {
    const file = await storage.getObjectEntityFile(attempt.path);
    const response = await storage.downloadObject(file, 3600);
    res.setHeader("Content-Type", response.headers.get("content-type") || "image/png");
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.status(200);
    await sendStorageBody(res, response.body, { storagePath: attempt.path });
  } catch (err) {
    if (err instanceof ObjectNotFoundError) { res.status(404).json({ error: "Example not found" }); return; }
    req.log.error({ err, attemptId: attemptId.data }, "[memberPictures] example image could not be read");
    res.status(503).json({ error: "Example unavailable" });
  }
});

router.post("/facts/:factId/member-pictures", async (req: Request, res: Response) => {
  setNoStore(res);
  if (!req.isAuthenticated()) { res.status(401).json({ error: "Unauthorized" }); return; }
  const factId = idParam.safeParse(req.params["factId"]);
  const body = commandBody.safeParse(req.body);
  if (!factId.success || !body.success) {
    res.status(400).json({ error: "invalid_input", details: body.success ? undefined : body.error.flatten() });
    return;
  }
  try {
    const handle = await requestMemberPicture({
      userId: req.user.id,
      requestId: body.data.requestId,
      factId: factId.data,
      gagId: body.data.gagId ?? null,
      uploadKey: body.data.uploadKey,
      lookStyleId: body.data.lookStyleId ?? null,
      subject: body.data.subject.kind === "pet"
        ? { kind: "pet", name: body.data.subject.name, pronouns: body.data.subject.pronouns?.trim().toLowerCase() ?? null }
        : { kind: "me" },
      aspectRatio: body.data.aspectRatio ?? "portrait",
    });
    const [state] = await statesFor(req.user.id, [handle.attemptId]);
    res.status(handle.created ? 202 : 200).json({ picture: state, credits: await creditBalance(req.user.id) });
  } catch (err) {
    if (err instanceof MemberPictureError) {
      res.status(err.status).json({ error: err.code, message: err.message });
      return;
    }
    throw err;
  }
});

router.get("/member-pictures", async (req: Request, res: Response) => {
  setNoStore(res);
  if (!req.isAuthenticated()) { res.status(401).json({ error: "Unauthorized" }); return; }
  const [pictures, credits] = await Promise.all([statesFor(req.user.id, null), creditBalance(req.user.id)]);
  res.json({ pictures, credits });
});

router.get("/member-pictures/:attemptId", async (req: Request, res: Response) => {
  setNoStore(res);
  if (!req.isAuthenticated()) { res.status(401).json({ error: "Unauthorized" }); return; }
  const attemptId = idParam.safeParse(req.params["attemptId"]);
  if (!attemptId.success) { res.status(400).json({ error: "Invalid picture" }); return; }
  const [[state], credits] = await Promise.all([statesFor(req.user.id, [attemptId.data]), creditBalance(req.user.id)]);
  if (!state) { res.status(404).json({ error: "Picture not found" }); return; }
  res.json({ picture: state, credits });
});

export default router;
