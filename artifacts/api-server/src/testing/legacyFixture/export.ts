/**
 * The legacy-fixture exporter (plan D6). Reads the source database inside one
 * read-only, repeatable-read transaction, addresses `public.<table>` only for
 * the tables the allowlist includes, selects only the columns it names, and
 * returns the scrubbed rows plus a manifest. It never prints, logs or returns
 * a source value: its messages name tables, columns, paths and counts.
 *
 * The CLI (`scripts/export-legacy-fixture.ts`) adds the environment refusals,
 * forces every connection read-only before any database module loads, and
 * writes the files; the sentinel test drives this module directly.
 */
import { createHash } from "node:crypto";
import { isIPv6 } from "node:net";
import fs from "node:fs";
import path from "node:path";
import pg from "pg";

import {
  hasRenderableVisualStrategyOverrideContent,
  resolveEnrichment,
  validateEnrichment,
  type EnrichmentOverrides,
  type FactEnrichment,
} from "@workspace/api-zod";

import { hasUnresolvedFactTokens, renderPersonalized } from "../../lib/renderCanonical";
import { isValidPromptIdentitySnapshot } from "../../lib/imagePrompt/promptIdentity";
import { includedTables, primaryKey, quoteIdent, sqlColumnRules, sqlName, type IncludedTable, type JsonRule, type ScalarRule } from "./allowlist";
import { MediaMap, MediaPlacementError, referencePattern, type MediaPlaceholder, type MediaRole } from "./media";
import { placeholderFor, type PlaceholderFact } from "./placeholderFacts";
import { emptyPredicateRecord, predicateCounts, type PredicateRecord } from "./predicates";
import { Scrubber, type SyntheticPerson } from "./scrub";
import { SHAPES, fixtureSubjectName, type ShapeName } from "./shapes";
import { journalHead } from "./journal";
import { ShapeStop, type WalkContext } from "./walker";

export const SCRUB_RULESET_VERSION = "2";

/** A generated 8×8 JPEG data URL for stock photo references (plan D5). Fixed bytes: an 8×8 mid-grey baseline JPEG. */
export const STOCK_DATA_URL =
  "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAAIAAgBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==";

export type Row = Record<string, unknown>;

export interface ExportManifest {
  fixture: "overhype-legacy";
  scrubRulesetVersion: string;
  sourceCommit: string;
  /** The journal the export's code was built against, and how much of it the source had applied (journal.ts). */
  migrationHead: { journalEntries: number; latestTag: string; appliedOnSource: number; sourceLedgerRows: number };
  extractedAt: string;
  rowCounts: Record<string, number>;
  excludedByPredicate: Record<string, number>;
  keptFactTexts: number;
  placeholderFactTexts: number;
  embeddingBackfillPredicateCount: number;
  placeholders: MediaPlaceholder[];
  /** Legacy memes (no recipe) whose bytes the image route reads from `memeKey(slug)`. */
  legacyMemeImages: Array<{ slug: string; owner: string | null }>;
  predicates: PredicateRecord;
  predicateCounts: Record<string, Record<string, number>>;
  /** Every check the exporter made on the transformed rows, as counts. */
  checks: Record<string, number>;
  /** Per-file sha256, filled in when files are written. */
  files: Record<string, string>;
}

export interface ExportResult {
  /** Absent when the export halted before the rows were transformed. */
  manifest?: ExportManifest;
  tables: Map<string, Row[]>;
  /** Problems that stop the export. Empty when the fixture may be written. Names only, never values. */
  stops: string[];
  /** Reference shapes seen per media role (digits and ids collapsed) — for the dry-run inventory. */
  mediaPatterns: Record<string, number>;
}

export interface ExportOptions {
  /** The source database. */
  sourceUrl: string;
  sourceCommit: string;
  /** Records each freshness predicate on the source; omitted in tests that exercise only the scrub. */
  /** Called with the export's snapshot id; must evaluate against that snapshot or throw (predicates.ts, evaluatePredicatesInSnapshot). */
  evaluatePredicates?: (snapshotId: string) => Promise<PredicateRecord>;
}


