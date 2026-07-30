/**
 * The two CyberTipline documents, built as pure functions.
 *
 * No I/O, no database, no config reads — everything either function needs is passed in.
 * That is what lets phase 2 assert exact documents without a network or a DB, and it is
 * also what keeps the two hardest rules in this file enforceable:
 *
 *   1. **Reported identity comes from a frozen snapshot, never from a live lookup.**
 *      Resolving `user_id` → email when the job runs reports whoever that account is
 *      *then*. `ncmec_reports.user_id` is `ON DELETE SET NULL`, so a deleted account
 *      produces an anonymous filing for a report that had an identified uploader, and a
 *      changed email produces a filing stating something that was not true at the incident.
 *      These functions cannot resolve anything: they take a snapshot or they omit the
 *      element.
 *   2. **Annotations come from persisted provenance, never inferred from the caller.**
 *      `createMemeRecord()` is not exclusively a generation path — its image source accepts
 *      template, stock, upload and identity — so "quarantined from there, therefore AI"
 *      would assert to a federal clearinghouse that ordinary user-uploaded content is
 *      AI-generated. `<generativeAi>` is `content_origin === 'generated'`, computed here,
 *      stored nowhere.
 *
 * Element ORDER matters. The ISPWS schema is a sequence, so a correctly-populated document
 * with its children in the wrong order is rejected with `4100 Validation failed` — which
 * this design classifies as terminal, so the mistake would burn a report rather than a
 * retry. Both builders emit in the order Appendix B and Appendix C document, and the tests
 * assert exact documents rather than element presence.
 *
 * Verified 2026-07-30 against <https://report.cybertip.org/ispws/documentation/>.
 */

import { XMLBuilder } from "fast-xml-parser";

import type { ContentOrigin, NcmecMatchSource } from "@workspace/db/schema";

/**
 * Raised when a document cannot be built truthfully. Always prefer this to emitting a
 * plausible guess: an omitted element is visibly incomplete and can be corrected, while a
 * confidently wrong one asserts something to a federal clearinghouse on the strength of a
 * value nobody chose.
 */
export class NcmecMappingError extends Error {
  constructor(readonly reason: "incident-type-unresolved" | "reporter-contact-missing", message: string) {
    super(message);
    this.name = "NcmecMappingError";
  }
}

// ─── Incident type ──────────────────────────────────────────────────────────

/**
 * NCMEC's documented `<incidentType>` values. Only the first is mapped; the rest are here
 * so a future mapping is a choice from the real vocabulary rather than a typed string.
 */
export const NCMEC_INCIDENT_TYPES = {
  CHILD_PORNOGRAPHY: "Child Pornography (possession, manufacture, and distribution)",
  CHILD_SEX_TRAFFICKING: "Child Sex Trafficking",
  CHILD_SEX_TOURISM: "Child Sex Tourism",
  CHILD_SEXUAL_MOLESTATION: "Child Sexual Molestation",
  MISLEADING_DOMAIN_NAME: "Misleading Domain Name",
  MISLEADING_WORDS_OR_IMAGES: "Misleading Words or Digital Images on the Internet",
  ONLINE_ENTICEMENT: "Online Enticement of Children for Sexual Acts",
  UNSOLICITED_OBSCENE_MATERIAL: "Unsolicited Obscene Material Sent to a Child",
} as const;

/**
 * Map a match source to an incident type, or `null` where the mapping is genuinely unknown.
 *
 * **The classifier path returns `null` deliberately, and that is a hard block rather than a
 * default.** Where wholly AI-generated or classifier-flagged material belongs in this
 * vocabulary is an open question with NCMEC. If the classifier flag were merely
 * default-off, turning it on would leave three bad options: guess an incident type, omit a
 * required element, or send reports NCMEC rejects with `4100`. Returning null means the
 * document cannot be built at all until the mapping is settled and encoded here — so the
 * flag becomes a live control rather than a trapdoor.
 */
export function ncmecIncidentTypeFor(matchSource: NcmecMatchSource): string | null {
  return matchSource === "arachnid" ? NCMEC_INCIDENT_TYPES.CHILD_PORNOGRAPHY : null;
}

// ─── Inputs ─────────────────────────────────────────────────────────────────

