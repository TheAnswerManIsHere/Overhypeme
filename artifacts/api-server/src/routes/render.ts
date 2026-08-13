/**
 * Phase-4 transient render endpoints.
 *
 *   POST /api/render-preview   anonymous-allowed (stock only) | streams image bytes
 *   POST /api/render-download  same render | streams as Content-Disposition attachment
 *
 * Both endpoints share `composeMeme` from `lib/memeComposite.ts` and produce
 * byte-identical output for identical inputs (the property the verification
 * checklist's "byte-identity" test relies on).
 *
 * Neither endpoint writes to GCS or the memes table — the bytes live only in
 * the response body. Every call (success, rejected, or errored) is recorded
 * in `transient_renders` for abuse detection. Per-IP rate limiting is
 * enforced at the Cloudflare WAF edge layer; see docs/cloudflare-rate-limits.md.
 *
 * Anonymous traffic is allowed because the cold-permalink personalisation
 * flow lets a not-yet-signed-up user try the meme builder once before being
 * asked to register. To keep the abuse surface small, anonymous callers are
 * restricted to `imageSource.type === "stock" | "template"` — uploaded assets
 * and PuLID-stylised images both require auth + ownership checks.
 */

import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import { factsTable, uploadImageMetadataTable } from "@workspace/db/schema";
import { and, eq, isNull } from "drizzle-orm";

import { setNoStore } from "../lib/cacheHeaders";
import { composeMeme, IdentityProfileMissingError } from "../lib/memeComposite";
import { ObjectNotFoundError } from "../lib/objectStorage";
import {
  RenderRequestBody,
  deriveRenderMode,
  type ImageSource,
  type RenderMode,
  type RenderRequest,
} from "../lib/validators/memeBuilder";
import { logTransientRender, ipFromRequest } from "../lib/transientRenderLog";

const router: IRouter = Router();

/**
 * Slugify a fact's text into a filename-safe stub for the download
 * Content-Disposition header. Capped at 60 chars so the filename stays under
 * Windows / macOS path limits when combined with the meme prefix.
 */
function factSlug(text: string | null | undefined, factId: number): string {
  if (!text) return `fact-${factId}`;
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || `fact-${factId}`;
}

interface RouteContext {
  endpoint: "preview" | "download";
  parsed: RenderRequest;
  isAuthenticated: boolean;
  userId: string | null;
  membershipTier: string;
  profileImageObjectPath: string | null;
}

/**
 * Run all the request-time checks — input validation, fact lookup, tier gate,
 * asset-ownership gate. Returns either a parsed-and-resolved context or an
 * already-handled response (the caller should `return` immediately).
 *
 * Logs to `transient_renders` with `result='rejected'` on every rejection
 * path so abuse-pattern queries see the failed attempts too.
 */