const EMAIL_SHAPE = /[A-Za-z0-9._%+-]+@(?!example\.test\b)[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

/** Credential and private-data shapes no output string may match (plan D6). */
const CREDENTIAL_SHAPES: Array<[string, RegExp]> = [
  ["a Stripe secret or restricted key", /\b(sk|rk)_(live|test)_[A-Za-z0-9]{8,}/],
  ["a Stripe webhook secret", /\bwhsec_[A-Za-z0-9]{8,}/],
  ["an OpenAI key", /\bsk-(proj-)?[A-Za-z0-9_-]{20,}/],
  ["a fal key", /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9a-f]{32}\b/i],
  ["a bearer token", /\bBearer\s+[A-Za-z0-9._-]{16,}/],
  ["a JWT", /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ["an email address", EMAIL_SHAPE],
  ["an IPv4 address", /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/],
];

/**
 * IPv6 literals in every spelling — full, compressed (`2001:db8::1`, `::1`), IPv4-mapped, bracketed —
 * found as hex-and-colon runs and confirmed by Node's own parser, so a timestamp or a hash is not one.
 */
const IPV6_CANDIDATE = /(?<![0-9a-z:.])(?:[0-9a-f]{0,4}:){2,7}(?:[0-9a-f]{0,4}|\d{1,3}(?:\.\d{1,3}){3})(?![0-9a-z:])/gi;
const hasIPv6 = (s: string): boolean => [...s.matchAll(IPV6_CANDIDATE)].some((m) => isIPv6(m[0]) && m[0] !== ":");

function* strings(value: unknown): Generator<string> {
  if (typeof value === "string") yield value;
  else if (Array.isArray(value)) for (const v of value) yield* strings(v);
  else if (value && typeof value === "object") for (const v of Object.values(value)) yield* strings(v);
}

export function credentialHits(value: unknown): string[] {
  const hits = new Set<string>();
  for (const s of strings(value)) {
    if (s.startsWith("data:image/")) continue; // the generated placeholder bytes
    for (const [label, re] of CREDENTIAL_SHAPES) {
      if (re.test(s)) hits.add(label);
    }
    if (hasIPv6(s)) hits.add("an IPv6 address");
  }
  return [...hits];
}

interface StripeTestIds {
  available: boolean;
  subscriptions: Set<string>;
  payment_intents: Set<string>;
  invoices: Set<string>;
  disputes: Set<string>;
  customers: Set<string>;
}

async function readStripeTestIds(client: pg.Client): Promise<StripeTestIds> {
  const empty: StripeTestIds = {
    available: false,
    subscriptions: new Set(),
    payment_intents: new Set(),
    invoices: new Set(),
    disputes: new Set(),
    customers: new Set(),
  };
  const { rows } = await client.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.columns
      WHERE table_schema = 'stripe' AND column_name = 'livemode'
        AND table_name IN ('subscriptions','payment_intents','invoices','disputes','customers')`,
  );
  if (rows.length === 0) return empty;
  const out = { ...empty, available: true };
  for (const { table_name } of rows) {
    // Ids only, and only test-mode ones: the eligibility boolean per reference (plan D2, C5). Nothing of this schema is written.
    const r = await client.query<{ id: string }>(`SELECT id FROM stripe.${quoteIdent(table_name)} WHERE livemode = false`);
    (out[table_name as keyof Omit<StripeTestIds, "available">] as Set<string>) = new Set(r.rows.map((x) => x.id));
  }
  return out;
}

function selectSql(entry: IncludedTable): { sql: string; columns: Array<{ column: string; rule: ScalarRule | JsonRule; property: string }> } {
  const cols = sqlColumnRules(entry).filter((c) => c.rule !== "drop");
  const select = cols.map((c) =>
    c.dataType === "PgCustomColumn" ? `t.${quoteIdent(c.column)}::text AS ${quoteIdent(c.column)}` : `t.${quoteIdent(c.column)}`,
  );
  const where = entry.rowFilter ? ` WHERE ${entry.rowFilter}` : "";
  return {
    sql: `SELECT ${select.join(", ")} FROM public.${quoteIdent(sqlName(entry.table))} t${where} ORDER BY 1${cols.length > 1 ? ", 2" : ""}`,
    columns: cols,
  };
}

/**
 * Run the export. Returns rows and manifest; writes nothing. One REPEATABLE READ READ ONLY transaction
 * spans the row read and the predicate pass: its snapshot is exported and handed to `evaluatePredicates`,
 * so the outcomes it records describe the rows the fixture holds (Codex round 1). The connection closes
 * on every path, which ends the transaction and the exported snapshot with it.
 */
export async function runExport(opts: ExportOptions): Promise<ExportResult> {
  const client = new pg.Client({ connectionString: opts.sourceUrl });
  await client.connect();
  try {
    return await exportWithin(client, opts);
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function exportWithin(client: pg.Client, opts: ExportOptions): Promise<ExportResult> {
  const scrubber = new Scrubber();
  const media = new MediaMap(scrubber, () => STOCK_DATA_URL);
  const stops: string[] = [];
  const checks: Record<string, number> = {};
  const count = (k: string, n = 1) => (checks[k] = (checks[k] ?? 0) + n);
  const mediaPatterns: Record<string, number> = {};
  const halt = (): ExportResult => ({ tables: new Map(), stops, mediaPatterns });

  const selects = new Map(includedTables().map((entry) => [sqlName(entry.table), selectSql(entry)] as const));
  const source = new Map<string, Row[]>();
  const journal = journalHead();
  let migrationHead: ExportManifest["migrationHead"] = { journalEntries: journal.entries, latestTag: journal.latestTag, appliedOnSource: 0, sourceLedgerRows: 0 };
  let stripe: StripeTestIds;
  let peopleRows: Array<{ id: string; display_name: string | null; email: string | null }>;
  let embeddingBackfill = 0;
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  const snapshotId = (await client.query<{ id: string }>("SELECT pg_export_snapshot() AS id")).rows[0]!.id;
  {

    const present = new Set(
      (await client.query<{ tablename: string }>(`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`)).rows.map((r) => r.tablename),
    );
    for (const entry of includedTables()) {
      if (!present.has(sqlName(entry.table))) stops.push(`public.${sqlName(entry.table)} is included by the allowlist but absent from the source`);
    }
    if (stops.length) return halt();

    const ledger = (await client.query<{ hash: string }>(`SELECT hash FROM drizzle.__drizzle_migrations`)).rows.map((r) => r.hash);
    const applied = new Set(ledger);
    migrationHead = { ...migrationHead, appliedOnSource: journal.hashes.filter((h) => applied.has(h)).length, sourceLedgerRows: ledger.length };
    if (migrationHead.appliedOnSource < journal.entries) {
      stops.push(`the source has applied ${migrationHead.appliedOnSource} of this commit's ${journal.entries} migrations: migrate it, or export from the commit it is at`);
      return halt();
    }

    stripe = await readStripeTestIds(client);

    // People are registered by rank before any row is scrubbed (plan D3). display_name and email are read
    // only to recognise an actor label; neither leaves this function.
    peopleRows = (await client.query(`SELECT id, display_name, email FROM public.users ORDER BY created_at, id`)).rows;
    scrubber.registerPeople(peopleRows.map((r) => ({ id: r.id, displayName: r.display_name, email: r.email })));

    embeddingBackfill = Number(
      (await client.query<{ n: string }>(`SELECT count(*)::text AS n FROM public.facts WHERE is_active AND (embedding IS NULL OR canonical_text IS NULL)`)).rows[0]!.n,
    );

    for (const [table, { sql }] of selects) source.set(table, (await client.query(sql)).rows);
  }

  // ── Payment eligibility (plan D2, C5): fails closed when the sync data is absent ──
  const excludedByPredicate: Record<string, number> = {};
  const isTestId = (table: keyof Omit<StripeTestIds, "available">, id: unknown) =>
    stripe.available && typeof id === "string" && stripe[table].has(id);
  {
    const ents = source.get("membership_entitlements")!;
    const kept = ents.filter((r) => {
      if (r.source_type === "admin_grant") return true;
      if (r.source_type === "stripe_subscription") return isTestId("subscriptions", r.provider_ref);
      if (r.source_type === "stripe_lifetime_payment") return isTestId("payment_intents", r.provider_ref);
      return false;
    });
    excludedByPredicate.membership_entitlements = ents.length - kept.length;
    source.set("membership_entitlements", kept);

    const hist = source.get("membership_history")!;
    const histKept = hist.filter(
      (r) =>
        (r.stripe_subscription_id == null || isTestId("subscriptions", r.stripe_subscription_id)) &&
        (r.stripe_payment_intent_id == null || isTestId("payment_intents", r.stripe_payment_intent_id)) &&
        (r.stripe_invoice_id == null || isTestId("invoices", r.stripe_invoice_id)) &&
        (r.stripe_dispute_id == null || isTestId("disputes", r.stripe_dispute_id)),
    );
    excludedByPredicate.membership_history = hist.length - histKept.length;
    source.set("membership_history", histKept);
  }

  // ── The kept set: the live text of active facts (plan D4) ──
  const facts = source.get("facts")!;
  const factById = new Map(facts.map((f) => [Number(f.id), f]));
  const keptTexts = new Set(facts.filter((f) => f.is_active === true).map((f) => f.text as string));
  const placeholderCache = new Map<string, PlaceholderFact>();
  const placeholder = (text: string) => {
    let p = placeholderCache.get(text);
    if (!p) placeholderCache.set(text, (p = placeholderFor(text, scrubber)));
    return p;
  };
  const isKept = (text: unknown) => typeof text === "string" && keptTexts.has(text);
  const factKept = (factId: unknown) => {
    const f = factById.get(Number(factId));
    return f ? f.is_active === true : false;
  };
  /**
   * Which rows keep their template (plan D4): a fact iff it is active; a review iff its own fact —
   * the one it stages or was approved into — is active and the texts match byte for byte; an
   * edit-history entry iff it is a kept text. A duplicate match or parent is not ownership.
   */
  const reviewKeepsText = (row: Row) =>
    [row.staging_fact_id, row.approved_fact_id].some((id) => {
      const f = id == null ? undefined : factById.get(Number(id));
      return f?.is_active === true && f.text === row.submitted_text;
    });
  const keepsText = (table: string, row: Row, text: string) =>
    table === "facts" ? row.is_active === true : table === "pending_reviews" ? reviewKeepsText(row) : isKept(text);
  const kept = (text: string, keep: boolean) => (keep ? text : placeholder(text).text);
  // A row whose own text is not kept takes the corpus's hashtags even when its text matches a live one.
  const hashtagsFor = (text: unknown) => (typeof text === "string" ? placeholder(text).hashtags : []);
  const scrubbedFactTemplate = (factId: unknown): string | null => {
    const f = factById.get(Number(factId));
    return f ? kept(f.text as string, f.is_active === true) : null;
  };

  const personOf = (userId: unknown): SyntheticPerson | undefined => (typeof userId === "string" ? scrubber.person(userId) : undefined);
  const usersById = new Map(source.get("users")!.map((u) => [u.id as string, u]));
  const pronounsOf = (userId: unknown): string | null => (typeof userId === "string" ? ((usersById.get(userId)?.pronouns as string | null) ?? null) : null);

  // ── Per-row context ──
  const rowContext = (table: string, row: Row, mode: "note" | "emit"): WalkContext => {
    const owner =
      (row.user_id as string | undefined) ??
      (row.created_by_id as string | undefined) ??
      (row.submitted_by_id as string | undefined) ??
      (row.author_id as string | undefined) ??
      (table === "users" ? (row.id as string) : undefined) ??
      null;
    let keptText = false;
    let placeholderHashtags: readonly string[] = [];
    if (table === "facts") {
      keptText = row.is_active === true;
      placeholderHashtags = hashtagsFor(row.text);
    } else if (table === "pending_reviews") {
      keptText = reviewKeepsText(row);
      placeholderHashtags = hashtagsFor(row.submitted_text);
    } else if ("fact_id" in row) {
      keptText = factKept(row.fact_id);
      const f = factById.get(Number(row.fact_id));
      placeholderHashtags = f ? hashtagsFor(f.text) : [];
    }
    const person = personOf(owner);
    // Row keys reach the manifest (media roles) and messages: never a source identity or a source path.
    const key =
      table === "users"
        ? scrubber.userId(String(row.id))
        : table === "upload_image_metadata"
          ? `#${scrubber.hmac("row", String(row.object_path)).slice(0, 8)}`
          : rowKey(table, row);
    return {
      scrubber,
      media,
      mode,
      where: `${table} row ${key}`,
      table,
      row: key,
      ownerSourceId: owner,
      keptText,
      placeholderHashtags,
      syntheticName: person?.firstName ?? "Alex",
    };
  };

  // ── Pass 1: note every media reference; Pass 2: emit ──
  const out = new Map<string, Row[]>();
  const legacyMemeImages: Array<{ slug: string; owner: string | null }> = [];
  for (const mode of ["note", "emit"] as const) {
    if (mode === "emit") {
      try {
        media.resolve();
      } catch (err) {
        if (err instanceof MediaPlacementError) stops.push(err.message);
        else throw err;
        return halt();
      }
    }
    for (const entry of includedTables()) {
      const table = sqlName(entry.table);
      const cols = selects.get(table)!.columns;
      const rows: Row[] = [];
      for (const row of source.get(table)!) {
        const ctx = rowContext(table, row, mode);
        const o: Row = {};
        try {
          for (const { column, rule } of cols) {
            o[column] = transformColumn(table, column, rule, row, ctx, mode);
          }
        } catch (err) {
          if (err instanceof ShapeStop || err instanceof MediaPlacementError) {
            if (mode === "note") stops.push(err.message);
            continue;
          }
          throw err;
        }
        rows.push(o);
        if (mode === "emit" && table === "memes" && row.image_source == null) {
          legacyMemeImages.push({ slug: row.permalink_slug as string, owner: typeof row.created_by_id === "string" ? scrubber.userId(row.created_by_id) : null });
        }
      }
      if (mode === "emit") out.set(table, rows);
    }
    if (stops.length) return halt();
  }

  // ── Hashtags: kept-text facts keep theirs; placeholder facts take the corpus's; counts recomputed ──
  rebuildHashtags(out, source, placeholder, count);

  // ── Ref checks (app-managed links, plan D4) ──
  checkRefs(out, source, (id) => scrubber.userId(id), stops, count);

  // ── Parity checks: validators and readers answer as on the source ──
  parityChecks(source, out, stops, count);

  // ── Credential scan over every output string ──
  for (const [table, rows] of out) {
    for (const r of rows) {
      for (const [col, v] of Object.entries(r)) {
        const h = credentialHits(v);
        if (h.length) stops.push(`${table}.${col} row ${rowKey(table, r)}: ${h.join(", ")} in the output`);
      }
    }
  }
  count("credential-scan:rows", [...out.values()].reduce((n, r) => n + r.length, 0));

  // Still inside the export's transaction: the readers see the snapshot the rows came from.
  const predicates = opts.evaluatePredicates ? await opts.evaluatePredicates(snapshotId) : emptyPredicateRecord();
  await client.query("COMMIT");

  /** Re-render a stored personalized text over the row's (kept or placeholder) template. */
  function rerender(row: Row, ctx: WalkContext, column: string, label: string, name: string, pronouns: string | null): string {
    const template = scrubbedFactTemplate(row.fact_id);
    if (!template) throw new ShapeStop(ctx.where, column, "a rendered text whose fact is not in the export");
    const rendered = renderPersonalized(template, name, pronouns);
    if (hasUnresolvedFactTokens(rendered)) throw new ShapeStop(ctx.where, column, "a re-rendered text with unresolved tokens");
    count(label);
    return rendered;
  }

  function transformColumn(table: string, column: string, rule: ScalarRule | JsonRule, row: Row, ctx: WalkContext, mode: "note" | "emit"): unknown {
    const value = row[column];
    if (rule.startsWith("shape:")) {
      const shape = SHAPES[rule.slice("shape:".length) as ShapeName];
      return shape.transform(value, { ...ctx, where: `${table}.${column} row ${ctx.row}` }, { overridePath: row.path as string | undefined });
    }
    if (rule.startsWith("ref:")) return value;
    switch (rule as ScalarRule) {
      case "keep":
        return value;
      case "null":
        return null;
      case "map-user":
        return value == null ? value : scrubber.userId(String(value));
      case "fact-text": {
        if (value == null) return value;
        const text = String(value);
        if (column === "canonical_text") {
          return row.is_active === true ? text : placeholder(row.text as string).canonicalText;
        }
        return kept(text, keepsText(table, row, text));
      }
      case "fact-derived": {
        if (row.is_active === true) return value;
        const p = placeholder(row.text as string);
        return column === "split_token_index" ? p.splitTokenIndex : p.hasPronouns;
      }
      case "prose":
        return scrubber.prose(value as string | null);
      case "rendered:attempt": {
        if (value == null) return value;
        const rc = (row.render_controls ?? {}) as { promptIdentity?: { name?: string; pronouns?: string | null; source?: string }; reviewRenderSubject?: { name: string; pronouns: string | null } };
        // The worker's precedence (imagePromptJobs.ts:456-485): frozen identity, then the review subject, then the user.
        let name = "Alex";
        let pronouns: string | null = null;
        if (rc.promptIdentity && isValidPromptIdentitySnapshot(rc.promptIdentity)) {
          name = rc.promptIdentity.source === "user" ? ctx.syntheticName : fixtureSubjectName(rc.promptIdentity.name!, ctx);
          pronouns = rc.promptIdentity.pronouns ?? null;
        } else if (rc.reviewRenderSubject?.name?.trim()) {
          name = fixtureSubjectName(rc.reviewRenderSubject.name, ctx);
          pronouns = rc.reviewRenderSubject.pronouns ?? null;
        } else if (typeof row.user_id === "string") {
          name = personOf(row.user_id)?.displayName ?? "Alex";
          pronouns = pronounsOf(row.user_id);
        }
        return rerender(row, ctx, column, "rendered:attempt", name, pronouns);
      }
      case "rendered:meme":
        if (value == null) return value;
        return rerender(row, ctx, column, "rendered:meme", ctx.syntheticName, pronounsOf(row.created_by_id));
      case "embedding-if-kept":
        return row.is_active === true ? value : null;
      case "rekey":
      case "predicate-hash":
        return scrubber.rekey(value as string | null);
      case "media": {
        if (value == null || value === "") return value;
        const v = String(value);
        if (mode === "note") {
          const shape = `${table}.${column}: ${referencePattern(v)}`;
          mediaPatterns[shape] = (mediaPatterns[shape] ?? 0) + 1;
        }
        const isProfile = (table === "users" && column === "profile_image_url") || (table === "upload_image_metadata" && row.is_profile === true);
        const size = table === "upload_image_metadata" ? { width: Number(row.width), height: Number(row.height) } : undefined;
        return media.noteOrRewrite(v, mediaRole(table, column, row), mode, { table, row: ctx.row }, ctx.ownerSourceId, { isProfile, ...(size ? { size } : {}) });
      }
      case "meme-route-url": {
        const slug = String(row.permalink_slug);
        if (value !== `/api/memes/${slug}/image`) throw new ShapeStop(ctx.where, column, "a meme image URL that is not the slug's route");
        return value;
      }
      case "admin-label":
        return scrubber.adminLabel(value as string | null);
      case "drop":
        return undefined;
    }
    if (rule.startsWith("synthetic:")) return synthetic(rule.slice("synthetic:".length), value, row, ctx);
    throw new ShapeStop(ctx.where, column, `rule ${rule} is not implemented`);
  }

  function synthetic(kind: string, value: unknown, row: Row, ctx: WalkContext): unknown {
    const person = personOf(row.id);
    switch (kind) {
      case "email":
        return value == null ? value : person?.email;
      case "first-name":
        return value == null ? value : person?.firstName;
      case "last-name":
        return value == null ? value : person?.lastName;
      case "display-name":
        return value == null ? value : person?.displayName;
      case "true":
        return true;
      case "verified-at-created":
        return row.created_at;
      case "stripe-customer":
        return value != null && isTestId("customers", value) ? scrubber.stripeId(String(value)) : null;
      case "stripe-provider-ref":
      case "stripe-id":
        return scrubber.stripeId(value as string | null);
      case "stripe-price":
        return typeof value === "string" && value.startsWith("price_") ? scrubber.stripeId(value) : value;
      case "opaque-id":
        return scrubber.opaqueId(value as string | null);
      case "vendor-error":
        return value == null ? value : "[fixture: vendor error redacted]";
      case "fixture-url":
        return scrubber.fixtureUrl(value as string | null);
      case "fixture-title":
        return scrubber.prose(value as string | null);
      case "config-value":
        return typeof value === "string"
          ? value.replace(new RegExp(EMAIL_SHAPE.source, "g"), (address) => `fixture-config-${scrubber.hmac("config-email", address).slice(0, 8)}@example.test`)
          : value;
    }
    throw new ShapeStop(ctx.where, "", `synthetic kind ${kind} is not implemented`);
  }

  const total = (t: string) => out.get(t)?.length ?? 0;
  const manifest: ExportManifest = {
    fixture: "overhype-legacy",
    scrubRulesetVersion: SCRUB_RULESET_VERSION,
    sourceCommit: opts.sourceCommit,
    migrationHead,
    extractedAt: new Date().toISOString(),
    rowCounts: Object.fromEntries([...out.keys()].map((t) => [t, total(t)])),
    excludedByPredicate,
    keptFactTexts: facts.filter((f) => f.is_active === true).length,
    placeholderFactTexts: facts.filter((f) => f.is_active !== true).length,
    embeddingBackfillPredicateCount: embeddingBackfill,
    placeholders: media.placeholders(),
    legacyMemeImages,
    predicates,
    predicateCounts: predicateCounts(predicates),
    checks,
    files: {},
  };
  return { manifest, tables: out, stops, mediaPatterns };
}

