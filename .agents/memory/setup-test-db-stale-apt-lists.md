---
name: The session-start test DB setup can fail silently on stale apt lists
description: Before #670, in a fresh cloud container, scripts/setup-test-db.sh (the .claude/settings.json SessionStart hook) died at "Unable to locate package postgresql-16-pgvector" because the image's apt lists were stale — so no Postgres was running, and every DB-backed test refused with ECONNREFUSED at the marker check. `apt-get update` then rerunning the script fixed it.
---

## Symptom

Every api-server test run, and `pnpm --filter @workspace/db push-force`, refuses with:

    [require-test-db] refusing: could not read the test-database marker (connect ECONNREFUSED 127.0.0.1:5432)

That reads like the marker guard misbehaving. It is not — there is simply no
Postgres, because the SessionStart hook that starts it failed at its first step
and the session carried on.

## Cause

`scripts/setup-test-db.sh` step 1 runs `apt-get install postgresql-16-pgvector`
without an `apt-get update`. On an image whose package lists are stale it prints
`E: Unable to locate package postgresql-16-pgvector`, and `set -e` ends the script
before the cluster is started. (Measured 2026-10-13, #566's session.)

## Fix, in-session

    apt-get update -qq && bash scripts/setup-test-db.sh

The script is idempotent; the second run creates the role and database, pushes
the schema, applies migrations and marks the database.

## Fixed upstream

`scripts/setup-test-db.sh` now runs `apt-get update` first on the path where the
package is missing (#670, 2026-10-13). The note stays for the symptom: a
session whose hook still fails for another reason shows the same ECONNREFUSED,
and the marker guard is not the cause.
