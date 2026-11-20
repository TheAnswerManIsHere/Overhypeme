/**
 * @purpose The submitter's own view of what they submitted for moderation (plan PLAN_LIBRARY_SUBMISSIONS.md): one identity per submission, one status each — Under Review, Approved & Live, Declined, No longer live — and the counts, search and pages the Library's Submissions tab reads, all from the same predicates so they cannot disagree.
 * @subsystem public-site
 */
import { db } from "@workspace/db";
import { commentsTable, factsTable, pendingReviewsTable } from "@workspace/db/schema";
import { and, asc, desc, eq, sql, type AnyColumn, type SQL } from "drizzle-orm";

export type SubmissionType = "facts" | "comments";
export type SubmissionStatus = "review" | "live" | "declined" | "gone";
export type StatusCounts = Record<SubmissionStatus, number>;
export type TypeCounts = Record<SubmissionType, StatusCounts>;

const r = pendingReviewsTable;
const f = factsTable;
const c = commentsTable;

// ── Identity and classification ────────────────────────────────────
//
// A fact submission is exactly one of: a fact the person submitted that was
// approved (or is live, which implies it), whatever reviews sit behind it; or
// a review the person submitted that is still pending or was rejected. An
// approved review is never listed (its fact is), and a never-approved staging
// fact is never listed (its review is). One comment is one submission.

/** The person's reviews that stand as submissions: pending or rejected. */
function reviewScope(userId: string): SQL {
  return and(eq(r.submittedById, userId), sql`${r.status} IN ('pending', 'rejected')`)!;
}

/** The person's facts that stand as submissions: approved, live or not. */
function factScope(userId: string): SQL {
  return and(eq(f.submittedById, userId), sql`(${f.isActive} OR ${f.approvedAt} IS NOT NULL)`)!;
}

function commentScope(userId: string): SQL {
  return eq(c.authorId, userId);
}

const REVIEW_STATUS = {
  review: sql`${r.status} = 'pending'`,
  declined: sql`${r.status} = 'rejected'`,
} as const;

const FACT_STATUS = {
  live: sql`${f.isActive}`,
  gone: sql`NOT ${f.isActive}`,
} as const;

/** Visible on the site, wherever its fact stands: approved and not flagged. */
const commentApprovedVisible = sql`(${c.status} = 'approved' AND NOT ${c.flagged})`;
const commentDeclined = sql`${c.status} = 'rejected'`;

/**
 * A comment's status. Under Review is written as "everything else", so the
 * four are total and disjoint by construction: an unrecognised status, or an
 * approved comment flagged for another look, can never read as live.
 */
const COMMENT_STATUS: Record<SubmissionStatus, SQL> = {
  declined: commentDeclined,
  live: sql`(${commentApprovedVisible} AND ${f.isActive})`,
  gone: sql`(${commentApprovedVisible} AND NOT ${f.isActive})`,
  review: sql`NOT (${commentDeclined} OR ${commentApprovedVisible})`,
};

// ── Search ─────────────────────────────────────────────────────────

/** At most this many words are matched; the rest of a long search is ignored. */
const MAX_TERMS = 8;

/**
 * The words of a search, each with its LIKE wildcards escaped so they match
 * literally. A leading "#" is dropped, so "#chin" and "chin" find the same.
 */
