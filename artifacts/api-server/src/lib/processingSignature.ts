/**
 * Server-side wrapper that reads the manual `engine_revision` marker from
 * admin_config and composes it with the pure api-zod code-version constants
 * into the current ProcessingSignature. Kept out of api-zod because api-zod has
 * no DB access.
 *
 * `engine_revision` is read RAW (bypassing the debug overlay): it's an
 * audit-bearing corpus-invalidation marker, so a debug value must never make
 * facts appear stale/fresh under a revision that was never formally bumped.
 */

import { currentProcessingSignature, type ProcessingSignature } from "@workspace/api-zod";
import { getConfigIntRaw } from "./adminConfig";

export const ENGINE_REVISION_CONFIG_KEY = "engine_revision";

export async function currentEngineRevision(): Promise<number> {
  return getConfigIntRaw(ENGINE_REVISION_CONFIG_KEY, 1);
}

export async function currentProcessingSignatureFromConfig(): Promise<ProcessingSignature> {
  return currentProcessingSignature(await currentEngineRevision());
}
