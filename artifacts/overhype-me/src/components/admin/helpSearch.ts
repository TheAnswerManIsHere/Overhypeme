import type { HelpSearchEntry } from "@/generated/help/searchIndex";

export interface HelpSearchHit {
  doc: string;
  docTitle: string;
  section: string;
  sectionTitle: string;
  /** A short window of the matching text, for the result row. */
  snippet: string;
  score: number;
}

const MAX_HITS = 30;
const SNIPPET_RADIUS = 70;

function snippetAround(text: string, at: number, termLen: number): string {
  const start = Math.max(0, at - SNIPPET_RADIUS);
  const end = Math.min(text.length, at + termLen + SNIPPET_RADIUS);
  return `${start > 0 ? "…" : ""}${text.slice(start, end).trim()}${end < text.length ? "…" : ""}`;
}

/**
 * Substring search over the build-time index, ranked crudely and on purpose.
 *
 * Ranking quality is deliberately unspecified by the plan — it is observable,
 * tunable, and cheaply fixed. What the plan DOES constrain is what the index
 * contains (rendered-visible text only, attributed to its nearest heading),
 * and that lives in the generator, not here.
 */
export function searchHelp(
  index: HelpSearchEntry[],
  query: string,
  titleFor: (docSlug: string) => string,
): HelpSearchHit[] {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];

  const hits: HelpSearchHit[] = [];
  for (const entry of index) {
    const haystack = entry.text.toLowerCase();
    const at = haystack.indexOf(q);
    const inTitle = entry.sectionTitle.toLowerCase().includes(q);
    if (at === -1 && !inTitle) continue;

    // A heading match beats a body match; an earlier body match beats a later
    // one. Enough to be useful, cheap enough to not pretend it is more.
    const score = (inTitle ? 1000 : 0) + (at === -1 ? 0 : Math.max(0, 500 - at));
    hits.push({
      doc: entry.doc,
      docTitle: titleFor(entry.doc),
      section: entry.section,
      sectionTitle: entry.sectionTitle,
      snippet: at === -1 ? snippetAround(entry.text, 0, 0) : snippetAround(entry.text, at, q.length),
      score,
    });
  }

  return hits.sort((a, b) => b.score - a.score).slice(0, MAX_HITS);
}
