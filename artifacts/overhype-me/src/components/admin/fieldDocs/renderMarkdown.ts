/**
 * Renders the field-documentation registry into the generated living reference
 * doc (`docs/ADMIN_FIELD_REFERENCE.md`). Pure data → string; no React, no
 * filesystem — the generator script and the staleness test both call this.
 *
 * DETERMINISM RULES (the staleness test depends on byte-stable output):
 *  - section order and field order come from the section arrays (stable);
 *  - enum value order comes from the canonical api-zod arrays via each
 *    FieldDoc's `values` (never object-key order);
 *  - no timestamps, no environment-dependent paths;
 *  - LF newlines, no trailing whitespace, exactly one final newline.
 */

import type { FieldDoc, FieldEffectClass, StaleBehavior } from "./types";
import { CLASSIFICATION_FIELD_DOCS } from "./classification";
import { VISUAL_STRATEGY_FIELD_DOCS } from "./visualStrategy";
import { REFERENCES_ENTITIES_FIELD_DOCS } from "./referencesEntities";
import { FIELD_DOC_USAGE } from "./index";

const SECTIONS: readonly { title: string; docs: readonly FieldDoc[] }[] = [
  { title: "AI Visual Classification", docs: CLASSIFICATION_FIELD_DOCS },
  { title: "Visual Strategy Override", docs: VISUAL_STRATEGY_FIELD_DOCS },
  { title: "References & Scene Entities", docs: REFERENCES_ENTITIES_FIELD_DOCS },
];

const EFFECT_TEXT: Record<FieldEffectClass, string> = {
  "render-affecting": "Render-affecting — feeds the prompt pipeline",
  "advisory-only": "Advisory only — AI-planner context, no fixed compiler directive",
  "gating-only": "Gating only — approval/health gate, never compiled into the prompt",
  "product-metadata": "Product metadata — ships with the fact, no render effect",
  "human-only": "Human-only — never leaves the admin UI",
};

const STALE_TEXT: Record<StaleBehavior, string | null> = {
  "marks-render-stale": "Editing re-flags render scenarios as stale.",
  "does-not-mark-render-stale": "Editing does not re-flag render scenarios.",
  "not-applicable": null,
};

function anchor(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
}

function fieldHeading(doc: FieldDoc): string {
  return doc.labelSuffix ? `${doc.label} ${doc.labelSuffix}` : doc.label;
}

function renderField(doc: FieldDoc, lines: string[]): void {
  lines.push(`### ${fieldHeading(doc)}`, "");
  lines.push(`*${doc.hint}*`, "");
  lines.push(`- **Effect:** ${EFFECT_TEXT[doc.effect]}`);
  const stale = STALE_TEXT[doc.staleBehavior];
  if (stale) lines.push(`- **Staleness:** ${stale}`);
  lines.push(`- **Editor surface:** ${FIELD_DOC_USAGE[doc.key]}`);
  if (doc.authoredStatus === "authored-needs-david-review") {
    lines.push(`- **Source status:** Authored from code behavior — David spot-check requested.`);
  }
  lines.push("");

  lines.push("**What it is**", "");
  for (const p of doc.whatItIs) lines.push(p, "");
  lines.push("**How the AI sets it**", "");
  for (const p of doc.howDerived) lines.push(p, "");
  lines.push("**How it affects the render**", "");
  for (const p of doc.renderImpact) lines.push(p, "");

  if (doc.values && doc.values.length > 0) {
    lines.push(`**Values (${doc.values.length})**`, "");
    for (const { value, doc: v } of doc.values) {
      const flag = v.authoredStatus === "authored-needs-david-review" ? " *(authored — verify)*" : "";
      lines.push(`- \`${value}\`${flag} — ${v.meaning}`);
      lines.push(`  - *Render:* ${v.renderImpact}`);
      lines.push(`  - *Example:* ${v.example}`);
    }
    lines.push("");
  }

  if (doc.workedExamples.length > 0) {
    lines.push("**Examples**", "");
    for (const ex of doc.workedExamples) {
      lines.push(`- **Scenario:** ${ex.scenario}`);
      lines.push(`  - **Input:** ${ex.input}`);
      lines.push(`  - **Outcome:** ${ex.outcome}`);
    }
    lines.push("");
  }

  if (doc.sourceRefs && doc.sourceRefs.length > 0) {
    lines.push("**Sources**", "");
    for (const s of doc.sourceRefs) {
      const sym = s.symbol ? ` \`${s.symbol}\`` : s.anchor ? ` (${s.anchor})` : "";
      lines.push(`- \`${s.path}\`${sym} — ${s.note}`);
    }
    lines.push("");
  }
}

export function renderAdminFieldReference(): string {
  const lines: string[] = [];
  lines.push("# Admin Field Reference — Enrichment Editor");
  lines.push("");
  lines.push(
    "> **GENERATED — do not edit by hand.** This document is rendered from the in-app",
    "> field-documentation registry (`artifacts/overhype-me/src/components/admin/fieldDocs/`).",
    "> To change it, edit the registry and run:",
    "> `pnpm --filter @workspace/overhype-me run generate:field-docs`",
    "> A CI test fails when this file is out of date with the registry.",
  );
  lines.push("");
  lines.push(
    "The same content powers the info icons beside every field in the admin enrichment",
    "editor (moderation Step 2 → Advanced Options, and Admin → Facts). Fields marked",
    "*authored — verify* have no upstream prose in code and were written from traced",
    "behavior; David's spot-check is requested.",
  );
  lines.push("");

  // Table of contents.
  lines.push("## Contents", "");
  for (const s of SECTIONS) {
    lines.push(`- [${s.title}](#${anchor(s.title)})`);
    for (const d of s.docs) {
      lines.push(`  - [${fieldHeading(d)}](#${anchor(fieldHeading(d))})`);
    }
  }
  lines.push("");

  for (const s of SECTIONS) {
    lines.push(`## ${s.title}`, "");
    for (const d of s.docs) renderField(d, lines);
  }

  // Normalize: strip trailing whitespace per line, collapse 3+ blank lines,
  // LF endings, exactly one trailing newline.
  const text = lines
    .map((l) => l.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\n+$/g, "");
  return `${text}\n`;
}
