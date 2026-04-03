import { db } from "@workspace/db";
import { factsTable, hashtagsTable, factHashtagsTable } from "@workspace/db/schema";
import { eq, sql, gt } from "drizzle-orm";
import { SEED_FACTS } from "../data/seed-facts";
import { embedFactAsync } from "./embeddings";

/**
 * Idempotent schema migration that adds any columns which may be missing when
 * the production database is restored into the development environment (or when
 * a fresh DB is used that pre-dates a schema addition).  Uses
 * ADD COLUMN IF NOT EXISTS so it is safe to run on every startup.
 */
export async function ensureSchema(): Promise<void> {
  const migrations: { label: string; ddl: string }[] = [
    {
      label: "facts.has_pronouns",
      ddl: `ALTER TABLE facts ADD COLUMN IF NOT EXISTS has_pronouns boolean NOT NULL DEFAULT false`,
    },
    {
      label: "users.pronouns",
      ddl: `ALTER TABLE users ADD COLUMN IF NOT EXISTS pronouns varchar(20) DEFAULT 'he/him'`,
    },
    {
      label: "users.pronouns widen to varchar(80)",
      ddl: `ALTER TABLE users ALTER COLUMN pronouns TYPE varchar(80)`,
    },
    {
      label: "password_reset_tokens table",
      ddl: `CREATE TABLE IF NOT EXISTS password_reset_tokens (
        id serial PRIMARY KEY,
        user_id varchar NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash text NOT NULL,
        expires_at timestamptz NOT NULL,
        used_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now()
      )`,
    },
    {
      label: "password_reset_tokens.IDX_prt_token_hash",
      ddl: `CREATE INDEX IF NOT EXISTS "IDX_prt_token_hash" ON password_reset_tokens (token_hash)`,
    },
    {
      label: "facts.is_active",
      ddl: `ALTER TABLE facts ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true`,
    },
    {
      label: "users.is_active",
      ddl: `ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true`,
    },
    {
      label: "facts.canonical_text",
      ddl: `ALTER TABLE facts ADD COLUMN IF NOT EXISTS canonical_text text`,
    },
    {
      label: "comments.status",
      ddl: `ALTER TABLE comments ADD COLUMN IF NOT EXISTS status varchar(20) NOT NULL DEFAULT 'pending'`,
    },
    {
      label: "comments.status backfill approved",
      ddl: `UPDATE comments SET status = 'approved' WHERE status = 'pending' AND flagged = false AND created_at < now() - interval '1 hour'`,
    },
    {
      label: "users.display_name",
      ddl: `ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name varchar`,
    },
    {
      label: "users.email_verified_at",
      ddl: `ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at timestamptz`,
    },
    {
      label: "email_verification_tokens table",
      ddl: `CREATE TABLE IF NOT EXISTS email_verification_tokens (
        id serial PRIMARY KEY,
        user_id varchar NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash text NOT NULL,
        expires_at timestamptz NOT NULL,
        used_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now()
      )`,
    },
    {
      label: "email_verification_tokens.IDX_evt_token_hash",
      ddl: `CREATE INDEX IF NOT EXISTS "IDX_evt_token_hash" ON email_verification_tokens (token_hash)`,
    },
    {
      label: "users.pending_email",
      ddl: `ALTER TABLE users ADD COLUMN IF NOT EXISTS pending_email varchar`,
    },
    {
      label: "email_verification_tokens.pending_email",
      ddl: `ALTER TABLE email_verification_tokens ADD COLUMN IF NOT EXISTS pending_email varchar`,
    },
    {
      label: "users.drop_username",
      ddl: `ALTER TABLE users DROP COLUMN IF EXISTS username`,
    },
    {
      label: "memes.is_low_res",
      ddl: `ALTER TABLE memes ADD COLUMN IF NOT EXISTS is_low_res boolean NOT NULL DEFAULT false`,
    },
    {
      label: "memes.original_width",
      ddl: `ALTER TABLE memes ADD COLUMN IF NOT EXISTS original_width integer`,
    },
    {
      label: "memes.original_height",
      ddl: `ALTER TABLE memes ADD COLUMN IF NOT EXISTS original_height integer`,
    },
    {
      label: "memes.upload_file_size_bytes",
      ddl: `ALTER TABLE memes ADD COLUMN IF NOT EXISTS upload_file_size_bytes integer`,
    },
    {
      label: "upload_image_metadata table",
      ddl: `CREATE TABLE IF NOT EXISTS upload_image_metadata (
        object_path text PRIMARY KEY,
        width integer NOT NULL,
        height integer NOT NULL,
        is_low_res boolean NOT NULL DEFAULT false,
        file_size_bytes integer NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )`,
    },
    {
      label: "upload_image_metadata.user_id",
      ddl: `ALTER TABLE upload_image_metadata ADD COLUMN IF NOT EXISTS user_id varchar REFERENCES users(id) ON DELETE SET NULL`,
    },
    {
      label: "upload_image_metadata.IDX_uim_user_id",
      ddl: `CREATE INDEX IF NOT EXISTS "IDX_uim_user_id" ON upload_image_metadata (user_id)`,
    },
    {
      label: "user_ai_images table",
      ddl: `CREATE TABLE IF NOT EXISTS user_ai_images (
        id serial PRIMARY KEY,
        user_id varchar NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        object_path text NOT NULL UNIQUE,
        created_at timestamptz NOT NULL DEFAULT now()
      )`,
    },
    {
      label: "user_ai_images.IDX_uai_user_id",
      ddl: `CREATE INDEX IF NOT EXISTS "IDX_uai_user_id" ON user_ai_images (user_id)`,
    },
    {
      label: "admin_config table",
      ddl: `CREATE TABLE IF NOT EXISTS admin_config (
        key varchar(100) PRIMARY KEY,
        value varchar(500) NOT NULL,
        data_type varchar(20) NOT NULL DEFAULT 'integer',
        label varchar(200) NOT NULL,
        description text,
        min_value integer,
        max_value integer,
        is_public boolean NOT NULL DEFAULT false,
        updated_at timestamptz NOT NULL DEFAULT now(),
        updated_by_id varchar REFERENCES users(id) ON DELETE SET NULL
      )`,
    },
    {
      label: "admin_config seed defaults",
      ddl: `INSERT INTO admin_config (key, value, data_type, label, description, min_value, max_value, is_public) VALUES
        ('ai_gallery_display_limit', '50', 'integer', 'AI Gallery Display Limit',
         'Maximum number of AI-generated backgrounds shown per gender in the Meme Builder gallery.',
         1, 500, true),
        ('ai_max_images_per_gender', '34', 'integer', 'AI Max Images Per Fact Per Gender',
         'Maximum AI images stored per gender per fact (3 genders × this value ≈ total per-fact cap). Oldest images are evicted when reached.',
         1, 500, false),
        ('user_max_images', '1000', 'integer', 'User Max Image Storage',
         'Total image storage limit per paid user, combining AI-generated images and uploaded photos. Oldest AI images are evicted when limit is reached.',
         10, 10000, false),
        ('pexels_photos_per_gender', '80', 'integer', 'Pexels Photos Per Fact Per Gender',
         'Number of stock photos fetched from Pexels per gender variant when processing a fact. Pexels maximum is 80.',
         1, 80, false)
      ON CONFLICT (key) DO NOTHING`,
    },
    {
      label: "memes.deleted_at",
      ddl: `ALTER TABLE memes ADD COLUMN IF NOT EXISTS deleted_at timestamptz`,
    },
    {
      label: "memes.IDX_memes_deleted_at",
      ddl: `CREATE INDEX IF NOT EXISTS "IDX_memes_deleted_at" ON memes (deleted_at) WHERE deleted_at IS NULL`,
    },
    {
      label: "admin_config seed max_memes_per_fact",
      ddl: `INSERT INTO admin_config (key, value, data_type, label, description, min_value, max_value, is_public)
        VALUES ('max_memes_per_fact', '40', 'integer', 'Max Memes Per Fact',
         'Maximum number of memes returned per fact in the gallery (applies to both public and personal views).',
         1, 500, false)
      ON CONFLICT (key) DO NOTHING`,
    },
  ];

  for (const { label, ddl } of migrations) {
    try {
      await db.execute(sql.raw(ddl));
    } catch (err) {
      console.warn(`[schema] Could not apply migration "${label}":`, err);
    }
  }
}

