import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PRIMARY_ARCHETYPES,
  ALL_SUBTYPES,
  VISUAL_LITERALNESS_VALUES,
  VISUAL_COMPLEXITY_VALUES,
  OVERHYPE_FIT_VALUES,
  ADULT_SUITABILITY_VALUES,
  KNOWN_FACT_MODIFIERS,
  REFERENCE_TYPE_VALUES,
  SEMANTIC_ENTITY_KIND_VALUES,
  CAPITALIZATION_SIGNAL_VALUES,
  SUBJECT_REALIZATION_MODE_VALUES,
  SUPPORTING_TEXT_MODE_VALUES,
  VIOLENCE_MODE_VALUES,
  VIOLENCE_INTENSITY_VALUES,
  OVERRIDABLE_PATHS,
  type OverridablePath,
} from "@workspace/api-zod";
import { FIELD_DOCS, FIELD_DOC_USAGE, PATH_TO_DOC_KEY, fieldLabel, modifierDoc } from "./index";
import type { FieldDocKey } from "./types";
import { renderAdminFieldReference } from "./renderMarkdown";

/**
 * The coverage ratchet: every field and every enum value must be fully
 * documented — non-empty content, canonical value order, label parity with the
 * api-zod mirror, valid provenance — and the generated reference doc must be in
 * sync with the registry. During authoring this suite is the burndown list.
 */

const ALL_KEYS = Object.keys(FIELD_DOC_USAGE) as FieldDocKey[];

describe("fieldDocs — content completeness", () => {
  it.each(ALL_KEYS)("%s is fully documented", (key) => {
    const doc = FIELD_DOCS[key];
    expect(doc, `missing doc for ${key}`).toBeTruthy();
    expect(doc.key).toBe(key);
    expect(doc.label.trim()).not.toBe("");
    expect(doc.hint.trim()).not.toBe("");
    for (const [section, paras] of [
      ["whatItIs", doc.whatItIs],
      ["howDerived", doc.howDerived],
      ["renderImpact", doc.renderImpact],
    ] as const) {
      expect(paras.length, `${key}.${section} empty`).toBeGreaterThan(0);
      for (const p of paras) expect(p.trim(), `${key}.${section} has empty paragraph`).not.toBe("");
    }
    expect(doc.workedExamples.length, `${key} needs >=1 worked example`).toBeGreaterThanOrEqual(1);
    for (const ex of doc.workedExamples) {
      expect(ex.scenario.trim()).not.toBe("");
      expect(ex.input.trim()).not.toBe("");
      expect(ex.outcome.trim()).not.toBe("");
    }
    for (const s of doc.sourceRefs ?? []) {
      expect(s.path.trim(), `${key} sourceRef missing path`).not.toBe("");
      expect(s.note.trim(), `${key} sourceRef missing note`).not.toBe("");
    }
    if (doc.values) {
      for (const { value, doc: v } of doc.values) {
        expect(v.meaning.trim(), `${key}.${value} meaning empty`).not.toBe("");
        expect(v.renderImpact.trim(), `${key}.${value} renderImpact empty`).not.toBe("");
        expect(v.example.trim(), `${key}.${value} example empty`).not.toBe("");
      }
    }
  });
});

describe("fieldDocs — enum value parity (set AND order match api-zod)", () => {
  const ENUM_FIELDS: [FieldDocKey, readonly string[]][] = [
    ["primaryArchetype", PRIMARY_ARCHETYPES],
    ["subtype", ALL_SUBTYPES],
    ["visualLiteralness", VISUAL_LITERALNESS_VALUES],
    ["visualComplexity", VISUAL_COMPLEXITY_VALUES],
    ["overhypeFit", OVERHYPE_FIT_VALUES],
    ["adultSuitability", ADULT_SUITABILITY_VALUES],
    ["modifiers", KNOWN_FACT_MODIFIERS],
    ["vso.subjectRealization", SUBJECT_REALIZATION_MODE_VALUES],
    ["vso.supportingTextPolicy", SUPPORTING_TEXT_MODE_VALUES],
    // The violence popover documents both of its enums, modes first.
    ["vso.violencePolicy", [...VIOLENCE_MODE_VALUES, ...VIOLENCE_INTENSITY_VALUES]],
    ["ref.referenceType", REFERENCE_TYPE_VALUES],
    ["ent.entityKind", SEMANTIC_ENTITY_KIND_VALUES],
    ["ent.capitalizationSignal", CAPITALIZATION_SIGNAL_VALUES],
  ];

  it.each(ENUM_FIELDS)("%s covers its canonical values exactly, in order", (key, canonical) => {
    const values = FIELD_DOCS[key].values;
    expect(values, `${key} should have per-value docs`).toBeTruthy();
    expect(values!.map((v) => v.value)).toEqual([...canonical]);
  });

  it("modifierDoc() resolves every known modifier and falls back for custom ones", () => {
    for (const m of KNOWN_FACT_MODIFIERS) {
      expect(modifierDoc(m).meaning.trim()).not.toBe("");
    }
    const custom = modifierDoc("definitely_not_a_known_modifier");
    // The custom fallback explains it isn't a known/catalog modifier.
    expect(custom.meaning.toLowerCase()).toContain("known");
    expect(custom.renderImpact.trim()).not.toBe("");
  });
});

describe("fieldDocs — label parity with the api-zod mirror", () => {
  it("every overridable path maps to a doc key with an identical label", () => {
    for (const path of Object.keys(OVERRIDABLE_PATHS) as OverridablePath[]) {
      const key = PATH_TO_DOC_KEY[path];
      expect(key, `no PATH_TO_DOC_KEY entry for ${path}`).toBeTruthy();
      expect(fieldLabel(key), `label mismatch for ${path} — update fieldDocs AND enrichmentOverrides.ts together`).toBe(
        OVERRIDABLE_PATHS[path].label,
      );
    }
  });
});

describe("fieldDocs — authored-content metadata", () => {
  it("every doc and value declares authoredStatus where authored from scratch", () => {
    // Structural rule: authoredStatus is optional, but when a value doc has no
    // sourceRefs AND no authoredStatus we can't tell where it came from. Require
    // one of the two on every value doc.
    for (const key of ALL_KEYS) {
      const doc = FIELD_DOCS[key];
      const docTraceable = (doc.sourceRefs?.length ?? 0) > 0 || doc.authoredStatus != null;
      expect(docTraceable, `${key} needs sourceRefs or authoredStatus`).toBe(true);
      for (const { value, doc: v } of doc.values ?? []) {
        const traceable = (v.sourceRefs?.length ?? 0) > 0 || v.authoredStatus != null;
        expect(traceable, `${key}.${value} needs sourceRefs or authoredStatus`).toBe(true);
      }
    }
  });
});

describe("generated reference doc (docs/ADMIN_FIELD_REFERENCE.md)", () => {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const docPath = resolve(__dirname, "..", "..", "..", "..", "..", "..", "docs", "ADMIN_FIELD_REFERENCE.md");

  it("is deterministic (two renders are identical)", () => {
    expect(renderAdminFieldReference()).toBe(renderAdminFieldReference());
  });

  it("is committed and in sync with the registry (run generate:field-docs if this fails)", () => {
    const committed = readFileSync(docPath, "utf8");
    expect(committed).toBe(renderAdminFieldReference());
  });
});
