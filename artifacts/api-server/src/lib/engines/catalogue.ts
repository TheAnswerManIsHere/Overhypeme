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
import { PULID_FLUX } from "./pulid-flux";
import { FAL_AUTO_SUBTITLE } from "./fal-auto-subtitle";

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
  PULID_FLUX,
  FAL_AUTO_SUBTITLE,
];