function computeWilsonScore(upvotes: number, downvotes: number): number {
  const n = upvotes + downvotes;
  if (n === 0) return 0;
  const z = 1.96;
  const pHat = upvotes / n;
  const numerator = pHat + (z * z) / (2 * n) - z * Math.sqrt((pHat * (1 - pHat)) / n + (z * z) / (4 * n * n));
  const denominator = 1 + (z * z) / n;
  return numerator / denominator;
}

export async function backfillWilsonScores(): Promise<void> {
  const facts = await db
    .select({ id: factsTable.id, upvotes: factsTable.upvotes, downvotes: factsTable.downvotes, wilsonScore: factsTable.wilsonScore })
    .from(factsTable)
    .where(gt(sql`${factsTable.upvotes} + ${factsTable.downvotes}`, 0));

  const toUpdate = facts.filter((f) => f.wilsonScore === 0 && (f.upvotes + f.downvotes) > 0);
  if (!toUpdate.length) return;

  console.log(`[wilson] Backfilling Wilson scores for ${toUpdate.length} facts...`);
  for (const f of toUpdate) {
    const wilsonScore = computeWilsonScore(f.upvotes, f.downvotes);
    await db.update(factsTable).set({ wilsonScore }).where(eq(factsTable.id, f.id));
  }
  console.log("[wilson] Backfill complete.");
}

export async function seedIfEmpty(): Promise<void> {
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(factsTable);

  if (count > 0) {
    return;
  }

  console.log("[seed] Production database is empty — seeding", SEED_FACTS.length, "facts...");

  for (const item of SEED_FACTS) {
    const [fact] = await db
      .insert(factsTable)
      .values({ text: item.text, isActive: true })
      .returning({ id: factsTable.id });

    for (const tagName of item.hashtags) {
      const existing = await db
        .select({ id: hashtagsTable.id })
        .from(hashtagsTable)
        .where(eq(hashtagsTable.name, tagName))
        .limit(1);

      let tagId: number;
      if (existing.length > 0) {
        tagId = existing[0].id;
      } else {
        const [newTag] = await db
          .insert(hashtagsTable)
          .values({ name: tagName })
          .returning({ id: hashtagsTable.id });
        tagId = newTag.id;
      }

      await db
        .insert(factHashtagsTable)
        .values({ factId: fact.id, hashtagId: tagId })
        .onConflictDoNothing();
    }

    embedFactAsync(fact.id, item.text).catch(() => {});
  }

  console.log("[seed] Done seeding facts.");
}
