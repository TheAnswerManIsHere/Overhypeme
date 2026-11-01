/**
 * @purpose The one list of fixed PostgreSQL advisory-lock keys the server takes, so no two locks share a number by accident (#805: the admin population lock and the media backup lock both used 7654322, so admin changes waited behind a backup). Per-row locks use `hashtext('<scope>:<id>')` instead and are not listed here.
 * @subsystem security
 */
import { MIGRATION_LOCK_KEY } from "@workspace/db/migrate";

/**
 * Every fixed single-key advisory lock, by what it guards. A new one is added
 * here, never as a literal in its module; `advisoryLockKeys.test.ts` holds the
 * values distinct.
 */
export const ADVISORY_LOCK_KEYS = {
  /** The migration runner (`lib/db/src/migrate.ts`), held for a whole migration. */
  migration: MIGRATION_LOCK_KEY,
  /** Mutations that could leave no account able to reach the admin console. */
  adminPopulation: 7_654_322,
  /** One media backup capture at a time, held for the whole capture. */
  mediaBackup: 7_654_323,
} as const;