/**
 * Uploader identity as frozen at quarantine time.
 *
 * Every field is optional because the snapshot records what was knowable *then*. An absent
 * snapshot is not the same as an anonymous one, and the two are distinguished by the
 * caller, not here.
 */
export interface NcmecReporterSnapshot {
  email?: string | null;
  displayName?: string | null;
  /** Our own user id, carried as `<espIdentifier>` so NCMEC can correlate follow-ups. */
  espIdentifier?: string | null;
}

/** The registered ESP's own details. Not defaults — see `buildReportXml`. */
export interface NcmecEspIdentity {
  /** The registered reporting entity, e.g. the company NCMEC issued credentials to. */
  organizationName: string;
  /** The registered reporting contact. NCMEC requires an email on `<reportingPerson>`. */
  contactEmail: string;
  contactFirstName?: string | null;
  contactLastName?: string | null;
  /** Standing language about the company, not specific to this incident. */
  companyTemplate?: string | null;
  legalUrl?: string | null;
}

export interface BuildReportXmlInput {
  matchSource: NcmecMatchSource;
  /** When the incident occurred — the report row's `created_at`, not "now". */
  incidentAt: Date;
  /** The platform the content appeared on, which is NOT the reporting entity. */
  platform: {
    name: string;
    /** Where the content lived. Omitted when there is no meaningful URL. */
    url?: string | null;
  };
  esp: NcmecEspIdentity;
  /**
   * The frozen uploader snapshot, or null.
   *
   * Null means "omit `<personOrUserReported>`". Whether null is an honest omission (a
   * genuinely anonymous upload) or an unresolved legacy row is decided by the caller before
   * it gets here — a legacy row with an unresolved identity is not eligible for automatic
   * submission at all.
   */
  reportedPerson: NcmecReporterSnapshot | null;
}

export interface BuildFileDetailsXmlInput {
  reportId: string;
  fileId: string;
  originalFileName?: string | null;
  /**
   * Provenance as persisted at quarantine time. `null` means genuinely unknown, and the
   * `<generativeAi>` annotation is omitted rather than guessed.
   */
  contentOrigin: ContentOrigin | null;
  /**
   * Whether this file is being reported as a meme shared out of mimicry rather than malice.
   * Only meaningful on a `Reported` file, which is the only relevance this design emits.
   */
  potentialMeme?: boolean;
  /** Request context captured at quarantine time. Omitted entirely when unavailable. */
  ipCapture?: { ipAddress: string; eventName?: string; capturedAt: Date } | null;
  additionalInfo?: string | null;
}

// ─── Builders ───────────────────────────────────────────────────────────────

const builder = new XMLBuilder({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  format: true,
  indentBy: "    ",
  suppressEmptyNode: true,
  processEntities: true,
});

const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8"?>\n';
const SCHEMA_ATTRS = {
  "@_xmlns:xsi": "http://www.w3.org/2001/XMLSchema-instance",
  "@_xsi:noNamespaceSchemaLocation": "https://report.cybertip.org/ispws/xsd",
};

/** Drop keys whose value is null/undefined/empty so no element is emitted for an absent fact. */
function compact<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value === null || value === undefined || value === "") continue;
    if (typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0) continue;
    out[key] = value;
  }
  return out as Partial<T>;
}

/**
 * `<person>` in the order Appendix A documents: firstName, lastName, phone, email, …
 * Nothing here invents a name from an email local-part — an email is what we know, and a
 * fabricated given name on a suspect record is not a rounding error.
 */
function personElement(input: {
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
}): Record<string, unknown> {
  return compact({
    firstName: input.firstName ?? null,
    lastName: input.lastName ?? null,
    email: input.email ?? null,
  });
}

/**
 * Build the `<report>` document that opens a submission.
 *
 * Throws rather than guessing in exactly two cases, both of which would otherwise produce a
 * document that looks complete and says something untrue:
 *
 * - **The incident type is unmapped** (`matchSource === "classifier"`), which is the hard
 *   block described on `ncmecIncidentTypeFor`.
 * - **The ESP contact email is missing.** NCMEC requires an email on `<reportingPerson>`,
 *   and there is no safe placeholder: a wrong address means the statutory notification of
 *   receipt goes nowhere. This is passed in rather than defaulted here precisely so it
 *   cannot be filled with something plausible.
 */
