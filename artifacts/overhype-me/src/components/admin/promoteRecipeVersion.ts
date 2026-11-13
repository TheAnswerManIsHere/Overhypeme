import { readError } from "@/components/admin/readError";

/**
 * Fired on `window` after a version is saved or promoted, so every view of
 * the recipe listing on the page re-reads it (the wording editor and the
 * comparison panel are siblings on the Eval page; PR #927 round 1).
 */
export const RECIPES_CHANGED_EVENT = "prompt-recipes-changed";
export function announceRecipesChanged(): void {
  window.dispatchEvent(new Event(RECIPES_CHANGED_EVENT));
}

/**
 * Promote a prompt-recipe version (or the baseline, `versionId` null) to live
 * for its engine family — plan PLAN_PROMPT_TUNER.md, D. One confirmation, and a
 * second when the server answers that the version changes a policy line. Shared
 * by the wording editor and a prompt comparison's results, so the promotion
 * contract lives in one place.
 *
 * Returns null when the admin cancelled; otherwise whether it worked and the
 * message to show.
 */
export async function promoteRecipeVersion(args: {
  family: string;
  versionId: number | null;
  name: string;
  /** Turns a changed policy piece's key into the label the admin knows it by. */
  labelFor?: (key: string) => string;
}): Promise<{ ok: boolean; message: string } | null> {
  const { family, versionId, name, labelFor = (k) => k } = args;
  if (!window.confirm(`Make ${name} live for ${family}? Renders on its engines use this wording from now on.`)) return null;
  const send = (confirmPolicy: boolean) => fetch(`/api/admin/prompt-recipes/${family}/promote`, {
    method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ versionId, ...(confirmPolicy ? { confirmPolicy: true } : {}) }),
  }).catch(() => null);
  let r = await send(false);
  if (r && r.status === 409) {
    const body = await r.clone().json().catch(() => ({})) as { needsPolicyConfirmation?: boolean; changedPolicy?: string[] };
    if (body.needsPolicyConfirmation) {
      const lines = (body.changedPolicy ?? []).map(labelFor).join(", ");
      if (!window.confirm(`${name} changes policy wording: ${lines}. Promote it anyway?`)) return null;
      r = await send(true);
    }
  }
  if (!r) return { ok: false, message: "The request failed." };
  if (!r.ok) return { ok: false, message: await readError(r) };
  announceRecipesChanged();
  return { ok: true, message: `${name} is now live for ${family}.` };
}
