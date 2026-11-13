/** The refusal or error an admin comparison route answered with, in words. */
export async function readError(r: Response): Promise<string> {
  const body = (await r.json().catch(() => null)) as { error?: string; reasons?: string[]; refusal?: string } | null;
  if (body?.refusal && body.reasons?.length) return `${body.refusal}: ${body.reasons.join("; ")}`;
  if (body?.reasons?.length) return body.reasons.join("; ");
  if (body?.refusal) return body.refusal;
  return body?.error ?? `request failed (${r.status})`;
}
