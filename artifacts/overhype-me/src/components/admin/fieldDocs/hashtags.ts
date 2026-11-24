/**
 * Field docs — the final-hashtags field on the moderation screen's approval step
 * (FinalHashtagsEditor). Pure data.
 *
 * The rest of the classification docs went with increment 2.1b (Issue #1018):
 * the AI taxonomy is read-only stored data that no picture or gag reads, so
 * their account of how each field steers a render described nothing.
 */

import type { FieldDoc } from "./types";

export const HASHTAG_FIELD_DOCS: FieldDoc[] = [
  {
    key: "finalHashtags",
    label: "Final hashtags",
    labelSuffix: "— these ship on approval",
    hint: "The discovery tags that actually attach to the live fact when you approve.",
    whatItIs: [
      "The authoritative tag list for this fact. Whatever chips are here when you click Approve become the fact's live discovery hashtags. It opens on the submitter's tags, which the AI suggested on the submit form and the submitter reviewed; moderation generates no tags of its own.",
    ],
    howDerived: [
      "Seeded from the submitter's tags. On approval the list here is what ships; a fact can't be approved with none. All are normalized (lowercase alphanumeric) and the exact subject/app names ('alex', 'overhype') and generic-humor tags are stripped.",
    ],
    renderImpact: ["None — hashtags never enter the render pipeline. They are product metadata for discovery/browse."],
    workedExamples: [
      {
        scenario: "The submitter sent [strength, legendary, earth]; you want a different focus.",
        input: 'Final hashtags: ["gymlife", "legendary", "strength"]',
        outcome: "Exactly those three attach to the live fact on approval; the removed submitter tags are discarded.",
      },
    ],
    effect: "product-metadata",
    staleBehavior: "does-not-mark-render-stale",
    sourceRefs: [
      {
        path: "artifacts/api-server/src/lib/hashtags.ts",
        symbol: "resolveFinalApprovalTags",
        note: "The moderator > submitter priority and normalization at approval.",
      },
    ],
    authoredStatus: "code-derived",
  },
];