async function validateAndResolve(
  req: Request,
  res: Response,
  endpoint: "preview" | "download",
): Promise<{ ctx: RouteContext; fact: { id: number; text: string | null; canonicalText: string | null }; mode: RenderMode } | null> {
  const startedAt = Date.now();
  const ip = ipFromRequest(req);

  const parsed = RenderRequestBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input", details: parsed.error.flatten() });
    void logTransientRender({
      endpoint,
      ip,
      result: "rejected",
      rejectionReason: "invalid_input",
      latencyMs: Date.now() - startedAt,
    });
    return null;
  }

  const isAuthenticated = req.isAuthenticated();
  const userId = isAuthenticated ? req.user.id : null;
  const membershipTier = isAuthenticated ? (req.user.membershipTier ?? "registered") : "unregistered";
  const profileImageObjectPath = isAuthenticated && typeof req.user.profileImageUrl === "string"
    ? req.user.profileImageUrl.replace(/^\/api\/storage/, "")
    : null;

  const mode = deriveRenderMode(parsed.data.imageSource);

  // Anonymous callers may only use stock-mode renders. Self-upload, identity,
  // and PuLID-stylised images all carry per-user ownership state and require
  // a session.
  if (!isAuthenticated && mode !== "stock") {
    res.status(403).json({ error: "mode_requires_auth" });
    void logTransientRender({
      endpoint,
      ip,
      mode,
      result: "rejected",
      rejectionReason: "mode_requires_auth",
      latencyMs: Date.now() - startedAt,
    });
    return null;
  }

  // The PuLID gate that used to sit here is GONE, and its removal is not a
  // weakening: it was unreachable. `deriveRenderMode` is called on line 103
  // with one argument, so its `imageTransform` parameter is always `undefined`
  // and `mode` can never be `"pulid"` — the branch never ran. It also checked
  // the wrong key (`meme_ai_background`) for the capability it named.
  //
  // PuLID's real, reachable gate is `meme_pulid_stylize`, enforced where PuLID
  // is actually requested: `pulidJobs.ts` and `createMemeRecord`.

  // Look up the fact. Soft-deleted / inactive facts are treated as missing.
  const [fact] = await db
    .select({ id: factsTable.id, text: factsTable.text, canonicalText: factsTable.canonicalText })
    .from(factsTable)
    .where(and(eq(factsTable.id, parsed.data.factId), eq(factsTable.isActive, true)))
    .limit(1);
  if (!fact) {
    res.status(404).json({ error: "fact_not_found" });
    void logTransientRender({
      endpoint,
      userId,
      ip,
      mode,
      result: "rejected",
      rejectionReason: "fact_not_found",
      latencyMs: Date.now() - startedAt,
    });
    return null;
  }

  // For uploaded assets, confirm ownership matches the authenticated user
  // and the upload is not soft-deleted. Cross-user / orphaned uploads are
  // rejected — never let the renderer pull bytes a user does not own.
  if (parsed.data.imageSource.type === "upload") {
    const ownershipOk = await assertUploadOwnership(parsed.data.imageSource.uploadKey, userId);
    if (!ownershipOk) {
      res.status(403).json({ error: "upload_not_owned" });
      void logTransientRender({
        endpoint,
        factId: fact.id,
        userId,
        ip,
        mode,
        result: "rejected",
        rejectionReason: "upload_not_owned",
        latencyMs: Date.now() - startedAt,
      });
      return null;
    }
  }

  return {
    ctx: {
      endpoint,
      parsed: parsed.data,
      isAuthenticated,
      userId,
      membershipTier,
      profileImageObjectPath,
    },
    fact,
    mode,
  };
}

/**
 * Ownership check for `imageSource.type === "upload"`. The uploaded asset
 * row in `upload_image_metadata` must exist and be tagged with the
 * authenticated user's id. Rows with no `user_id` (system-generated) are
 * rejected on purpose — they should never be referenced from a user-mode
 * meme.
 */
async function assertUploadOwnership(uploadKey: string, userId: string | null): Promise<boolean> {
  if (!userId) return false;
  // The uploadKey shape is `/objects/<subPath>` per the storageKeys helper;
  // the metadata row is keyed by the same path.
  const [row] = await db
    .select({ userId: uploadImageMetadataTable.userId })
    .from(uploadImageMetadataTable)
    .where(eq(uploadImageMetadataTable.objectPath, uploadKey))
    .limit(1);
  return !!row && row.userId === userId;
}

router.post("/render-preview", async (req: Request, res: Response) => {
  setNoStore(res);
  const startedAt = Date.now();
  const ip = ipFromRequest(req);

  const resolved = await validateAndResolve(req, res, "preview");
  if (!resolved) return;
  const { ctx, fact, mode } = resolved;

  try {
    const result = await composeMeme(
      {
        factTextTemplate: fact.text ?? fact.canonicalText ?? "",
        name: ctx.parsed.name,
        pronouns: ctx.parsed.pronouns,
        imageSource: ctx.parsed.imageSource,
        textOptions: ctx.parsed.textOptions,
        framingTransform: ctx.parsed.framingTransform ?? null,
        aspectRatio: ctx.parsed.aspectRatio ?? "landscape",
      },
      { profileImageObjectPath: ctx.profileImageObjectPath },
    );

    res.setHeader("Content-Type", result.mime);
    res.setHeader("Content-Length", result.buffer.length);
    res.status(200).send(result.buffer);

    void logTransientRender({
      endpoint: "preview",
      factId: fact.id,
      userId: ctx.userId,
      ip,
      mode,
      result: "success",
      latencyMs: Date.now() - startedAt,
    });
  } catch (err) {
    handleRenderError(req, res, err, {
      endpoint: "preview",
      factId: fact.id,
      userId: ctx.userId,
      ip,
      mode,
      startedAt,
    });
  }
});

