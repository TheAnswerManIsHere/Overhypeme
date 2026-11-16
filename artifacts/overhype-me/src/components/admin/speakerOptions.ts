/**
 * The bubble speaker dropdown's choices (PLAN_BUBBLE_SPEAKERS.md, C). Pure, so
 * both bubble-editor placements read the same list and it is unit-testable.
 *
 * Order: the subject; the fact's characters; labels this gag's Scene Role
 * Assignments add that the fact list doesn't have. A saved speaker matching
 * none of those is offered as itself, marked, so it is shown and saved
 * unchanged — never rewritten.
 */
import {
  CANONICAL_SUBJECT_NAME,
  possessive,
  type FactCharacter,
  type VisualStrategyRoleBinding,
} from "@workspace/api-zod";

export type SpeakerOptionSource = "subject" | "fact" | "gag" | "off-list";

export interface SpeakerOption {
  /** What the bubble stores as its `entity`. */
  value: string;
  /** What the dropdown shows. */
  label: string;
  source: SpeakerOptionSource;
}

export function characterDisplayName(c: Pick<FactCharacter, "label" | "ofSubject">, subjectName = CANONICAL_SUBJECT_NAME): string {
  return c.ofSubject ? `${possessive(subjectName)} ${c.label}` : c.label;
}

export function buildSpeakerOptions(opts: {
  characters: readonly FactCharacter[];
  roleBindings: readonly Pick<VisualStrategyRoleBinding, "entity">[];
  /** The speaker values currently saved in this gag's bubbles. */
  currentSpeakers: readonly string[];
  subjectName?: string;
}): SpeakerOption[] {
  const subjectName = opts.subjectName ?? CANONICAL_SUBJECT_NAME;
  const out: SpeakerOption[] = [{ value: "subject", label: `${subjectName} (the subject)`, source: "subject" }];
  const seen = new Set<string>(["subject"]);
  for (const c of opts.characters) {
    const key = c.label.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ value: c.label.trim(), label: characterDisplayName(c, subjectName), source: "fact" });
  }
  for (const rb of opts.roleBindings) {
    const v = rb.entity.trim();
    const key = v.toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ value: v, label: `${v} (added in this gag)`, source: "gag" });
  }
  for (const s of opts.currentSpeakers) {
    const v = s.trim();
    const key = v.toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ value: s, label: `${v} (not in this fact's character list)`, source: "off-list" });
  }
  return out;
}

/** The option a saved speaker selects: case-insensitive, trimmed. */
export function selectedSpeakerValue(options: readonly SpeakerOption[], entity: string): string {
  const key = entity.trim().toLowerCase();
  return options.find((o) => o.value.trim().toLowerCase() === key)?.value ?? entity;
}
