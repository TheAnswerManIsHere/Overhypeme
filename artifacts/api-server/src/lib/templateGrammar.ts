const ALLOWED_SIMPLE_TOKENS = new Set([
  "NAME",
  "SUBJ", "Subj",
  "OBJ", "Obj",
  "POSS", "Poss",
  "POSS_PRO", "Poss_Pro",
  "REFL", "Refl",
]);

const CONJUGATION_PAIR_RE = /^[^|]+\|[^|]+$/;

export interface GrammarValidationResult {
  valid: boolean;
  error?: string;
}

export function validateTemplate(template: string): GrammarValidationResult {
  if (!template || template.length === 0) {
    return { valid: false, error: "Template is empty" };
  }

  let i = 0;
  while (i < template.length) {
    const openIdx = template.indexOf("{", i);
    if (openIdx === -1) break;

    if (template[openIdx + 1] === "{") {
      return { valid: false, error: "Nested braces detected" };
    }

    const closeIdx = template.indexOf("}", openIdx + 1);
    if (closeIdx === -1) {
      return { valid: false, error: "Unmatched opening brace" };
    }

    const inner = template.slice(openIdx + 1, closeIdx);

    if (inner.includes("{")) {
      return { valid: false, error: "Nested braces detected" };
    }

    if (ALLOWED_SIMPLE_TOKENS.has(inner)) {
      i = closeIdx + 1;
      continue;
    }

    if (CONJUGATION_PAIR_RE.test(inner)) {
      const parts = inner.split("|");
      if (parts.length !== 2) {
        return { valid: false, error: `Conjugation pair "${inner}" must have exactly two alternatives` };
      }
      if (!parts[0] || !parts[1]) {
        return { valid: false, error: `Conjugation pair "${inner}" must have non-empty alternatives` };
      }
      i = closeIdx + 1;
      continue;
    }

    return { valid: false, error: `Unknown token "{${inner}}"` };
  }

  const trailingOpen = template.lastIndexOf("{");
  if (trailingOpen !== -1) {
    const trailingClose = template.indexOf("}", trailingOpen);
    if (trailingClose === -1) {
      return { valid: false, error: "Unmatched opening brace at end of template" };
    }
  }

  const unmatched = (template.match(/\}/g) ?? []).length - (template.match(/\{/g) ?? []).length;
  if (unmatched > 0) {
    return { valid: false, error: "Unmatched closing brace" };
  }

  return { valid: true };
}
