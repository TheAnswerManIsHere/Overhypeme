/**
 * The legacy fixture's allowlist (Launch Phase 2, increment 5; #631; plan
 * `docs/plans/PLAN_PHASE2_INC5_LEGACY_FIXTURE.md`, D1–D2).
 *
 * Every table the schema exports is classified here, by Drizzle table object.
 * An included table names a rule for EVERY one of its columns — the mapped
 * type below is a full `Record`, so a column added to the schema fails the
 * typecheck until it is classified here, and a jsonb column can only carry a
 * `shape:` rule (or be dropped), so no unshaped JSON can be exported. An
 * excluded table names its class and is never queried. The exporter builds
 * its `SELECT` from these maps, addresses `public.<table>` only, and reads
 * nothing else.
 *
 * The schema index exports 57 tables; the two dead declarations in
 * `lib/db/src/schema/conversations.ts` / `messages.ts` are not exported, so no
 * code path — this one included — can read or write them.
 */
import * as schema from "@workspace/db/schema";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { is } from "drizzle-orm";
import { PgTable as PgTableClass } from "drizzle-orm/pg-core";

import type { ShapeName } from "./shapes";

/** Why a whole table never leaves the source. */
export type ExclusionClass =
  | "auth-state"
  | "job-state"
  | "child-safety"
  | "payment-obligation"
  | "runtime-state"
  | "telemetry"
  | "not-catalogue";

/** Synthetic generators the exporter knows (scrub.ts). */
export type SyntheticKind =
  | "email"
  | "first-name"
  | "last-name"
  | "display-name"
  | "true"
  | "verified-at-created"
  | "stripe-customer"
  | "stripe-provider-ref"
  | "stripe-price"
  | "stripe-id"
  | "opaque-id"
  | "vendor-error"
  | "fixture-url"
  | "fixture-title"
  | "config-value";

/**
 * What happens to one column's value.
 *
 * - `keep` — copied as stored (structural values, counts, enums, timestamps).
 * - `map-user` — a user id, rewritten through the run's identity map (D3).
 * - `ref:<table>` — a pointer to another exported row, kept as stored (integer
 *   keys carry no identity); the exporter refuses a pointer whose target is
 *   absent from the export (D4, app-managed links).
 * - `fact-text` — template text, kept only on rows whose text is the live text
 *   of an active fact, placeholder otherwise (D4).
 * - `fact-derived` — `split_token_index` / `has_pronouns`: kept for a kept-text
 *   fact, recomputed from the placeholder otherwise (the real normaliser).
 * - `prose` — free text: a content-keyed placeholder; blank stays blank (D4).
 * - `rendered:meme` / `rendered:attempt` — personalised text, re-rendered from
 *   the row's scrubbed template and its synthetic identity (D4).
 * - `embedding-if-kept` — kept for a kept-text fact, null otherwise.
 * - `rekey` — a hash of private bytes, re-keyed so equal inputs stay equal.
 * - `predicate-hash` — written by the exporter as a re-key, restored by the
 *   loader so the reader's freshness predicate answers as it did on the source.
 * - `media` — a storage reference, rewritten through the run's media map (D5).
 * - `meme-route-url` — `/api/memes/<slug>/image`, built from the kept slug
 *   (createMemeRecord.ts:410); kept, and refused when it is anything else.
 * - `admin-label` — a human-readable actor label, rewritten to the mapped
 *   admin's synthetic name (D3).
 * - `synthetic:<kind>` — a generated value (scrub.ts).
 * - `null` — written as null.
 * - `drop` — not selected at all; the column takes its default on load.
 */
export type ScalarRule =
  | "keep"
  | "map-user"
  | `ref:${string}`
  | "fact-text"
  | "fact-derived"
  | "prose"
  | "rendered:meme"
  | "rendered:attempt"
  | "embedding-if-kept"
  | "rekey"
  | "predicate-hash"
  | "media"
  | "meme-route-url"
  | "admin-label"
  | `synthetic:${SyntheticKind}`
  | "null"
  | "drop";

export type JsonRule = `shape:${ShapeName}` | "null" | "drop";

type ColumnsOf<T extends PgTable> = T["_"]["columns"];
type RuleFor<C> = C extends { _: { columnType: "PgJsonb" } } ? JsonRule : ScalarRule;
type ColumnRules<T extends PgTable> = { [K in keyof ColumnsOf<T>]: RuleFor<ColumnsOf<T>[K]> };

