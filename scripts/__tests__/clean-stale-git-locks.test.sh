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

# run_in_temp_repo NAME [--real-pgrep] CMD [ARGS...]
#
# Runs CMD inside an isolated temp directory that looks like a git repo
# (hand-crafted skeleton — no `git init` required, the Replit sandbox
# intercepts the `git` binary in workflow processes).
#
# By default a fake pgrep that always returns exit 1 ("no git processes")
# is injected into PATH so the cleaner script's active-process guard never
# fires unexpectedly.  Pass --real-pgrep to use the real system pgrep
# instead (needed by the "active process blocks cleanup" test).
run_in_temp_repo() {
  local test_name="$1"
  shift

  local use_real_pgrep=0
  if [ "${1:-}" = "--real-pgrep" ]; then
    use_real_pgrep=1
    shift
  fi

  local temp_root
  temp_root="$(mktemp -d)"
  trap 'rm -rf "${temp_root}"' RETURN

  mkdir -p "${temp_root}/scripts"
  cp "${SCRIPT_UNDER_TEST}" "${temp_root}/scripts/clean-stale-git-locks.sh"
  chmod +x "${temp_root}/scripts/clean-stale-git-locks.sh"

  # Inject a fake pgrep that reports "no git process running" so the
  # cleaner script's active-process guard never silently skips deletion.
  # This prevents Replit's checkpoint/commit git processes from flaking
  # tests that assert a lock WAS removed.
  local fake_bin
  fake_bin="$(mktemp -d)"
  if [ "${use_real_pgrep}" -eq 0 ]; then
    cat > "${fake_bin}/pgrep" <<'PGREP_EOF'
#!/usr/bin/env bash
# Stub: no git process is running — let the sweeper proceed.
exit 1
PGREP_EOF
    chmod +x "${fake_bin}/pgrep"
  fi

  (
    cd "${temp_root}"
    # Build a minimal .git skeleton without invoking `git init`.
    # The Replit sandbox intercepts the `git` binary in workflow processes,
    # making `git init` unreliable in CI.  The cleaner script only inspects
    # .git/{index,HEAD,...}.lock and .git/refs/**/*.lock — it never runs any
    # git command itself — so a hand-crafted skeleton is sufficient.
    mkdir -p .git/refs/heads .git/refs/tags .git/refs/remotes
    printf 'ref: refs/heads/main\n' > .git/HEAD
    PATH="${fake_bin}:${PATH}" "$@"
  )

  trap - RETURN
  rm -rf "${temp_root}"
  rm -rf "${fake_bin}"
}

echo "test: stale allowlisted lock is removed"
run_in_temp_repo "stale allowlisted" bash -euo pipefail -c '
  touch .git/index.lock
  touch -d "10 minutes ago" .git/index.lock
  [ -e .git/index.lock ]
  GIT_LOCK_STALE_SECONDS=120 bash scripts/clean-stale-git-locks.sh >/dev/null
  [ ! -e .git/index.lock ]
'

echo "test: fresh allowlisted lock is not removed"
run_in_temp_repo "fresh allowlisted" bash -euo pipefail -c '
  touch .git/index.lock
  [ -e .git/index.lock ]
  GIT_LOCK_STALE_SECONDS=120 bash scripts/clean-stale-git-locks.sh >/dev/null
  [ -e .git/index.lock ]
'

echo "test: stale non-allowlisted lock is not removed"
run_in_temp_repo "stale non allowlisted" bash -euo pipefail -c '
  touch .git/some-future-feature.lock
  touch -d "10 minutes ago" .git/some-future-feature.lock
  [ -e .git/some-future-feature.lock ]
  GIT_LOCK_STALE_SECONDS=120 bash scripts/clean-stale-git-locks.sh >/dev/null
  [ -e .git/some-future-feature.lock ]
'

echo "test: stale refs lock is removed"
run_in_temp_repo "stale refs lock" bash -euo pipefail -c '
  mkdir -p .git/refs/heads
  touch .git/refs/heads/main.lock
  touch -d "10 minutes ago" .git/refs/heads/main.lock
  [ -e .git/refs/heads/main.lock ]
  GIT_LOCK_STALE_SECONDS=120 bash scripts/clean-stale-git-locks.sh >/dev/null
  [ ! -e .git/refs/heads/main.lock ]
'

echo "test: active git process blocks all cleanup"
run_in_temp_repo "active process" --real-pgrep bash -euo pipefail -c '
  touch .git/index.lock
  touch -d "10 minutes ago" .git/index.lock

  # Stub pgrep so the sweeper sees a "running git process" without needing to
  # actually spawn a process named git (exec -a is not reliable here because
  # the Replit git wrapper intercepts executions of files named "git",
  # and /proc/self/comm renaming is Linux-only and race-prone in a test).
  fake_bin="$(mktemp -d)"
  cat > "${fake_bin}/pgrep" <<'"'"'PGREP_EOF'"'"'
#!/usr/bin/env bash
# Simulate: a git process is running for this user.
exit 0
PGREP_EOF
  chmod +x "${fake_bin}/pgrep"

  PATH="${fake_bin}:${PATH}" \
    GIT_LOCK_STALE_SECONDS=120 bash scripts/clean-stale-git-locks.sh >/dev/null
  [ -e .git/index.lock ]

  rm -rf "${fake_bin}"
'

echo "test: disabled flag short-circuits without deleting"
run_in_temp_repo "disabled" bash -euo pipefail -c '
  touch .git/index.lock
  touch -d "10 minutes ago" .git/index.lock
  [ -e .git/index.lock ]
  GIT_LOCK_WATCHER_ENABLED=0 GIT_LOCK_STALE_SECONDS=120 bash scripts/clean-stale-git-locks.sh >/dev/null
  [ -e .git/index.lock ]
'

echo "PASS: clean-stale-git-locks safety tests"
