#!/usr/bin/env bash
set -euo pipefail

SCRIPT_UNDER_TEST="scripts/clean-stale-git-locks.sh"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

assert_exists() {
  local path="$1"
  [ -e "$path" ] || fail "expected file to exist: $path"
}

assert_not_exists() {
  local path="$1"
  [ ! -e "$path" ] || fail "expected file to be removed: $path"
}

run_in_temp_repo() {
  local test_name="$1"
  shift

  local temp_root
  temp_root="$(mktemp -d)"
  trap 'rm -rf "${temp_root}"' RETURN

  mkdir -p "${temp_root}/scripts"
  cp "${SCRIPT_UNDER_TEST}" "${temp_root}/scripts/clean-stale-git-locks.sh"
  chmod +x "${temp_root}/scripts/clean-stale-git-locks.sh"

  (
    cd "${temp_root}"
    git init -q
    "$@"
  )

  trap - RETURN
  rm -rf "${temp_root}"
}

set_stale_mtime() {
  local path="$1"
  touch -d '10 minutes ago' "$path"
}

run_sweeper() {
  GIT_LOCK_STALE_SECONDS=120 bash scripts/clean-stale-git-locks.sh >/dev/null
}

echo "test: stale allowlisted lock is removed"
run_in_temp_repo "stale allowlisted" bash -c '
  touch .git/index.lock
  touch -d "10 minutes ago" .git/index.lock
  [ -e .git/index.lock ]
  GIT_LOCK_STALE_SECONDS=120 bash scripts/clean-stale-git-locks.sh >/dev/null
  [ ! -e .git/index.lock ]
'

echo "test: fresh allowlisted lock is not removed"
run_in_temp_repo "fresh allowlisted" bash -c '
  touch .git/index.lock
  [ -e .git/index.lock ]
  GIT_LOCK_STALE_SECONDS=120 bash scripts/clean-stale-git-locks.sh >/dev/null
  [ -e .git/index.lock ]
'

echo "test: stale non-allowlisted lock is not removed"
run_in_temp_repo "stale non allowlisted" bash -c '
  touch .git/some-future-feature.lock
  touch -d "10 minutes ago" .git/some-future-feature.lock
  [ -e .git/some-future-feature.lock ]
  GIT_LOCK_STALE_SECONDS=120 bash scripts/clean-stale-git-locks.sh >/dev/null
  [ -e .git/some-future-feature.lock ]
'

echo "test: stale refs lock is removed"
run_in_temp_repo "stale refs lock" bash -c '
  mkdir -p .git/refs/heads
  touch .git/refs/heads/main.lock
  touch -d "10 minutes ago" .git/refs/heads/main.lock
  [ -e .git/refs/heads/main.lock ]
  GIT_LOCK_STALE_SECONDS=120 bash scripts/clean-stale-git-locks.sh >/dev/null
  [ ! -e .git/refs/heads/main.lock ]
'

echo "test: active git process blocks all cleanup"
run_in_temp_repo "active process" bash -c '
  touch .git/index.lock
  touch -d "10 minutes ago" .git/index.lock
  bash -c "exec -a git sleep 30" &
  fake_git_pid=$!
  trap "kill ${fake_git_pid} 2>/dev/null || true" EXIT
  GIT_LOCK_STALE_SECONDS=120 bash scripts/clean-stale-git-locks.sh >/dev/null
  [ -e .git/index.lock ]
  kill ${fake_git_pid} 2>/dev/null || true
  wait ${fake_git_pid} 2>/dev/null || true
  trap - EXIT
'

echo "test: disabled flag short-circuits without deleting"
run_in_temp_repo "disabled" bash -c '
  touch .git/index.lock
  touch -d "10 minutes ago" .git/index.lock
  [ -e .git/index.lock ]
  GIT_LOCK_WATCHER_ENABLED=0 GIT_LOCK_STALE_SECONDS=120 bash scripts/clean-stale-git-locks.sh >/dev/null
  [ -e .git/index.lock ]
'

echo "PASS: clean-stale-git-locks safety tests"