export interface IncludedTable<T extends PgTable = PgTable> {
  kind: "include";
  table: T;
  columns: ColumnRules<T>;
  /** A SQL predicate over the source row (aliased `t`) that a row must satisfy to leave the source. */
  rowFilter?: string;
  /** One line on why the filter exists. */
  rowFilterReason?: string;
}

export interface ExcludedTable {
  kind: "exclude";
  table: PgTable;
  class: ExclusionClass;
  reason: string;
}

export type TableClassification = IncludedTable | ExcludedTable;

function include<T extends PgTable>(
  table: T,
  columns: ColumnRules<T>,
  filter?: { rowFilter: string; reason: string },
): IncludedTable {
  return {
    kind: "include",
    table,
    columns,
    ...(filter ? { rowFilter: filter.rowFilter, rowFilterReason: filter.reason } : {}),
  } as unknown as IncludedTable;
}

function exclude(table: PgTable, cls: ExclusionClass, reason: string): ExcludedTable {
  return { kind: "exclude", table, class: cls, reason };
}

const s = schema;

/**
 * The classification. Order is load order (foreign keys before their
 * dependants); excluded tables are listed after.
 */
export const LEGACY_FIXTURE_ALLOWLIST: readonly TableClassification[] = [
  // ── Catalogue configuration: product settings, kept verbatim ──────────────
  include(s.featureFlagsTable, { key: "keep", displayName: "keep", description: "keep", createdAt: "keep" }),
  include(s.tierFeaturePermissionsTable, { tier: "keep", featureKey: "ref:feature_flags", enabled: "keep", updatedAt: "keep" }),
  include(s.entitlementGridRevisionTable, { id: "keep", revision: "keep" }),
  include(s.enginesTable, {
    id: "keep", provider: "keep", endpointId: "keep", label: "keep", description: "keep", kind: "keep",
    tierRequirement: "keep", isDefault: "keep", isActive: "keep", sortOrder: "keep",
    allowedDurationsSec: "shape:config", defaultDurationSec: "keep", allowedResolutions: "shape:config",
    defaultResolution: "keep", allowedAspectRatios: "shape:config", defaultAspectRatio: "keep",
    supportedModes: "shape:config", defaultMode: "keep", audioHandling: "keep", paramSchema: "shape:config",
    estimatedCostUsdPerCall: "keep", estimatedCostUsdPerSecond: "keep", expectedRunMs: "keep",
    defaultTemperature: "keep", defaultMaxTokens: "keep", defaultReasoningEffort: "keep",
    featureFlagRequired: "keep", createdAt: "keep", updatedAt: "keep", deletedAt: "keep",
  }),
  include(s.lookStylesTable, {
    id: "keep", label: "keep", description: "keep", promptSuffix: "keep", promptSuffixReference: "keep",
    previewImagePath: "media", sortOrder: "keep", isActive: "keep", createdAt: "keep", updatedAt: "keep",
  }),
  include(s.heroExamplesTable, {
    id: "keep", artifactType: "keep", assetUrl: "media", posterUrl: "media", captionLabel: "prose",
    sortOrder: "keep", active: "keep", createdAt: "keep", updatedAt: "keep",
  }),
  include(s.falPricingCacheTable, {
    endpointId: "keep", unitPrice: "keep", unit: "keep", currency: "keep", fetchedAt: "keep",
    createdAt: "keep", updatedAt: "keep",
  }),

  // ── People: identities become synthetic (D3) ─────────────────────────────
  include(s.usersTable, {
    id: "map-user",
    email: "synthetic:email",
    pendingEmail: "drop",
    firstName: "synthetic:first-name",
    lastName: "synthetic:last-name",
    displayName: "synthetic:display-name",
    profileImageUrl: "media",
    passwordHash: "drop",
    googleLinked: "keep",
    appleLinked: "keep",
    captchaVerified: "synthetic:true",
    isAdmin: "keep",
    adminNotifications: "keep",
    disputeNotifications: "keep",
    isActive: "keep",
    stripeCustomerId: "synthetic:stripe-customer",
    membershipTier: "keep",
    membershipValidUntil: "keep",
    avatarStyle: "keep",
    avatarSource: "keep",
    pronouns: "keep",
    emailVerifiedAt: "synthetic:verified-at-created",
    monthlyGenerationLimitOverrideUsd: "keep",
    nsfwModeEnabled: "keep",
    createdAt: "keep",
    updatedAt: "keep",
  }),
  include(s.adminConfigTable, {
    // Settings are kept verbatim, except that an address in one (the sender and reply-to settings) becomes synthetic.
    key: "keep", value: "synthetic:config-value", valueLabel: "keep", debugValue: "synthetic:config-value", debugValueLabel: "keep",
    dataType: "keep", label: "keep", description: "keep", minValue: "keep", maxValue: "keep",
    isPublic: "keep", updatedAt: "keep", updatedById: "map-user",
  }),

  // ── The catalogue (D4) ───────────────────────────────────────────────────
  include(s.factsTable, {
    id: "keep",
    text: "fact-text",
    submittedById: "map-user",
    parentId: "ref:facts",
    useCase: "keep",
    upvotes: "keep",
    downvotes: "keep",
    score: "keep",
    wilsonScore: "keep",
    commentCount: "keep",
    shareCount: "keep",
    hasPronouns: "fact-derived",
    isActive: "keep",
    canonicalText: "fact-text",
    splitTokenIndex: "fact-derived",
    pexelsImages: "shape:factPexelsImages",
    pexelsStatus: "keep",
    visualConceptCandidates: "shape:visualConceptCandidatesBlob",
    visualConceptStatus: "keep",
    aiScenePrompts: "shape:aiScenePrompts",
    aiMemeImages: "shape:aiMemeImages",
    aiMemeBackfillStatus: "keep",
    enrichment: "shape:factEnrichment",
    enrichmentAiDerived: "shape:factEnrichment",
    enrichmentOverrides: "shape:enrichmentOverrides",
    enrichmentBaselineChanged: "keep",
    enrichmentStatus: "keep",
    primaryArchetype: "keep",
    subtype: "keep",
    overhypeFit: "keep",
    adultSuitability: "keep",
    lastProcessedSignature: "shape:processingSignature",
    evalGolden: "keep",
    evalGoldenReason: "prose",
    embedding: "embedding-if-kept",
    createdAt: "keep",
    updatedAt: "keep",
  }),
  include(s.hashtagsTable, { id: "keep", name: "keep", factCount: "keep" }),
  include(s.factHashtagsTable, { factId: "ref:facts", hashtagId: "ref:hashtags" }),
  include(s.pendingReviewsTable, {
    id: "keep",
    submittedText: "fact-text",
    submittedById: "map-user",
    matchingFactId: "ref:facts",
    matchingSimilarity: "keep",
    parentFactId: "ref:facts",
    hashtags: "shape:reviewHashtags",
    enrichment: "shape:factEnrichment",
    enrichmentStatus: "keep",
    status: "keep",
    workflowStage: "keep",
    stagingFactId: "ref:facts",
    reason: "keep",
    adminNote: "prose",
    reviewedById: "map-user",
    approvedFactId: "ref:facts",
    productionRejectedAt: "keep",
    productionRejectedById: "map-user",
    productionRejectionNote: "prose",
    visualRenderApprovalWaiver: "shape:visualRenderApprovalWaiver",
    candidateVersionId: "ref:fact_enrichment_versions",
    createdAt: "keep",
    reviewedAt: "keep",
  }),
  include(s.factEnrichmentVersionsTable, {
    id: "keep",
    factId: "ref:facts",
    versionNo: "keep",
    status: "keep",
    enrichment: "shape:factEnrichment",
    enrichmentAiDerived: "shape:factEnrichment",
    enrichmentOverrides: "shape:enrichmentOverrides",
    visualOverride: "shape:visualStrategyOverride",
    factTextHash: "predicate-hash",
    signature: "shape:processingSignature",
    source: "keep",
    sourceReviewId: "ref:pending_reviews",
    note: "prose",
    createdBy: "map-user",
    createdAt: "keep",
    promotedAt: "keep",
    supersededAt: "keep",
    rejectedAt: "keep",
  }),
  include(s.enrichmentOverrideHistoryTable, {
    id: "keep", factId: "ref:facts", path: "keep", action: "keep",
    oldValue: "shape:overrideValue", newValue: "shape:overrideValue",
    aiGenerationId: "keep", reason: "prose", performedBy: "map-user", createdAt: "keep",
  }),
  include(s.factTextEditHistoryTable, {
    id: "keep", factId: "ref:facts", oldText: "fact-text", newText: "fact-text", reason: "prose",
    performedBy: "map-user", createdAt: "keep",
  }),
  include(s.imagePromptAttemptsTable, {
    id: "keep",
    factId: "ref:facts",
    userId: "map-user",
    requestId: "synthetic:opaque-id",
    renderJobId: "synthetic:opaque-id",
    generationMode: "keep",
    subjectRenderMode: "keep",
    userSelectedSubjectRenderMode: "keep",
    fallbackReason: "prose",
    targetEngine: "keep",
    sourceImageAnalysis: "shape:sourceImageAnalysis",
    sourceImageSha256: "rekey",
    identityPolicy: "shape:identityPolicy",
    renderControls: "shape:renderControls",
    factEnrichmentSnapshot: "shape:factEnrichment",
    archetypeStrategyVersion: "keep",
    renderedFactText: "rendered:attempt",
    visualPlan: "shape:visualPlan",
    compiledPrompt: "shape:compiledPrompt",
    subjectFactCompatibility: "shape:subjectFactCompatibility",
    error: "synthetic:vendor-error",
    errorCode: "keep",
    generatedImageObjectPath: "media",
    reviewId: "ref:pending_reviews",
    reviewRenderScenarioKey: "keep",
    reviewRenderInputHash: "predicate-hash",
    reviewReferenceAssetVersion: "keep",
    reviewReferenceIdentityType: "keep",
    reviewRenderBatchId: "synthetic:opaque-id",
    // The eval lane is dropped with eval_runs (D2).
    moderatorRating: "drop",
    failureTag: "drop",
    evalNotes: "drop",
    evalBy: "drop",
    evalAt: "drop",
    evalRunId: "drop",
    evalScenarioKey: "drop",
    evalInputHash: "drop",
    createdAt: "keep",
    updatedAt: "keep",
  }),

  // ── What users made (D2, D5) ─────────────────────────────────────────────
  include(
    s.memesTable,
    {
      id: "keep",
      factId: "ref:facts",
      templateId: "keep",
      imageUrl: "meme-route-url",
      permalinkSlug: "keep",
      textOptions: "shape:textOptions",
      imageSource: "shape:imageSource",
      framingTransform: "shape:framingTransform",
      isPublic: "keep",
      isLowRes: "keep",
      originalWidth: "keep",
      originalHeight: "keep",
      uploadFileSizeBytes: "keep",
      createdById: "map-user",
      createdAt: "keep",
      deletedAt: "keep",
      aspectRatio: "keep",
      renderedFactText: "rendered:meme",
      heartCount: "keep",
      status: "keep",
      quarantineReason: "drop",
      nsfwClassifierScore: "keep",
      isNsfw: "keep",
      imageTransform: "keep",
      artifactType: "keep",
    },
    {
      rowFilter: "t.status <> 'quarantined' AND t.artifact_type <> 'video'",
      reason: "a quarantined meme is child-safety-adjacent; a video meme is a soft-deleted row of a feature cut in launch Phase 4 (migration 0103)",
    },
  ),
  include(
    s.uploadImageMetadataTable,
    {
      objectPath: "media",
      width: "keep",
      height: "keep",
      isLowRes: "keep",
      fileSizeBytes: "keep",
      createdAt: "keep",
      userId: "map-user",
      arachnidClassification: "drop",
      arachnidMatchType: "drop",
      arachnidSha1Base32: "drop",
      arachnidSha256Hex: "drop",
      arachnidScannedAt: "drop",
      isNsfw: "keep",
      isProfile: "keep",
      transform: "keep",
      sourceObjectPath: "media",
      factId: "ref:facts",
      transformParamsHash: "keep",
      sourceImageAnalysis: "drop",
      sourceImageAnalysisVersion: "drop",
    },
    {
      rowFilter: "t.arachnid_match_type IS NULL",
      reason: "an Arachnid match is child-safety evidence",
    },
  ),
  include(s.userAiImagesTable, {
    id: "keep", userId: "map-user", factId: "ref:facts", gender: "keep", storagePath: "media",
    imageType: "keep", createdAt: "keep",
  }),
  include(s.commentsTable, {
    id: "keep", factId: "ref:facts", authorId: "map-user", text: "prose", status: "keep", flagged: "keep",
    flagReason: "prose", heartCount: "keep", createdAt: "keep",
  }),
  include(s.ratingsTable, { factId: "ref:facts", userId: "map-user", rating: "keep", createdAt: "keep" }),
  include(
    s.reactionsTable,
    { id: "keep", userId: "map-user", targetType: "keep", targetId: "keep", reactionType: "keep", createdAt: "keep" },
    {
      rowFilter:
        "(t.target_type <> 'meme' OR EXISTS (SELECT 1 FROM public.memes m WHERE m.id = t.target_id AND m.status <> 'quarantined' AND m.artifact_type <> 'video'))",
      reason: "a reaction on a meme the export leaves out would point at nothing",
    },
  ),
  include(s.externalLinksTable, {
    id: "keep", factId: "ref:facts", url: "synthetic:fixture-url", title: "synthetic:fixture-title",
    platform: "keep", addedById: "map-user", createdAt: "keep",
  }),

  // ── Money, with the eligibility predicate (D2, C5) ───────────────────────
  include(
    s.membershipEntitlementsTable,
    {
      id: "keep",
      userId: "map-user",
      sourceType: "keep",
      providerRef: "synthetic:stripe-provider-ref",
      isMembershipProduct: "keep",
      lifecycleStatus: "keep",
      plan: "synthetic:stripe-price",
      currentPeriodEnd: "keep",
      cancelAtPeriodEnd: "keep",
      amount: "keep",
      currency: "keep",
      graceStartedAt: "keep",
      graceExpiresAt: "keep",
      disputeLossRevokedAt: "keep",
      grantedByAdminId: "map-user",
      grantedByAdminLabel: "admin-label",
      grantReason: "prose",
      revokedByAdminId: "map-user",
      revokedByAdminLabel: "admin-label",
      revokedReason: "prose",
      revokedAt: "keep",
      sourceStateAsOf: "keep",
      createdAt: "keep",
      updatedAt: "keep",
    },
    {
      // Evaluated by the exporter's payment-eligibility pass (export.ts), not by SQL alone.
      rowFilter: "TRUE",
      reason: "a provider-backed row leaves only with livemode = false provenance in the source's Stripe sync data",
    },
  ),
  include(
    s.membershipHistoryTable,
    {
      id: "keep",
      userId: "map-user",
      event: "keep",
      plan: "synthetic:stripe-price",
      amount: "keep",
      currency: "keep",
      stripePaymentIntentId: "synthetic:stripe-id",
      stripeSubscriptionId: "synthetic:stripe-id",
      stripeInvoiceId: "synthetic:stripe-id",
      stripeDisputeId: "synthetic:stripe-id",
      performedByAdminId: "map-user",
      createdAt: "keep",
    },
    {
      rowFilter: "TRUE",
      reason: "every Stripe id on the row must resolve with livemode = false in the source's Stripe sync data",
    },
  ),
  include(s.userGenerationCostsTable, {
    id: "keep", userId: "map-user", jobType: "keep", endpointId: "keep", unitPriceAtCreation: "keep",
    billingUnits: "keep", computedCostUsd: "keep", pricingFetchedAt: "keep",
    jobReferenceId: "synthetic:opaque-id", isEstimated: "keep", createdAt: "keep",
  }),

  // ── Excluded whole (never queried) ───────────────────────────────────────
  exclude(s.sessionsTable, "auth-state", "a copied session is valid against whatever it is loaded into"),
  exclude(s.emailVerificationTokensTable, "auth-state", "a verification token is a credential"),
  exclude(s.passwordResetTokensTable, "auth-state", "a reset token is a credential"),
  exclude(s.oauthPendingStatesTable, "auth-state", "OAuth state and PKCE verifiers are credentials"),
  exclude(s.asyncJobsTable, "job-state", "job rows are executable work and their payloads carry recipients and results"),
  exclude(s.workerLaneHeartbeatsTable, "job-state", "per-process worker liveness"),
  exclude(s.membershipLeasesTable, "job-state", "fenced leases held by running workers"),
  exclude(s.quarantinedMemesTable, "child-safety", "the child-safety boundary"),
  exclude(s.ncmecReportsTable, "child-safety", "the child-safety boundary"),
  exclude(s.ncmecSafetyAuditLogTable, "child-safety", "the child-safety boundary"),
  exclude(s.stripeProcessedEventsTable, "payment-obligation", "Stripe webhook plumbing; the Stripe fake (#566) owns this evidence"),
  exclude(s.stripeWebhookAuditTable, "payment-obligation", "Stripe webhook plumbing; the Stripe fake (#566) owns this evidence"),
  exclude(s.stripeCheckoutRequestLedgerTable, "payment-obligation", "Stripe checkout session ids"),
  exclude(s.entitlementSourceDisputesTable, "payment-obligation", "Stripe dispute ids; the Stripe fake (#566) owns this evidence"),
  exclude(s.rateLimitCountersTable, "runtime-state", "IP-keyed abuse counters"),
  exclude(s.transientRendersTable, "runtime-state", "IP-hash-keyed abuse log"),
  exclude(s.routeStatsTable, "telemetry", "visit counters"),
  exclude(s.routeStatEventsTable, "telemetry", "visit events"),
  exclude(s.affiliateClicksTable, "telemetry", "per-visitor clicks"),
  exclude(s.searchHistoryTable, "telemetry", "free-text search queries"),
  exclude(s.shareIntentsTable, "telemetry", "per-visitor share events"),
  exclude(s.activityFeedTable, "telemetry", "per-user notification prose"),
  exclude(s.userFactPreferencesTable, "telemetry", "per-user viewing state"),
  exclude(s.referenceResearchCacheTable, "not-catalogue", "cached admin research calls"),
  exclude(s.evalRunsTable, "not-catalogue", "the eval lane, dropped with image_prompt_attempts.eval_*"),
  exclude(s.tierFeaturePermissionAuditTable, "not-catalogue", "admin audit history"),
  exclude(s.featurePermissionsMigrationLogTable, "not-catalogue", "one-off migration bookkeeping"),
  exclude(s.engineRevisionBumpsTable, "not-catalogue", "admin audit history"),
];

