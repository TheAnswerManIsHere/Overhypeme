#!/usr/bin/env bash
# clean-stale-git-locks.sh — remove stale Git lock files left behind by
# crashed or interrupted Git operations.
#
# Why this exists
#   Whenever a Git command (commit, push, fetch, background `git maintenance`,
#   ref update, etc) is killed mid-write it leaves a `.git/*.lock` file
#   behind. Subsequent operations — including the Replit "Sync" button —
#   refuse to start until the lock is gone. The Replit agent sandbox cannot
#   delete files inside `.git/`, so today the only fix is for the user to
#   open a Shell and run `rm` themselves. This script runs from a workflow
#   process (which *can* write to `.git/`) and clears those leftover locks
#   automatically.
#
# Safety model (read before changing)
#   1. Allowlist only. We only ever look at a fixed, hardcoded set of well
#      known lock paths. We do NOT do `find .git -name "*.lock" -delete` —
#      that would risk wiping locks that future Git versions add for new,
#      legitimately-long-running operations we don't know about yet.
#   2. Stale threshold. A lock must be older than GIT_LOCK_STALE_SECONDS
#      (default 120s) before it's eligible for removal. 120s is conservative
#      on purpose: large pushes/fetches and Replit filesystem stalls can
#      legitimately keep a lock alive longer than 30s, and the cost of being
#      wrong (corrupting an in-flight Git operation) is much higher than the
#      cost of waiting another minute for self-healing.
#   3. Active-process check. Before deleting *anything* this tick, we run
#      pgrep against the current user looking for `git`, `git-remote-https`,
#      `git-upload-pack`, and `git-receive-pack`. If any are running we skip
#      ALL deletions for this tick and log it. This is the last-line defense
#      against deleting a lock that belongs to a real, in-flight operation
#      whose mtime happens to look old (e.g. a slow upload).
#
# Tuning / disabling (env vars)
#   GIT_LOCK_WATCHER_ENABLED   default 1.   Set to 0 to short-circuit and
#                                            exit immediately. The watcher
#                                            workflow honors this too, so
#                                            setting it to 0 disables the
#                                            whole feature without removing
#                                            any workflow.
#   GIT_LOCK_STALE_SECONDS     default 120. Minimum lock age in seconds
#                                            before a lock is considered
#                                            stale and eligible for removal.
#   (GIT_LOCK_WATCHER_INTERVAL is read by the watcher loop, not by this
#    sweeper itself.)
#
# Exit code
#   Always 0 on success, including when there's nothing to do. Designed to
#   be run repeatedly (every few seconds) and concurrently with normal Git
#   activity.

set -u

ENABLED="${GIT_LOCK_WATCHER_ENABLED:-1}"
STALE_SECONDS="${GIT_LOCK_STALE_SECONDS:-120}"

log() {
  echo "[git-lock-sweeper] $*"
}

if [ "${ENABLED}" = "0" ]; then
  log "disabled via GIT_LOCK_WATCHER_ENABLED=0, exiting"
  exit 0
fi

if ! [[ "${STALE_SECONDS}" =~ ^[0-9]+$ ]]; then
  log "GIT_LOCK_STALE_SECONDS must be a non-negative integer, got: ${STALE_SECONDS}"
  exit 0
fi

# Resolve repo root so this script works no matter where it's invoked from.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
GIT_DIR="${REPO_ROOT}/.git"

if [ ! -d "${GIT_DIR}" ]; then
  # Not a git checkout (or .git is a worktree pointer file). Nothing to do.
  exit 0
fi

# Hardcoded allowlist of top-level lock paths. Refs are handled separately
# below because they live under an enumerated subtree.
ALLOWLIST=(
  "${GIT_DIR}/index.lock"
  "${GIT_DIR}/HEAD.lock"
  "${GIT_DIR}/ORIG_HEAD.lock"
  "${GIT_DIR}/packed-refs.lock"
  "${GIT_DIR}/shallow.lock"
  "${GIT_DIR}/config.lock"
  "${GIT_DIR}/objects/maintenance.lock"
)

# Collect candidate locks: allowlisted top-level paths plus any
# .git/refs/**/*.lock. `refs/` is itself an enumerated subtree (heads,
# remotes, tags), so a glob limited to it is still allowlisted in spirit.
candidates=()
for p in "${ALLOWLIST[@]}"; do
  [ -e "${p}" ] && candidates+=("${p}")
done

if [ -d "${GIT_DIR}/refs" ]; then
  while IFS= read -r -d '' lock; do
    candidates+=("${lock}")
  done < <(find "${GIT_DIR}/refs" -type f -name '*.lock' -print0 2>/dev/null)
fi

if [ "${#candidates[@]}" -eq 0 ]; then
  exit 0
fi

now_epoch=$(date +%s)

# First pass: figure out which candidates are actually stale (and log skips
# for fresh locks so it's obvious why we left them alone).
eligible=()
for lock in "${candidates[@]}"; do
  # Re-check existence — could have been removed by Git itself between the
  # listing and now.
  [ -e "${lock}" ] || continue
  mtime=$(stat -c %Y "${lock}" 2>/dev/null || echo "")
  if [ -z "${mtime}" ]; then
    continue
  fi
  age=$(( now_epoch - mtime ))
  if [ "${age}" -lt "${STALE_SECONDS}" ]; then
    log "skip ${lock#${REPO_ROOT}/} — too fresh (age=${age}s, threshold=${STALE_SECONDS}s)"
    continue
  fi
  eligible+=("${lock}|${age}")
done

if [ "${#eligible[@]}" -eq 0 ]; then
  exit 0
fi

# Second pass: refuse to delete anything if a real Git process is running
# for this user. This is the most important guardrail in the script — an
# eligible lock might belong to a long-running operation whose mtime happens
# to look old (e.g. an upload that hasn't touched the lock file in a while).
my_uid=$(id -u)
if pgrep -u "${my_uid}" -x git >/dev/null 2>&1 \
   || pgrep -u "${my_uid}" -x git-remote-https >/dev/null 2>&1 \
   || pgrep -u "${my_uid}" -x git-upload-pack >/dev/null 2>&1 \
   || pgrep -u "${my_uid}" -x git-receive-pack >/dev/null 2>&1; then
  log "active git process found, skipping cleanup of ${#eligible[@]} candidate lock(s)"
  exit 0
fi

for entry in "${eligible[@]}"; do
  lock="${entry%|*}"
  age="${entry##*|}"
  if rm -f "${lock}" 2>/dev/null; then
    log "removed ${lock#${REPO_ROOT}/} (age=${age}s)"
  else
    log "failed to remove ${lock#${REPO_ROOT}/} (age=${age}s)"
  fi
done

exit 0