function rowKey(table: string, row: Row): string {
  if (row.id !== undefined) return String(row.id);
  if (table === "fact_hashtags") return `${row.fact_id}/${row.hashtag_id}`;
  if (table === "ratings") return `${row.fact_id}/(a rating)`;
  if (table === "tier_feature_permissions") return `${row.tier}/${row.feature_key}`;
  if (table === "upload_image_metadata") return "(an upload row)";
  if (table === "admin_config" || table === "feature_flags") return String(row.key);
  if (table === "fal_pricing_cache") return String(row.endpoint_id);
  return "?";
}

function mediaRole(table: string, column: string, row: Row): MediaRole {
  if (table === "users") return "profile-image";
  if (table === "upload_image_metadata") return column === "source_object_path" ? "upload-metadata-source" : row.is_profile === true ? "upload-metadata-profile" : "upload-metadata";
  if (table === "user_ai_images") return row.image_type === "reference" ? "ai-tracking-reference" : "ai-tracking-generic";
  if (table === "image_prompt_attempts") return "attempt-output";
  return "catalogue-asset";
}

/** Hashtags of kept-text facts keep their names; placeholder facts take the corpus's; fact_count is recomputed. */
function rebuildHashtags(
  out: Map<string, Row[]>,
  source: Map<string, Row[]>,
  placeholder: (text: string) => PlaceholderFact,
  count: (k: string, n?: number) => void,
): void {
  const facts = source.get("facts")!;
  const tags = source.get("hashtags")!;
  const links = source.get("fact_hashtags")!;
  const keptFactIds = new Set(facts.filter((f) => f.is_active === true).map((f) => Number(f.id)));
  const nameById = new Map(tags.map((t) => [Number(t.id), t.name as string]));
  const idByName = new Map(tags.map((t) => [t.name as string, Number(t.id)]));
  let nextId = Math.max(0, ...tags.map((t) => Number(t.id))) + 1;
  const ensure = (name: string) => {
    let id = idByName.get(name);
    if (id === undefined) {
      id = nextId++;
      idByName.set(name, id);
      nameById.set(id, name);
    }
    return id;
  };
  const newLinks: Row[] = [];
  for (const l of links) if (keptFactIds.has(Number(l.fact_id))) newLinks.push({ fact_id: l.fact_id, hashtag_id: l.hashtag_id });
  for (const f of facts) {
    if (keptFactIds.has(Number(f.id))) continue;
    if (!links.some((l) => Number(l.fact_id) === Number(f.id))) continue; // a fact with no tags keeps none
    for (const name of placeholder(f.text as string).hashtags) newLinks.push({ fact_id: f.id, hashtag_id: ensure(name) });
  }
  const used = new Set(newLinks.map((l) => Number(l.hashtag_id)));
  const factCount = new Map<number, number>();
  for (const l of newLinks) factCount.set(Number(l.hashtag_id), (factCount.get(Number(l.hashtag_id)) ?? 0) + 1);
  out.set("fact_hashtags", newLinks);
  out.set(
    "hashtags",
    [...used].sort((a, b) => a - b).map((id) => ({ id, name: nameById.get(id)!, fact_count: factCount.get(id) ?? 0 })),
  );
  count("hashtags:rebuilt", used.size);
}

