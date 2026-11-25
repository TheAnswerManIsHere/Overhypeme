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
  /** The slot (1–3) of the gag the record acted on, or null (Issue #1284). */
  gagSlot?: number | null;
  /** The picture a render record is about, or null (Issue #1284). */
  picture?: "male" | "female" | "pet" | null;
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

/** What the record acted on, in words: "Gag 2 · pet picture" (Issue #1284). */
export function historySubject(entry: Pick<FactHistoryEntry, "gagSlot" | "picture">): string | null {
  const parts = [entry.gagSlot != null ? `Gag ${entry.gagSlot}` : null, entry.picture ? `${entry.picture} picture` : null];
  return parts.filter(Boolean).join(" · ") || null;
}

/** One record in words; an action this build does not know is shown by its name. */
export function describeHistory(entry: FactHistoryEntry): { title: string; subject: string | null; detail: string | null } {
  const subject = historySubject(entry);
  const words = (HISTORY_WORDS as Record<string, (typeof HISTORY_WORDS)[AdminAction] | undefined>)[entry.action];
  if (!words) return { title: entry.action, subject, detail: null };
  return { title: words.title, subject, detail: words.detail?.(entry.detail ?? {}) ?? null };
}

/** One labelled part of a record's full detail; `lines` are shown one per line. */
export interface HistoryField { label: string; lines: string[] }

const BUBBLE_WORD: Record<string, string> = { speech: "Speech bubble", thought: "Thought bubble" };

/** A gag's content in full: its scene, every bubble, and the lists an admin wrote (Issue #1284). */
function gagFields(content: unknown): HistoryField[] {
  if (!content || typeof content !== "object") return [];
  const c = content as Record<string, unknown>;
  const out: HistoryField[] = [];
  const sceneText = str(c["coreSceneOverride"]);
  out.push({ label: "Scene", lines: [sceneText ?? "No scene written"] });
  const bubbles = Array.isArray(c["bubbles"]) ? (c["bubbles"] as Record<string, unknown>[]) : [];
  out.push({
    label: "Bubbles",
    lines: bubbles.length
      ? bubbles.map((b) => `${BUBBLE_WORD[String(b?.["type"])] ?? "Bubble"}${str(b?.["entity"]) ? ` (${str(b?.["entity"])})` : ""}: “${str(b?.["text"]) ?? ""}”`)
      : ["None"],
  });
  const cast = Array.isArray(c["cast"])
    ? (c["cast"] as Record<string, unknown>[]).map((e) => [str(e?.["label"]), str(e?.["description"])].filter(Boolean).join(": ")).filter(Boolean)
    : [];
  if (cast.length) out.push({ label: "Also in the scene", lines: cast });
  for (const [key, label] of [["requiredVisualDetails", "Must show"], ["forbiddenVisualDetails", "Must not show"], ["compositionGuidance", "Composition"]] as const) {
    const items = list(c[key]);
    if (items.length) out.push({ label, lines: items });
  }
  return out;
}

/** The plain words for a stored detail field; anything else is shown by its own name. */
const FIELD_LABEL: Record<string, string> = {
  text: "Text", from: "Before", original: "Original wording", adminNote: "Admin note", reason: "Reason",
  outcome: "Outcome", hashtags: "Hashtags", added: "Added", removed: "Removed", kinds: "Pictures",
  redraw: "Redraw", stage: "Step", gagsDiscarded: "Gags discarded", published: "Gags published",
  reverted: "Gags put back", edited: "Edited", withDraft: "With a draft", noteChanged: "After the Humor Note changed",
  referenceIdentityType: "Picture", lookStyleId: "Look", readingId: "Reading", attemptId: "Picture id",
  gagId: "Gag id", changed: "Changed", after: "After", factId: "Fact",
};

function valueLines(v: unknown): string[] {
  if (v == null || v === "") return [];
  if (typeof v === "boolean") return [v ? "Yes" : "No"];
  if (typeof v === "string" || typeof v === "number") return [String(v)];
  if (Array.isArray(v)) return v.map((x) => (typeof x === "string" || typeof x === "number" ? String(x) : JSON.stringify(x)));
  if (typeof v === "object") return Object.keys(v as object).length ? [Object.keys(v as object).join(", ")] : [];
  return [String(v)];
}

/**
 * Everything a record stores, in words, for the line's opened view (Issue
 * #1284): what it acted on, a gag's full content, then every other field.
 */
export function historyFields(entry: FactHistoryEntry): HistoryField[] {
  const out: HistoryField[] = [];
  const subject = historySubject(entry);
  if (subject) out.push({ label: "About", lines: [subject] });
  const d = entry.detail ?? {};
  out.push(...gagFields(d["content"]));
  for (const [key, v] of Object.entries(d)) {
    if (key === "content") continue;
    const lines = valueLines(v);
    if (lines.length) out.push({ label: FIELD_LABEL[key] ?? key, lines });
  }
  return out;
}
