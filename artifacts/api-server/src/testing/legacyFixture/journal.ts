/**
 * The migration head the fixture's code was built against: the repository's
 * journal, hashed the way the migrator hashes it (lib/db/src/migrate.ts:179-181).
 * The source database's raw ledger is not the head: the dev ledger also holds
 * rows no journal entry produced (re-applied edits, rows a test left behind).
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The folder the migrator reads (lib/db/src/migrate.ts:81-90): its override first, then the repository's.
const MIGRATIONS = process.env.DRIZZLE_MIGRATIONS_FOLDER ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../../lib/db/migrations");

export interface JournalHead {
  entries: number;
  latestTag: string;
  hashes: string[];
}

export function journalHead(): JournalHead {
  const journal = JSON.parse(fs.readFileSync(path.join(MIGRATIONS, "meta/_journal.json"), "utf8")) as { entries: Array<{ tag: string }> };
  const hashes = journal.entries.map((e) => createHash("sha256").update(fs.readFileSync(path.join(MIGRATIONS, `${e.tag}.sql`), "utf8")).digest("hex"));
  return { entries: journal.entries.length, latestTag: journal.entries.at(-1)!.tag, hashes };
}
