/**
 * The legacy fixture's classification and scrub rules, with no database
 * (Launch Phase 2, increment 5; #631; plan D1–D4, D9).
 *
 * These turn the 2026-08-28 instruction "enumerate afresh against the current
 * schema before any copy" into a CI guard: a table or column added to the
 * schema fails here (and in the typecheck) until it is classified, and a
 * credential- or identity-shaped column cannot be included by accident.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getTableConfig } from "drizzle-orm/pg-core";

import { EMPTY_VISUAL_STRATEGY_OVERRIDE, buildPlaceholderFactEnrichment } from "@workspace/api-zod";

import {
  LEGACY_FIXTURE_ALLOWLIST,
  exportedSchemaTables,
  includedTables,
  sqlColumnRules,
  sqlName,
} from "../testing/legacyFixture/allowlist";
import { PLACEHOLDER_TEMPLATES, placeholderFor } from "../testing/legacyFixture/placeholderFacts";
import { Scrubber } from "../testing/legacyFixture/scrub";
import { MediaMap, MediaPlacementError } from "../testing/legacyFixture/media";
import { SHAPES } from "../testing/legacyFixture/shapes";
import { ShapeStop, sizedPlaceholderHashtags, type WalkContext } from "../testing/legacyFixture/walker";
import { normalizeFactTemplateForStorage } from "../lib/normalizeFactTemplateForStorage";
import { credentialHits } from "../testing/legacyFixture/export";

describe("the legacy fixture's allowlist classifies the whole schema", () => {
  it("names every exported table exactly once", () => {
    const exported = [...exportedSchemaTables().keys()].sort();
    const classified = LEGACY_FIXTURE_ALLOWLIST.map((c) => sqlName(c.table)).sort();
    assert.deepEqual(classified, exported, "a table the schema exports is unclassified, or one is classified twice");
  });

  it("gives every column of an included table exactly one rule", () => {
    for (const entry of includedTables()) {
      const rules = sqlColumnRules(entry);
      const sqlCols = getTableConfig(entry.table).columns.map((c) => c.name).sort();
      assert.deepEqual(rules.map((r) => r.column).sort(), sqlCols, `${sqlName(entry.table)}: columns and rules differ`);
    }
  });

  it("lets a jsonb column out only through a named shape", () => {
    for (const entry of includedTables()) {
      for (const r of sqlColumnRules(entry)) {
        if (r.dataType !== "PgJsonb") continue;
        assert.ok(r.rule.startsWith("shape:") || r.rule === "drop" || r.rule === "null", `${sqlName(entry.table)}.${r.column} is jsonb without a shape`);
        if (r.rule.startsWith("shape:")) assert.ok(SHAPES[r.rule.slice(6) as keyof typeof SHAPES], `${r.rule} is not a known shape`);
      }
    }
  });

  it("never selects a credential, session, IP or child-safety column", () => {
    const forbidden = [/^password_hash$/, /token_hash$/, /(access|refresh|session|api|auth)_?token/, /secret/, /api_key/, /^code_verifier$/, /^nonce$/, /^sess$/, /^ip_/, /_ip$/, /^ip$/, /^key_raw$/, /^request_metadata$/, /^evidence_/, /^arachnid_/];
    for (const entry of includedTables()) {
      for (const r of sqlColumnRules(entry)) {
        if (r.rule === "drop") continue;
        for (const re of forbidden) assert.ok(!re.test(r.column), `${sqlName(entry.table)}.${r.column} is included but matches ${re}`);
      }
    }
  });

  it("excludes every table of the 2026-08-28 classes", () => {
    const excluded = new Set(LEGACY_FIXTURE_ALLOWLIST.filter((c) => c.kind === "exclude").map((c) => sqlName(c.table)));
    for (const t of [
      "sessions", "email_verification_tokens", "password_reset_tokens", "oauth_pending_states",
      "async_jobs", "video_jobs",
      "quarantined_memes", "ncmec_reports", "ncmec_safety_audit_log",
      "stripe_processed_events", "stripe_webhook_audit", "stripe_checkout_request_ledger", "entitlement_source_disputes",
      "rate_limit_counters", "transient_renders",
    ]) assert.ok(excluded.has(t), `${t} must be excluded`);
  });

  it("maps every user reference through the identity map, foreign key or not", () => {
    const named = /^(user_id|.*_by_id|.*_by|actor_.*|owner_.*|link_user_id|author_id)$/;
    const fkLess = new Set(["user_generation_costs.user_id"]);
    for (const entry of includedTables()) {
      const cfg = getTableConfig(entry.table);
      const fkToUsers = new Set(
        cfg.foreignKeys.flatMap((fk) => {
          const ref = fk.reference();
          return getTableConfig(ref.foreignTable).name === "users" ? ref.columns.map((c) => c.name) : [];
        }),
      );
      for (const r of sqlColumnRules(entry)) {
        const key = `${cfg.name}.${r.column}`;
        const isUserRef = fkToUsers.has(r.column) || fkLess.has(key);
        if (isUserRef) assert.equal(r.rule, "map-user", `${key} references a user but its rule is ${r.rule}`);
        if (named.test(r.column) && r.rule !== "drop") {
          assert.ok(isUserRef, `${key} is named like a user reference but is neither a foreign key to users nor on the FK-less list`);
        }
      }
    }
  });
});

describe("the placeholder corpus", () => {
  it("is valid grammar with valid hashtags, and content-keyed", () => {
    for (const t of PLACEHOLDER_TEMPLATES) {
      assert.ok(normalizeFactTemplateForStorage(`${t.template} (case 0a1b2c).`).valid, t.template);
      assert.ok(t.hashtags.length >= 3 && t.hashtags.every((h) => /^[a-z0-9]+$/.test(h)), t.template);
    }
    const s = new Scrubber(Buffer.alloc(32, 7));
    assert.equal(placeholderFor("{NAME} a.", s).text, placeholderFor("{NAME} a.", s).text);
    assert.notEqual(placeholderFor("{NAME} a.", s).text, placeholderFor("{NAME} b.", s).text);
  });
});

describe("the scrub primitives", () => {
  const scrubber = new Scrubber(Buffer.alloc(32, 9));
  const ctx = (over: Partial<WalkContext> = {}): WalkContext => ({
    scrubber,
    media: new MediaMap(scrubber, () => "data:image/jpeg;base64,AA=="),
    mode: "emit",
    where: "t.c row 1",
    table: "t",
    row: "1",
    ownerSourceId: null,
    keptText: false,
    placeholderHashtags: ["fixture", "legend", "time"],
    syntheticName: "Avery",
    ...over,
  });

  it("keeps absent, null, empty and whitespace-only prose exactly as stored", () => {
    for (const v of [undefined, null, "", "   "]) assert.equal(scrubber.prose(v as string | null | undefined), v);
    assert.match(scrubber.prose("real words")!, /^\[fixture text [0-9a-f]{8}\]$/);
    assert.equal(scrubber.prose("same"), scrubber.prose("same"));
  });

  it("keeps a blank core scene and a half-filled bubble as they are (Astra round 2)", () => {
    const e = buildPlaceholderFactEnrichment("x");
    const partial = { ...e, visualPromptStrategyOverride: { ...EMPTY_VISUAL_STRATEGY_OVERRIDE, coreSceneOverride: "", bubbles: [{ type: "speech", entity: "subject", text: "" }] } };
    const out = SHAPES.factEnrichment.transform(partial, ctx(), {}) as typeof partial;
    assert.equal(out.visualPromptStrategyOverride.coreSceneOverride, "");
    assert.deepEqual(out.visualPromptStrategyOverride.bubbles, [{ type: "speech", entity: "subject", text: "" }]);
  });

  it("keeps an override's enum value valid for its path's own schema (Astra round 1)", () => {
    const overrides = { "/overhypeFit": { value: "strong", overriddenFrom: "questionable", createdAt: "2026-01-01T00:00:00Z", createdBy: "u1" } };
    const out = SHAPES.enrichmentOverrides.transform(overrides, ctx(), {}) as Record<string, { value: unknown; createdBy: string }>;
    assert.equal(out["/overhypeFit"]!.value, "strong");
    assert.equal(out["/overhypeFit"]!.createdBy, scrubber.userId("u1"));
  });

  it("keeps a legacy row the validator refuses refused: an over-long label and a token in a label (dev dry run, 2026-10-13)", () => {
    const e = buildPlaceholderFactEnrichment("x");
    const vso = (entity: string) => ({ ...e, visualPromptStrategyOverride: { ...EMPTY_VISUAL_STRATEGY_OVERRIDE, roleBindings: [{ entity, visualRole: "zqx role" }] } });
    for (const entity of ["{NAME}", "z".repeat(61)]) {
      const src = vso(entity);
      assert.notEqual(SHAPES.factEnrichment.validate!(src, {}), null, `the source with ${entity.slice(0, 8)} is refused`);
      const out = SHAPES.factEnrichment.transform(src, ctx(), {});
      assert.notEqual(SHAPES.factEnrichment.validate!(out, {}), null, "and so is its output");
      assert.ok(!JSON.stringify(out).includes("zzzz") && !JSON.stringify(out).includes("NAME"), "the value itself does not survive");
    }
    const ok = SHAPES.factEnrichment.transform(vso("mother"), ctx(), {});
    assert.equal(SHAPES.factEnrichment.validate!(ok, {}), null, "an accepted label stays accepted");
  });

  it("stops on a key the shape does not describe, naming the path and never the value", () => {
    const e = { ...buildPlaceholderFactEnrichment("x"), zqxUnknownField: "zqx private value" };
    assert.throws(
      () => SHAPES.factEnrichment.transform(e, ctx(), {}),
      (err: unknown) => err instanceof ShapeStop && /zqxUnknownField/.test(err.message) && !/zqx private value/.test(err.message),
    );
  });

  it("replaces a frozen user name and keeps a sampled one", () => {
    const user = SHAPES.renderControls.transform({ aspectRatio: "landscape", contentMode: "sfw", promptIdentity: { version: 1, name: "Realname", pronouns: null, source: "user" } }, ctx(), {}) as { promptIdentity: { name: string } };
    assert.equal(user.promptIdentity.name, "Avery");
    const sampled = SHAPES.renderControls.transform({ aspectRatio: "landscape", contentMode: "sfw", promptIdentity: { version: 1, name: "Jordan", pronouns: null, source: "review_sample" } }, ctx(), {}) as { promptIdentity: { name: string } };
    assert.equal(sampled.promptIdentity.name, "Jordan");
  });

  it("replaces a vendor-hosted render reference with the local image, and stops on any other host", () => {
    const stock = "data:image/jpeg;base64,AA==";
    const media = new MediaMap(scrubber, () => stock);
    const fal = "https://v3b.fal.media/files/b/0a1b2c/zqxFacePhoto.jpeg";
    media.note(fal, "render-reference", { table: "image_prompt_attempts", row: "1" }, null);
    assert.equal(media.rewrite(fal), stock);
    const other = new MediaMap(scrubber, () => stock);
    other.note("https://cdn.example.org/zqx.jpeg", "render-reference", { table: "image_prompt_attempts", row: "2" }, null);
    assert.throws(() => other.resolve(), MediaPlacementError);
  });

  it("keeps an upload whose account was deleted private to nobody, and stops on any other ownerless upload", () => {
    const stock = "data:image/jpeg;base64,AA==";
    const orphan = "/objects/uploads/ab/0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0.jpg";
    const media = new MediaMap(scrubber, () => stock);
    media.note(orphan, "upload-metadata", { table: "upload_image_metadata", row: "x" }, null);
    const [placed] = media.placeholders();
    assert.equal(placed!.acl?.visibility, "private");
    assert.notEqual(placed!.acl?.owner, null);
    assert.ok(!placed!.path.includes("0f1e2d3c"), "the source path does not survive");
    const shared = new MediaMap(scrubber, () => stock);
    shared.note(orphan, "upload-metadata", { table: "upload_image_metadata", row: "x" }, null);
    shared.note(orphan, "ai-tracking-generic", { table: "user_ai_images", row: "y" }, null);
    assert.throws(() => shared.resolve(), MediaPlacementError);
  });

  it("gives placeholder hashtags the source's distinct count, so the validator's verdict on the count holds", () => {
    const corpus = ["fixture", "legend", "time"];
    assert.deepEqual(sizedPlaceholderHashtags(["#Zqx", "zqx", "other"], corpus), ["fixture", "legend"], "two distinct after normalization");
    assert.deepEqual(sizedPlaceholderHashtags([], corpus), []);
    assert.equal(sizedPlaceholderHashtags(["a", "b", "c", "d", "e", "f", "g", "h", "i"], corpus).length, 9, "an over-long list stays over-long");
    assert.equal(new Set(sizedPlaceholderHashtags(["a", "b", "c", "d"], corpus)).size, 4);
  });

  it("finds the credential shapes the export refuses, and passes the synthetic forms", () => {
    assert.deepEqual(credentialHits({ v: "sk_live_abcdefgh12345678" }), ["a Stripe secret or restricted key"]);
    assert.deepEqual(credentialHits({ v: "a@realmail.com" }), ["an email address"]);
    assert.deepEqual(credentialHits({ v: "203.0.113.7" }), ["an IPv4 address"]);
    assert.deepEqual(credentialHits({ v: "fixture-user-1@example.test", w: "1.2.3.4".replace(/\./g, "-") }), []);
  });
});
