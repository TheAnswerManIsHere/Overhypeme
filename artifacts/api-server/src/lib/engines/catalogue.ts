/**
 * Engine catalogue array. Lives in its own module (rather than in index.ts)
 * because the reconciler imports it; routing it through the barrel would
 * create a cycle (index → reconcile → index) that the check-cycles linter
 * blocks.
 */

import type { EngineDefinition } from "./types";
import { NANO_BANANA_PRO } from "./nano-banana-pro";
import { NANO_BANANA_PRO_T2I } from "./nano-banana-pro-t2i";
import { NANO_BANANA_2 } from "./nano-banana-2";
import { NANO_BANANA_2_EDIT } from "./nano-banana-2-edit";
import { FLUX_PRO_V1_1 } from "./flux-pro-v1-1";
import { FLUX_2_PRO } from "./flux-2-pro";
import { GPT_IMAGE_2 } from "./gpt-image-2";
import { GPT_IMAGE_2_EDIT } from "./gpt-image-2-edit";
import { FAL_YOLO_WORLD } from "./fal-yolo-world";
import { OPENAI_GENERAL } from "./openai-general";
import { GPT_IMAGE_2_5, GPT_IMAGE_2_5_EDIT } from "./gpt-image-2-5";
import { NANO_BANANA_2_1, NANO_BANANA_2_1_EDIT } from "./nano-banana-2-1";
import { FLUX_3, FLUX_3_EDIT } from "./flux-3";
import { SEEDREAM_5_PRO, SEEDREAM_5_PRO_EDIT } from "./seedream-5-pro";
import { MUSE_IMAGE, MUSE_IMAGE_EDIT } from "./muse-image";
import { OPENAI_VISUAL_PLANNER } from "./openai-visual-planner";
import { OPENAI_ENRICHER } from "./openai-enricher";

/**
 * Code-first engine catalogue. To add a new engine: drop a new file in this
 * directory and append its export here. The boot reconciliation
 * (`reconcile.ts`) upserts each entry into the `engines` table at server
 * start.
 */
export const ALL_ENGINES: EngineDefinition[] = [
  NANO_BANANA_PRO,
  NANO_BANANA_PRO_T2I,
  NANO_BANANA_2,
  NANO_BANANA_2_EDIT,
  FLUX_PRO_V1_1,
  FLUX_2_PRO,
  GPT_IMAGE_2,
  GPT_IMAGE_2_EDIT,
  // Launch Phase 8 candidates, as text-to-image + edit pairs (`family`).
  GPT_IMAGE_2_5,
  GPT_IMAGE_2_5_EDIT,
  NANO_BANANA_2_1,
  NANO_BANANA_2_1_EDIT,
  FLUX_3,
  FLUX_3_EDIT,
  SEEDREAM_5_PRO,
  SEEDREAM_5_PRO_EDIT,
  MUSE_IMAGE,
  MUSE_IMAGE_EDIT,
  FAL_YOLO_WORLD,
  OPENAI_GENERAL,
  OPENAI_VISUAL_PLANNER,
  OPENAI_ENRICHER,
];
