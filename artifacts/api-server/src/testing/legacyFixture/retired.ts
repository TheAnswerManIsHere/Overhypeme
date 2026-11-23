/**
 * @purpose Apply migration 0151's retirement of refresh and resubmission reviews to a fixture exported before it, so a load never restores what that migration deleted.
 * @subsystem legacy-fixture
 *
 * The committed fixture was exported while refresh reviews existed. The loader
 * runs after every migration, so without this step it would put back the rows
 * 0151 deleted, and a refresh review would reappear as an ordinary open review
 * of a live fact. The rules are 0151's (lib/db/migrations/0151_retire_refresh_reviews.sql),
 * applied to the fixture's raw rows: refresh reviews (candidate_version_id
 * set) and open resubmissions (an open review of a fact created before it)
 * are left out (the enrichment versions 0151 also deleted are not loaded at
 * all: their table went with 0160); a
 * gag a refresh owned loses that refresh's change and picks; references to a
 * left-out review are nulled. The freshness predicates of left-out or changed
 * rows are not checked on either side, since no recorded outcome describes them.
 *
 * Migration 0155's stage map is applied here too, for the same reason: the
 * fixture's reviews carry the stage labels 0155 replaced, which the loaded
 * schema no longer has (`fixtureStage`).
 */
import type { Row } from "./export";
import type { PredicateRecord } from "./predicates";

export interface FixtureRetirement {
  /** Reviews left out: every refresh, and every open resubmission. */
  reviewIds: Set<number>;
  /** Of those, the refresh reviews (the owners of gag operations). */
  refreshIds: Set<number>;
  /** Staging facts of the open reviews left out. */
  openReviewFacts: Set<number>;
  /** Gags a refresh review owned an operation on. */
  refreshGagIds: Set<number>;
  /** Render attempts made in a left-out review, or of a refresh-owned gag (their input changed). */
  attemptIds: Set<number>;
  /** Reviews whose staging fact's gag-idea set the retirement clears (a refresh review shared its live fact). */
  clearedBlobReviewIds: Set<number>;
  /** Facts with an approved humor note (0155 maps their prep-stage reviews to gags, the rest to reading). */
  notedFacts: Set<number>;
}

/** A review's stage as migration 0155 maps it (lib/db/migrations/0155_moderation_four_steps.sql). */
export function fixtureStage(stage: unknown, stagingFactId: number | null, notedFacts: Set<number>): unknown {
  switch (stage) {
    case "triage_pending": return "triage";
    case "prep_pending":
    case "prep_failed":
    case "concept_review": return stagingFactId != null && notedFacts.has(stagingFactId) ? "gags" : "reading";
    case "production_review": return "test_renders";
    case "production_approved": return "approved";
    case "triage_rejected":
    case "production_rejected": return "rejected";
    default: return stage;
  }
}

const num = (v: unknown): number | null => (typeof v === "number" ? v : typeof v === "string" && v !== "" ? Number(v) : null);

export function fixtureRetirement(read: (table: string) => Row[]): FixtureRetirement {
  const factCreated = new Map<number, string>();
  for (const f of read("facts")) factCreated.set(num(f["id"])!, String(f["created_at"]));
  const reviewIds = new Set<number>();
  const refreshIds = new Set<number>();
  const openReviewFacts = new Set<number>();
  for (const r of read("pending_reviews")) {
    const id = num(r["id"])!;
    const staging = num(r["staging_fact_id"]);
    const refresh = r["candidate_version_id"] != null;
    const created = staging != null ? factCreated.get(staging) : undefined;
    const resubmission = !refresh && r["status"] === "pending" && created != null
      && new Date(created).getTime() < new Date(String(r["created_at"])).getTime();
    if (!refresh && !resubmission) continue;
    reviewIds.add(id);
    if (refresh) refreshIds.add(id);
    if (r["status"] === "pending" && staging != null) openReviewFacts.add(staging);
  }
  const refreshGagIds = new Set<number>();
  for (const g of read("fact_gags")) {
    const owner = num(g["pending_review_id"]);
    if (owner != null && refreshIds.has(owner) && g["removed_at"] == null) refreshGagIds.add(num(g["id"])!);
  }
  const attemptIds = new Set<number>();
  for (const a of read("image_prompt_attempts")) {
    const gag = num(a["gag_id"]);
    const review = num(a["review_id"]);
    if ((gag != null && refreshGagIds.has(gag)) || (review != null && reviewIds.has(review))) attemptIds.add(num(a["id"])!);
  }
  const clearedFacts = new Set<number>();
  for (const f of read("facts")) {
    const owner = f["visual_concept_owner"];
    const blob = f["visual_concept_candidates"] as Record<string, unknown> | null | undefined;
    const ownedByRetired = typeof owner === "string" && owner.startsWith("review:") && reviewIds.has(parseInt(owner.slice(7), 10));
    if (ownedByRetired || (blob && typeof blob === "object" && blob["source"] === "candidate_version")) clearedFacts.add(num(f["id"])!);
  }
  const clearedBlobReviewIds = new Set<number>();
  for (const r of read("pending_reviews")) {
    const staging = num(r["staging_fact_id"]);
    if (staging != null && clearedFacts.has(staging)) clearedBlobReviewIds.add(num(r["id"])!);
  }
  const notedFacts = new Set<number>();
  for (const f of read("facts")) if (f["humor_note_approved_at"] != null) notedFacts.add(num(f["id"])!);
  return { reviewIds, refreshIds, openReviewFacts, refreshGagIds, attemptIds, clearedBlobReviewIds, notedFacts };
}

