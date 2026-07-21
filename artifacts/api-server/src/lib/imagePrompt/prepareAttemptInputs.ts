/**
 * Canonical, side-effect-free preparation of the frozen inputs for an
 * image-prompt attempt (rev-7 plan §11.0).
 *
 * Resolves — ONCE, in one place — the two inputs that today's async worker
 * re-derives LIVE at run time (and can therefore silently diverge on): the
 * prompt-identity snapshot and the resolved-style snapshot. It then renders
 * the fact text FROM the same reduced identity, so the frozen fact text and
 * the compiler's later token gate can never use two different identities.
 *
 * Side-effect-free except for the unavoidable DB reads its resolvers do (user
 * lookup, look_styles lookup). It writes nothing and enqueues nothing — the
 * caller persists the returned snapshots onto the attempt and enqueues. That
 * separation is what lets the workbench/preview path call this for its inputs
 * WITHOUT creating an attempt row.
 *
 * Returns a typed domain result; the caller adapts (an HTTP route maps
 * `style_invalid` to 4xx, a batch maps it to a failed scenario) — this helper
 * never knows about HTTP.
 */

import type { GenerationMode } from "@workspace/api-zod";
import { renderPersonalized, hasUnresolvedFactTokens } from "../renderCanonical";
import {
  type PromptIdentitySnapshot,
  resolvePromptIdentityForUser,
  resolvePromptIdentityFromSample,
  resolvePromptIdentityForWorkbench,
  canonicalPromptIdentity,
} from "./promptIdentity";
import {
  type ResolvedRenderStyleSnapshot,
  type StyleInvalidReason,
  resolveRenderStyle,
  freezeRenderStyleSnapshot,
} from "./styleResolution";

/** How to source the identity for this attempt. */
export type PrepareIdentityInput =
  | { kind: "user"; userId: string | null }
  | { kind: "sample"; sample: { name: string; pronouns: string | null }; source: "review_sample" | "eval_sample" }
  | { kind: "workbench"; name: string; pronouns: string | null };

export interface PrepareAttemptInputsArgs {
  /** The fact TEMPLATE ({NAME}/{SUBJ}/… still present). */
  factTemplate: string;
  identity: PrepareIdentityInput;
  styleId: string | null | undefined;
  generationMode: GenerationMode;
}

export interface PreparedAttemptInputs {
  promptIdentity: PromptIdentitySnapshot;
  /** The template rendered against the (reduced) prompt identity — token-free. */
  renderedFactText: string;
  resolvedRenderStyle: ResolvedRenderStyleSnapshot;
}

export type PrepareAttemptInputsResult =
  | { ok: true; prepared: PreparedAttemptInputs }
  | { ok: false; error: "style_invalid"; styleId: string; reason: StyleInvalidReason }
  | { ok: false; error: "fact_template_unresolved"; renderedFactText: string };

async function resolveIdentitySnapshot(identity: PrepareIdentityInput): Promise<PromptIdentitySnapshot> {
  switch (identity.kind) {
    case "user":
      return identity.userId ? resolvePromptIdentityForUser(identity.userId) : canonicalPromptIdentity();
    case "sample":
      return resolvePromptIdentityFromSample(identity.sample, identity.source);
    case "workbench":
      return resolvePromptIdentityForWorkbench(identity.name, identity.pronouns);
  }
}

/**
 * Resolve + freeze the attempt's identity and style, and render the fact text
 * from the identity. Pure of writes/enqueues. See module docstring.
 */
export async function prepareImagePromptAttemptInputs(
  args: PrepareAttemptInputsArgs,
): Promise<PrepareAttemptInputsResult> {
  const promptIdentity = await resolveIdentitySnapshot(args.identity);

  const renderedFactText = renderPersonalized(args.factTemplate, promptIdentity.name, promptIdentity.pronouns);
  if (hasUnresolvedFactTokens(renderedFactText)) {
    return { ok: false, error: "fact_template_unresolved", renderedFactText };
  }

  const style = await resolveRenderStyle(args.styleId, args.generationMode);
  if (style.selection === "invalid") {
    return { ok: false, error: "style_invalid", styleId: style.styleId, reason: style.reason };
  }
  const resolvedRenderStyle = freezeRenderStyleSnapshot(style, "frozen");

  return { ok: true, prepared: { promptIdentity, renderedFactText, resolvedRenderStyle } };
}
