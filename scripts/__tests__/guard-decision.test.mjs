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
  checkMerge,
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

  // --- round-1 review findings (PR #329), each pinned where it was found ---
  ["rm -rf on a root glob -- the old regex's un-anchored match caught this too", "rm -rf /*"],
  ["command wrapper hides the real program", "command git push --force origin claude/x"],
  ["env wrapper hides the real program", "env git push -f origin claude/x"],
  ["sudo wrapper hides the real program", "sudo git push -f origin claude/x"],
  ["leading env-assignment hides the real program", "GIT_SSH_COMMAND=ssh git push --force origin claude/x"],
  ["abbreviated --mirror", "git push --m origin"],
  ["abbreviated --force-with-lease onto main is still main", "git push --force-with origin main"],
  ["backslash-newline splits a bundled short flag", "git push -\\\nf origin main"],
  ["inline git alias expands to push", "git -c alias.p=push p --force origin claude/x"],
  ["grouping braces hide the real command", "{ git push -f origin claude/x; }"],
  ["if/then hides the real command", "if true; then git push -f origin claude/x; fi"],
  ["ANSI-C quoted program name", "$'git' push -f origin claude/x"],
  ["empty-source refspec deletes rather than updates", "git push --force-with-lease origin :claude/x"],
  ["--delete is a deletion even without a force flag", "git push --delete origin claude/x"],

  // --- round-2 review findings (PR #329) ---
  ["inline alias expansion carries the force flag itself", "git -c alias.p='push --force' p origin claude/x"],
  ["env -i is a known bare flag, unwrapping continues past it", "env -i git push -f origin claude/x"],
  ["command -p is a known bare flag, unwrapping continues past it", "command -p git push -f origin claude/x"],
  ["short -d is the documented short form of --delete", "git push -d origin claude/x"],
  ["a nested bash -c push is judged the same as a top-level one", "bash -c 'git push -f origin claude/x'"],
  ["a nested sh -c rm -rf / is judged the same as a top-level one", "sh -c 'rm -rf /'"],
  ["coproc hides the real command the same way { or if do", "coproc git push -f origin claude/x"],
  ["rm -Rf -- the capital-R spelling rm --help lists first", "rm -Rf /"],
  ["rm -fR -- reordered capital-R bundle", "rm -fR /"],
  ["rm --recursive --force as separate long flags", "rm --recursive --force /"],
  ["a leading-dot root glob is still root-only", "rm -rf /.*"],
  ["a bracket character class is a class, not literal text", "rm -rf /[be]*"],
  ["ANSI-C hex escapes decode to the program name", "$'\\x67\\x69\\x74' push -f origin claude/x"],
  ["brace expansion turns one token into two force-shaped flags", "git push -{f,u} origin claude/x"],
  ["a versioned drizzle-kit package spec is still drizzle-kit", "npx drizzle-kit@latest push"],

  // --- round-3 review findings (PR #329) ---
  ["a bundled shell option (-lc) still carries the -c argument", "bash -lc 'git push -f origin claude/x'"],
  ["another bundled form (-ec)", "sh -ec 'rm -rf /'"],
  ["a known value-taking wrapper flag is skipped with its value", "env -u GIT_CONFIG git push -f origin claude/x"],
  ["a bundled short delete flag is still a deletion", "git push -qd origin claude/x"],
  ["an alias expansion can lead with a git option before push", "git -c alias.p='-c core.pager=cat push --force' p origin claude/x"],
  ["a bang-prefixed alias is a literal shell command, per git's own docs", "git -c alias.p='!git push -f origin claude/x' p"],
  ["eval joins a quoted command string and runs it", "eval 'git push -f origin claude/x'"],
  ["eval joins unquoted words into the same command", "eval git push -f origin claude/x"],
  ["the git-push executable itself takes push's own flags directly", "/usr/lib/git-core/git-push -f origin claude/x"],
  ["the git-update-ref executable is update-ref with no subcommand word", "/usr/lib/git-core/git-update-ref refs/heads/main abc1234"],
  ["--exec-path's separate-value form does not hide the subcommand", "git --exec-path /usr/lib/git-core push -f origin claude/x"],
  ["a heredoc feeding a bare shell interpreter's stdin is not inert data", "bash <<'EOF'\ngit push -f origin claude/x\nEOF"],
  ["npx -c joins its command string the same way a shell's -c does", "npx -c 'drizzle-kit push'"],
  ["npm exec -c is the same interface npx uses", "npm exec -c 'drizzle-kit push'"],
  ["parent-directory traversal climbs back out of an apparently scoped path", "rm -rf /tmp/../*"],

  // --- curl/wget: refused outright (David, 2026-08-17) ---
  // The rule exists because api.github.com fails SILENTLY inside a pipeline.
  // It refuses the whole program rather than deciding which invocations reach
  // that host, because four review rounds showed that judgement cannot be made
  // without reimplementing curl's and wget's own argument parsing.
  ["curl to the GitHub API", "curl -sS https://api.github.com/repos/o/r/pulls/1"],
  ["the CI-poll shape that stalled on 2026-08-16", "curl -sS https://api.github.com/repos/o/r/commits/abc/check-runs | grep -c in_progress"],
  ["wget too", "wget -qO- https://api.github.com/rate_limit"],
  ["hidden behind a wrapper", "env -i curl -sS https://api.github.com/x"],
  ["hidden in a compound command", "echo hi && curl -sS https://api.github.com/x"],
  ["hidden inside a nested shell", "bash -c 'curl -sS https://api.github.com/x'"],

  // Any other host, deliberately. Precision was the whole cost centre, and an
  // ad-hoc fetch is rare enough to ask about.
  ["curl to an unrelated host is refused too", "curl -sS https://example.com/thing"],
  ["so is wget to one", "wget -O out.html https://example.com"],
  ["and a fetch with no URL-shaped argument at all", "curl --help"],

  // The routes that ended the parser. Each was a live bypass found by Codex on
  // #488 across four rounds, in a different sub-language of these tools; all of
  // them are now blocked by the same single rule rather than five mechanisms.
  ["round 3: an attached short value (wget -i)", "wget -ihttps://api.github.com/rate_limit"],
  ["round 4: a wgetrc directive via --execute", "wget -e base=https://api.github.com/ -F -i local.html"],
  ["round 4: --connect-to's second host", "curl --connect-to example.com:443:api.github.com:443 https://example.com/"],
  ["round 4: URL brace globbing", "curl 'https://api.github.{com,org}/rate_limit'"],
  ["round 4: a SOCKS-scheme proxy endpoint", "curl --proxy socks5h://api.github.com https://example.com/"],
  ["round 4: variable interpolation into --expand-url", "curl --variable h=api.github.com --expand-url 'https://{{h}}/rate_limit'"],

  // Round 5 attacked the ONE exception the rule used to carry -- the agent
  // proxy's own status probe -- and found three ways through it in a single
  // pass. The exception is gone rather than tightened: the third of these
  // cannot be fixed by inspecting arguments at all, because the extra request
  // is not in the arguments.
  ["round 5: the probe path on ANY origin, including the blocked one", "curl https://api.github.com/__agentproxy/status"],
  ["round 5: an attached -K config file alongside the probe", "curl -K/tmp/api.conf \"$HTTPS_PROXY/__agentproxy/status\""],
  ["round 5: a .curlrc reached via CURL_HOME adds transfers argv never shows", "CURL_HOME=/tmp/profile curl -sS \"$HTTPS_PROXY/__agentproxy/status\""],
  ["the probe itself, now that there is no exception", "curl -sS \"$HTTPS_PROXY/__agentproxy/status\""],

  // Round 5 also found the one remaining fail-OPEN: an unrecognised wrapper
  // flag made resolveRealCommand give up and return the wrapper, so the
  // membership test never saw the fetcher.
  ["round 5: exec -a substitutes argv0 and still runs curl", "exec -a fetch /usr/bin/curl https://api.github.com/rate_limit"],
  ["the same wrapper without the flag", "exec /usr/bin/curl https://api.github.com/rate_limit"],

  // Round 6: programs that DISPATCH to a fetcher. `timeout` is the one of
  // these I might plausibly have typed by accident -- it is the natural
  // spelling of a CI wait, which is the mistake this whole rule exists for.
  ["round 6: timeout starts COMMAND after its DURATION", "timeout 30 curl https://api.github.com/rate_limit"],
  ["with an option before the duration", "timeout -k 5 30 curl https://api.github.com/x"],
  ["round 6: env -S splits its value into a command line", "env -S 'curl https://api.github.com/rate_limit'"],
  ["the attached spelling of the same", "env -Scurl https://api.github.com/x"],
  ["round 6: npx --call, the long spelling of -c", "npx --call 'curl https://api.github.com/x'"],
  ["npm exec --call likewise", "npm exec --call 'curl https://api.github.com/x'"],
  // The heredoc-delimiter work that rounds 8-15 produced is SPLIT OUT of this
  // PR (David, 2026-08-17). Its rows travel with it. What remains here is the
  // fetcher refusal, which is what this PR is about and which has been stable
  // since round 6.
  //
  // The consequence is stated rather than hidden: with main's identifier-only
  // delimiter grammar, a fetcher behind a punctuated heredoc delimiter reaches
  // the untokenisable path, where `LOOKS_DESTRUCTIVE` -- known incomplete --
  // decides. That is a pre-existing gap this PR neither widens nor closes.
  // Round 8: `help time` documents `time [-p] pipeline` and it EXECUTES the
  // pipeline. A plausible diagnostic command, and one the deleted sweep had
  // been masking.
  ["round 8: time -p runs its pipeline", "time -p curl https://api.github.com/rate_limit"],
  ["the bare form too", "time curl https://api.github.com/x"],
  // Round 7: the query exemption must cover only the WRAPPER's own leading
  // options. Here `-v` belongs to curl, and curl really runs.
  ["round 7: command's operand with its own -v", "command curl -v https://api.github.com/rate_limit"],
  // Round 16: `npm exec --help` documents `x` as the alias, verified against
  // this container's npm. Same dispatcher, second spelling.
  ["round 16: npm x is npm exec", "npm x --call 'curl --version'"],
  ["the -c spelling of the same alias", "npm x -c 'wget --help'"],
  // Round 16: measured -- `env -S '-i printf ...'` runs printf, so the split
  // words go into ENV's argv, not straight to the child. Judging the first
  // word as the program let an option prefix hide the fetcher behind it.
  ["round 16: an option prefix inside env -S", "env -S '-i curl --version'"],
  ["a value-taking option prefix inside env -S", "env -S '-u HOME wget --help'"],
  ["an end-of-options marker inside env -S", "env -S '-- curl --version'"],
  ["the attached spelling of the same", "env -S'-i curl --version'"],
  // Round 16: the array-assignment suppression must not swallow a command
  // substitution sitting inside the parentheses.
  ["round 16: a substitution inside an array literal is still a command", "arr=( $(git push -f origin main) )"],
  // Round 17: `$` is not what makes a substitution executable. Round 16's
  // suppression tested only for `$`, so both of these were erased whole --
  // `segments()` returned an empty array and the fetcher vanished. A fail-open
  // created by a fix for a false block, from checking one example.
  ["round 17: backticks in an array literal still execute", "arr=( `curl --version` )"],
  ["round 17: process substitution in an array literal still executes", "arr=( <(curl --version) )"],
  // Round 17, second pass: `help declare` says integer variables undergo
  // ARITHMETIC EVALUATION on assignment, so an integer array's initializer
  // expands a plain identifier -- and a variable whose value carries a
  // substitution then runs. Measured: the equivalent probe wrote its marker
  // file. This is what killed the "every token is a plain word" whitelist:
  // whether tokens are inert depends on attributes set elsewhere in the
  // command, not on the tokens.
  ["round 17: an integer array's initializer is arithmetic, not data", "curl='a[$(/usr/bin/curl --version)0]'; declare -ia arr=(curl)"],
  ["the bare form of the same", "declare -ia arr=(curl)"],
  // ACCEPTED OVER-BLOCK, pinned deliberately. Bash assigns two strings here
  // and runs neither, so this refusal is wrong -- and it is the cost of
  // deleting the suppression that tried to allow it, which opened a
  // fail-open in each of its two versions. Do not "fix" this row without
  // reading the note above `segments()`.
  ["an array literal naming fetchers is over-blocked, and that is the accepted trade", "fetchers=(curl wget)"],
  ["the append spelling, same accepted trade", "fetchers+=(curl)"],
  // Round 18: the over-block is NOT fetcher-only. Deleting the suppression
  // restored it for every rule in the module, because the literal's words are
  // emitted as a command segment that all of them judge. Pinned across three
  // different rules so the class is what is asserted, not one example -- the
  // first version of this note named only the fetcher case and understated
  // the deletion's blast radius by three rules.
  ["a push in an array literal is over-blocked too", "ops=(git push -f origin main)"],
  ["an rm in an array literal, same class", "cleanup=(rm -rf /)"],
  ["a drizzle-kit push in an array literal, same class", "migration=(drizzle-kit push)"],
  // Round 19: update-ref is a SEPARATE branch of checkCommand from push, so
  // naming push did not cover it -- the second consecutive round in which this
  // note was too narrow. Both spellings, since the direct executable is its
  // own branch again.
  ["an update-ref in an array literal, a fourth distinct rule", "ops=(git update-ref refs/heads/main abc1234)"],
  ["the direct git-update-ref executable, same class", "ops=(/usr/lib/git-core/git-update-ref refs/heads/main abc1234)"],
  // Round 20: the drizzle-kit rule scans ALL tokens rather than command
  // position, so an inert leading word does NOT defuse it -- unlike every
  // other rule (see the MUST_ALLOW rows below). Pinned because it is the one
  // case that distinguishes "judged as ordinary argv" from "the first word
  // decides", and the header's claim now rests on that distinction.
  ["a drizzle-kit push behind an inert word is still caught, because that rule scans every token", "ops=(echo drizzle-kit push)"],
  ["an unclosed array paren is not suppressed", "arr=(curl wget"],
  ["a subshell is not an array assignment", "(cd x && curl https://api.github.com/x)"],
  ["an array literal does not exempt what follows it", "fetchers=(curl wget) && curl https://api.github.com/x"],
  // Round 16: truncating the option scan at `--` must not lose the ordinary
  // spelling, where the command-string flag precedes the boundary.
  ["a command string before npm's -- boundary", "npm exec -c 'curl https://api.github.com/x' -- pkg"],
];

