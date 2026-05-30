/**
 * Admin reference-research endpoint.
 *
 *   POST /admin/references/research
 *     Body: { factText, sourcePhrase, referenceType, canonicalReference,
 *              existingExplanation?, existingVisualImplication?, adminNotes?,
 *              forceRefresh? }
 *     Returns: { result, fromCache, cacheKey }
 *
 * The route is admin-only. The result is NOT persisted by this endpoint —
 * the frontend applies it into the enrichment-editor form state, then the
 * existing save/approve flow persists the edited cultural reference (with
 * the optional research metadata stamped on it).
 */

import { Router, type IRouter, type Request, type Response } from "express";
import { requireAdmin } from "./admin";
import {
  researchCulturalReference,
  ReferenceResearchError,
} from "../lib/referenceResearch";
import { logger } from "../lib/logger";

const router: IRouter = Router();

interface ResearchReferenceBody {
  factText?: unknown;
  sourcePhrase?: unknown;
  referenceType?: unknown;
  canonicalReference?: unknown;
  existingExplanation?: unknown;
  existingVisualImplication?: unknown;
  adminNotes?: unknown;
  forceRefresh?: unknown;
}

function asStr(v: unknown, max: number): string {
  if (typeof v !== "string") return "";
  const s = v.trim();
  return s.length > max ? s.slice(0, max) : s;
}

router.post("/admin/references/research", requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const body = (req.body && typeof req.body === "object" ? req.body : {}) as ResearchReferenceBody;

  const factText = asStr(body.factText, 2000);
  const sourcePhrase = asStr(body.sourcePhrase, 300);
  const referenceType = asStr(body.referenceType, 80);
  const canonicalReference = asStr(body.canonicalReference, 300);
  const existingExplanation = asStr(body.existingExplanation, 1200);
  const existingVisualImplication = asStr(body.existingVisualImplication, 1200);
  const adminNotes = asStr(body.adminNotes, 1200);
  const forceRefresh = body.forceRefresh === true;

  if (!factText) {
    res.status(400).json({ error: "factText is required" });
    return;
  }
  if (!sourcePhrase && !canonicalReference) {
    res.status(400).json({ error: "sourcePhrase or canonicalReference must be present" });
    return;
  }
  if (!referenceType) {
    res.status(400).json({ error: "referenceType is required" });
    return;
  }

  try {
    const outcome = await researchCulturalReference(
      {
        factText,
        sourcePhrase,
        referenceType,
        canonicalReference,
        ...(existingExplanation ? { existingExplanation } : {}),
        ...(existingVisualImplication ? { existingVisualImplication } : {}),
        ...(adminNotes ? { adminNotes } : {}),
      },
      { forceRefresh },
    );
    res.json({
      result: outcome.result,
      fromCache: outcome.fromCache,
      cacheKey: outcome.cacheKey,
    });
  } catch (err) {
    if (err instanceof ReferenceResearchError) {
      if (err.phase === "input") {
        res.status(400).json({ error: err.message });
        return;
      }
      if (err.phase === "openai") {
        logger.warn({ err }, "[adminReferenceResearch] OpenAI call failed");
        res.status(502).json({ error: "research_provider_unavailable", details: err.message });
        return;
      }
      if (err.phase === "validation") {
        logger.warn({ err }, "[adminReferenceResearch] result validation failed");
        res.status(502).json({ error: "research_validation_failed", details: err.message });
        return;
      }
    }
    logger.error({ err }, "[adminReferenceResearch] unexpected failure");
    res.status(500).json({ error: "internal_error" });
  }
});

export default router;
