/**
 * Engine catalogue array. Lives in its own module (rather than in index.ts)
 * because the reconciler imports it; routing it through the barrel would
 * create a cycle (index → reconcile → index) that the check-cycles linter
 * blocks.
 */

import type { EngineDefinition } from "./types";
import { VEO_3_1_LITE } from "./veo-3.1-lite";
import { VEO_3_1_FAST } from "./veo-3.1-fast";
import { KLING_V3_STANDARD } from "./kling-v3-standard";
import { SEEDANCE_2_0_FAST } from "./seedance-2.0-fast";
import { GROK_IMAGINE } from "./grok-imagine";
import { NANO_BANANA_PRO } from "./nano-banana-pro";
import { NANO_BANANA_PRO_T2I } from "./nano-banana-pro-t2i";
import { NANO_BANANA_2 } from "./nano-banana-2";
import { NANO_BANANA_2_EDIT } from "./nano-banana-2-edit";
import { PULID_FLUX } from "./pulid-flux";
import { FLUX_PRO_V1_1 } from "./flux-pro-v1-1";
import { FLUX_2_PRO } from "./flux-2-pro";
import { GPT_IMAGE_2 } from "./gpt-image-2";
import { GPT_IMAGE_2_EDIT } from "./gpt-image-2-edit";
import { FAL_AUTO_SUBTITLE } from "./fal-auto-subtitle";
import { FAL_YOLO_WORLD } from "./fal-yolo-world";
import { OPENAI_GENERAL } from "./openai-general";

/**
 * Code-first engine catalogue. To add a new engine: drop a new file in this
 * directory and append its export here. The boot reconciliation
 * (`reconcile.ts`) upserts each entry into the `engines` table at server
 * start.
 */
export const ALL_ENGINES: EngineDefinition[] = [
  VEO_3_1_LITE,
  VEO_3_1_FAST,
  KLING_V3_STANDARD,
  SEEDANCE_2_0_FAST,
  GROK_IMAGINE,
  NANO_BANANA_PRO,
  NANO_BANANA_PRO_T2I,
  NANO_BANANA_2,
  NANO_BANANA_2_EDIT,
  PULID_FLUX,
  FLUX_PRO_V1_1,
  FLUX_2_PRO,
  GPT_IMAGE_2,
  GPT_IMAGE_2_EDIT,
  FAL_AUTO_SUBTITLE,
  FAL_YOLO_WORLD,
  OPENAI_GENERAL,
];
