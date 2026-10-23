# Debug mode — lessons for a rebuild

Debug mode (a second value per setting, `admin_config.debug_value` with its
display label `debug_value_label`, swapped in everywhere while the
`debug_mode_active` setting read `"true"`; the config screen's Debug column,
"has debug value" badge and Debug Mode ON/OFF toggle) was deleted in launch
Phase 4, removal 8 (#744). Its ledger row is in [`README.md`](README.md); the
code and docs as they stood are at the tag `pre-cut/debug-mode`, in
`artifacts/api-server/src/lib/adminConfig.ts`,
`artifacts/api-server/src/lib/membershipTiming.ts` and the config route in
`artifacts/api-server/src/routes/admin.ts`. Why it was cut is
`launch-feature-inventory.md`, Journeys H and I (David, 2026-10-05): a parallel
config universe with a global switch on a live site, whose real need (trying a
setting safely) the engine evaluation and per-key edit history already serve.
Nothing on the roadmap brings it back, so this page holds only what a rebuild
of anything like it would otherwise rediscover.

## How it worked

- **One flag, every getter.** `getConfigInt`, `getConfigString`,
  `getConfigFloat`, `getConfigStringWithSource` and the public `/api/config`
  map returned a row's `debug_value` when the flag was `"true"` and the debug
  value was non-empty, else `value`. The flag's own row was never redirected,
  so it could not switch itself off.
- **Opt-outs were per call site, not per setting.** `getConfigStringRaw` and
  `getConfigIntRaw` read `value` directly so that the Stripe live-mode switch
  and the `engine_revision` staleness marker could never move under the flag.
  Each exemption was found by someone noticing a setting must not flip; there
  was no list of settings the overlay was allowed to touch. Those two getters
  survive as plain `value` readers.
- **A dropdown setting carried a label per value**, so the debug side had its
  own `debug_value_label`.
- **Enrichment provenance recorded it.** A fact enriched while a debug prompt
  was in force stamps `classificationPromptDiagnostics.source =
  "admin_config_debug_value"`. That enum value stays readable in
  `lib/api-zod/src/taxonomy.ts` for blobs stamped then; nothing writes it now.

## What it cost

- **Every relational invariant had to hold twice.** The membership timing
  settings (lease TTL, lease waiter, grace sweep interval and alert) must be
  coherent as a set. With an inert overlay, an operator could store debug
  values each valid against the base set and invalid together, and one flip
  of the flag (not itself a membership key, so no relational check ran)
  activated the broken pair on the payments path. The route grew a locked
  read of both columns plus the flag, validation of the patched set under both
  resolutions, and tracking of override *presence* separately from its value
  (an override equal to `value` still pins the debug resolution). All of that
  went with the column; the route now locks and validates one set.
- **Every prompt migration ran twice.** Migrations 0064, 0073, 0082, 0084,
  0085 and 0090 each scrubbed the same text out of `value` and again out of
  `debug_value`. Those files are unchanged; on a fresh database the runner
  skips their debug half as an absent-column error, and the tests that replay
  0073 and 0082 replay the `value` half only.
- **Clearing was a second write path.** `clearDebugValue: true` and
  `debugValue: null` both cleared an override, and an early revision
  validated only one of them.

## What the data held when it went

- **Dev, read 2026-10-23 before the migration:** the flag was `"false"` and
  exactly one setting had a debug value (`user_max_images`; the committed
  fixture's copy of that row reads `"100"` beside a standard `"1000"`).
  Migration 0108 captured that row whole,
  and the flag row, into `feature_permissions_migration_log.deleted_rows`
  (`migration_name = '0108_retire_debug_mode'`) before deleting the flag and
  dropping both columns.
- **The migration refuses while the flag is `"true"`**, naming the settings
  whose debug value would stop applying, because dropping the columns then
  would silently change live values. Production has not been migrated; a
  publish runs 0108 there and meets the same check.

## If something like it is rebuilt

Make the overlay opt-in per setting (a declared list), not opt-out per call
site, and validate any cross-setting invariant on the flip itself, not only on
each write.