/**
 * Every link the allowlist names — each `ref:<table>` column and each `map-user` column — must resolve
 * in the output (plan D4). A link that resolves on neither side is a column with no foreign key naming
 * a row deleted on the source, and that shape is kept; a link the export itself broke stops.
 */
function checkRefs(out: Map<string, Row[]>, source: Map<string, Row[]>, mapUser: (id: string) => string, stops: string[], count: (k: string, n?: number) => void): void {
  const keysOf = (rows: Map<string, Row[]>, table: string, map: (v: string) => string = (v) => v) => {
    const [key] = primaryKey(table);
    return new Set((rows.get(table) ?? []).map((r) => map(String(r[key!]))));
  };
  const targets = new Map<string, { out: Set<string>; source: Set<string> }>();
  const targetOf = (table: string) => {
    let t = targets.get(table);
    if (!t) targets.set(table, (t = { out: keysOf(out, table), source: keysOf(source, table, table === "users" ? mapUser : undefined) }));
    return t;
  };
  for (const entry of includedTables()) {
    const table = sqlName(entry.table);
    for (const { column, rule } of sqlColumnRules(entry)) {
      const target = rule.startsWith("ref:") ? rule.slice(4) : rule === "map-user" && !(table === "users" && column === "id") ? "users" : null;
      if (!target) continue;
      const t = targetOf(target);
      for (const r of out.get(table) ?? []) {
        const v = r[column];
        if (v == null) continue;
        if (t.out.has(String(v))) count(`ref:${table}.${column}`);
        else if (t.source.has(String(v))) stops.push(`${table}.${column} row ${rowKey(table, r)}: points at a ${target} row the export does not hold`);
        else count(`ref:dangling-on-source:${table}.${column}`);
      }
    }
  }
}

