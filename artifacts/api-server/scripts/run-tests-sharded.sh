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
# --test-force-exit is critical: without it Node's test runner waits for the
# event loop to drain after the last test, which adds ~60s of idle time per
# shard because the @workspace/db pool keeps unref'd connection-keepalive
# work alive. With --test-force-exit the runner calls process.exit() once
# all tests have completed, which is safe here because each shard is a
# short-lived test process that does not need graceful shutdown.
common_args=(
  --import tsx/esm
  --test-force-exit
  --test-isolation=none
  --test-concurrency=1
  --test
)

pids=()
for ((k = 1; k <= shards; k++)); do
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

exit "$overall"
