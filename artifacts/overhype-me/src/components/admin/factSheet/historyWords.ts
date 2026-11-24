/**
 * @purpose The fact sheet's History tab in words: what each admin-action record says, read from its action and detail.
 * @subsystem moderation
 *
 * Plan docs/plans/PLAN_FACT_LIFECYCLE_REBUILD.md, 3C and oracle item 22. The
 * vocabulary is api-zod's ADMIN_ACTION_VALUES, which every writer records
 * with; keyed by it here, so a new action fails the build until it has words.
 * The detail shapes are each writer's (api-server lib/factSheet.ts,
 * lib/factLifecycle.ts, routes/reviews.ts, routes/gags.ts, routes/admin.ts);
 * a field missing from an older record is left out of the line, never guessed.
 */
import type { AdminAction } from "@workspace/api-zod";

export interface FactHistoryEntry {
  id: number;
  action: string;
  reviewId: number | null;
  actorId: string | null;
  actorName: string | null;
  detail: Record<string, unknown>;
  createdAt: string;
}

type Detail = Record<string, unknown>;

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** A quoted excerpt, kept to one line. */
function quote(v: unknown, max = 140): string | null {
  const s = str(v);
  if (!s) return null;
  const one = s.replace(/\s+/g, " ");
  return `“${one.length > max ? `${one.slice(0, max - 1)}…` : one}”`;
}

/** The scene a gag record carried, quoted. */
function scene(d: Detail): string | null {
  const content = d["content"] as { coreSceneOverride?: unknown } | null | undefined;
  return quote(content?.coreSceneOverride);
}

/** Counts that are non-zero, in words: "1 gag published, 1 removed". */
function counts(parts: [number | null, string][]): string | null {
  const said = parts.filter(([n]) => n != null && n > 0).map(([n, w]) => `${n} ${w}`);
  return said.length ? said.join(", ") : null;
}

/** Each action: a short title, and a line of detail when the record carries one. */
export const HISTORY_WORDS: Record<AdminAction, { title: string; detail?: (d: Detail) => string | null }> = {
  provisional_approval: { title: "Provisionally approved", detail: (d) => quote(d["adminNote"]) },
  wording_edit: { title: "Wording edited at Triage", detail: (d) => quote(d["text"]) },
  duplicate_check: { title: "Duplicate check", detail: (d) => str(d["outcome"]) },
  reading_requested: { title: "Reading requested" },
  reading_approval: { title: "Humor Note approved", detail: (d) => quote(d["text"]) },
  humor_note_save: { title: "Humor Note saved", detail: (d) => quote(d["text"]) },
  hashtags_save: {
    title: "Hashtags changed",
    detail: (d) => {
      const added = list(d["added"]);
      const removed = list(d["removed"]);
      const parts = [added.length ? `added ${added.map((t) => `#${t}`).join(", ")}` : null, removed.length ? `removed ${removed.map((t) => `#${t}`).join(", ")}` : null];
      return parts.filter(Boolean).join("; ") || null;
    },
  },
  gag_approval: { title: "Gags approved, on to Test Renders" },
  back_to_gags: { title: "Sent back to the Gags step" },
  test_renders_requested: { title: "Test renders requested" },
  approve_for_production: {
    title: "Approved for production",
    detail: (d) => {
      const tags = list(d["hashtags"]);
      return [tags.length ? tags.map((t) => `#${t}`).join(" ") : null, quote(d["adminNote"])].filter(Boolean).join(" · ") || null;
    },
  },
  reject: { title: "Rejected", detail: (d) => [str(d["reason"]), quote(d["adminNote"])].filter(Boolean).join(" · ") || null },
  classification_edit: { title: "Taxonomy edited" },
  classification_rerun: { title: "Taxonomy re-run requested" },
  fact_edit: {
    title: "Fact edited (old editor)",
    detail: (d) => {
      const changed = d["changed"];
      return changed && typeof changed === "object" ? Object.keys(changed).join(", ") || null : null;
    },
  },
  publish: {
    title: "Changes published",
    detail: (d) => counts([[num(d["published"]), num(d["published"]) === 1 ? "gag published" : "gags published"], [num(d["removed"]), "removed"]]),
  },
  discard: {
    title: "Changes discarded",
    detail: (d) => counts([[num(d["reverted"]), num(d["reverted"]) === 1 ? "gag put back" : "gags put back"], [num(d["removed"]), "unpublished removed"]]),
  },
  deactivate: { title: "Deactivated" },
  reactivate: { title: "Reactivated" },
  delete: { title: "Deleted permanently" },
  gag_create: { title: "Gag added", detail: scene },
  gag_save: { title: "Gag saved", detail: scene },
  gag_discard: { title: "Gag change discarded" },
  gag_remove: { title: "Gag removed" },
  gag_render_approval: { title: "Render approved" },
  gag_ideas_requested: { title: "Gag ideas requested", detail: (d) => (d["noteChanged"] === true ? "after the Humor Note changed" : null) },
  gag_renders_requested: {
    title: "Renders requested",
    detail: (d) => {
      const kinds = list(d["kinds"]);
      return [kinds.length ? kinds.join(", ") : null, d["redraw"] === true ? "redraw" : null].filter(Boolean).join(" · ") || null;
    },
  },
  import: { title: "Imported" },
  content_takedown: { title: "A member's meme or photo taken down" },
  stripe_event_replayed: { title: "Missed Stripe event replayed" },
};

/** One record in words; an action this build does not know is shown by its name. */
export function describeHistory(entry: FactHistoryEntry): { title: string; detail: string | null } {
  const words = (HISTORY_WORDS as Record<string, (typeof HISTORY_WORDS)[AdminAction] | undefined>)[entry.action];
  if (!words) return { title: entry.action, detail: null };
  return { title: words.title, detail: words.detail?.(entry.detail ?? {}) ?? null };
}
