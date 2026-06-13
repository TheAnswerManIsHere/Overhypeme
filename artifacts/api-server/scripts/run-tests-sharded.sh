#!/usr/bin/env bash
# run-tests-sharded.sh — run the api-server test suite as N parallel shards.
#
# Each shard is its own `node --test` process. Node's --test-shard=K/N flag
# splits the matched test files across N shards by file index, so each shard
# gets an independent process — that means in-memory module state (the
# stripeSyncRunner lock, in-memory rate limiters, the session cache, env-var
# snapshots) is naturally isolated between shards.
#
# Usage:
#   run-tests-sharded.sh [shard_count]
#
# If shard_count is omitted, defaults to 2. Must be a positive integer >=1.
#
# Exit status is the bitwise-OR of the individual shard exit codes, so any
# shard failure surfaces as a non-zero overall exit. Output from the shards
# is interleaved on stdout/stderr — that is acceptable here because the test
# runner already prints per-test diagnostics with file paths.

set -u

shards="${1:-2}"

if ! [[ "$shards" =~ ^[0-9]+$ ]] || (( shards < 1 )); then
  echo "[run-tests-sharded] shard_count must be a positive integer, got: $shards" >&2
  exit 2
fi

# Args common to every shard. --test-isolation=none + --test-concurrency=1
# keep each shard single-process (file ordering inside a shard stays
# sequential), and we let Node expand the glob.
#
# TEST_DB_ALLOW_EXIT_ON_IDLE=1 tells the @workspace/db Pool to set
# allowExitOnIdle: true at construction time.  This unrefs idle-timeout
# timers and client sockets so Node exits cleanly once all tests have
# finished, without waiting up to idleTimeoutMillis (60 s) for idle
# connections to drain.  That lets us drop --test-force-exit and regain
# the ability to detect leaked promises.
# The test-isolation flag was introduced as --experimental-test-isolation and
# later stabilized to --test-isolation. Different node builds (CI, Replit, the
# cloud dev environment) ship different versions and advertise different names —
# passing the wrong one makes node abort at startup ("bad option"). Detect which
# name THIS node knows from --help and use it; both select the same
# single-process behavior. Don't silently omit it: within a shard we rely on
# isolation=none so in-memory module state (the stripeSyncRunner lock, rate
# limiters, caches) is shared and file ordering stays sequential.
if node --help 2>&1 | grep -q -- '--test-isolation='; then
  isolation_flag="--test-isolation=none"
elif node --help 2>&1 | grep -q -- '--experimental-test-isolation='; then
  isolation_flag="--experimental-test-isolation=none"
else
  echo "[run-tests-sharded] WARNING: node $(node --version) advertises no test-isolation flag;" >&2
  echo "[run-tests-sharded] running without it (each test file gets its own process)." >&2
  isolation_flag=""
fi

common_args=(--import tsx/esm)
[[ -n "$isolation_flag" ]] && common_args+=("$isolation_flag")
common_args+=(--test-concurrency=1 --test)

# purge_test_data — FK-safe sweep of every test-created row from the database.
#
# Tests run against the real dev DB (no isolated test DB), so leaked rows
# accumulate and cost money. This runs OUTSIDE the parallel-shard window (once
# before, once after) so it never races a shard mid-test:
#
#   • pre-sweep  heals any rows left by a previously crashed/interrupted run, so
#                each run starts from a clean DB.
#   • post-sweep removes this run's rows on normal completion, and via the EXIT
#                trap also runs if the script is interrupted (SIGINT/SIGTERM).
#
# The sweep is best-effort: a failure here must never mask a real test result,
# so its exit code is swallowed. The next run's pre-sweep is the hard guarantee.
purge_test_data() {
  TEST_DB_ALLOW_EXIT_ON_IDLE=1 node --import tsx/esm \
    src/__tests__/helpers/purgeTestData.ts || true
}

# Ensure a sweep runs even if the shards are interrupted partway through.
trap 'purge_test_data' EXIT

echo "[run-tests-sharded] pre-sweep: purging leftover test rows…"
purge_test_data

pids=()
for ((k = 1; k <= shards; k++)); do
  # CRON_SECRET has no fallback in routes/jobs.ts — app.js throws at module load
  # if it is unset, which fails every test that imports the full app (e.g.
  # csrf.integration). Stub it the same way RESEND_API_KEY is stubbed so the
  # suite is self-contained and does not depend on a real secret being present.
  TEST_DB_ALLOW_EXIT_ON_IDLE=1 RESEND_API_KEY_DEV="" RESEND_API_KEY_PROD="" RESEND_API_KEY="re_test_dummy" \
    CRON_SECRET="${CRON_SECRET:-test-cron-secret}" \
    node "${common_args[@]}" --test-shard="${k}/${shards}" \
    'src/__tests__/**/*.test.ts' &
  pids+=("$!")
done

overall=0
for pid in "${pids[@]}"; do
  if ! wait "$pid"; then
    overall=1
  fi
done

# Normal-completion sweep. The EXIT trap also fires after this (harmless: a
# second sweep on an already-clean DB is a no-op).
echo "[run-tests-sharded] post-sweep: purging this run's test rows…"
purge_test_data

exit "$overall"
