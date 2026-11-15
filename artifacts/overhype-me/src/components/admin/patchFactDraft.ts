import { FACT_TEXT_EDIT_CODES } from "@workspace/api-zod";

/**
 * Typed client for PATCH /admin/facts/:id — turns the endpoint's success body
 * and its typed refusal into a discriminated result the Facts editor branches
 * on without string-matching. A fact's wording is locked once accepted (plan
 * PLAN_THREE_GAGS.md, increment 3), so the editor never sends a changed
 * wording; `wording_locked` is the server's answer if one arrives anyway.
 */
export type PatchFactDraftResult<F> =
  | { kind: "saved"; fact: F }
  | { kind: "wording_locked"; message: string }
  | { kind: "error"; message: string };

export async function patchFactDraft<F>(factId: number, body: Record<string, unknown>): Promise<PatchFactDraftResult<F>> {
  let res: Response;
  try {
    res = await fetch(`/api/admin/facts/${factId}`, {
      method: "PATCH",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    return { kind: "error", message: "Network error — could not reach the server." };
  }

  const data = (await res.json().catch(() => ({}))) as { fact?: F; code?: string; error?: string };
  if (res.ok && data.fact) return { kind: "saved", fact: data.fact };
  if (data.code === FACT_TEXT_EDIT_CODES.WORDING_LOCKED) {
    return { kind: "wording_locked", message: data.error ?? "A fact's wording can't be changed once it is accepted." };
  }
  return { kind: "error", message: data.error ?? "Save failed" };
}
