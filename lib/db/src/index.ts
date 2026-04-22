import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import * as schema from "./schema";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

export const pool = new Pool({ connectionString: process.env.DATABASE_URL });
export const db = drizzle(pool, { schema });

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const LEGACY_MIGRATIONS = [
  { hash: "acf52a12f90a0479d8f83821fe01e5dc14714357d5ae529032ae04b2f48e9809", createdAt: 1700000000000 },
  { hash: "9a21bb5e6dea4df6a7109de8eb59edc8fab0b3fd58def044047baeb511567f59", createdAt: 1700000001000 },
  { hash: "a857826416c2c8a2a2a60785ada99a0c6956db213231baec410c9210bef7c4de", createdAt: 1700000002000 },
  { hash: "587d32e6eadd27406cf059c78e60d49b4c617b1fa0405512cf2456cc4fea12f4", createdAt: 1700000003000 },
  { hash: "2613ab16112adfcd6daf83e4b74ccafd028820fe3a7b4f64a45d01057e045ef9", createdAt: 1700000004000 },
  { hash: "9b530b4d09fcdbe22f2070ca17f784b9337f52544608b9413fcfdcfa19e6f920", createdAt: 1700000005000 },
  { hash: "e9bc1a306467e9d5bfdb1806c2ae14c86559b48cfe8a1d1f5f96b7990effdbbf", createdAt: 1700000006000 },
  { hash: "f71039b583221df1ab0c11ffec14b71faa74acdddc1bb1b90272894aab0df42c", createdAt: 1700000007000 },
  { hash: "c46ccf2324c2d75c084c159d7c0323f3db42cef264d3317e069718f7ad22317a", createdAt: 1700000008000 },
  { hash: "8020c56a7add22b0871d8791fec2385017cfaf5a1819d658fccc7cd6247c9ae9", createdAt: 1700000009000 },
  { hash: "0d2599b7296005585caa18eb1d668a2485436465f3796c1ea824b603911abc43", createdAt: 1700000010000 },
  { hash: "cd6387e454b77300d58410c21382496397462791138e82906a8d9ed4e294d651", createdAt: 1700000011000 },
  { hash: "215b45f3684a61827a343588b7090aa7268ca898bcfa2699d65deb3c78fd265d", createdAt: 1700000012000 },
  { hash: "011be3a3027f68132d4b8e3fd22b77ac8b90b9bef36b5fff972843108dd100bd", createdAt: 1700000013000 },
  { hash: "2c054923ef760fe97057d095cd8b15313497b43878cd5d0a3626069a0d0c46de", createdAt: 1700000014000 },
  { hash: "3b54d050b601667d7b4f39dda2a66aa85435010b96687f1a3ea16efb23b06226", createdAt: 1700000015000 },
  { hash: "5895871e31a16f40a59132a774c85b0c0c2f443ac1365264b0ca74582b2d57a2", createdAt: 1776300000000 },
  // 0018_cute_maestro — route_stat_events table (already applied in prod via partial deploy)
  { hash: "892a000eebbcacd6266eeb379fbbebac7b2f845f0b98b46a3548d77a5c3b81c9", createdAt: 1776450557270 },
  // 0019_bright_gateway — route_stat_events indexes
  { hash: "843f7398e3258d10a9088a5ffe9a250366dd04810fbd977c35b97fd52109dd89", createdAt: 1776451074957 },
  // 0020_smiling_sir_ram — users.oauth_provider column (already applied in prod via partial deploy)
  { hash: "7f08ab488a8ad2ee518e73479adbf6fe0924c52ef9691063e2f4e1cfe7a4ccbf", createdAt: 1776467764250 },
];

async function seedLegacyMigrations(client: pg.PoolClient): Promise<void> {
  await client.query(`CREATE SCHEMA IF NOT EXISTS drizzle`);
  await client.query(`
    CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at bigint
    )
  `);

  const { rows: tableCheck } = await client.query<{ exists: boolean }>(`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'facts'
    ) AS exists
  `);

  if (!tableCheck[0].exists) {
    return;
  }

  const { rows: existingRows } = await client.query<{ hash: string; created_at: string | null }>(
    `SELECT hash, created_at FROM drizzle.__drizzle_migrations`,
  );
  const existingByHash = new Map(
    existingRows.map((r) => [r.hash, r.created_at === null ? null : Number(r.created_at)]),
  );

  for (const m of LEGACY_MIGRATIONS) {
    if (!existingByHash.has(m.hash)) {
      await client.query(
        `INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)`,
        [m.hash, m.createdAt],
      );
    } else if (existingByHash.get(m.hash) !== m.createdAt) {
      // Reconcile created_at so Drizzle's "select ... order by created_at desc limit 1"
      // comparison correctly skips already-applied migrations whose folderMillis matches.
      // IS DISTINCT FROM makes this a no-op if any row already matches (NULL-safe).
      await client.query(
        `UPDATE drizzle.__drizzle_migrations SET created_at = $2 WHERE hash = $1 AND created_at IS DISTINCT FROM $2`,
        [m.hash, m.createdAt],
      );
    }
  }
}

function getMigrationsFolder(): string {
  if (process.env.DRIZZLE_MIGRATIONS_FOLDER) {
    return process.env.DRIZZLE_MIGRATIONS_FOLDER;
  }
  const candidateDistMigrations = path.join(__dirname, "migrations");
  if (fs.existsSync(candidateDistMigrations)) {
    return candidateDistMigrations;
  }
  return path.join(__dirname, "../migrations");
}

export async function runMigrations(): Promise<void> {
  const migrationsFolder = getMigrationsFolder();
  const client = await pool.connect();
  try {
    await seedLegacyMigrations(client);
  } finally {
    client.release();
  }
  await migrate(db, { migrationsFolder });
}

export * from "./schema";
