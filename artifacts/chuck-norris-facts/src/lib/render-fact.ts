/**
 * Replace {Name} token in a fact string with the user's chosen name.
 */
export function renderFact(text: string, name: string): string {
  return text.replace(/\{Name\}/g, name || DEFAULT_NAME);
}

const DEFAULT_NAME = "David Franklin";

/**
 * Tokenize "Chuck Norris" (or any two-word name pattern already stored
 * as the old tokens) in user-submitted text so it can be personalized.
 */
export function tokenizeFact(text: string): string {
  return text
    .replace(/\{First_Name\}\s*\{Last_Name\}/g, "{Name}")
    .replace(/\bchuck norris\b/gi, "{Name}");
}