const VALIDATED_SHAPE_COLUMNS: Array<[string, string, ShapeName]> = [
  ["facts", "enrichment", "factEnrichment"],
  ["facts", "enrichment_ai_derived", "factEnrichment"],
  ["facts", "enrichment_overrides", "enrichmentOverrides"],
  ["facts", "visual_concept_candidates", "visualConceptCandidatesBlob"],
  ["facts", "last_processed_signature", "processingSignature"],
  ["pending_reviews", "enrichment", "factEnrichment"],
  ["pending_reviews", "visual_render_approval_waiver", "visualRenderApprovalWaiver"],
  ["fact_enrichment_versions", "enrichment", "factEnrichment"],
  ["fact_enrichment_versions", "enrichment_ai_derived", "factEnrichment"],
  ["fact_enrichment_versions", "enrichment_overrides", "enrichmentOverrides"],
  ["fact_enrichment_versions", "visual_override", "visualStrategyOverride"],
  ["fact_enrichment_versions", "signature", "processingSignature"],
  ["enrichment_override_history", "old_value", "overrideValue"],
  ["enrichment_override_history", "new_value", "overrideValue"],
  ["image_prompt_attempts", "fact_enrichment_snapshot", "factEnrichment"],
  ["image_prompt_attempts", "visual_plan", "visualPlan"],
  ["image_prompt_attempts", "compiled_prompt", "compiledPrompt"],
  ["image_prompt_attempts", "render_controls", "renderControls"],
  ["image_prompt_attempts", "identity_policy", "identityPolicy"],
  ["image_prompt_attempts", "source_image_analysis", "sourceImageAnalysis"],
  ["image_prompt_attempts", "subject_fact_compatibility", "subjectFactCompatibility"],
  ["memes", "image_source", "imageSource"],
  ["memes", "text_options", "textOptions"],
  ["facts", "ai_scene_prompts", "aiScenePrompts"],
  ["facts", "ai_meme_images", "aiMemeImages"],
];