const MUST_ALLOW = [
  // --- the host may be MENTIONED freely; only running a fetcher is refused ---
  // A substring rule would have blocked all of these, and the last three are
  // things this repo does constantly.
  ["a path that merely looks like the host", "cat ./api.github.com.md"],
  ["a commit message naming it", "git commit -m 'note that api.github.com is blocked from bash'"],
  ["a doc write naming it", "echo 'api.github.com returns 403 here' > notes.md"],
  ["loop-metrics, which uses Node fetch and fails loudly on its own", "node scripts/loop-metrics.mjs --pr 472"],

  // The hook reads the command line typed at it, not a script's contents, so a
  // script that runs curl internally is untouched. That is what keeps the
  // blanket refusal cheap: these were the only real curl uses in the repo.
  ["a script that runs curl internally", "bash scripts/phase5-og-smoke.sh"],

  // Round 6 also found two FALSE BLOCKS that the refusal and its wrapper
  // sweep had introduced. Both are pinned, because a guard that refuses
  // ordinary work gets worked around rather than obeyed.
  ["command -v names a program without running it", "command -v curl"],
  ["sudo -p's value is a prompt string, not a program", "sudo -p curl true"],
  ["timeout wrapping something that is not a fetcher", "timeout 90 bash -c 'pnpm test'"],
  ["sudo -u's value is a username", "sudo -u postgres psql"],
  // Round 7: three false blocks the fail-closed sweep produced before it was
  // deleted. They are pinned because deleting the sweep is the fix, and a
  // regression would be re-adding it.
  ["sudo -l lists privileges without running the command", "sudo -l curl"],
  ["an unlisted wrapper flag must not make data look executable", "sudo -n printf '%s\\n' curl"],
  ["an in-range octal escape still decodes", "cat <<$'\\101'\nUse /usr/bin/curl for the probe; David's note\nA"],

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

  // --- round-1 review findings (PR #329): the same constructs, permitted shape ---
  ["command wrapper around a permitted push", "command git push --force-with-lease origin claude/x"],
  ["env wrapper around a permitted push", "env git push --force-with-lease origin claude/x"],
  ["env-assignment prefix around a permitted push", "GIT_SSH_COMMAND=ssh git push --force-with-lease origin claude/x"],
  ["abbreviated lease onto an owned branch", "git push --force-with origin claude/x"],
  ["abbreviated lease with -c reaching the subcommand correctly", "git -c core.pager=cat push --force-with-lease origin claude/x"],
  ["grouping braces around a permitted push", "{ git push --force-with-lease origin claude/x; }"],
  ["if/then around a permitted push", "if true; then git push --force-with-lease origin claude/x; fi"],
  ["ANSI-C quoted program name, permitted shape", "$'git' push --force-with-lease origin claude/x"],
  ["a root-only glob is not confused with a scoped one", "rm -rf /tmp/scratch-xyz"],
  ["a scoped absolute glob is not root-shaped", "rm -rf /tmp/*"],
  ["an alias to something other than push is not treated as one", "git -c alias.co=checkout co claude/x"],

  // --- round-2 review findings (PR #329): the same constructs, permitted shape ---
  ["env -i around a permitted push", "env -i git push --force-with-lease origin claude/x"],
  ["command -p around a permitted push", "command -p git push --force-with-lease origin claude/x"],
  ["a nested bash -c permitted push", "bash -c 'git push --force-with-lease origin claude/x'"],
  ["a nested bash -c doing something harmless", "bash -c 'echo hi'"],
  ["rm -Rf on a scoped path is still scoped", "rm -Rf /tmp/scratch-xyz"],
  ["a leading dot on a real directory name is a real name", "rm -rf /.git"],
  ["a bracket glob confined to a scoped directory stays scoped", "rm -rf /tmp/[ab]*"],
  ["a brace with no comma is literal text, not expansion", 'echo "hi{there}"'],
  ["an ordinary drizzle-kit command other than push is untouched", "npx drizzle-kit generate"],

  // --- round-3 review findings (PR #329): the same constructs, permitted shape ---
  ["a bundled shell option around a permitted push", "bash -lc 'git push --force-with-lease origin claude/x'"],
  ["a known value-taking wrapper flag around a permitted push", "env -u GIT_CONFIG git push --force-with-lease origin claude/x"],
  ["an alias leading with a git option, permitted shape", "git -c alias.p='-c core.pager=cat push --force-with-lease' p origin claude/x"],
  ["a bang alias running something harmless", "git -c alias.p='!echo hi' p"],
  ["eval running something harmless", "eval 'echo hi'"],
  ["the git-push executable, permitted shape", "/usr/lib/git-core/git-push --force-with-lease origin claude/x"],
  ["--exec-path's separate-value form around a permitted push", "git --exec-path /usr/lib/git-core push --force-with-lease origin claude/x"],
  ["a heredoc feeding a bare shell interpreter something harmless", "bash <<'EOF'\necho hi\nEOF"],
  ["a heredoc feeding a shell that HAS -c is genuinely inert data", "bash -c 'echo hi' <<'EOF'\ngit push -f origin claude/x\nEOF"],
  ["npx -c running something harmless", "npx -c 'echo hi'"],
  ["parent traversal that still lands on a real scoped name", "rm -rf /tmp/sub/../scratch-xyz"],

  // --- round 16: false blocks the blanket fetcher refusal introduced ---
  // Naming a fetcher stays allowed; only running one is refused. `(` is an
  // operator, so an array literal was segmented into a command whose argv[0]
  // was `curl`, contradicting that boundary.
  ["an ordinary array is unaffected", "files=(a.txt b.txt)"],
  // Round 20: the over-block is NOT "any protected name in an array". Array
  // contents are judged as ordinary command argv, so a rule keyed on the
  // RESOLVED program does not fire when an inert word comes first.
  //
  // These rows pin runtime verdicts and nothing more. An earlier version of
  // this comment claimed they made "a future widening of that claim fail the
  // suite" -- false, since no assertion here reads the header's prose, and the
  // branch shipped 236 green tests beside a header statement that was already
  // refuted. (Codex, #488 round 21.) The coupling that comment wanted now
  // exists as the array-literal invariant at the end of this file.
  ["an inert leading word defuses the fetcher rule", "ops=(echo curl)"],
  ["and the push rule", "ops=(echo git push -f origin main)"],
  ["and the rm rule", "ops=(echo rm -rf /)"],
  // A dispatcher's `--` ends ITS options; `--call` past that boundary belongs
  // to the invoked package. Measured for the shell branch too: `bash -- -c
  // 'printf X'` reports `bash: -c: No such file or directory`, so bash reads
  // `-c` as $0 and never runs the string.
  ["a child's identically-named argument after npm's --", "npm exec -- eslint --call 'curl is inert data'"],
  ["bash's -- means the -c string is not a command", "bash -- -c 'curl https://api.github.com'"],
  // Re-entering env -S as `env <split>` reuses the measured option table, so
  // an option prefix in front of a HARMLESS child stays allowed.
  ["an option prefix in env -S around something harmless", "env -S '-i make'"],
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
  // Unbalanced quote: tokenising throws.
  assert.equal(blocked("git push -f origin main 'unterminated"), true);
});

