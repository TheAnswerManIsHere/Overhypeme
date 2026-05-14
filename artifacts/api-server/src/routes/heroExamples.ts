/**
 * MBFO-2: hero examples for the wizard's Step 1.
 *
 *   GET /api/hero-examples                  → { image: [], video: [] }
 *   GET /api/hero-examples?artifact_type=image  → { image: [] }   (single key)
 *   GET /api/hero-examples?artifact_type=video  → { video: [] }
 *
 * Returns active rows only, ordered by sort_order then id, capped at 10 per
 * type. No auth required — this is public marketing content for the wizard.
 *
 * The client randomizes which row it actually shows per visit. Server-side
 * randomization would defeat HTTP caching.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import {
  heroExamplesTable,
  HERO_EXAMPLE_ARTIFACT_TYPES,
  type HeroExample,
  type HeroExampleArtifactType,
} from "@workspace/db/schema";
import { and, asc, eq } from "drizzle-orm";

const router: IRouter = Router();

const MAX_PER_TYPE = 10;

export interface HeroExampleDTO {
  id: number;
  artifactType: HeroExampleArtifactType;
  assetUrl: string;
  posterUrl: string | null;
  captionLabel: string;
}

function toDto(row: HeroExample): HeroExampleDTO {
  return {
    id: row.id,
    artifactType: row.artifactType as HeroExampleArtifactType,
    assetUrl: row.assetUrl,
    posterUrl: row.posterUrl,
    captionLabel: row.captionLabel,
  };
}

function isArtifactType(v: unknown): v is HeroExampleArtifactType {
  return typeof v === "string" && (HERO_EXAMPLE_ARTIFACT_TYPES as readonly string[]).includes(v);
}

async function fetchFor(artifactType: HeroExampleArtifactType): Promise<HeroExampleDTO[]> {
  const rows = await db
    .select()
    .from(heroExamplesTable)
    .where(and(
      eq(heroExamplesTable.artifactType, artifactType),
      eq(heroExamplesTable.active, true),
    ))
    .orderBy(asc(heroExamplesTable.sortOrder), asc(heroExamplesTable.id))
    .limit(MAX_PER_TYPE);
  return rows.map(toDto);
}

router.get("/hero-examples", async (req: Request, res: Response) => {
  const filter = req.query.artifact_type;

  if (filter !== undefined) {
    if (!isArtifactType(filter)) {
      res.status(400).json({
        error: `Invalid artifact_type. Expected one of: ${HERO_EXAMPLE_ARTIFACT_TYPES.join(", ")}`,
      });
      return;
    }
    const rows = await fetchFor(filter);
    res.json({ [filter as string]: rows });
    return;
  }

  const [image, video] = await Promise.all([fetchFor("image"), fetchFor("video")]);
  res.json({ image, video });
});

export default router;