/** The schema paths of a validator's issue list, never its messages (a message can quote the value). */
function issuePaths(issues: string): string {
  return [...new Set(issues.split("; ").map((i) => i.split(": ")[0]!.replace(/\.\d+(?=\.|$)/g, "[*]")))].join(", ");
}

/** The outcomes the readers reach on a source row and its output row must be the same (plan D4's table). */
function parityChecks(source: Map<string, Row[]>, out: Map<string, Row[]>, stops: string[], count: (k: string, n?: number) => void): void {
  const keyOf = (table: string, r: Row) => rowKey(table, r);
  const indexed = (table: string, rows: Row[]) => new Map(rows.map((r) => [keyOf(table, r), r]));

  for (const [table, column, shapeName] of VALIDATED_SHAPE_COLUMNS) {
    const shape = SHAPES[shapeName];
    if (!shape.validate) continue;
    const outRows = indexed(table, out.get(table) ?? []);
    for (const src of source.get(table) ?? []) {
      const o = outRows.get(keyOf(table, src));
      if (!o || src[column] == null) continue;
      const row = { overridePath: src.path as string | undefined };
      const beforeIssues = shape.validate(src[column], row);
      const afterIssues = shape.validate(o[column], row);
      const before = beforeIssues === null;
      const after = afterIssues === null;
      if (before !== after) {
        stops.push(`${table}.${column} row ${keyOf(table, src)}: validates ${before ? "on the source but not" : "on the output but not"} on the ${before ? "output" : "source"} (failing at ${issuePaths((beforeIssues ?? afterIssues)!)})`);
      }
      else count(`validator:${table}.${column}`);
    }
  }

  // The override resolver, the concept gate and the renderable-override signal (enrichmentOverrides.ts:195; moderationStaging.ts:237; visualStrategyOverride.ts:535).
  const readerOutcome = (aiDerived: unknown, overrides: unknown, effective: unknown) => {
    const ai = validateEnrichment(aiDerived);
    const eff = validateEnrichment(effective);
    const vso = eff.ok ? eff.data.visualPromptStrategyOverride : undefined;
    const resolved = ai.ok
      ? resolveEnrichment({ aiDerived: ai.data as FactEnrichment, overrides: (overrides ?? {}) as EnrichmentOverrides, visualPromptStrategyOverride: vso })
      : null;
    return JSON.stringify({
      invalidPaths: resolved?.summary.invalidPaths ?? null,
      baselineChangedPaths: resolved?.summary.baselineChangedPaths ?? null,
      crossFieldInvalid: resolved?.summary.crossFieldInvalid ?? null,
      hasVso: resolved?.summary.hasVisualStrategyOverride ?? null,
      conceptPresent: Boolean(vso?.coreSceneOverride?.trim()),
      renderable: vso ? hasRenderableVisualStrategyOverrideContent(vso) : null,
    });
  };
  for (const table of ["facts", "fact_enrichment_versions"]) {
    const outRows = indexed(table, out.get(table) ?? []);
    for (const src of source.get(table) ?? []) {
      const o = outRows.get(keyOf(table, src));
      if (!o) continue;
      const a = readerOutcome(src.enrichment_ai_derived, src.enrichment_overrides, src.enrichment);
      const b = readerOutcome(o.enrichment_ai_derived, o.enrichment_overrides, o.enrichment);
      if (a !== b) {
        const [pa, pb] = [JSON.parse(a) as Record<string, unknown>, JSON.parse(b) as Record<string, unknown>];
        const differ = Object.keys(pa).filter((k) => JSON.stringify(pa[k]) !== JSON.stringify(pb[k]));
        stops.push(`${table} row ${keyOf(table, src)}: the override resolver or concept gate answers differently on the output (${differ.join(", ")})`);
      }
      else count(`reader:${table}.resolveEnrichment`);
    }
  }

  // The frozen identity's validity (imagePromptJobs.ts:464).
  const attemptsOut = indexed("image_prompt_attempts", out.get("image_prompt_attempts") ?? []);
  for (const src of source.get("image_prompt_attempts") ?? []) {
    const o = attemptsOut.get(keyOf("image_prompt_attempts", src));
    if (!o) continue;
    const a = isValidPromptIdentitySnapshot((src.render_controls as { promptIdentity?: unknown } | null)?.promptIdentity);
    const b = isValidPromptIdentitySnapshot((o.render_controls as { promptIdentity?: unknown } | null)?.promptIdentity);
    if (a !== b) stops.push(`image_prompt_attempts row ${keyOf("image_prompt_attempts", src)}: the frozen identity's validity changed`);
    else count("reader:image_prompt_attempts.promptIdentity");
  }
}

/** Write the NDJSON files and the manifest into an empty directory. */
export function writeFixture(result: ExportResult, outDir: string): void {
  if (!result.manifest || result.stops.length) throw new Error("[legacy-fixture] the export stopped; there is nothing to write");
  if (fs.existsSync(outDir) && fs.readdirSync(outDir).length > 0) throw new Error(`[legacy-fixture] ${outDir} is not empty`);
  fs.mkdirSync(outDir, { recursive: true });
  const files: Record<string, string> = {};
  for (const entry of includedTables()) {
    const table = sqlName(entry.table);
    const rows = result.tables.get(table) ?? [];
    const body = rows.map((r) => JSON.stringify(r, (_k, v) => (v instanceof Date ? v.toISOString() : v))).join("\n") + (rows.length ? "\n" : "");
    const name = `${table}.ndjson`;
    fs.writeFileSync(path.join(outDir, name), body);
    files[name] = createHash("sha256").update(body).digest("hex");
  }
  const manifest = { ...result.manifest, files };
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
}
