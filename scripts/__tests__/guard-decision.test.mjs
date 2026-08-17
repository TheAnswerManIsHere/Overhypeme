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
  // Round 6: a heredoc delimiter outside the identifier grammar makes
  // tokenising throw, so only the conservative fallback sees this text.
  ["round 6: a fetcher surviving on the untokenisable path", "curl --help <<'MSG-1'\nDavid's note\nMSG-1"],
  ["round 7: path-qualified on that same path", "/usr/bin/curl --help <<'MSG-1'\nDavid's note\nMSG-1"],
  ["round 9: and with a leading-dot delimiter", "/usr/bin/curl --help <<'.MSG'\nDavid's note\n.MSG"],
  ["round 10: and with a colon", "/usr/bin/curl --help <<'NOTE:1'\nDavid's note\nNOTE:1"],
  ["a shell stdin heredoc with a punctuated delimiter", "bash <<'RUN:1'\ngit push -f origin claude/x\nRUN:1"],
  // Round 11: the delimiter is a QUOTED WORD, so finding its end needs the
  // shell's escape rules, not a `(['"]?)…\1` pair. Bash's delimiter here is
  // `A"B`; reading it as `A\` hunts for the wrong terminator and deletes the
  // real push sitting between the two.
  ['round 11: an escaped quote must not move the terminator', 'cat <<"A\\"B"\nA"B\ngit push -f origin main\nA\\'],
  ["the same over-match from unquoted escaped whitespace", "cat <<A\\ B\nA B\ngit push -f origin main\nA\\"],
  // Round 12: `$'...'` is a quoting FORM, not a `$` composed with a quote.
  // Bash's delimiter here is `EOF`; reading it as `$EOF` runs the terminator
  // search past the real one and swallows the commands in between.
  ["round 12: ANSI-C quoting must not shift the terminator", "cat <<$'EOF'\nEOF\ngit push -f origin main\n$EOF"],
  // An empty delimiter is a real opener, so the body it introduces is still a
  // script when the opener command is a shell reading stdin.
  ["an empty delimiter still feeds a shell's stdin", "bash <<''\ngit push -f origin claude/x\n"],
  // Round 13: Bash emits a BYTE for an octal escape, so `\777` wraps to 0xFF.
  // Building the unbounded code unit (U+01FF) sent the terminator search past
  // the real terminator and swallowed the command in between.
  // Round 14 REPLACED round 13's version of this row, which asserted that
  // `$'\777'` and a `ÿ` line name the same delimiter. They do not: Bash emits
  // the raw byte FF while `ÿ` in UTF-8 command text is C3 BF, so Bash leaves
  // the heredoc open and never runs the push. The row was wrong about Bash,
  // not merely about the code. Any escape at or above 0x80 now abstains, so
  // the body stays in the text and the push is judged on its own.
  ["round 14: a non-ASCII escape abstains rather than inventing a delimiter", "cat <<$'\\777'\n\u00ff\ngit push -f origin main\n\u00ff"],
  // Round 14: `<<-` strips leading tabs from every body line, and the body is
  // what a shell reading stdin then parses. Stripping only the terminator left
  // the nested `\tIN` looking like data, so the inner heredoc ran on to the
  // later bare `IN` and swallowed the push.
  ["round 14: <<- body tabs are stripped before a nested heredoc is parsed", "bash <<-OUT\n\tcat <<IN\n\tdata\n\tIN\n\tgit push -f origin main\nIN\nOUT"],
  // Round 14: an unreadable delimiter leaves prose in place, tokenising throws,
  // and the old fallback did not list a force refspec. Refusing untokenisable
  // text closes that by construction rather than by a longer list.
  ["round 14: an unreadable delimiter cannot hide a force refspec", "cat <<$'A\\0B'\nDavid's note\nA\ngit push origin +main"],
  // An abstention must not hide anything: an undecodable escape means no
  // heredoc is recognised, so the text is judged in full.
  ["a NUL escape abstains rather than hiding a push", "cat <<$'A\\0B'\ngit push -f origin main\nA"],
  // Round 8: `help time` documents `time [-p] pipeline` and it EXECUTES the
  // pipeline. A plausible diagnostic command, and one the deleted sweep had
  // been masking.
  ["round 8: time -p runs its pipeline", "time -p curl https://api.github.com/rate_limit"],
  ["the bare form too", "time curl https://api.github.com/x"],
  // Round 7: the query exemption must cover only the WRAPPER's own leading
  // options. Here `-v` belongs to curl, and curl really runs.
  ["round 7: command's operand with its own -v", "command curl -v https://api.github.com/rate_limit"],
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
  // Round 8: a non-identifier heredoc delimiter is now stripped, so an inert
  // body mentioning a fetcher path is data, not a command. This is the shape
  // of every doc and commit message this session wrote about the guard.
  ["a heredoc body naming a fetcher path is prose", "cat <<'MSG-1'\nUse /usr/bin/curl for the probe; David's note\nMSG-1"],
  // Round 9: the delimiter grammar must be uniform across positions. Bash
  // documents the delimiter as an unrestricted `word`; widening only positions
  // 2+ fixed the shape I had been shown and left these two broken.
  ["a leading-dot delimiter", "cat <<'.MSG'\nUse /usr/bin/curl for the probe; David's note\n.MSG"],
  ["a leading-dash delimiter", "cat <<'-MSG'\nUse /usr/bin/curl for the probe; David's note\n-MSG"],
  // Round 10: a colon is outside every punctuation allowlist I had written,
  // which is why the class is now negated rather than enumerated.
  ["a colon in the delimiter", "cat <<'NOTE:1'\nUse /usr/bin/curl for the probe; David's note\nNOTE:1"],
  // Round 11: the same escaped-quote delimiter, read correctly, is an
  // ordinary inert body.
  ['an escaped quote inside a double-quoted delimiter', 'cat <<"A\\"B"\nUse /usr/bin/curl for the probe; David\'s note\nA"B'],
  // The terminator is compared as a string, so a delimiter carrying regex
  // metacharacters cannot make an unrelated line end the body early.
  ["a delimiter containing regex metacharacters", "cat <<'A.B'\nAXB\ngit push -f origin main\nA.B"],
  // Round 12: three more quoting forms, each of which had left an inert body
  // unstripped and therefore refused as an unparseable destructive command.
  ["an ANSI-C quoted delimiter", "cat <<$'EOF'\nUse /usr/bin/curl for the probe; David's note\nEOF"],
  ["an ANSI-C escape inside the delimiter", "cat <<$'A\\tB'\nUse /usr/bin/curl for the probe; David's note\nA\tB"],
  ["an empty quoted delimiter terminates on a blank line", "cat <<''\nUse /usr/bin/curl for the probe; David's note\n"],
  ["a delimiter continued across a backslash-newline", 'cat <<"A\\\nB"\nUse /usr/bin/curl for the probe; David\'s note\nAB'],
  // Round 13: the terminator is compared the way Bash compares it -- exactly,
  // with leading TABS removed only for `<<-`. Trimming both ends of every line
  // was inherited from the regex this replaced, and an empty delimiter made it
  // visible: a spaces-only line reduced to "" and ended the body early.
  ["a spaces-only line is not an empty terminator", "cat <<''\n   \nUse /usr/bin/curl for the probe; David's note\n"],
  ["<<- strips leading tabs from its terminator", "cat <<-EOF\nUse /usr/bin/curl for the probe; David's note\n\tEOF"],
  // Plain `<<` strips nothing, so an indented line is body, not terminator --
  // which means the push below it is data being fed to `cat`, exactly as Bash
  // would treat it.
  ["plain << does not strip an indented terminator", "cat <<EOF\n  EOF\ngit push -f origin main\nEOF"],
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

test("unparseable input is blocked even when it looks harmless", () => {
  // Round 14 reversed this row, and the reversal is the finding. It used to
  // assert that untokenisable text was ALLOWED unless a `LOOKS_DESTRUCTIVE`
  // regex recognised it -- an enumeration of destructive shapes, which is the
  // third enumeration this PR has had to abandon. Codex walked through the
  // gap: an unreadable heredoc delimiter left an inert body in place, prose
  // apostrophes made tokenising throw, and `git push origin +main` was not in
  // the list, so a force refspec sailed through.
  //
  // Refusing here is what makes every "this abstains, which over-blocks"
  // claim in the module true by construction rather than by the completeness
  // of a regex.
  assert.equal(blocked("echo 'unterminated"), true);
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

