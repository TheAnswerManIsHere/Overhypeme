/**
 * The ways to use a visual idea on a fact's gags (plan
 * docs/plans/PLAN_THREE_GAGS.md, decision 9): in place of the default gag, as
 * an additional gag, or in place of a named one. Each saves the idea at once
 * as that gag's change, which reaches users only once a test render of it is
 * approved as the gag's example. Shared by the moderation review's Gags step
 * and the Facts editor's Draft more gags, so the two offer the same actions.
 */
import { useCallback, useMemo, useState } from "react";
import { EMPTY_VISUAL_STRATEGY_OVERRIDE, withCandidateConceptDraft, type FactGagsView, type VisualPromptStrategyOverride } from "@workspace/api-zod";
import type { ConceptAction } from "../VisualConceptCandidates";
import { ensureCast, gagApi, type GagResult } from "./gagApi";

/**
 * A used idea goes through the same preparation as an edited gag (plan
 * PLAN_GAG_DIRECT_RENDER.md, C): its cast is read from its scene before the
 * save, and a speaker the scene does not show stops it.
 */
async function withCastRead(factId: number, content: VisualPromptStrategyOverride, save: (c: VisualPromptStrategyOverride) => Promise<GagResult>): Promise<GagResult> {
  const r = await ensureCast(factId, content);
  return r.ok ? save(r.content) : { ok: false, error: `This idea cannot be used as it stands. ${r.error}` };
}

export function useGagIdeaActions(args: {
  factId: number;
  /** The review the actions come from; null in the Facts editor. */
  reviewId: number | null;
  /** The gags as the panel last loaded them; null until it has. */
  gagsView: FactGagsView | null;
  /** The server's view after an idea was used: reload the panel with it. */
  onApplied: (view: FactGagsView) => void;
  onError: (message: string) => void;
}): { actions: ConceptAction[]; saving: boolean } {
  const { factId, reviewId, gagsView, onApplied, onError } = args;
  // While an idea is being saved the panel's drafts would be replaced by its
  // response, so editing waits for it (Codex, PR #956 round 3).
  const [saving, setSaving] = useState(false);

  const apply = useCallback(async (run: () => ReturnType<typeof gagApi.load>) => {
    onError("");
    setSaving(true);
    try {
      const r = await run();
      if (!r.ok) { onError(r.error); return; }
      onApplied(r.view);
    } finally {
      setSaving(false);
    }
  }, [onApplied, onError]);

  const actions = useMemo((): ConceptAction[] => {
    if (!gagsView || factId <= 0) return [];
    const live = gagsView.gags.filter((g) => !g.pendingRemove);
    const contentOf = (g: (typeof live)[number]) => g.pendingContent ?? g.approvedContent ?? EMPTY_VISUAL_STRATEGY_OVERRIDE;
    const first = live.find((g) => g.isDefault) ?? live[0];
    const out: ConceptAction[] = [];
    if (!first) {
      out.push({ key: "first", label: "Use as the first gag", run: (c) => apply(() => withCastRead(factId, withCandidateConceptDraft(EMPTY_VISUAL_STRATEGY_OVERRIDE, c), (p) => gagApi.create(factId, p, reviewId))) });
      return out;
    }
    out.push({
      key: "default",
      label: "Use this instead of the current default gag",
      run: (c) => apply(() => withCastRead(factId, withCandidateConceptDraft(contentOf(first), c), (p) => gagApi.save(factId, first.id, p, reviewId))),
    });
    if (gagsView.gags.length < gagsView.maxGags) {
      out.push({
        key: "additional",
        label: "Use as an additional gag",
        run: (c) => apply(() => withCastRead(factId, withCandidateConceptDraft(EMPTY_VISUAL_STRATEGY_OVERRIDE, c), (p) => gagApi.create(factId, p, reviewId))),
      });
    }
    for (const g of live) {
      if (g.id === first.id) continue;
      out.push({
        key: `replace-${g.slot}`,
        label: `Replace gag ${g.slot}`,
        run: (c) => apply(() => withCastRead(factId, withCandidateConceptDraft(contentOf(g), c), (p) => gagApi.save(factId, g.id, p, reviewId))),
      });
    }
    return out;
  }, [gagsView, factId, reviewId, apply]);

  return { actions, saving };
}
