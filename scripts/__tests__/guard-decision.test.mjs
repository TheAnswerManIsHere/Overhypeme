import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  decide,
  tokenize,
  segments,
  checkCommand,
  extractCommand,
  stripHeredocs,
} from "../guard-decision.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** The hook receives a PreToolUse payload, not a bare string. */
const payload = (command) => JSON.stringify({ tool_name: "Bash", tool_input: { command } });

const blocked = (command) => decide(payload(command)).blocked;

// ---------------------------------------------------------------------------
// The matrix. This table is the point of the whole file: the version this
// replaced blocked `git push --force origin main` and ALLOWED
// `git push -f origin main`, and there was no test to notice. Every row below
// is a spelling that must land on the correct side.
// ---------------------------------------------------------------------------

const MUST_BLOCK = [
  // --- main, in every spelling ---
  ["long form", "git push --force origin main"],
  ["short form -- the hole in the old guard", "git push -f origin main"],
  ["bundled short opts", "git push -uf origin main"],
  ["lease onto main is still onto main", "git push --force-with-lease origin main"],
  ["lease onto main via HEAD refspec", "git push --force-with-lease origin HEAD:main"],
  ["force refspec, no flag at all", "git push origin +main"],
  ["mirror rewrites every ref", "git push --mirror origin"],
  ["update-ref moves a ref with no safety net", "git update-ref refs/heads/main abc1234"],

  // --- own branches, but without a lease ---
  ["bare force on my own branch", "git push --force origin claude/status-nvkst1"],
  ["short force on my own branch", "git push -f origin claude/status-nvkst1"],
  ["force-if-includes is not a lease", "git push --force-if-includes origin claude/x"],

  // --- lease, but not a shape we can verify ---
  ["implicit refspec -- target unknowable from here", "git push --force-with-lease"],
  ["implicit refspec with a remote", "git push --force-with-lease origin"],
  ["two refspecs", "git push --force-with-lease origin claude/a claude/b"],
  ["a branch outside the owned namespaces", "git push --force-with-lease origin feature/x"],
  ["main-adjacent name that is not owned", "git push --force-with-lease origin claudex/main"],
  ["--all ignores the refspec entirely", "git push --all --force-with-lease origin claude/x"],
  ["--delete removes the branch", "git push --delete --force-with-lease origin claude/x"],
  ["unclassified option on a force push", "git push --force-with-lease --receive-pack=evil origin claude/x"],

  // --- compound commands: every segment is judged ---
  ["force push hidden after &&", "echo hi && git push -f origin main"],
  ["force push hidden after ;", "cd /tmp; git push --force origin main"],
  ["force push inside a substitution", "echo $(git push -f origin main)"],
  ["force push inside backticks", "echo `git push -f origin main`"],
  ["a permitted push next to a forbidden command", "git push --force-with-lease origin claude/x && rm -rf /"],

  // --- the other standing denials ---
  ["rm -rf /", "rm -rf /"],
  ["rm -fr / with flags reordered", "rm -fr /"],
  ["rm -r -f / as separate flags", "rm -r -f /"],
  ["drizzle-kit push", "drizzle-kit push"],
  ["drizzle-kit push via pnpm", "pnpm drizzle-kit push"],
  ["drizzle-kit push via npx", "npx drizzle-kit push --force"],
];

const MUST_ALLOW = [
  // --- the one permitted force shape ---
  ["lease onto an owned branch", "git push --force-with-lease origin claude/status-nvkst1"],
  ["lease onto a plan-review branch", "git push --force-with-lease origin plan-review/evidence-retention"],
  ["lease with an explicit expectation", "git push --force-with-lease=claude/x:abc123 origin claude/x"],
  ["lease with a HEAD refspec onto an owned branch", "git push --force-with-lease origin HEAD:claude/x"],
  ["lease alongside -u", "git push -u --force-with-lease origin claude/x"],
  ["git -C still resolves the subcommand", "git -C /repo push --force-with-lease origin claude/x"],

  // --- reset --hard: local only, cannot reach the remote ---
  ["hard reset", "git reset --hard HEAD~1"],
  ["hard reset to a ref", "git reset --hard origin/main"],

  // --- ordinary work must not be collateral ---
  ["normal push", "git push -u origin claude/status-nvkst1"],
  ["normal push to main is GitHub's call, not ours", "git push origin main"],
  ["status", "git status --short"],
  ["checkout -B, the documented reset primitive", "git checkout -B claude/x origin/main"],
  ["fetch and merge", "git fetch origin main && git merge origin/main"],

  // --- text ABOUT a force push is not a force push (the old false positive) ---
  ["commit message mentioning force push", 'git commit -m "explain why we never git push --force to main"'],
  ["echoing the rule", 'echo "do not use git push -f on main"'],
  ["grep -f is not a force flag", "grep -f patterns.txt CLAUDE.md"],
  ["rm -rf on a scoped path", "rm -rf node_modules/.cache"],
];

for (const [name, command] of MUST_BLOCK) {
  test(`blocks: ${name}`, () => {
    assert.equal(blocked(command), true, `should have blocked: ${command}`);
  });
}

for (const [name, command] of MUST_ALLOW) {
  test(`allows: ${name}`, () => {
    assert.equal(blocked(command), false, `should have allowed: ${command}`);
  });
}

