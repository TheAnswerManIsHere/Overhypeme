import {
  FACT_TEXT_EDIT_CODES,
  type ApprovedFactTextEditImpact,
  type ConfirmTextEdit,
  type PrepDispatchState,
} from "@workspace/api-zod";

/**
 * Typed client for PATCH /admin/facts/:id — turns the endpoint's success body
 * and its typed 409/422 codes into a discriminated result the Facts editor can
 * branch on without string-matching. Deliberate outcomes (confirmation needed,
 * stale baseline, blockers) are distinct from an ordinary error so the caller
 * can open the right modal instead of flashing a red "Save failed".
 */
export type PatchFactDraftResult<F> =
  | { kind: "saved"; fact: F; auditRowId?: number; prepDispatch?: PrepDispatchState }
  | { kind: "confirmation_required"; impact: ApprovedFactTextEditImpact }
  | { kind: "stale_baseline"; impact: ApprovedFactTextEditImpact }
  | { kind: "staging_prep_in_progress" }
  | { kind: "error"; message: string };

export async function patchFactDraft<F>(
  factId: number,
  body: Record<string, unknown>,
  confirmation?: ConfirmTextEdit,
): Promise<PatchFactDraftResult<F>> {
  let res: Response;
  try {
    res = await fetch(`/api/admin/facts/${factId}`, {
      method: "PATCH",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, ...(confirmation ? { confirmTextEdit: confirmation } : {}) }),
    });
  } catch {
    return { kind: "error", message: "Network error — could not reach the server." };
  }

  const data = (await res.json().catch(() => ({}))) as {
    fact?: F;
    auditRowId?: number;
    prepDispatch?: PrepDispatchState;
    impact?: ApprovedFactTextEditImpact;
    code?: string;
    error?: string;
  };

  if (res.ok && data.fact) {
    return {
      kind: "saved",
      fact: data.fact,
      auditRowId: data.auditRowId,
      prepDispatch: data.prepDispatch,
    };
  }

  switch (data.code) {
    case FACT_TEXT_EDIT_CODES.REQUIRES_CONFIRMATION:
      if (data.impact) return { kind: "confirmation_required", impact: data.impact };
      break;
    case FACT_TEXT_EDIT_CODES.STALE_BASELINE:
      if (data.impact) return { kind: "stale_baseline", impact: data.impact };
      break;
    case FACT_TEXT_EDIT_CODES.STAGING_PREP_IN_PROGRESS:
      return { kind: "staging_prep_in_progress" };
  }
  return { kind: "error", message: data.error ?? "Save failed" };
}