export function searchTerms(q: string | undefined): string[] {
  if (!q) return [];
  return q
    .trim()
    .split(/\s+/)
    .map((w) => w.replace(/^#+/, ""))
    .filter((w) => w.length > 0)
    .slice(0, MAX_TERMS)
    .map((w) => `%${w.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`);
}

/** Every term must appear: in the fact's saved wording or one of its hashtags. */
function reviewSearch(terms: string[]): SQL | undefined {
  if (!terms.length) return undefined;
  return and(...terms.map((p) => sql`(${r.submittedText} ILIKE ${p} OR EXISTS (
    SELECT 1 FROM jsonb_array_elements_text(coalesce(${r.hashtags}, '[]'::jsonb)) AS h(name) WHERE h.name ILIKE ${p}))`));
}

function factSearch(terms: string[]): SQL | undefined {
  if (!terms.length) return undefined;
  return and(...terms.map((p) => sql`(${f.text} ILIKE ${p} OR EXISTS (
    SELECT 1 FROM fact_hashtags fh JOIN hashtags h ON h.id = fh.hashtag_id
     WHERE fh.fact_id = ${f.id} AND h.name ILIKE ${p}))`));
}

function commentSearch(terms: string[]): SQL | undefined {
  if (!terms.length) return undefined;
  return and(...terms.map((p) => sql`${c.text} ILIKE ${p}`));
}

// ── Counts ─────────────────────────────────────────────────────────

const n = (s: SQL) => sql<number>`(count(*) FILTER (WHERE ${s}))::int`;

async function countFacts(userId: string, search: SQL | undefined, reviewSearchSql: SQL | undefined): Promise<StatusCounts> {
  const [[reviews], [facts]] = await Promise.all([
    db.select({
      review: n(and(REVIEW_STATUS.review, reviewSearchSql ?? sql`true`)!),
      declined: n(and(REVIEW_STATUS.declined, reviewSearchSql ?? sql`true`)!),
    }).from(r).where(reviewScope(userId)),
    db.select({
      live: n(and(FACT_STATUS.live, search ?? sql`true`)!),
      gone: n(and(FACT_STATUS.gone, search ?? sql`true`)!),
    }).from(f).where(factScope(userId)),
  ]);
  return { review: reviews!.review, declined: reviews!.declined, live: facts!.live, gone: facts!.gone };
}

async function countComments(userId: string, search: SQL | undefined): Promise<StatusCounts> {
  const s = search ?? sql`true`;
  const [row] = await db.select({
    review: n(and(COMMENT_STATUS.review, s)!),
    live: n(and(COMMENT_STATUS.live, s)!),
    declined: n(and(COMMENT_STATUS.declined, s)!),
    gone: n(and(COMMENT_STATUS.gone, s)!),
  }).from(c).innerJoin(f, eq(c.factId, f.id)).where(commentScope(userId));
  return row!;
}

/** Totals per type and status, and with a search term, the matches too. */
export async function countMySubmissions(userId: string, q?: string): Promise<{ totals: TypeCounts; matches: TypeCounts | null }> {
  const terms = searchTerms(q);
  const [factTotals, commentTotals, factMatches, commentMatches] = await Promise.all([
    countFacts(userId, undefined, undefined),
    countComments(userId, undefined),
    terms.length ? countFacts(userId, factSearch(terms), reviewSearch(terms)) : null,
    terms.length ? countComments(userId, commentSearch(terms)) : null,
  ]);
  return {
    totals: { facts: factTotals, comments: commentTotals },
    matches: factMatches && commentMatches ? { facts: factMatches, comments: commentMatches } : null,
  };
}

// ── Pages ──────────────────────────────────────────────────────────

/** The cursor: the last row's sort date, at full precision, and its id. */
function encodeCursor(key: string, id: number): string {
  return Buffer.from(JSON.stringify([key, id])).toString("base64url");
}

function decodeCursor(cursor: string | undefined): [string, number] | null {
  if (!cursor) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (
      Array.isArray(parsed) && parsed.length === 2 &&
      typeof parsed[0] === "string" && !Number.isNaN(Date.parse(parsed[0])) &&
      Number.isSafeInteger(parsed[1])
    ) {
      return parsed as [string, number];
    }
  } catch { /* an unreadable cursor reads as the first page */ }
  return null;
}

/** Rows after the cursor in the list's own order, (date, id) descending or ascending. */
function afterCursor(key: SQL, id: AnyColumn, cursor: [string, number] | null, oldest: boolean): SQL | undefined {
  if (!cursor) return undefined;
  return oldest
    ? sql`(${key}, ${id}) > (${cursor[0]}::timestamptz, ${cursor[1]})`
    : sql`(${key}, ${id}) < (${cursor[0]}::timestamptz, ${cursor[1]})`;
}

export type FactRow = typeof factsTable.$inferSelect;

/** One submission as listed. A live fact carries its row, for the full fact card. */
export type SubmissionRow =
  | {
      kind: "review"; id: number; text: string; hashtags: string[]; createdAt: string;
      decidedAt: string | null; progress: "first_look" | "preparing" | null;
      reason: string | null; teamNote: string | null;
    }
  | { kind: "fact"; id: number; text: string; createdAt: string; decidedAt: string | null; row: FactRow }
  | { kind: "fact_gone"; id: number; text: string; hashtags: string[]; createdAt: string; decidedAt: string | null }
  | {
      kind: "comment"; id: number; text: string; createdAt: string;
      factId: number; factText: string; factLive: boolean; hidden: boolean; teamNote: string | null;
    };

export interface ListOptions {
  type: SubmissionType;
  status: SubmissionStatus;
  q?: string;
  oldest: boolean;
  cursor?: string;
  limit: number;
}

const iso = (key: string | null) => (key ? new Date(key).toISOString() : null);

/** One page of the person's submissions of one type in one status. */
export async function listMySubmissions(userId: string, opts: ListOptions): Promise<{ items: SubmissionRow[]; nextCursor: string | null }> {
  const terms = searchTerms(opts.q);
  const cursor = decodeCursor(opts.cursor);
  const dir = opts.oldest ? asc : desc;

  let page: { key: string; id: number; item: SubmissionRow }[];
  let more: boolean;

  if (opts.type === "facts" && (opts.status === "review" || opts.status === "declined")) {
    // Under Review is ordered by when it was sent; Declined by when it was
    // declined (when it was sent, where no decision date was recorded).
    const key = opts.status === "review" ? sql`${r.createdAt}` : sql`coalesce(${r.reviewedAt}, ${r.createdAt})`;
    const rows = await db.select({
      key: sql<string>`(${key})::text`,
      id: r.id, text: r.submittedText, hashtags: r.hashtags, createdAt: r.createdAt,
      reviewedAt: r.reviewedAt, status: r.status, workflowStage: r.workflowStage,
      reason: r.reason, adminNote: r.adminNote,
    })
      .from(r)
      .where(and(reviewScope(userId), REVIEW_STATUS[opts.status], reviewSearch(terms), afterCursor(key, r.id, cursor, opts.oldest)))
      .orderBy(dir(key), dir(r.id))
      .limit(opts.limit + 1);
    more = rows.length > opts.limit;
    page = rows.slice(0, opts.limit).map((row) => {
      const declined = row.status === "rejected";
      return {
        key: row.key,
        id: row.id,
        item: {
          kind: "review",
          id: row.id,
          text: row.text,
          hashtags: row.hashtags ?? [],
          createdAt: row.createdAt.toISOString(),
          decidedAt: declined ? (row.reviewedAt?.toISOString() ?? null) : null,
          // The step name stays on the server: a first look, or past it and
          // being prepared. Neither promises publication.
          progress: declined ? null : row.workflowStage === "triage" ? "first_look" : "preparing",
          // Before a decline both columns hold the moderator's unsaved draft,
          // which is not the submitter's to read (Issue #1057).
          reason: declined ? (row.reason ?? null) : null,
          teamNote: declined ? (row.adminNote ?? null) : null,
        },
      };
    });
  } else if (opts.type === "facts") {
    const status = opts.status === "gone" ? "gone" : "live";
    const key = sql`coalesce(${f.approvedAt}, ${f.createdAt})`;
    const rows = await db.select({ key: sql<string>`(${key})::text`, row: f })
      .from(f)
      .where(and(factScope(userId), FACT_STATUS[status], factSearch(terms), afterCursor(key, f.id, cursor, opts.oldest)))
      .orderBy(dir(key), dir(f.id))
      .limit(opts.limit + 1);
    more = rows.length > opts.limit;
    const kept = rows.slice(0, opts.limit);
    const tags = status === "gone" ? await hashtagsOf(kept.map((k) => k.row.id)) : new Map<number, string[]>();
    page = kept.map(({ key: k, row }) => {
      const base = { id: row.id, text: row.text, createdAt: row.createdAt.toISOString(), decidedAt: iso(k) };
      return {
        key: k,
        id: row.id,
        item: status === "live"
          ? { kind: "fact", ...base, row }
          : { kind: "fact_gone", ...base, hashtags: tags.get(row.id) ?? [] },
      };
    });
  } else {
    const key = sql`${c.createdAt}`;
    const rows = await db.select({
      key: sql<string>`(${key})::text`,
      id: c.id, text: c.text, createdAt: c.createdAt, status: c.status, flagged: c.flagged,
      flagReason: c.flagReason, factId: c.factId, factText: f.text, factLive: f.isActive,
    })
      .from(c)
      .innerJoin(f, eq(c.factId, f.id))
      .where(and(commentScope(userId), COMMENT_STATUS[opts.status], commentSearch(terms), afterCursor(key, c.id, cursor, opts.oldest)))
      .orderBy(dir(key), dir(c.id))
      .limit(opts.limit + 1);
    more = rows.length > opts.limit;
    page = rows.slice(0, opts.limit).map((row) => {
      const declined = row.status === "rejected";
      return {
        key: row.key,
        id: row.id,
        item: {
          kind: "comment",
          id: row.id,
          text: row.text,
          createdAt: row.createdAt.toISOString(),
          factId: row.factId,
          factText: row.factText,
          factLive: row.factLive,
          hidden: row.status === "approved" && row.flagged,
          // On a declined comment this is the moderator's note to the author;
          // on any other it can be an automated flag's explanation, not theirs.
          teamNote: declined ? (row.flagReason ?? null) : null,
        },
      };
    });
  }

  const last = page[page.length - 1];
  return { items: page.map((p) => p.item), nextCursor: more && last ? encodeCursor(last.key, last.id) : null };
}

async function hashtagsOf(factIds: number[]): Promise<Map<number, string[]>> {
  const out = new Map<number, string[]>();
  if (!factIds.length) return out;
  const rows = await db.execute<{ fact_id: number; name: string }>(sql`
    SELECT fh.fact_id, h.name FROM fact_hashtags fh JOIN hashtags h ON h.id = fh.hashtag_id
     WHERE fh.fact_id IN (${sql.join(factIds.map((id) => sql`${id}`), sql`, `)})
     ORDER BY h.name`);
  for (const row of rows.rows) {
    const list = out.get(row.fact_id) ?? [];
    list.push(row.name);
    out.set(row.fact_id, list);
  }
  return out;
}
