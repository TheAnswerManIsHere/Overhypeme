/**
 * Replace {First_Name} and {Last_Name} tokens in a fact string.
 * Falls back to the raw token text if either name part is empty.
 */
export function renderFact(text: string, firstName: string, lastName: string): string {
  return text
    .replace(/\{First_Name\}/g, firstName || "Chuck")
    .replace(/\{Last_Name\}/g, lastName || "Norris");
}

/**
 * Tokenize "Chuck Norris" in user-submitted text so it can be
 * personalized for any name at render time.
 */
export function tokenizeFact(text: string): string {
  return text.replace(/\bchuck norris\b/gi, "{First_Name} {Last_Name}");
}
