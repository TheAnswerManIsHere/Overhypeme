/**
 * @purpose One LIKE/ILIKE "contains" pattern for user-typed search text, with the pattern's own wildcards (%, _ and the escape character) escaped so they match literally.
 * @subsystem public-site
 */

/** `%term%`, with `\`, `%` and `_` in `term` escaped for Postgres's default LIKE escape character. */
export function likeContains(term: string): string {
  return `%${term.replace(/[\\%_]/g, "\\$&")}%`;
}