test("unparseable input that looks harmless is allowed", () => {
  // This row asserts main's behaviour, unchanged by this PR: untokenisable
  // text is allowed unless `LOOKS_DESTRUCTIVE` recognises it.
  //
  // That list is KNOWN INCOMPLETE -- Codex showed on #488 round 14 that
  // `git push origin +main` is absent from it, so a force refspec behind an
  // unreadable heredoc gets through. Refusing untokenisable text outright
  // closes that, and reverses this row; it is split out with the heredoc
  // scanner it depends on, because the pair was still converging after five
  // rounds. Left here as main has it, so this PR's diff is the fetcher
  // refusal and nothing else.
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
// The two limits the module docstring discloses rather than chases. These are
// not "should fail" assertions -- they pin the CURRENT, documented behaviour,
// so a change to either is a deliberate edit to the docstring, not a silent
// drift discovered later.
// ---------------------------------------------------------------------------

test("known limit: a substitution nested in double quotes is not decomposed", () => {
  assert.equal(blocked('echo "$(git push -f origin main)"'), false);
});

test("known limit: IFS-based field splitting is not reconstructed", () => {
  assert.equal(blocked("git${IFS}push${IFS}-f${IFS}origin${IFS}claude/x"), false);
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

// Round-1 finding (PR #329): a command chained after the heredoc OPENER, on
// the very same line, is not part of the body. The single-regex version
// swallowed it anyway -- `cat <<EOF && git push -f ...` executes `cat`
// (reading the heredoc as its stdin) and then, once that finishes, the push,
// but the old regex removed everything from `<<EOF` through the terminator,
// deleting the push along with the genuinely inert body beneath it.
test("a command chained after a heredoc opener is not swallowed as body", () => {
  const command = ["cat <<EOF && git push -f origin claude/x", "harmless body", "EOF"].join("\n");
  assert.equal(blocked(command), true);
});

test("stripHeredocs preserves a command chained on the opener's own line", () => {
  const stripped = stripHeredocs(["cat <<EOF && git push -f origin claude/x", "harmless body", "EOF"].join("\n"));
  assert.match(stripped, /git push -f origin claude\/x/);
  assert.equal(/harmless body/.test(stripped), false);
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

// Round-2 review findings (PR #329): tokenizer-level units for the two
// syntactic expansions added this round.

test("brace expansion splits one token into several", () => {
  assert.deepEqual(tokenize("git push -{f,u} origin claude/x"), [
    "git", "push", "-f", "-u", "origin", "claude/x",
  ]);
});

test("a brace with no comma is not expansion", () => {
  assert.deepEqual(tokenize("echo hi{there}"), ["echo", "hi{there}"]);
});

test("ANSI-C hex escapes decode per byte", () => {
  assert.deepEqual(tokenize("$'\\x67\\x69\\x74'"), ["git"]);
});

test("ANSI-C octal escapes decode", () => {
  assert.deepEqual(tokenize("$'\\147\\151\\164'"), ["git"]);
});

test("ANSI-C unicode escapes decode by code point", () => {
  assert.deepEqual(tokenize("$'\\u0067\\u0069\\u0074'"), ["git"]);
});

test("an ANSI-C escape this module does not recognise keeps its backslash, matching Bash", () => {
  // Verified directly: `bash -c "printf '%s\n' \$'\\q'"` prints `\q`, not `q`.
  assert.deepEqual(tokenize("$'\\q'"), ["\\q"]);
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

// ---------------------------------------------------------------------------
// Round-3 (PR #329): the nested-shell depth cap fails CLOSED, not open.
// Verified against real bash first that this construction is valid shell
// (bash -c "$CMD" actually runs it) before trusting it as a test fixture --
// naive alternating-quote nesting looked plausible but was syntactically
// invalid and would have silently tested nothing.
// ---------------------------------------------------------------------------

function shQuote(s) {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

function nestBashC(inner, depth) {
  return depth === 0 ? inner : nestBashC(`bash -c ${shQuote(inner)}`, depth - 1);
}

for (const depth of [1, 2, 3, 4]) {
  test(`depth ${depth} (within the cap): a real push still blocks`, () => {
    assert.equal(blocked(nestBashC("git push -f origin claude/x", depth)), true);
  });
  test(`depth ${depth} (within the cap): harmless work is still allowed`, () => {
    assert.equal(blocked(nestBashC("echo hi", depth)), false);
  });
}

for (const depth of [5, 6]) {
  test(`depth ${depth} (past the cap): a real push still blocks`, () => {
    assert.equal(blocked(nestBashC("git push -f origin claude/x", depth)), true);
  });
  test(`depth ${depth} (past the cap): harmless work FAILS CLOSED, not silently allowed`, () => {
    // This is the point of the fail-closed fix: reaching the cap with an
    // uninspected -c argument still present is not evidence of safety, so
    // it denies even though the actual inner command is harmless.
    assert.equal(blocked(nestBashC("echo hi", depth)), true);
  });
}


// ---------------------------------------------------------------------------
// The array-literal invariant, executed rather than described.
//
// The header's note about array over-blocking was wrong in FOUR consecutive
// review rounds (#488 rounds 18-21) while the behaviour never changed: too
// narrow, too narrow again, then "any protected name is refused" (false --
// `ops=(echo curl)` is allowed), then "the literal's first word decides" (also
// false -- `ops=(env curl)` is refused, because wrappers and environment
// assignments are stripped first).
//
// Codex's round-21 finding named why patching the prose kept failing: a
// comment claiming "a future widening fails the suite" was itself false. These
// rows pin runtime verdicts; nothing read the prose, and the branch shipped 236
// green tests alongside a header statement that was refuted.
//
// So the claim is now a single executable invariant instead of a description:
// an array literal gets exactly the verdict its words get as a command. Unlike
// the four descriptions it replaces, it fails here if it stops being true.
//
// BUT THE CASE LIST BELOW IS HAND-CURATED, so the coverage does NOT update
// itself. A new rule whose inputs aren't represented here can behave
// differently inside an array with every one of these green. **If you add a
// rule to guard-decision.mjs, add a case here** -- or derive this list from the
// rule set instead of maintaining it by hand. An earlier version of this
// comment claimed the invariant "needs no updating when a rule is added,"
// which was the same false assurance the block above warns about, two
// paragraphs after warning about it. (Codex, #499 round 2.)
//
// THE BOUNDARY MATTERS. The invariant is over COMMAND TEXT, which is what
// `blocked()` compares -- both operands wrapped in a payload. Stated one level
// up as `decide(a) === decide(b)` it is false, because `decide` parses its
// argument as PreToolUse JSON first: a WORDS value that is itself valid
// payload JSON has its inner command extracted on one side and is read as
// shell text on the other. The header said it that way for one round and the
// tests could not have caught it. (Codex, #488 round 22.) The last case below
// is that input, pinned.
const ARRAY_INVARIANT_CASES = [
  // protected in command position
  "curl https://api.github.com/x",
  "git push -f origin main",
  "git update-ref refs/heads/main abc1234",
  "rm -rf /",
  "drizzle-kit push",
  // defused by an inert leading word -- all of these are ALLOWED both ways
  "echo curl",
  "echo git push -f origin main",
  "echo rm -rf /",
  // NOT defused: the drizzle-kit rule scans every token
  "echo drizzle-kit push",
  // reached THROUGH a wrapper or an assignment prefix, which is what refuted
  // the "first word decides" version
  "env curl",
  "FOO=x curl",
  "env git push -f origin main",
  "FOO=x rm -rf /",
  "sudo curl",
  "timeout 5 curl",
  // ordinary, allowed both ways
  "a.txt b.txt",
  "echo hi",
  "git push --force-with-lease origin claude/x",
  // The case that distinguishes the command-text boundary from `decide`'s own:
  // valid PreToolUse JSON. As command TEXT both sides agree (neither runs a
  // fetcher); passed to `decide` directly they would not, which is why the
  // invariant is stated over command text.
  '{"tool_input":{"command":"curl --version"}}',
];

for (const words of ARRAY_INVARIANT_CASES) {
  test(`array literal matches the bare command: ${words}`, () => {
    assert.equal(blocked(`arr=(${words})`), blocked(words));
  });
}

// ---------------------------------------------------------------------------
// The merge gate.
//
// CLAUDE.md's merge bar is CI green + Codex converged + every review thread
// resolved. It was reported from a single checked item twice -- PR #458 (merged
// with a round outstanding; seven findings landed 47 seconds later) and PR #487
// (reported green having run get_check_runs and nothing else, on a PR where no
// review had ever been requested). The standing rule is that a discipline
// broken twice becomes a check, so the merge tool now requires the receipt
// scripts/pr-ready.mjs produces.
//
// `checkMerge` takes its receipt reader and SHA resolver as parameters so this
// table asserts the decision rather than the filesystem.
// ---------------------------------------------------------------------------

const READY = {
  verdict: "READY",
  pr: 500,
  repo: "TheAnswerManIsHere/Overhypeme",
  headSha: "a".repeat(40),
  branch: "claude/x",
  generatedAt: new Date(Date.now() - 60_000).toISOString(),
  // When the PR was READ, which is what the gate ages against. `generatedAt`
  // only records when the check ran, and re-running a saved snapshot resets it
  // while the data behind it stays as old as it was. (Codex, #490.)
  evidenceAt: new Date(Date.now() - 60_000).toISOString(),
  items: { ci: { pass: true }, codex: { pass: true }, threads: { pass: true } },
};

const MERGE_INPUT = { pullNumber: 500, owner: "TheAnswerManIsHere", repo: "Overhypeme" };

const mergeReason = (receipt, { tip = READY.headSha, input = MERGE_INPUT } = {}) =>
  checkMerge(input, { readReceipt: () => receipt, resolveSha: () => tip });

test("merge gate: a current, passing receipt allows the merge", () => {
  assert.equal(mergeReason(READY), null);
});

test("merge gate: no receipt at all blocks -- the PR #487 shape", () => {
  assert.match(mergeReason(null), /no readiness receipt/);
});

test("merge gate: a NOT READY receipt blocks and names the failing item", () => {
  const receipt = {
    ...READY,
    verdict: "NOT READY",
    items: {
      ci: { pass: true, detail: "9 checks, all passing" },
      codex: { pass: false, detail: "no `@codex review` request found" },
      threads: { pass: true, detail: "0 threads" },
    },
  };
  const reason = mergeReason(receipt);
  assert.match(reason, /NOT READY/);
  // The whole failure being fixed is a green CI reading standing in for the
  // bar, so the message must name the item that actually failed.
  assert.match(reason, /codex: no `@codex review` request found/);
});

test("merge gate: a receipt older than the age cap blocks", () => {
  const stale = { ...READY, evidenceAt: new Date(Date.now() - 90 * 60_000).toISOString() };
  assert.match(mergeReason(stale), /no longer current/);
});

test("merge gate: an unparseable timestamp blocks rather than reading as age zero", () => {
  assert.match(mergeReason({ ...READY, evidenceAt: "whenever" }), /no longer current/);
});

test("merge gate: a receipt from the future blocks", () => {
  const future = { ...READY, evidenceAt: new Date(Date.now() + 10 * 60_000).toISOString() };
  assert.match(mergeReason(future), /no longer current/);
});

test("merge gate: a push after validation invalidates the receipt", () => {
  // The age cap alone cannot catch this: the receipt was accurate when written
  // and my own next commit made it describe a commit that will not merge.
  const reason = mergeReason(READY, { tip: "b".repeat(40) });
  assert.match(reason, /is not the commit that would merge/);
});

test("merge gate: an unresolvable branch BLOCKS rather than abstaining", () => {
  // This abstained in the first cut, on the reasoning that a branch the remote
  // lookup cannot resolve is not evidence of a problem. Wrong default for a
  // guard: the abstention is indistinguishable from the case it exists to
  // catch. (Codex, #490.)
  assert.match(mergeReason(READY, { tip: null }), /could not resolve the current tip/);
});

test("merge gate: a receipt minted for ANOTHER repository blocks", () => {
  // Receipts are keyed by PR number and shas resolve against this checkout's
  // origin, so a merge aimed elsewhere would find a locally valid receipt and a
  // locally matching tip and pass every remaining check. (Codex, #490.)
  const reason = mergeReason(READY, {
    input: { pullNumber: 500, owner: "someone-else", repo: "Overhypeme" },
  });
  assert.match(reason, /minted for TheAnswerManIsHere\/Overhypeme/);
});

test("merge gate: a merge input naming no repository blocks", () => {
  assert.match(mergeReason(READY, { input: { pullNumber: 500 } }), /names no owner\/repo/);
});

test("merge gate: a receipt recording no repository blocks", () => {
  const { repo, ...noRepo } = READY;
  assert.match(mergeReason(noRepo), /an unrecorded repository/);
});

test("merge gate: a receipt with no evidenceAt blocks", () => {
  // Its age would otherwise describe when the check RAN rather than when the
  // PR was read -- the gap a saved snapshot walks through. (Codex, #490.)
  const { evidenceAt, ...noEvidence } = READY;
  assert.match(mergeReason(noEvidence), /records no evidenceAt/);
});

test("merge gate: a receipt whose body names a different PR blocks", () => {
  // Found by filename, so a mismatched body means a hand-edited or misfiled
  // receipt -- the artifact whose word should least be taken.
  assert.match(mergeReason({ ...READY, pr: 501 }), /says it is for PR #501/);
});

test("merge gate: a receipt with no branch blocks", () => {
  const noBranch = { ...READY, branch: null };
  assert.match(mergeReason(noBranch), /names no branch/);
});

test("merge gate: an abbreviated head sha blocks", () => {
  // The tip comparison is exact equality, so a short sha would never match and
  // the binding would be dead weight that still looked present.
  assert.match(mergeReason({ ...READY, headSha: "abc1234" }), /no full head sha/);
});

test("merge gate: a missing pullNumber blocks", () => {
  assert.match(mergeReason(READY, { input: {} }), /no pullNumber/);
});

test("merge gate: the merge tool routes to the gate, not the Bash parser", () => {
  const raw = JSON.stringify({
    tool_name: "mcp__github__merge_pull_request",
    tool_input: { owner: "o", repo: "r", pullNumber: 500 },
  });
  const { blocked: isBlocked, reason } = decide(raw, {
    readReceipt: () => null,
    resolveSha: () => null,
  });
  assert.equal(isBlocked, true);
  assert.match(reason, /no readiness receipt/);
});
