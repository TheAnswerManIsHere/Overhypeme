/**
 * Pure, import-safe backfill transform for retiring the never-valid "They's"
 * render from stored fact templates.
 *
 * Lives in its own module — separate from the CLI script
 * (`scripts/backfill-expand-subject-contractions.ts`) — specifically so it can
 * be unit-tested by importing this file directly, without pulling in the CLI's
 * `installStdioGuard()` call, the `db` connection, or `void main()` side
 * effects. The script imports this module and does nothing else but I/O.
 *
 * Expands BOTH forms that can produce "They's":
 *   1. The current deterministic contraction `{Subj}'s` / `{SUBJ}'s` — the
 *      same `expandSubjectContractions` pass every template-writing ingress
 *      now runs (see templateGrammar.ts). Included here so the backfill
 *      catches any row that predates that ingress guarantee.
 *   2. The legacy token `{He's}` / `{he's}` (a single brace-wrapped token,
 *      distinct from #1's bare "'s" after a simple token) that
 *      `render-fact.ts` still substitutes for backward compatibility but
 *      that is NOT in the closed grammar set — relevant only to old stored
 *      rows, so it stays in this backfill-only module rather than the shared
 *      api-zod grammar contract.
 *
 * Both expand to an explicit {is|are} pair, matching the deterministic net's
 * "ambiguous is/has defaults to the copula" rule. Pure and idempotent —
 * running it twice equals running it once.
 */

import { expandSubjectContractions, HAS_ONLY_FOLLOWING_WORDS } from "./templateGrammar";

// The legacy {He's}/{he's} token — apostrophe INSIDE the braces, unlike the
// {Subj}'s/{SUBJ}'s contraction (apostrophe after a closed brace) that
// `expandSubjectContractions` already handles.
const LEGACY_HES_TOKEN_RE = /\{(He's|he's)\}/g;

/**
 * Expands the legacy `{He's}`/`{he's}` token, applying the same
 * `HAS_ONLY_FOLLOWING_WORDS` disambiguation as `expandSubjectContractions` so
 * "{He's} got the keys" backfills to "{Subj} {has|have} got the keys", not
 * the guaranteed-ungrammatical "They are got the keys".
 */
export function expandSubjectContractionsForBackfill(template: string): string {
  if (!template) return template;
  const legacyExpanded = template.replace(
    LEGACY_HES_TOKEN_RE,
    (match: string, token: string, offset: number, full: string) => {
      const subj = token === "He's" ? "{Subj}" : "{SUBJ}";
      const rest = full.slice(offset + match.length);
      const nextWord = /^\s+([A-Za-z]+)/.exec(rest)?.[1]?.toLowerCase();
      const aux = nextWord && HAS_ONLY_FOLLOWING_WORDS.has(nextWord) ? "has|have" : "is|are";
      return `${subj} {${aux}}`;
    },
  );
  return expandSubjectContractions(legacyExpanded);
}