/** The table's rows as 0151 (and 0155's stage map) leaves them. */
export function retireRows(table: string, rows: Row[], r: FixtureRetirement, now: string): Row[] {
  const nullRef = (row: Row, col: string): Row => {
    const v = num(row[col]);
    return v != null && r.reviewIds.has(v) ? { ...row, [col]: null } : row;
  };
  switch (table) {
    case "pending_reviews":
      return rows
        .filter((row) => !r.reviewIds.has(num(row["id"])!))
        .map((row) => ({ ...nullRef(row, "matching_review_id"), workflow_stage: fixtureStage(row["workflow_stage"], num(row["staging_fact_id"]), r.notedFacts) }));
    case "image_prompt_attempts":
      return rows.map((row) => nullRef(row, "review_id"));
    case "fact_gag_examples":
      return rows.filter((row) => !(row["stage"] === "pending" && r.refreshGagIds.has(num(row["gag_id"])!)));
    case "fact_gags":
      return rows.map((row) => {
        if (!r.refreshGagIds.has(num(row["id"])!)) return row;
        return row["approved_content"] == null
          ? { ...row, removed_at: now, updated_at: now }
          : { ...row, pending_content: null, pending_by: null, pending_at: null, updated_at: now };
      });
    case "facts":
      return rows.map((row) => {
        let out = row;
        const owner = row["visual_concept_owner"];
        if (typeof owner === "string" && owner.startsWith("review:") && r.reviewIds.has(parseInt(owner.slice(7), 10))) {
          out = { ...out, visual_concept_owner: null, visual_concept_status: null, visual_concept_candidates: null };
        }
        const blob = out["visual_concept_candidates"];
        if (blob && typeof blob === "object" && !Array.isArray(blob)) {
          const b = blob as Record<string, unknown>;
          if (b["source"] === "candidate_version") out = { ...out, visual_concept_candidates: null, visual_concept_status: null };
          else if ("candidateVersionId" in b) {
            const { candidateVersionId: _gone, ...rest } = b;
            out = { ...out, visual_concept_candidates: rest };
          }
        }
        if (out["enrichment_status"] === "pending" && r.openReviewFacts.has(num(out["id"])!)) {
          out = { ...out, enrichment_status: out["is_active"] === true ? "ok" : null };
        }
        return out;
      });
    default:
      return rows;
  }
}

/**
 * A predicate record less the rows the retirement leaves out or changes:
 * applied to the recorded side (those rows are not loaded as recorded) and to
 * the loaded side (a kept render attempt of a retired review is still read,
 * against inputs 0151 changed, so no recorded outcome speaks for it).
 */
export function withoutRetired(p: PredicateRecord, r: FixtureRetirement): PredicateRecord {
  const keep = <T>(rec: Record<string, T>, gone: Set<number>): Record<string, T> =>
    Object.fromEntries(Object.entries(rec).filter(([k]) => !gone.has(Number(k))));
  return {
    renderAttempts: keep(p.renderAttempts, r.attemptIds),
    conceptBlobs: keep(p.conceptBlobs, new Set([...r.reviewIds, ...r.clearedBlobReviewIds])),
  };
}