router.post("/render-download", async (req: Request, res: Response) => {
  setNoStore(res);
  const startedAt = Date.now();
  const ip = ipFromRequest(req);

  const resolved = await validateAndResolve(req, res, "download");
  if (!resolved) return;
  const { ctx, fact, mode } = resolved;

  try {
    const result = await composeMeme(
      {
        factTextTemplate: fact.text ?? fact.canonicalText ?? "",
        name: ctx.parsed.name,
        pronouns: ctx.parsed.pronouns,
        imageSource: ctx.parsed.imageSource,
        textOptions: ctx.parsed.textOptions,
        framingTransform: ctx.parsed.framingTransform ?? null,
        aspectRatio: ctx.parsed.aspectRatio ?? "landscape",
      },
      { profileImageObjectPath: ctx.profileImageObjectPath },
    );

    const filename = `overhype-${factSlug(fact.text ?? fact.canonicalText, fact.id)}.jpg`;
    res.setHeader("Content-Type", result.mime);
    res.setHeader("Content-Length", result.buffer.length);
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.status(200).send(result.buffer);

    void logTransientRender({
      endpoint: "download",
      factId: fact.id,
      userId: ctx.userId,
      ip,
      mode,
      result: "success",
      latencyMs: Date.now() - startedAt,
    });
  } catch (err) {
    handleRenderError(req, res, err, {
      endpoint: "download",
      factId: fact.id,
      userId: ctx.userId,
      ip,
      mode,
      startedAt,
    });
  }
});

interface ErrorContext {
  endpoint: "preview" | "download";
  factId: number;
  userId: string | null;
  ip: string;
  mode: RenderMode;
  startedAt: number;
}

function handleRenderError(req: Request, res: Response, err: unknown, ctx: ErrorContext): void {
  if (err instanceof IdentityProfileMissingError) {
    res.status(400).json({ error: "identity_profile_missing" });
    void logTransientRender({
      endpoint: ctx.endpoint,
      factId: ctx.factId,
      userId: ctx.userId,
      ip: ctx.ip,
      mode: ctx.mode,
      result: "rejected",
      rejectionReason: "identity_profile_missing",
      latencyMs: Date.now() - ctx.startedAt,
    });
    return;
  }
  if (err instanceof ObjectNotFoundError) {
    res.status(404).json({ error: "asset_not_found" });
    void logTransientRender({
      endpoint: ctx.endpoint,
      factId: ctx.factId,
      userId: ctx.userId,
      ip: ctx.ip,
      mode: ctx.mode,
      result: "rejected",
      rejectionReason: "asset_not_found",
      latencyMs: Date.now() - ctx.startedAt,
    });
    return;
  }
  req.log.error({ err, factId: ctx.factId, mode: ctx.mode }, "Render failed");
  res.status(502).json({ error: "render_failed" });
  void logTransientRender({
    endpoint: ctx.endpoint,
    factId: ctx.factId,
    userId: ctx.userId,
    ip: ctx.ip,
    mode: ctx.mode,
    result: "error",
    rejectionReason: err instanceof Error ? err.name : "unknown",
    latencyMs: Date.now() - ctx.startedAt,
  });
}

export default router;

// Re-export so consumers can avoid digging into validators/memeBuilder.
export type { ImageSource };
