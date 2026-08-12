# Claude CLI PATH persistence — Replit → Claude Code Web

**From:** Replit live-environment session (ops/diagnostics only; no product-code
changes made).
**To:** Claude Code Web — to design/implement the `.replit` change.
**Status:** Investigation complete. One item is unverified and needs an actual
Repl restart to confirm before the PR is finalized.

## The ask

David wants `claude` available in every fresh shell without a manual PATH
export or reinstall after a Repl restart, ideally via a `.replit` change.

## Confirmed environment facts

- `/home/runner` is an **overlayfs** (ephemeral container layer, wiped on
  restart). `/home/runner/workspace` is a separate **btrfs volume**
  (persistent). Verified via `mount` / `stat -f`.
- The real Claude Code payload is a single binary **file** at
  `.../workspace/.local/share/claude/versions/<version>` (not a directory —
  corrects the original assumption in the ask). It already persists
  correctly; only the symlink to it is lost.
- `~/.local/bin/claude` is a symlink into that versioned file, and is lost on
  restart because it lives under `$HOME`.
- `~/.local/bin` is already unconditionally first on `PATH` via the base
  container image's `~/.profile` (generic `if [ -d "$HOME/.local/bin" ]`
  boilerplate). That part is **not** `.replit`-controlled and already
  survives restarts fine — it's not part of the gap.

## Findings

**1. Would a workspace-based symlink itself survive a restart?**
Yes — confirmed by the mount evidence above. A symlink placed under
`/home/runner/workspace/.local/bin/claude` lives on the persistent btrfs
volume, same as the binary it would point to.

**2. Is there a cleaner/more official mechanism than a hand-rolled symlink?**
No. `.claude.json` shows `installMethod: "native"` (Anthropic's own native
installer), and its entire indirection mechanism *is* that one symlink
(`~/.local/bin/claude → versions/<N>`). No `current`/`latest` manifest exists
anywhere under `.local/share/claude/` — checked directly.

**3. Exact `PATH` value for `.replit`'s `[env]` block — UNVERIFIED, needs a
real restart test.**
I read the generated shell-environment script Replit sources into every new
shell (`/run/replit/env/latest`, rebuilt by `update_environment()` in the
sourced bashrc). Its one `PATH=` assignment is built algorithmically from
installed Nix module bin dirs; nothing in that generated file reads a
`[env]`-declared `PATH` override the way it does for a plain var (e.g.
`CLAUDE_CONFIG_DIR` comes through as a literal `declare -gx`). **I could not
confirm `.replit`'s `[env]` block can extend `PATH` at all**, and would not
ship a `PATH` line there without an actual before/after-restart check.

Since `~/.local/bin` is already on `PATH` unconditionally (see facts above),
`PATH` itself is likely not the real gap — the gap is that nothing currently
*recreates the file* `~/.local/bin/claude` after `$HOME` resets. Recommend
investigating a `.replit` boot-time hook instead of a `PATH` edit (this repo
already has `[[workflows.workflow]]` entries defined; unclear whether any of
them run automatically on Repl start vs. only on demand — check that before
assuming one exists) that re-links `~/.local/bin/claude` to the persistent
binary.

**4. Does the version path change on updates? What's the update-safe
reference?**
Yes. `claude update` exists ("Check for updates and install if available");
`.claude.json` shows `autoUpdates: false` / `autoUpdatesProtectedForNative:
true`, so it won't happen silently — but a deliberate `claude update` will
still produce a new `versions/<N>` file and re-point `~/.local/bin/claude`.
**No manifest/"latest" pointer exists to depend on instead** — checked
`.local/share/claude/` directly. A persistent symlink pinned to today's
literal version string will go stale on the next update. The update-safe
pattern: re-derive the persistent symlink's target from
`readlink -f ~/.local/bin/claude` **at the moment `claude update` runs**, not
hardcode a version anywhere.

## Recommended shape for the `.replit` PR

- Don't add a `PATH` line to `[env]` without testing that it actually
  survives an environment rebuild.
- Add a boot-time (or otherwise every-fresh-shell) step that ensures
  `~/.local/bin/claude` exists, symlinked to whatever the persistent install
  currently resolves to.
- Add the same step (or a documented manual one) to run right after any
  future `claude update`, so the persistent reference doesn't go stale.
- The TEST_RUN for this PR must include an actual Repl restart with
  `which claude` / `claude --version` checked in a brand-new shell — that's
  the one thing that couldn't be verified from inside a live, still-running
  session.

## Unrelated housekeeping done in the same session (not part of this ask)

This session's local Claude Code permissions
(`.claude/settings.local.json` — gitignored; check that file directly for
current state rather than trusting a snapshot here) had accumulated an
over-broad `Bash(python3 -c ' *)` allowlist entry (arbitrary code execution)
from an earlier approval. It was removed and replaced with two narrow
read-only entries. No committed files were touched by that change.