/** Every table the schema exports, by SQL name. */
export function exportedSchemaTables(): Map<string, PgTable> {
  const out = new Map<string, PgTable>();
  for (const value of Object.values(schema)) {
    if (is(value, PgTableClass)) out.set(getTableConfig(value as PgTable).name, value as PgTable);
  }
  return out;
}

export const sqlName = (table: PgTable): string => getTableConfig(table).name;

/** A SQL identifier, quoted. */
export const quoteIdent = (s: string): string => `"${s.replace(/"/g, '""')}"`;

/** The included tables, in load order. */
export const includedTables = (): IncludedTable[] =>
  LEGACY_FIXTURE_ALLOWLIST.filter((c): c is IncludedTable => c.kind === "include");

/**
 * Column rules keyed by SQL column name, for one included table. Every SQL
 * column appears exactly once.
 */
/** The primary-key columns of an exported table, by SQL name (composite keys in declared order). */
export function primaryKey(table: string): string[] {
  const t = exportedSchemaTables().get(table);
  if (!t) throw new Error(`[legacy-fixture] ${table} is not an exported table`);
  const cfg = getTableConfig(t);
  return cfg.primaryKeys[0]?.columns.map((c) => c.name) ?? cfg.columns.filter((c) => c.primary).map((c) => c.name);
}