export function buildReportXml(input: BuildReportXmlInput): string {
  const incidentType = ncmecIncidentTypeFor(input.matchSource);
  if (!incidentType) {
    throw new NcmecMappingError(
      "incident-type-unresolved",
      `No <incidentType> is mapped for match source "${input.matchSource}". Classifier-sourced reports are blocked until NCMEC confirms which incident type applies; this is deliberate, not a missing default.`,
    );
  }
  if (!input.esp.contactEmail?.trim()) {
    throw new NcmecMappingError(
      "reporter-contact-missing",
      "NCMEC requires an <email> on <reportingPerson>; no registered reporting contact was supplied.",
    );
  }

  const report = compact({
    ...SCHEMA_ATTRS,
    incidentSummary: compact({
      incidentType,
      platform: input.platform.name,
      // ISO 8601 with an offset. `toISOString()` always emits UTC with a `Z`, which is a
      // valid offset — the point is that it is never a bare local timestamp.
      incidentDateTime: input.incidentAt.toISOString(),
    }),
    internetDetails: input.platform.url
      ? { webPageIncident: { url: input.platform.url } }
      : null,
    reporter: compact({
      reportingPerson: personElement({
        firstName: input.esp.contactFirstName ?? null,
        lastName: input.esp.contactLastName ?? null,
        email: input.esp.contactEmail,
      }),
      // The registered reporting entity, carried separately from the platform above. They
      // are different fields and conflating them would misfile the report.
      companyTemplate: input.esp.companyTemplate ?? input.esp.organizationName,
      legalURL: input.esp.legalUrl ?? null,
    }),
    personOrUserReported: buildReportedPerson(input.reportedPerson),
  });

  return XML_DECLARATION + builder.build({ report });
}

function buildReportedPerson(snapshot: NcmecReporterSnapshot | null): Record<string, unknown> | null {
  if (!snapshot) return null;
  const person = personElement({ email: snapshot.email ?? null });
  const element = compact({
    personOrUserReportedPerson: person,
    espIdentifier: snapshot.espIdentifier ?? null,
  });
  // A snapshot that carries nothing reportable is the same as no snapshot: emitting an
  // empty <personOrUserReported> asserts a suspect record with no content in it.
  return Object.keys(element).length > 0 ? element : null;
}

/**
 * Build the `<fileDetails>` document for one uploaded file.
 *
 * `<fileAnnotations>` children are `0|1` values, **not** empty marker elements — the
 * report-level `<reportAnnotations>` are empty markers and the two are easy to conflate.
 * An annotation whose fact is unknown is omitted rather than sent as `0`, because `0` is a
 * positive claim that the file is *not* that thing.
 */
export function buildFileDetailsXml(input: BuildFileDetailsXmlInput): string {
  const annotations = compact({
    // Order follows Appendix C.1.
    potentialMeme: input.potentialMeme === undefined ? null : input.potentialMeme ? "1" : "0",
    generativeAi:
      input.contentOrigin === null ? null : input.contentOrigin === "generated" ? "1" : "0",
  });

  const fileDetails = compact({
    ...SCHEMA_ATTRS,
    reportId: input.reportId,
    fileId: input.fileId,
    originalFileName: input.originalFileName ?? null,
    // "Reported" is the content that motivated the report. It is also the only relevance
    // under which a potential-meme annotation or an industry classification is permitted,
    // so emitting it is a precondition for the annotations above, not decoration.
    fileRelevance: "Reported",
    fileAnnotations: annotations,
    // <industryClassification> is deliberately absent. The A1/A2/B1/B2 mapping from an
    // Arachnid classification is an open question with NCMEC, and a categorization scale is
    // not something to infer onto a federal report.
    ipCaptureEvent: input.ipCapture
      ? compact({
          ipAddress: input.ipCapture.ipAddress,
          eventName: input.ipCapture.eventName ?? "Upload",
          dateTime: input.ipCapture.capturedAt.toISOString(),
        })
      : null,
    additionalInfo: input.additionalInfo ?? null,
  });

  return XML_DECLARATION + builder.build({ fileDetails });
}
