# A retirement migration captures admin-curated rows before deleting them

**Shape.** A migration that retires a feature deletes rows an admin may have
edited: config values, engine rows, curated lists. The deleting migration is
the last moment those values exist anywhere the repository can reach. The tag
holds the code and the seed defaults, never what an admin typed, and the
production copy goes at the next publish with nobody looking at it.

**Evidence.** Launch Phase 4, removal 4 (#756): migration 0105 deleted the
seven `zazzle_*` settings and logged only a count. On dev two of them had been
edited away from the seed defaults (the store and category IDs), so the values
a merch rebuild needs were lost from the repository's reach; the build report
caught it after the merge. Removals 2 and 3 had captured their retired
features into `feature_permissions_migration_log.deleted_rows`, so the pattern
existed and was not applied.

**Do this.** Before a migration deletes any row an admin can edit, select the
rows into `feature_permissions_migration_log.deleted_rows` (one row per
migration, `migration_name` set to the migration's tag) in the same `DO`
block, then delete. Count-only notices are for rows nothing curated. Test it:
the migration test asserts the captured JSON holds the deleted rows' values.