export function sqlColumnRules(
  entry: IncludedTable,
): Array<{ property: string; column: string; rule: ScalarRule | JsonRule; dataType: string }> {
  const cfg = getTableConfig(entry.table);
  const unmapped = new Set(cfg.columns.map((c) => c.name));
  const out: Array<{ property: string; column: string; rule: ScalarRule | JsonRule; dataType: string }> = [];
  for (const [property, column] of Object.entries(getColumnsByProperty(entry.table))) {
    const rule = (entry.columns as Record<string, ScalarRule | JsonRule>)[property];
    if (!rule) throw new Error(`[legacy-fixture] ${cfg.name}.${column.name} has no rule`);
    out.push({ property, column: column.name, rule, dataType: column.columnType });
    unmapped.delete(column.name);
  }
  if (unmapped.size > 0) throw new Error(`[legacy-fixture] ${cfg.name}: unmapped columns ${[...unmapped].join(", ")}`);
  return out;
}

/** Drizzle columns keyed by TypeScript property name. */
export function getColumnsByProperty(table: PgTable): Record<string, { name: string; columnType: string }> {
  // drizzle-orm exposes the column map on the table under the property names it was declared with.
  const out: Record<string, { name: string; columnType: string }> = {};
  for (const [key, value] of Object.entries(table as unknown as Record<string, unknown>)) {
    if (value && typeof value === "object" && "columnType" in value && "name" in value) {
      out[key] = value as { name: string; columnType: string };
    }
  }
  return out;
}