// ---------------------------------------------------------------------------
// Posture: an input the parser cannot understand must not sail through.
// ---------------------------------------------------------------------------

test("unparseable input that looks destructive is blocked", () => {
  // Unbalanced quote: tokenising throws, so the conservative scan decides.
  assert.equal(blocked("git push -f origin main 'unterminated"), true);
});

test("unparseable input that looks harmless is allowed", () => {
  assert.equal(blocked("echo 'unterminated"), false);
});

test("a force push whose target is computed rather than named is blocked", () => {
  // Unquoted substitution: `(` splits it off, so the refspec is unreadable and
  // therefore not an owned branch. A target the hook cannot read is one it
  // cannot vouch for.
  assert.equal(blocked("git push --force-with-lease origin $(git branch --show-current)"), true);
});

test("an ordinary push alongside a substitution is not collateral", () => {
  assert.equal(blocked('echo "done $(date)" && git push -u origin claude/x'), false);
});

test("a hard reset to a computed ref is not collateral", () => {
  assert.equal(blocked("git reset --hard $(git rev-parse HEAD~1)"), false);
});

// ---------------------------------------------------------------------------
// Heredocs. A body is data being fed to a program, not commands to judge --
// and this repo writes every commit message through one. An earlier revision
// scanned the body as text and blocked its own introducing commit for quoting
// force-push examples; these pin that it cannot happen again.
// ---------------------------------------------------------------------------

const COMMIT_WITH_EXAMPLES = [
  "git commit -F - <<'MSG'",
  "fix(devops): narrow the guard",
  "",
  "It blocked `git push --force origin main` and allowed",
  "`git push -f origin main`. GitHub's ruleset is the real control.",
  "MSG",
].join("\n");

test("a commit message quoting force-push examples is allowed", () => {
  assert.equal(blocked(COMMIT_WITH_EXAMPLES), false);
});

test("prose apostrophes in a heredoc do not break tokenising", () => {
  const command = ["cat <<'EOF'", "GitHub's ruleset, David's call, the branch's history", "EOF"].join("\n");
  assert.equal(blocked(command), false);
});

test("a real force push is still caught when the command also carries a heredoc", () => {
  const command = ["git push -f origin main", "git commit -F - <<'MSG'", "harmless text", "MSG"].join("\n");
  assert.equal(blocked(command), true);
});

test("stripHeredocs removes the body and keeps the surrounding command", () => {
  const stripped = stripHeredocs("git commit -F - <<'MSG'\ngit push -f origin main\nMSG");
  assert.equal(/push/.test(stripped), false);
  assert.match(stripped, /git commit -F -/);
});

test("a denial always carries a reason", () => {
  const { blocked: isBlocked, reason } = decide(payload("git push -f origin main"));
  assert.equal(isBlocked, true);
  assert.match(reason, /force push/);
});

// ---------------------------------------------------------------------------
// Payload handling.
// ---------------------------------------------------------------------------

test("reads the command out of a PreToolUse payload", () => {
  assert.equal(extractCommand(payload("git status")), "git status");
});

test("falls back to the raw text when the payload is not the expected shape", () => {
  assert.equal(extractCommand("git status"), "git status");
  assert.equal(extractCommand("{not json"), "{not json");
});

test("a description mentioning a force push does not block the command it describes", () => {
  const raw = JSON.stringify({
    tool_name: "Bash",
    tool_input: { command: "git status" },
    description: "check state before we git push --force origin main",
  });
  assert.equal(decide(raw).blocked, false);
});

// ---------------------------------------------------------------------------
// Tokeniser units -- the parts the matrix depends on being right.
// ---------------------------------------------------------------------------

test("a quoted string stays one token", () => {
  assert.deepEqual(tokenize('git commit -m "a b c"'), ["git", "commit", "-m", "a b c"]);
});

test("operators are emitted as their own tokens", () => {
  assert.deepEqual(tokenize("a && b"), ["a", "&&", "b"]);
  assert.deepEqual(tokenize("a; b"), ["a", ";", "b"]);
});

test("segments split a compound command", () => {
  assert.deepEqual(segments(tokenize("echo hi && git status")), [["echo", "hi"], ["git", "status"]]);
});

test("checkCommand judges a single argv", () => {
  assert.equal(checkCommand(["git", "push", "-f", "origin", "main"]) !== null, true);
  assert.equal(checkCommand(["git", "status"]), null);
  assert.equal(checkCommand([]), null);
});

// ---------------------------------------------------------------------------
// End to end through the hook itself, so the wiring is covered and not just
// the module. exit 2 = blocked, exit 0 = allowed (the hook's contract).
// ---------------------------------------------------------------------------

function runHook(command) {
  try {
    execFileSync("bash", [".claude/guard.sh"], {
      cwd: REPO_ROOT,
      input: payload(command),
      stdio: ["pipe", "pipe", "pipe"],
    });
    return 0;
  } catch (error) {
    return error.status;
  }
}

test("hook exits 2 on a force push to main", () => {
  assert.equal(runHook("git push -f origin main"), 2);
});

test("hook exits 0 on a leased force push to an owned branch", () => {
  assert.equal(runHook("git push --force-with-lease origin claude/status-nvkst1"), 0);
});

test("hook exits 0 on ordinary work", () => {
  assert.equal(runHook("git status --short"), 0);
});
