import { pgTable, bigserial, bigint, integer, varchar, text, jsonb, timestamp, index, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * Image tracing (plan docs/plans/PLAN_IMAGE_TRACING.md; #905). Two tables,
 * written by `artifacts/api-server/src/lib/provenance/`, read by the admin
 * "Trace an image" screen.
 *
 * Neither table has a foreign key, deliberately: every reference is a plain
 * value, so deleting a meme, an upload, an attempt, a fact or an account can
 * never cascade into a record or null it. A record outlives its picture
 * (plan, Settled Decision 2). Only the retention purge
 * (`image_provenance.retention_days`, 0 = never) removes records.
 */

/** Who started the work: a member, an admin, nobody signed in, or unattended work. */
export const PROVENANCE_ACTOR_KINDS = ["member", "admin", "anonymous", "system"] as const;
export type ProvenanceActorKind = (typeof PROVENANCE_ACTOR_KINDS)[number];

/** Which code path called the vendor. */
export const GENERATION_PRODUCERS = [
  "product_render",
  "review_render",
  "eval_render",
  "comparison_cell",
  "engine_workbench",
] as const;
export type GenerationProducer = (typeof GENERATION_PRODUCERS)[number];

/**
 * The exact request a vendor received, persisted BEFORE it was submitted
 * (plan, Proposed Design: "Execution context, before the vendor is called"),
 * with the vendor's request id added when it returns. A storage-only retry or
 * a recovery reads this row; it never rebuilds the request from today's
 * configuration.
 */
export const imageGenerationRequestsTable = pgTable("image_generation_requests", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  producer: varchar("producer", { length: 24 }).notNull().$type<GenerationProducer>(),
  engineId: varchar("engine_id", { length: 64 }),
  endpointId: text("endpoint_id").notNull(),
  /** The input object exactly as submitted to the endpoint. */
  request: jsonb("request").notNull(),
  vendorRequestId: text("vendor_request_id"),
  attemptId: bigint("attempt_id", { mode: "number" }),
  comparisonCellId: bigint("comparison_cell_id", { mode: "number" }),
  factId: integer("fact_id"),
  actorKind: varchar("actor_kind", { length: 12 }).notNull().$type<ProvenanceActorKind>(),
  actorUserId: varchar("actor_user_id"),
  /** The account's contact address at the time (David, 2026-11-10, Question 1). */
  actorEmail: text("actor_email"),
  /** Full source commit the submitting process was built from; null = unversioned run. */
  sourceCommit: varchar("source_commit", { length: 40 }),
  /** The commit's date and subject (the pull request title, for a squash merge), captured at build. */
  sourceCommitAt: timestamp("source_commit_at", { withTimezone: true }),
  sourceCommitTitle: text("source_commit_title"),
  deploymentId: text("deployment_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("IDX_igr_attempt_id").on(t.attemptId),
  index("IDX_igr_comparison_cell_id").on(t.comparisonCellId),
  index("IDX_igr_vendor_request_id").on(t.vendorRequestId),
  check("image_generation_requests_producer_check", sql`((producer)::text = ANY (ARRAY[('product_render'::character varying)::text, ('review_render'::character varying)::text, ('eval_render'::character varying)::text, ('comparison_cell'::character varying)::text, ('engine_workbench'::character varying)::text]))`),
  check("image_generation_requests_actor_kind_check", sql`((actor_kind)::text = ANY (ARRAY[('member'::character varying)::text, ('admin'::character varying)::text, ('anonymous'::character varying)::text, ('system'::character varying)::text]))`),
]);

export type ImageGenerationRequest = typeof imageGenerationRequestsTable.$inferSelect;

/** What a picture is. */
export const PROVENANCE_KINDS = [
  "ai_render",
  "comparison_cell",
  "workbench",
  "upload",
  "meme_bake",
  "meme_live",
  "preview",
  "download",
] as const;
export type ProvenanceKind = (typeof PROVENANCE_KINDS)[number];

/**
 * One row per picture produced, committed with the hash of exactly the bytes
 * that are then stored or sent, and never edited afterwards. Its id is a
 * random 52-bit integer (not sequential, so one id says nothing about another
 * or about volume; within JavaScript's exact-integer range) and is the opaque
 * id a file carries.
 */
export const imageProvenanceTable = pgTable("image_provenance", {
  id: bigint("id", { mode: "number" }).primaryKey(),
  kind: varchar("kind", { length: 24 }).notNull().$type<ProvenanceKind>(),
  generationRequestId: bigint("generation_request_id", { mode: "number" }),
  /** The record of the picture this one was made from (a meme's background upload). */
  sourceProvenanceId: bigint("source_provenance_id", { mode: "number" }),
  actorKind: varchar("actor_kind", { length: 12 }).notNull().$type<ProvenanceActorKind>(),
  actorUserId: varchar("actor_user_id"),
  actorEmail: text("actor_email"),
  /** Lookup keys that outlive their rows: a link resolves through these. */
  memeSlug: varchar("meme_slug", { length: 16 }),
  objectPath: text("object_path"),
  attemptId: bigint("attempt_id", { mode: "number" }),
  comparisonCellId: bigint("comparison_cell_id", { mode: "number" }),
  factId: integer("fact_id"),
  engineId: varchar("engine_id", { length: 64 }),
  /** What was true when the picture was made, by kind (prompt, caption, options, ...). */
  snapshot: jsonb("snapshot").notNull().default({}),
  sha256: varchar("sha256", { length: 64 }).notNull(),
  mime: varchar("mime", { length: 32 }).notNull(),
  byteSize: integer("byte_size").notNull(),
  width: integer("width"),
  height: integer("height"),
  /** The invisible-watermark scheme, when one was embedded (increment 2). */
  watermarkScheme: varchar("watermark_scheme", { length: 32 }),
  sourceCommit: varchar("source_commit", { length: 40 }),
  /** The commit's date and subject (the pull request title, for a squash merge), captured at build. */
  sourceCommitAt: timestamp("source_commit_at", { withTimezone: true }),
  sourceCommitTitle: text("source_commit_title"),
  deploymentId: text("deployment_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("IDX_image_provenance_sha256").on(t.sha256),
  index("IDX_image_provenance_object_path").on(t.objectPath),
  index("IDX_image_provenance_meme_slug").on(t.memeSlug),
  index("IDX_image_provenance_attempt_id").on(t.attemptId),
  index("IDX_image_provenance_comparison_cell_id").on(t.comparisonCellId),
  index("IDX_image_provenance_created_at").on(t.createdAt),
  check("image_provenance_kind_check", sql`((kind)::text = ANY (ARRAY[('ai_render'::character varying)::text, ('comparison_cell'::character varying)::text, ('workbench'::character varying)::text, ('upload'::character varying)::text, ('meme_bake'::character varying)::text, ('meme_live'::character varying)::text, ('preview'::character varying)::text, ('download'::character varying)::text]))`),
  check("image_provenance_actor_kind_check", sql`((actor_kind)::text = ANY (ARRAY[('member'::character varying)::text, ('admin'::character varying)::text, ('anonymous'::character varying)::text, ('system'::character varying)::text]))`),
]);

export type ImageProvenance = typeof imageProvenanceTable.$inferSelect;
