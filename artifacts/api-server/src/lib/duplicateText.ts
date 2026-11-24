/**
 * @purpose The punctuation-insensitive exact-match form of a fact's wording, for duplicate detection only.
 * @subsystem moderation
 *
 * The exact-match form of a fact's wording for duplicate detection (plan
 * docs/plans/PLAN_DUPLICATE_VERDICT.md): lower-cased, punctuation dropped, runs
 * of whitespace collapsed, ends trimmed. Template-token braces and the `|` of
 * `{does|do}` are kept, so a token-different template stays different.
 *
 * The one exception is the possessive name, which has two spellings that
 * render identically: `{NAME}'s` (most of the corpus) and `{NAME_POSSESSIVE}`
 * (what the tokenizer writes since PR #1177). `{name_possessive}` is folded to
 * `{name}s`, the form `{NAME}'s` takes once its apostrophe is dropped, so the
 * same fact in either spelling is one wording.
 *
 * Computed in SQL on BOTH sides of every comparison, so the database's notion
 * of a letter is the only one. Local to duplicate detection: bulk import's
 * exact-text dedupe keeps its own normalization.
 */
import { sql, type SQL, type SQLWrapper } from "drizzle-orm";

export function duplicateMatchText(value: SQLWrapper | string): SQL {
  return sql`btrim(regexp_replace(regexp_replace(replace(lower(${value}), '{name_possessive}', '{name}s'), '[^[:alnum:][:space:]{}|]', '', 'g'), '[[:space:]]+', ' ', 'g'))`;
}
