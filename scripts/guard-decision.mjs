#!/usr/bin/env node
/**
 * Decision logic for `.claude/guard.sh` (the PreToolUse Bash hook).
 *
 * WHY THIS IS NARROW
 * ------------------
 * Three layers protect `main`, and this is the third, not the first:
 *
 *   1. The harness's own classifier, which refuses to let this session edit
 *      its guardrails without David approving the write.
 *   2. GitHub's ruleset on `main` -- "Block force pushes", "Restrict
 *      deletions", "Require linear history", "Require a pull request before
 *      merging", "Require status checks to pass" (verified 2026-08-05).
 *      That is the real control: it is server-side, applies to every actor,
 *      and catches spellings a local hook cannot be trusted to enumerate.
 *   3. This hook.
 *
 * So this hook does NOT try to be GitHub's ruleset. Its one job is to make the
 * LEASE MANDATORY on the branches this session owns. That matters more here
 * than on a normal machine: the container is ephemeral, so the local reflog
 * dies with it and an overwritten remote branch has no second copy to recover
 * from. `--force-with-lease` refuses when the remote moved since the last
 * fetch, which is exactly the "something I have not seen is up there" case.
 *
 * POSTURE
 * -------
 * DEFAULT DENY for anything force-push shaped, with one precisely-parsed
 * allowance:
 *
 *     git push --force-with-lease <remote> <claude/...|plan-review/...>
 *
 * Anything else -- main, a bare -f, --mirror, an implicit refspec, a compound
 * command -- falls through to deny. A gap in this parser therefore over-blocks
 * rather than under-blocks.
 *
 * Every judgement is made over shell TOKENS, never over raw payload text, so a
 * command that merely mentions a force push (a commit message, a heredoc, a
 * tool description) is not blocked for talking about one. That was a real
 * defect in the previous grep-the-payload version, alongside the bigger one:
 * it blocked `git push --force` while waving through `git push -f`.
 *
 * KNOWN LIMITS, stated rather than hidden
 * -----------------------------------------
 * Codex's rounds 1-3 of this module (PR #329) found thirty-six concrete
 * parser gaps across three passes, thirty-three now fixed. Round 1 and round 2
 * closed the first twenty (see git history / PR #329 for the full list:
 * transparent wrappers, environment-assignment prefixes, abbreviated long
 * options, a backslash-newline continuation, an inline git alias, shell
 * grouping keywords including `coproc`, ANSI-C quoting, brace expansion, an
 * empty-source/short `-d` delete refspec, a chained heredoc command, a
 * dot/bracket root glob, case-insensitive `rm` flag detection, a versioned
 * `drizzle-kit@` spec, and a first pass at nested `bash -c` recursion).
 * Round 3 found thirteen more, mostly extending or hardening that round-2
 * work rather than opening new categories: bundled shell option letters
 * (`bash -lc '...'`, not just exact `-c`), a wrapper's KNOWN value-taking
 * flags (`env -u NAME`) skipped together with their value rather than
 * stopping the unwrap, a bundled short `-d` (`-qd`), an alias expansion that
 * leads with further git options before `push`, a `!`-prefixed alias (Git's
 * own literal-shell-command alias form, recursed into exactly like `bash
 * -c`), `eval` as a second command-string dispatcher alongside shell `-c`,
 * `npx -c`/`npm exec -c` as a third, the direct `git-push`/`git-update-ref`
 * executables (no leading subcommand word to skip), `git --exec-path`'s
 * separate-value form, a heredoc feeding a bare shell interpreter's STDIN
 * (script, not inert data, when the interpreter has no `-c` of its own),
 * `..` parent-directory traversal climbing back out of an apparently scoped
 * `rm` target, and the nested-shell depth cap now FAILS CLOSED on an
 * uninspected command string instead of silently allowing it once reached.
 * Each has its own comment at the fix site and its own pinning test.
 *
 * One round-3 finding is a genuine POLICY question, not a parser bug, and is
 * deliberately left as-is pending a decision: brace expansion can produce a
 * root-anchored target naming specific system directories
 * (`rm -rf /{bin,etc}` -> `/bin` and `/etc`), but this guard ALREADY allows
 * the byte-for-byte-equivalent non-brace spelling (`rm -rf /bin /etc`) under
 * its own twice-stated policy that a literal, named absolute path is scoped,
 * not root-shaped. Blocking only the brace-expanded spelling would be
 * cosmetic, not a real fix, without also deciding whether specific
 * catastrophic system directories should be denied by name regardless of
 * spelling -- a broader policy call this hook has deliberately avoided,
 * since enumerating "dangerous directory names" is the same allowlist-rot
 * this module's own design already argues against for push options.
 *
 * Two classes remain open, deliberately, for the same reason as before:
 *
 * 1. A command substitution nested inside DOUBLE QUOTES -- `echo "$(git push
 *    -f origin main)"`. The quotes swallow the operators that would
 *    otherwise make the substitution its own segment. Unquoted substitutions
 *    and backticks ARE handled, as is a force push whose target is computed
 *    rather than named.
 * 2. Reconstructing the command WORD ITSELF through Bash's general variable
 *    expansion -- `${IFS}`-based field splitting (`git${IFS}push...`), or
 *    any `$VAR`/`${VAR}` whose value supplies part of a command. Resolving
 *    this needs Bash's actual expansion semantics, not a bigger token list:
 *    the space is unbounded (any variable, any prior assignment, any
 *    parameter expansion operator), and it does not stop at git -- the exact
 *    same class hides `rm` and `drizzle-kit` from THIS hook just as
 *    thoroughly. A shell alias/function defined in one place and invoked
 *    under an unrelated-looking name elsewhere in the same script is the
 *    same problem in a different shape (and additionally requires
 *    `shopt -s expand_aliases`, off by default in a non-interactive shell,
 *    to matter for aliases at all).
 *
 * Both are left open deliberately. Closing them by scanning raw text is what
 * the previous version did, and that is the defect this module exists to
 * remove -- an earlier revision of THIS file tried exactly that as a
 * "backstop" and immediately blocked the commit introducing it, for quoting
 * force-push examples in its own message. Both need a DELIBERATELY
 * obfuscated command to reach -- not something ordinary git usage, or an
 * accidental typo, produces -- and `main` is covered by GitHub's ruleset
 * regardless of whether this hook is evaded. A hook that blocks real work to
 * defeat a hypothetical gets turned off, which protects nothing at all.
 *
 * ROUND 4, AND THE DECISION TO STOP (David, 2026-08-05)
 * -------------------------------------------------------
 * Round 4 found nineteen more gaps -- MORE than round 3's twelve. Rather
 * than fix these piecemeal and start a round 5, David and I stopped here and
 * documented them instead. The per-round count of NEWLY FOUND gaps is the
 * evidence, and it never fell: 11, 11, 12, 19. (Fixes per round were 9, 11,
 * 11, 0 -- the gap between the two columns is the disclosed-not-fixed items
 * above.) Each round's fixes were real, but flat-then-rising discovery is
 * what says the defense is the wrong SHAPE rather than merely unfinished:
 * this is a hand-rolled recognizer chasing a language -- Bash --
 * whose expressive surface for "run this program" is not enumerable in
 * practice. Every round closes a class of gaps and a reviewer thinking
 * adversarially about Bash finds another one, because Bash itself is a large
 * language (wrapper commands, quoting forms, script-dispatch mechanisms, and
 * git's own alias system all combine multiplicatively). That is not a
 * diligence problem this hook can fix by trying harder; it is the same
 * losing shape as blocklist-based XSS sanitization. The real control was
 * never this file -- see the three-layer model at the top -- so the
 * pragmatic stop is here, not at some hypothetical fully-enumerated end
 * state that the data suggests does not exist.
 *
 * What round 4 found, left open:
 * - Wrapper commands still missing bare/value-flag tables: `sudo -n`,
 *   `time -p`, `timeout DURATION`, a named `coproc NAME { ... }`, and
 *   `trap 'CMD' EXIT` (a command-string dispatcher this hook does not treat
 *   as one).
 * - `env`'s `-S`/`--split-string` (itself a second command-string
 *   dispatcher) and its combined-form value flags (`--unset=NAME`,
 *   `--chdir=DIR`), which the current value-flag table only recognizes in
 *   separate-argument form.
 * - `git --config-env`, both the separate-value form (missing from the
 *   value-consuming global-option set) and the inline `NAME=ENVVAR` form
 *   used to smuggle a `!`-prefixed shell-escape alias through an env var
 *   this hook never inspects.
 * - Numeric short options bundled with `-f`/`-d` (`-4f`, `-4d`) -- the
 *   bundled-flag regexes only permit letters.
 * - `$"..."` locale-translated double-quoted words (a second quoting form
 *   alongside `$'...'` that the tokenizer does not decode) and a
 *   backslash-newline continuation inside a double-quoted token (removed by
 *   Bash before argv is built; this tokenizer keeps it as a literal
 *   newline instead).
 * - Redirections (`>file`) appearing before or in the middle of a simple
 *   command rather than only after it, which the segmenter does not
 *   currently expect.
 * - Here-strings (`<<<`) as a second way (besides heredocs) to feed a bare
 *   shell interpreter a script over stdin.
 * - Two heredoc gaps: the opener-command lookup uses everything before `<<`
 *   rather than the command actually attached to the redirection when the
 *   opener is not the first command on its line; and the depth-cap
 *   fail-closed rule (added in round 3 for `-c`/`eval` strings) does not
 *   yet cover an uninspected heredoc body at the cap.
 * - `npm exec --call`/`npx --call` as a second spelling of the command-string
 *   flag alongside `-c`.
 * - `git send-pack --force`/`--mirror`, a fourth remote-ref-update surface
 *   alongside `push`, `update-ref`, and the direct `git-push` executable.
 * - Heredoc delimiters that are valid in Bash but not identifier-shaped
 *   (`<<'MSG-1'`) are now recognized by the stripping regex. This was
 *   documented here as a false-POSITIVE risk only, and that was wrong twice
 *   over: an unstripped body makes tokenising throw, which both let a real
 *   `curl --help <<'MSG-1'` reach the permissive fallback (a bypass) and made
 *   an inert body mentioning `/usr/bin/curl` refuse an ordinary `cat` (a false
 *   block). Both are fixed by stripping the body, which is why the delimiter
 *   grammar now captures the WHOLE delimiter -- anything that is not
 *   whitespace, a quote, or a shell metacharacter -- rather than an allowlist
 *   of punctuation. Two earlier attempts each added the characters in the
 *   example I had just been shown (`MSG-1`, then `.MSG`/`-MSG`, and `NOTE:1`
 *   would have been a third), which is the same mistake the option tables kept
 *   making: matching the reported instance instead of reading the grammar.
 *   Bash documents the delimiter as an unrestricted `word`, and for the quoted
 *   forms the quote itself is the terminator, so a negated class is the actual
 *   rule rather than an approximation of one. An accepted limitation also
 *   stops being accurate the moment a new rule is added above it. (Codex,
 *   #488 rounds 6-10.)
 */

const ALLOW = 0;
const BLOCK = 2;

/** Branch namespaces this session owns. A force push may only ever land here. */
const OWNED_BRANCH = /^(?:claude|plan-review)\/[A-Za-z0-9._/-]+$/;

/** Force spellings that are never permitted, with or without a target. */
const BARE_FORCE = new Set(["--force", "-f", "--force-if-includes", "--mirror"]);
const LEASE = "--force-with-lease";

/** Options tolerated alongside a permitted force push. Anything else denies. */
const BENIGN_PUSH_OPTS = new Set(["--quiet", "-q", "--verbose", "-v", "--set-upstream", "-u"]);

/** Whole-repo or destructive push modes, refused even with a lease. */
const WIDE_PUSH_OPTS = new Set(["--all", "--delete", "--prune", "--tags", "--mirror"]);

const OPERATORS = new Set(["&&", "||", ";", "|", "&", "(", ")", "<", ">", ">>", "<<", "\n"]);
const OPERATOR_CHARS = new Set(["&", "|", ";", "(", ")", "<", ">"]);

/**
 * git global options that consume a following value, e.g. `git -C /path push`.
 * `--exec-path` reaches this set alongside `-C`/`-c`: its separate-value form
 * (`git --exec-path /usr/lib/git-core push -f ...`) left the path swallowed as
 * the "subcommand" and the real `push` word past it invisible.
 */
const GIT_GLOBAL_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"]);

/**
 * Shell reserved words that always precede another command rather than being
 * one themselves. Stripped from the front of a segment (possibly several in
 * a row) so `{ git push -f origin claude/x; }` and
 * `if true; then git push -f origin claude/x; fi` are judged as the `git`
 * command they hide, not as `{`/`then`. `{`/`}` reach this set because they
 * are ordinary whitespace-delimited words to this tokenizer -- Bash requires
 * the space around them too, so this does not misparse a literal filename.
 */
const SHELL_KEYWORDS = new Set([
  "{", "}", "if", "then", "elif", "else", "fi",
  "do", "done", "while", "until", "for", "select",
  "case", "esac", "in", "function", "!", "coproc",
]);

/**
 * Interpreters whose `-c STRING` argument is itself a full command line Bash
 * will execute -- `bash -c 'git push -f origin claude/x'` runs the push just
 * as directly as typing it at this hook's own prompt would. Unlike the
 * variable-expansion class in the KNOWN LIMITS above, the dangerous command
 * here is not hidden behind runtime state -- it is sitting in the payload as
 * a literal string, one token away. Recursing into it is the same kind of
 * bounded, syntactic work as reading a heredoc body, not an attempt to
 * reimplement Bash.
 */
const SHELL_INTERPRETERS = new Set(["bash", "sh", "zsh", "dash", "ksh"]);
const MAX_NESTED_SHELL_DEPTH = 4;

/**
 * Commands that execute their trailing argv unchanged -- Bash resolves them
 * before choosing what "the command" is, so `env git push -f ...` runs `git`,
 * not `env`.
 */
const TRANSPARENT_WRAPPERS = new Set([
  "command", "env", "exec", "sudo", "nice", "nohup", "stdbuf", "ionice", "time",
  // `timeout --help`: `timeout [OPTION] DURATION COMMAND [ARG]...`. It starts
  // COMMAND, so it is as transparent as `nice`. It was missing, and
  // `timeout 30 curl <url>` is the ONE shape in round 6 I might plausibly have
  // typed by accident -- it is the natural spelling of a CI wait. (Codex, #488.)
  "timeout",
]);

/**
 * Positional arguments a wrapper consumes before the command it runs.
 *
 * `timeout` is the only one so far: its DURATION is not flag-shaped, so
 * without this the resolver reads `30` as the program name.
 */
const WRAPPER_POSITIONALS = { timeout: 1 };

/** A leading `NAME=value` word is an environment assignment, not a program. */
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Per-wrapper flags known to take NO value -- safe to skip past while still
 * looking for the real command, unlike a value-taking flag (`env -u NAME`)
 * whose following word is the flag's argument, not the next thing to judge.
 * Sourced from each wrapper's own `--help`: `env --help` lists `-i`/`-0`/
 * `--ignore-environment`/`--null` as bare; `command -p`/`-v`/`-V` per POSIX
 * `command`; the rest are conservatively left unlisted (empty set) rather
 * than guessed at.
 */
const WRAPPER_BARE_FLAGS = {
  env: new Set(["-i", "-0", "--ignore-environment", "--null"]),
  // `-v`/`-V` are NOT here: `help command` documents them as printing a
  // description rather than running anything, so `command -v curl` is a query
  // and must not be judged as an invocation. See QUERY_ONLY_FLAGS.
  command: new Set(["-p"]),
  // `help exec` documents `exec [-cl] [-a name] [command [argument ...]]`.
  exec: new Set(["-c", "-l", "-cl", "-lc"]),
  // `help time` documents `time [-p] pipeline` and says it EXECUTES the
  // pipeline. Without this, `time -p curl <url>` stopped resolution at `time`
  // -- a plausible diagnostic command, not an obscure spelling, and one the
  // deleted sweep had been masking. (Codex, #488 round 8.)
  time: new Set(["-p"]),
};

/**
 * Per-wrapper flags known to take exactly ONE following value -- safe to
 * skip past (both the flag and its value) while still looking for the real
 * command. `env --help` lists `-u, --unset=NAME` and `-C, --chdir=DIR` as
 * separate-value forms alongside their `=value` combined forms; the combined
 * form needs no special handling here since it is already one token.
 */
const WRAPPER_VALUE_FLAGS = {
  env: new Set(["-u", "--unset", "-C", "--chdir", "-S", "--split-string"]),
  // `exec -a name command` substitutes argv0 and then runs `command`.
  exec: new Set(["-a"]),
  // `sudo --help` documents these as taking a value. Without them the
  // fail-closed sweep read `sudo -p curl true`'s prompt STRING as a program
  // and refused a command that runs `true`. (Codex, #488 round 6.)
  sudo: new Set([
    "-p", "--prompt", "-u", "--user", "-g", "--group", "-C", "--close-from",
    "-h", "--host", "-r", "--role", "-t", "--type", "-U", "--other-user",
  ]),
  timeout: new Set(["-s", "--signal", "-k", "--kill-after"]),
};

/**
 * Wrapper flags that make the wrapper REPORT on a command instead of running
 * it. `help command` documents `-v`/`-V` as printing a description, and a
 * `command -v curl` run prints `/usr/bin/curl` without executing it -- so
 * promoting `curl` to `program` and refusing was a false block introduced by
 * the blanket rule. (Codex, #488 round 6.)
 */
const QUERY_ONLY_FLAGS = { command: new Set(["-v", "-V"]) };

/**
 * Peel off constructs Bash resolves before dispatching to a program: leading
 * `NAME=value` environment assignments, and a transparent wrapper in front
 * of the real command, skipping past any of that wrapper's KNOWN bare
 * (non-value-taking) flags -- `env -i git push -f ...` and
 * `command -p git push -f ...` still run `git` -- and any KNOWN value-taking
 * flag together with its value -- `env -u GIT_CONFIG git push -f ...` skips
 * both `-u` and `GIT_CONFIG` as a pair, not just the flag, since Bash still
 * resolves `git` as the command regardless of how many recognised flags (bare
 * or value-taking) sit between the wrapper and it.
 *
 * Deliberately narrow: an UNRECOGNISED flag still stops the unwrap rather
 * than guessing past it -- misreading a flag's value as the real command
 * would be worse than not unwrapping at all.
 */
function resolveRealCommand(argv) {
  let i = 0;
  while (i < argv.length) {
    if (ENV_ASSIGNMENT.test(argv[i])) {
      i += 1;
      continue;
    }
    const bare = argv[i].split("/").pop();
    if (TRANSPARENT_WRAPPERS.has(bare)) {
      const bareFlags = WRAPPER_BARE_FLAGS[bare] ?? new Set();
      const valueFlags = WRAPPER_VALUE_FLAGS[bare] ?? new Set();
      const queryFlags = QUERY_ONLY_FLAGS[bare] ?? new Set();
      let next = i + 1;
      let isQuery = false;
      while (next < argv.length) {
        // A query mode names a command without running it, so the wrapper IS
        // the command. It only counts among the wrapper's OWN leading options:
        // in `command curl -v <url>` the `-v` belongs to curl, and searching
        // the whole argv for it exempted a real invocation. (Codex, #488 r7.)
        if (queryFlags.has(argv[next])) {
          isQuery = true;
          break;
        }
        if (bareFlags.has(argv[next])) {
          next += 1;
          continue;
        }
        if (valueFlags.has(argv[next])) {
          next += 2;
          continue;
        }
        break;
      }
      if (isQuery) break;
      if (argv[next] === "--") next += 1;
      // Skip the wrapper's own positional arguments (timeout's DURATION).
      next += WRAPPER_POSITIONALS[bare] ?? 0;
      if (next < argv.length && !argv[next].startsWith("-")) {
        i = next;
        continue;
      }
      break; // an unrecognised flag: give up, judge the wrapper itself
    }
    break;
  }
  return argv.slice(i);
}

/**
 * Long options this guard cares about, canonical spelling. Git resolves an
 * unambiguous prefix of a long option to the option itself -- `git push --m
 * origin` runs as `--mirror` -- so a flag that exact-matches none of these
 * strings can still BE one of them. Expanding a prefix to its canonical form
 * before classification is what lets the rest of this module keep comparing
 * against exact strings, rather than growing a second, parallel prefix-aware
 * check at every comparison site.
 */
const KNOWN_PUSH_LONG_OPTIONS = [
  "--force-with-lease", // before --force: must not be swallowed as an
  "--force-if-includes", // abbreviation of the plain flag.
  "--force",
  "--mirror",
  "--all",
  "--delete",
  "--prune",
  "--tags",
  "--quiet",
  "--verbose",
  "--set-upstream",
];

/**
 * Expand `flag` to its canonical spelling if it is an UNAMBIGUOUS prefix of
 * exactly one option in `KNOWN_PUSH_LONG_OPTIONS`.
 *
 * An abbreviation ambiguous within this known set (`--f`, `--fo`) is left
 * unexpanded rather than guessed at -- verified directly that real git also
 * treats these as ambiguous and refuses to run at all
 * (`error: ambiguous option: f (could be --force-if-includes or
 * --follow-tags)`), so no actual push happens in that case either. An
 * abbreviation that resolves uniquely HERE but is ambiguous against git's
 * full option set (one this guard does not track) would cause this hook to
 * classify a command that git itself would also refuse -- over-blocking,
 * the direction this module already errs toward.
 */
function expandAbbreviatedLongOption(flag) {
  if (!flag.startsWith("--") || flag.length < 3) return flag;
  const eq = flag.indexOf("=");
  const name = eq === -1 ? flag : flag.slice(0, eq);
  const suffix = eq === -1 ? "" : flag.slice(eq);
  if (KNOWN_PUSH_LONG_OPTIONS.includes(name)) return flag;
  const matches = KNOWN_PUSH_LONG_OPTIONS.filter((opt) => opt.startsWith(name));
  return matches.length === 1 ? matches[0] + suffix : flag;
}

/**
 * Resolve `..`/`.`/empty path segments the way the filesystem would, without
 * touching the disk. `/tmp/../*` LOOKS scoped by its first segment ("tmp"),
 * but `..` climbs back out of it -- verified directly that Bash expands
 * `/tmp/../*` to root's own children (`/bin`, `/etc`, ...), making it exactly
 * as dangerous as `/*` despite the "tmp" text sitting right there in the
 * token. Popping `..` against an already-empty stack is a no-op, matching
 * how `/../etc` resolves to `/etc` -- you cannot climb above root.
 */
function normalizeAbsolutePathSegments(token) {
  const stack = [];
  for (const part of token.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      stack.pop();
      continue;
    }
    stack.push(part);
  }
  return stack;
}

/**
 * True for an `rm` target that, once `..`/`.` are resolved, has a FIRST path
 * component composed entirely of glob syntax with no literal name in it --
 * `/`, `/*`, `/**`, `//`, `/.*`, `/[be]*`, `/tmp/../*`. Such a target can
 * match many or all top-level entries, which is the shape this guard treats
 * as root-equivalent. A scoped absolute path (`/tmp/x`, `/tmp/*`) has a real
 * literal first component after normalization and is left alone, matching
 * this guard's narrowing philosophy: block the catastrophic case, not every
 * absolute path (the pre-narrowing guard's un-anchored regex matched the
 * latter too, which was almost certainly incidental breadth, not an
 * intentional policy -- it would have caught routine scratch cleanup like
 * `rm -rf /tmp/x`).
 *
 * A bracket expression (`[be]`) is stripped as ONE unit, not character by
 * character: `[be]` is a character CLASS matching a single `b` or `e`, not
 * the literal two-character string "be" -- verified directly that
 * `/[be]*` expands to `/bin`, `/boot`, `/etc`, ... on this environment,
 * exactly the breadth a per-character strip would miss. `.` is treated as
 * glob syntax too (a leading dot is Bash's hidden-file matcher), which is
 * why a literal dotted name like `/.git` still reads as safe: stripping the
 * leading dot from ".git" still leaves "git", a real component.
 */
function isRootShaped(token) {
  if (!token.startsWith("/")) return false;
  const segments = normalizeAbsolutePathSegments(token);
  if (segments.length === 0) return true; // resolves to root itself
  const stripped = segments[0].replace(/\[[^\]]*\]/g, "").replace(/[*?.]/g, "");
  return stripped === "";
}

const isBundledShortDelete = (flag) => /^-[A-Za-z]*d[A-Za-z]*$/.test(flag);

/**
 * True when the push's own arguments (i.e. everything after `push`) name or
 * imply deletion: an explicit `--delete`/`-d` (bundled with other short
 * flags or alone -- `git push -qd origin claude/x` bundles quiet with
 * delete, and Git accepts that), or a refspec with an empty `<src>`
 * (`:claude/x`), which Git's own refspec rules define as deleting the
 * remote `<dst>`. Checked independently of `forcing` below so a deletion is
 * refused even without an accompanying force flag -- the concern this
 * closes is specifically a delete-shaped push slipping past because it does
 * not use the word "force" at all.
 */
function looksLikeDeletion(pushArgs) {
  if (pushArgs.some((t) => t === "--delete" || isBundledShortDelete(t))) return true;
  const positionals = pushArgs.filter((t) => !t.startsWith("-"));
  const refspecs = positionals.slice(1); // positionals[0] is the remote
  return refspecs.some((r) => r.startsWith(":"));
}

const ANSI_C_SIMPLE_ESCAPES = {
  n: "\n", t: "\t", r: "\r", "\\": "\\", "'": "'", '"': '"',
  a: "\x07", b: "\b", f: "\f", v: "\v", e: "\x1b", E: "\x1b", "?": "?",
};

/**
 * Decode the body of a `$'...'` ANSI-C-quoted string starting at `source[i]`
 * (just past the opening quote), per the Bash manual's full escape set:
 * the single-character escapes, `\nnn` (1-3 octal digits), `\xHH` (1-2 hex
 * digits), `\uHHHH`/`\UHHHHHHHH` (1-4 / 1-8 hex digits, as a Unicode code
 * point), and `\cX` (control character). An escape this function does not
 * recognise is left as its literal character, same as Bash's own fallback.
 * Returns { value, next } where `next` is the index just past the closing
 * quote.
 */
function readAnsiCQuoted(source, i) {
  let value = "";
  while (i < source.length && source[i] !== "'") {
    if (source[i] !== "\\" || i + 1 >= source.length) {
      value += source[i];
      i += 1;
      continue;
    }
    const esc = source[i + 1];
    if (esc in ANSI_C_SIMPLE_ESCAPES) {
      value += ANSI_C_SIMPLE_ESCAPES[esc];
      i += 2;
      continue;
    }
    if (esc === "x") {
      const hex = source.slice(i + 2, i + 4).match(/^[0-9A-Fa-f]{1,2}/);
      if (hex) {
        value += String.fromCharCode(parseInt(hex[0], 16));
        i += 2 + hex[0].length;
        continue;
      }
    }
    if (esc >= "0" && esc <= "7") {
      const octal = source.slice(i + 1, i + 4).match(/^[0-7]{1,3}/);
      value += String.fromCharCode(parseInt(octal[0], 8) & 0xff);
      i += 1 + octal[0].length;
      continue;
    }
    if (esc === "u" || esc === "U") {
      const width = esc === "u" ? 4 : 8;
      const hex = source.slice(i + 2, i + 2 + width).match(/^[0-9A-Fa-f]{1,}/);
      if (hex) {
        value += String.fromCodePoint(parseInt(hex[0], 16));
        i += 2 + hex[0].length;
        continue;
      }
    }
    if (esc === "c" && i + 2 < source.length) {
      // Bash: Control-X is (uppercased X) XOR 0x40.
      value += String.fromCharCode(source[i + 2].toUpperCase().charCodeAt(0) ^ 0x40);
      i += 3;
      continue;
    }
    // An unrecognised escape keeps its backslash, matching Bash directly
    // (verified: `printf '%s' $'\q'` prints the two characters `\q`).
    value += "\\" + esc;
    i += 2;
  }
  if (source[i] !== "'") throw new Error("unbalanced $'...' quote");
  return { value, next: i + 1 };
}

/**
 * Expand simple (non-nested, no `{1..5}` ranges) brace expansion:
 * `pre{a,b,c}post` becomes the three tokens `preapost`, `prebpost`,
 * `precpost`. Bash performs this before word-splitting, so `-{f,u}` is TWO
 * arguments to the command, `-f` and `-u`, not one token containing a
 * literal brace -- verified directly. `{a}` alone (no comma) is not
 * expansion in Bash and is left as literal text.
 *
 * Applied uniformly to every token regardless of whether it came from a
 * quoted string, which is a deliberate simplification: real Bash does not
 * expand a QUOTED brace, but this tokenizer does not track per-character
 * quoting once a token is assembled. Over-expanding a token that was
 * actually a quoted literal is the safe direction this module already
 * documents erring toward.
 */
function expandBraces(token) {
  const match = /^([^{}]*)\{([^{}]*)\}([^{}]*)$/.exec(token);
  if (!match || !match[2].includes(",")) return [token];
  const [, prefix, body, suffix] = match;
  return body.split(",").map((alt) => prefix + alt + suffix);
}

/**
 * Split a command line into shell tokens, emitting operators as their own
 * tokens so compound commands can be evaluated segment by segment.
 *
 * Throws on unbalanced quotes -- the caller treats that as "cannot understand,
 * therefore deny if it looks destructive at all".
 */
export function tokenize(input) {
  // Backticks become a command separator, not whitespace. As whitespace they
  // left `echo `git push -f ...`` as a single segment whose argv[0] is `echo`,
  // so the git check never fired. As a separator the substitution becomes its
  // own segment and is judged on its own. (`$(` needs no such help: `(` is
  // already an operator character below.)
  const source = input.replace(/`/g, " ; ");
  const tokens = [];
  let current = "";
  let hadQuotes = false;
  let i = 0;

  const flush = () => {
    if (current !== "" || hadQuotes) {
      tokens.push(current);
      current = "";
      hadQuotes = false;
    }
  };

  while (i < source.length) {
    const c = source[i];

    if (c === "\\" && source[i + 1] === "\n") {
      // Unquoted backslash-newline is a LINE CONTINUATION: Bash removes both
      // characters entirely and joins the pieces with nothing between them,
      // so `git push -\<newline>f origin main` runs as `git push -f origin
      // main` -- as one token, "-f", not two. Appending the newline (the old
      // behaviour) instead produced "-\nf", which missed the bundled-force
      // check below.
      i += 2;
      continue;
    }

    if (c === "\\") {
      if (i + 1 < source.length) current += source[i + 1];
      i += 2;
      continue;
    }

    if (c === "$" && source[i + 1] === "'") {
      // ANSI-C quoting: $'git' evaluates to the string "git" (with backslash
      // escapes processed), so `$'git' push -f origin claude/x` executes
      // exactly like `git push -f origin claude/x`. Left unhandled, the `$`
      // stays glued to the token as literal text ("$git"), which is not
      // recognised as the git program at all. Decoding covers the Bash
      // manual's full ANSI-C escape set, not just the single-character
      // forms -- $'\x67\x69\x74' is "git" too.
      const result = readAnsiCQuoted(source, i + 2);
      i = result.next;
      current += result.value;
      hadQuotes = true;
      continue;
    }

    if (c === "'") {
      const end = source.indexOf("'", i + 1);
      if (end === -1) throw new Error("unbalanced single quote");
      current += source.slice(i + 1, end);
      hadQuotes = true;
      i = end + 1;
      continue;
    }

    if (c === '"') {
      i += 1;
      let closed = false;
      while (i < source.length) {
        if (source[i] === "\\" && i + 1 < source.length) {
          current += source[i + 1];
          i += 2;
          continue;
        }
        if (source[i] === '"') {
          closed = true;
          i += 1;
          break;
        }
        current += source[i];
        i += 1;
      }
      if (!closed) throw new Error("unbalanced double quote");
      hadQuotes = true;
      continue;
    }

    if (c === "\n") {
      flush();
      tokens.push("\n");
      i += 1;
      continue;
    }

    if (/\s/.test(c)) {
      flush();
      i += 1;
      continue;
    }

    if (OPERATOR_CHARS.has(c)) {
      flush();
      const two = source.slice(i, i + 2);
      if (two === "&&" || two === "||" || two === ">>" || two === "<<") {
        tokens.push(two);
        i += 2;
      } else {
        tokens.push(c);
        i += 1;
      }
      continue;
    }

    current += c;
    i += 1;
  }

  flush();
  return tokens.flatMap(expandBraces);
}

/** Group tokens into individual commands, splitting on shell operators. */
export function segments(tokens) {
  const out = [];
  let current = [];
  for (const token of tokens) {
    if (OPERATORS.has(token)) {
      if (current.length) out.push(current);
      current = [];
    } else {
      current.push(token);
    }
  }
  if (current.length) out.push(current);
  return out;
}

/**
 * Where an inline alias's expansion actually leads. Git's alias docs specify
 * two shapes: a `!`-prefixed value is a literal SHELL command (run via the
 * shell, not interpreted as more git arguments at all), while anything else
 * is prepended to the command line as if the user had typed it after `git ` --
 * meaning it can itself start with further git OPTIONS (`-c core.pager=cat
 * push --force`) before the real subcommand word appears. Checking only
 * whether the raw value starts with the literal text "push" misses both: an
 * option-prefixed expansion, and a `!` escape that reaches `push` (or
 * anything else) via an arbitrary shell command this function cannot
 * interpret without recursing into it as a script.
 *
 * Returns { shell } for a `!`-prefixed value (with `!` stripped), or
 * { tokens, index } pointing at the effective subcommand word within the
 * tokenized expansion, or { tokens: null } if the expansion could not be
 * tokenized at all.
 */
function resolveAliasTarget(rawValue) {
  const trimmed = rawValue.trim();
  if (trimmed.startsWith("!")) return { shell: trimmed.slice(1) };

  let tokens;
  try {
    tokens = tokenize(trimmed);
  } catch {
    return { tokens: null };
  }

  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];
    if (GIT_GLOBAL_WITH_VALUE.has(token)) {
      i += 2;
      continue;
    }
    if (token.startsWith("-")) {
      i += 1;
      continue;
    }
    return { tokens, index: i };
  }
  return { tokens, index: -1 };
}

/**
 * Locate the subcommand in `git [global opts] <subcommand>`, expanding an
 * inline alias (`-c alias.<name>=<expansion>`) invoked in the same command.
 *
 * Returns { name, index, argv }, where `name` can be the sentinel
 * `"SHELL_ESCAPE"` alongside a `shellText` field -- `checkCommand` recurses
 * into that text through the same nested-shell machinery as `bash -c`,
 * since a `!`-prefixed alias runs exactly like one.
 *
 * For a non-`!` alias, `argv` is normally the input unchanged, but an alias
 * whose EFFECTIVE subcommand (after skipping any leading git options inside
 * the expansion itself) is "push" returns a NEW argv with the alias token
 * spliced out and the full tokenized expansion spliced in -- `index` then
 * points at "push" within that new array. Splicing the whole expansion, not
 * just its subcommand word, matters: `git -c alias.p='push --force' p
 * origin claude/x` carries the force flag inside the alias value itself,
 * not just a renamed subcommand, so dropping everything after the
 * subcommand word would silently discard the part that makes the push
 * dangerous.
 *
 * `index` alone (without a new argv) is what lets a caller parse the
 * subcommand's own arguments without the global options bleeding in -- that
 * distinction is load-bearing: treating the value of `-C /repo` as a
 * positional made `git -C /repo push --force-with-lease origin claude/x`
 * parse as having two refspecs, and a permitted push was rejected.
 *
 * Only tracks aliases defined via `-c` on the SAME invocation, since that is
 * the reproducible shape. A pre-existing alias in `.gitconfig` is a
 * materially different problem this hook has no way to see: arbitrary prior
 * repo or global state, not something visible in the command text at all.
 */
function gitSubcommand(argv) {
  let i = 1;
  const aliases = new Map(); // name -> raw expansion text
  while (i < argv.length) {
    const token = argv[i];
    if (token === "-c" && typeof argv[i + 1] === "string") {
      const match = /^alias\.([^=\s]+)=(.*)$/.exec(argv[i + 1]);
      if (match) aliases.set(match[1], match[2]);
      i += 2;
      continue;
    }
    if (GIT_GLOBAL_WITH_VALUE.has(token)) {
      i += 2;
      continue;
    }
    if (token.startsWith("-")) {
      i += 1;
      continue;
    }
    if (aliases.has(token)) {
      const target = resolveAliasTarget(aliases.get(token));
      if (target.shell !== undefined) {
        return { name: "SHELL_ESCAPE", index: i, argv, shellText: target.shell };
      }
      if (target.tokens === null) {
        return { name: "push", index: i, argv }; // unparseable expansion: still flag it as push
      }
      if (target.index !== -1 && target.tokens[target.index] === "push") {
        const spliced = [...argv.slice(0, i), ...target.tokens, ...argv.slice(i + 1)];
        return { name: "push", index: i + target.index, argv: spliced };
      }
      return { name: target.index === -1 ? null : target.tokens[target.index], index: i, argv };
    }
    return { name: token, index: i, argv };
  }
  return { name: null, index: -1, argv };
}

const isBundledShortForce = (flag) => /^-[A-Za-z]*f[A-Za-z]*$/.test(flag);
const isLease = (flag) => flag === LEASE || flag.startsWith(`${LEASE}=`);

/**
 * True only for a force push we are willing to permit.
 *
 * An implicit refspec (`git push --force-with-lease` with no target) is
 * deliberately refused: the destination would depend on the current branch's
 * upstream, which this hook cannot see. Naming the branch is the price of
 * forcing at all, and it is a good habit independently.
 */
export function pushIsSafe(argv, pushIndex) {
  const args = argv.slice(pushIndex + 1);
  const flags = args.filter((t) => t.startsWith("-"));
  const positionals = args.filter((t) => !t.startsWith("-"));

  if (!flags.some(isLease)) return false;

  for (const flag of flags) {
    if (isLease(flag)) continue;
    if (BENIGN_PUSH_OPTS.has(flag)) continue;
    if (BARE_FORCE.has(flag)) return false;
    if (WIDE_PUSH_OPTS.has(flag)) return false;
    if (isBundledShortForce(flag)) return false;
    // An option we have not classified. Enumerating "safe" options is how
    // allowlists rot, so an unknown one on a force push is a deny.
    return false;
  }

  // positionals[0] is the remote, the rest are refspecs.
  const refspecs = positionals.slice(1);
  if (refspecs.length !== 1) return false;

  const refspec = refspecs[0];
  if (refspec.startsWith("+")) return false; // forcing via refspec rather than a flag

  const colon = refspec.indexOf(":");
  if (colon === -1) return OWNED_BRANCH.test(refspec);

  const source = refspec.slice(0, colon);
  const destination = refspec.slice(colon + 1);
  // An empty <src> is Git's own syntax for deleting the remote <dst> -- not
  // an update, so it is never a shape a "leased update" allowance covers.
  if (source === "") return false;
  return OWNED_BRANCH.test(destination);
}

/**
 * True when BOTH a recursive flag and a force flag appear somewhere in
 * `args` -- across separate tokens, bundled into one token, in any letter
 * case, or spelled out long. `rm --help` documents `-r`/`-R`/`--recursive`
 * as equivalent and `-f`/`--force` as force; a prior version's bundled-flag
 * check compared case-SENSITIVELY, so `-Rf` and `-fR` (the capital-R
 * spellings `rm --help` itself lists first) slipped through entirely, and
 * `--recursive --force` as two separate long tokens was never checked at
 * all.
 */
function isRecursiveAndForced(args) {
  const isRecursiveFlag = (a) => a === "--recursive" || (/^-[A-Za-z]+$/.test(a) && /r/i.test(a));
  const isForceFlag = (a) => a === "--force" || (/^-[A-Za-z]+$/.test(a) && /f/i.test(a));
  return args.some(isRecursiveFlag) && args.some(isForceFlag);
}

/** True for any token naming (a versioned spec of) the drizzle-kit binary. */
/**
 * HTTP clients whose ARGUMENTS are URLs, so a host check over tokens is
 * meaningful. Deliberately not `node`/`python`: their URLs live inside a
 * script string, which is payload text, and judging payload text is the exact
 * defect this module was built to remove (a commit message may legitimately
 * mention a blocked URL). `node scripts/loop-metrics.mjs --pr N` is therefore
 * untouched -- correctly, since that script's own Node `fetch` reaches the
 * real API and fails loudly with 401 "Bad credentials" rather than silently.
 */
const HTTP_FETCHERS = new Set(["curl", "wget"]);

/**
 * Why this is a blanket refusal rather than a parser (David, 2026-08-17).
 *
 * The first four revisions tried to decide whether a given curl/wget
 * invocation *would actually connect to* api.github.com, so that unrelated
 * fetches stayed available. Codex found real defects in that judgement in four
 * consecutive rounds -- 3, 1, 3, then 7 -- and round 4's new findings were in
 * five different sub-languages of these tools: wgetrc directives via
 * `-e base=...`, composite `--connect-to HOST1:P1:HOST2:P2` values, brace URL
 * globbing, unique-prefix long-option abbreviation, and `--variable` /
 * `--expand-url` interpolation. Behind those sat `-K` config files, `.netrc`,
 * environment proxies, and whatever the next round would have found.
 *
 * That is not a converging series. Deciding it correctly means reimplementing
 * two very large command-line parsers, and the reviewer can RUN them while this
 * module can only reason about them -- which is how the same class of mistake
 * appeared four rounds running, twice as a conclusion I had written down as
 * checked and Codex refuted by execution.
 *
 * WHY THERE IS NO LONGER AN EXCEPTION EITHER. The first version of this rule
 * kept one: the agent proxy's own `__agentproxy/status` diagnostic, on the
 * reasoning that it is not a GitHub route and is the only ad-hoc fetch this
 * container has ever needed. Round 5 produced three findings against that
 * single exception in one pass -- the fragment matched on ANY origin, so
 * `curl https://api.github.com/__agentproxy/status` was allowed; an attached
 * `-K/tmp/api.conf` smuggled a config file past the flag filter; and a
 * `.curlrc` reached via `$CURL_HOME` adds transfers that never appear in argv
 * at all. The last of those cannot be fixed by inspecting arguments, because
 * the extra request is not IN the arguments.
 *
 * The lesson was the same one level down: an exception is a thing to attack,
 * and this one had exactly the same unbounded surface as the parser did. So
 * there is no exception. Refusing every curl and wget is the whole rule, and it
 * is the only version of it that is complete by construction.
 *
 * The cost is genuinely small. This hook inspects the command line typed at it,
 * not the contents of a script, so `bash scripts/phase5-og-smoke.sh` and CI's
 * own readiness loop are untouched -- they were the only real uses in the repo.
 * What is lost is the ad-hoc one-off fetch, including the proxy probe, and
 * losing it fails LOUDLY with the message below, which is the opposite of the
 * silent failure this rule exists to prevent.
 */
const FETCHER_REFUSAL =
  "curl and wget are refused in this container. The reason the rule exists is api.github.com, " +
  "which is intercepted by the agent proxy and returns HTTP 403 \"GitHub access is not enabled for " +
  "this session\" -- a failure that is SILENT inside a pipeline, because a `grep` over the 403 body " +
  "finds nothing and reads as \"no results\" rather than as an error. Every CI-wait loop built that " +
  "way on 2026-08-16 was a pure sleep. This refuses the whole program, with no exception for any " +
  "argument shape: four review rounds showed which invocations reach that host cannot be judged " +
  "without reimplementing curl's and wget's own argument parsing, and a fifth showed the same of the " +
  "one allowlisted probe. " +
  "Use mcp__github__* for GitHub state -- pull_request_read (get_check_runs) for CI, get_reviews for " +
  "a review landing, get for merge state, issue_read for labels -- and WebFetch for web content. " +
  "A script that runs curl internally is unaffected. If an ad-hoc fetch is genuinely needed, " +
  "including the agent proxy's own status probe, ask David rather than routing around this. " +
  "See .agents/memory/github-rest-api-blocked-from-bash.md.";

/**
 * True when this argv runs a fetcher.
 *
 * DELIBERATELY JUST THE RESOLVED PROGRAM. Round 5 added a fail-closed sweep
 * here -- when unwrapping stopped on a transparent wrapper, any fetcher token
 * anywhere in the argv refused -- to catch `exec -a fetch /usr/bin/curl <url>`
 * without naming `-a`. It was removed in round 7, for two reasons:
 *
 *  1. It closed nothing the wrapper tables do not. `exec -a` is a known value
 *     flag now, so that command resolves to `curl` and refuses on this line.
 *  2. It cost three false blocks in two rounds -- `sudo -p curl true`,
 *     `sudo -l curl`, `sudo -n printf '%s\n' curl` -- because sweeping every
 *     token necessarily reads option values and data arguments as programs.
 *     Each was patched by adding one more sudo flag to a table, which is the
 *     enumeration this PR has already abandoned twice.
 *
 * What that gives up, stated plainly: `<wrapper> <flag-not-in-our-tables>
 * curl <url>` is allowed. That needs an unlisted wrapper flag AND a fetcher in
 * one command, which is not a shape anyone types by accident -- and there is
 * no adversary in this container, only me. Accepted, and recorded here rather
 * than left implicit.
 *
 * THREE MORE ACCEPTED GAPS, all found in round 7 and all in the same class --
 * a spelling that reaches a fetcher without the resolver seeing it. Each is
 * real; none is a shape typed by accident, and every attempt to close one in
 * this layer has introduced a new defect elsewhere (round 7 returned SEVEN
 * findings, SIX of them defects in the two preceding commits):
 *
 *  - `timeout --foreground 5 curl <url>` -- an unlisted bare option stops
 *    option parsing, and the DURATION offset is then applied to the wrong
 *    position.
 *  - `env -S 'curl <url>' extra` -- trailing arguments make the generic env
 *    unwrapping promote `extra` before the split-string dispatch is consulted.
 *  - `/usr/bin/cu?l --version` -- Bash expands the glob before command lookup;
 *    this module compares the unexpanded word.
 *
 * The rule this file follows now: the fetcher refusal is judged from the
 * RESOLVED PROGRAM and nothing else. Making the resolver perfect is a third
 * enumeration, after curl's option grammar and the probe allowlist, and the
 * first two each ended in deletion.
 */
function reachesFetcher(program) {
  return HTTP_FETCHERS.has(program);
}

function isDrizzleKitToken(token) {
  const base = token.split("/").pop();
  return base === "drizzle-kit" || base.startsWith("drizzle-kit@") || base.includes("drizzle-kit");
}

const isShortFlagBundleContaining = (letter) => (t) => /^-[A-Za-z]+$/.test(t) && t.includes(letter);

/**
 * Find the text a program will hand off to be executed as a full command
 * line, if `program`/`rest` shows one of the recognised dispatch shapes:
 *
 * - A shell interpreter (`bash`/`sh`/`zsh`/`dash`/`ksh`) with a `-c` flag --
 *   possibly BUNDLED with other short options (`-lc`, `-ec`), which the
 *   previous exact `indexOf("-c")` lookup missed. Bash resolves the bundle
 *   the same way regardless of what else rides along in it.
 * - `eval`, which the Bash manual describes as concatenating ALL of its
 *   arguments with spaces and executing the result as one command -- so
 *   `eval git push -f origin claude/x` (unquoted, four separate argv
 *   entries) and `eval 'git push -f origin claude/x'` (one quoted string)
 *   are the same dispatch, closed by the same `rest.join(" ")`.
 * - `npx -c '<cmd>'` / `npm exec -c '<cmd>'`, which `npm exec --help`
 *   documents as running `<cmd>` as a shell command line, the same
 *   contract as a shell's own `-c`.
 *
 * Returns null when `program`/`rest` shows none of these shapes.
 */
function findCommandStringDispatch(program, rest) {
  if (SHELL_INTERPRETERS.has(program)) {
    const cIndex = rest.findIndex(isShortFlagBundleContaining("c"));
    return cIndex !== -1 && typeof rest[cIndex + 1] === "string" ? rest[cIndex + 1] : null;
  }
  if (program === "eval") {
    return rest.length ? rest.join(" ") : null;
  }
  if (program === "npx" || (program === "npm" && rest[0] === "exec")) {
    // `npm exec --help` lists `[-c|--call <call>]`; only `-c` was recognised,
    // so `npx --call 'curl ...'` dispatched unseen. (Codex, #488 round 6.)
    const cIndex = rest.findIndex((t) => t === "-c" || t === "--call");
    if (cIndex !== -1 && typeof rest[cIndex + 1] === "string") return rest[cIndex + 1];
    const attached = rest.find((t) => t.startsWith("--call="));
    return attached ? attached.slice("--call=".length) : null;
  }
  // `env --help`: `-S, --split-string=S` "process and split S into separate
  // arguments". Its value is a command line, not inert option data, so it is
  // re-entered like any other command string. (Codex, #488 round 6.)
  if (program === "env") {
    const sIndex = rest.findIndex((t) => t === "-S" || t === "--split-string");
    if (sIndex !== -1 && typeof rest[sIndex + 1] === "string") return rest[sIndex + 1];
    const attached = rest.find((t) => t.startsWith("--split-string=") || /^-S./.test(t));
    if (attached) return attached.startsWith("--") ? attached.slice("--split-string=".length) : attached.slice(2);
  }
  return null;
}

/**
 * Judge a `git push`-shaped argv (subcommand already located at
 * `subcommandIndex` within `gitArgv`) and return a denial reason, or null.
 * Shared by the normal `git push ...` dispatch and the direct
 * `git-push`/`git-update-ref` executable dispatch below, which present
 * identically once the subcommand word itself is accounted for.
 */
function checkGitPush(gitArgv, subcommandIndex) {
  // Abbreviations are expanded to canonical spellings before anything
  // downstream compares against exact strings -- `--m` reads as `--mirror`
  // from here on, `--force-with` as `--force-with-lease`.
  const pushArgs = gitArgv
    .slice(subcommandIndex + 1)
    .map((t) => (t.startsWith("-") ? expandAbbreviatedLongOption(t) : t));
  const pushArgv = [...gitArgv.slice(0, subcommandIndex + 1), ...pushArgs];

  const forcing =
    pushArgs.some((t) => t.startsWith("-") && (BARE_FORCE.has(t) || isLease(t) || isBundledShortForce(t))) ||
    pushArgs.some((t) => !t.startsWith("-") && t.startsWith("+"));
  const deleting = looksLikeDeletion(pushArgs);

  if ((forcing || deleting) && !pushIsSafe(pushArgv, subcommandIndex)) {
    return [
      "force push or remote branch deletion outside the permitted shape.",
      "Only `git push --force-with-lease <remote> <claude/...|plan-review/...>`",
      "is allowed: main belongs to GitHub's ruleset, and the lease is mandatory",
      "so a push can never discard work this session has not seen.",
    ].join(" ");
  }
  return null;
}

/**
 * Return a denial reason for one command, or null to allow it.
 *
 * `depth` counts nested shell invocations already unwrapped (see
 * `evaluateScript` below) and is never set by an external caller.
 */
export function checkCommand(argv, depth = 0) {
  if (!argv.length) return null;

  // Shell syntax that precedes the real command ({, if/then/fi, coproc, ...)
  // and transparent wrappers/env-assignments in front of it are both peeled
  // off before anything is judged, so `if true; then git push -f ...; fi`
  // and `env -i git push -f ...` are seen as the git command they actually
  // run.
  let start = 0;
  while (start < argv.length && SHELL_KEYWORDS.has(argv[start])) start += 1;
  const afterKeywords = argv.slice(start);
  if (!afterKeywords.length) return null;

  const resolved = resolveRealCommand(afterKeywords);
  if (!resolved.length) return null;

  const program = resolved[0].split("/").pop();
  const rest = resolved.slice(1);

  const dispatchText = findCommandStringDispatch(program, rest);
  if (dispatchText !== null) {
    // The cap is a safety BOUND, not a permission slip: reaching it with
    // another command string still to inspect means failing closed, not
    // silently falling through to "the outer command isn't git/rm, so
    // allow" -- an uninspected `-c`/`eval` argument is not evidence of
    // safety, only of unexamined text.
    if (depth >= MAX_NESTED_SHELL_DEPTH) {
      return "nested shell/eval command depth limit reached -- refusing rather than allowing an uninspected command string";
    }
    const nested = evaluateScript(dispatchText, depth + 1);
    if (nested) return nested;
  }

  if (reachesFetcher(program)) return FETCHER_REFUSAL;

  if (program === "rm") {
    if (isRecursiveAndForced(rest) && rest.some((a) => !a.startsWith("-") && isRootShaped(a))) {
      return "rm -rf / (or a root-only glob) -- deletes the filesystem root's contents";
    }
  }

  if (resolved.some(isDrizzleKitToken) && resolved.includes("push")) {
    return "drizzle-kit push -- schema changes go through a migration, never a push";
  }

  // `git-push`/`git-update-ref` are the actual executables `git push`/
  // `git update-ref` dispatch to (`$(git --exec-path)/git-push`) and take
  // the identical flags with no leading subcommand word to skip -- so a
  // hardcoded path to one bypasses the `program === "git"` branch below
  // entirely unless handled here directly.
  if (program === "git-push") {
    const reason = checkGitPush(resolved, 0);
    if (reason) return reason;
  }
  if (program === "git-update-ref") {
    return "git update-ref -- moves a ref with no safety net";
  }

  if (program === "git") {
    // gitSubcommand may return a NEW argv with an inline alias's full
    // expansion spliced in -- e.g. `-c alias.p='push --force'` -- so every
    // reference to the git command from here on uses ITS returned argv, not
    // `resolved`.
    const { name: subcommand, index: subcommandIndex, argv: gitArgv, shellText } = gitSubcommand(resolved);

    if (subcommand === "SHELL_ESCAPE") {
      // A `!`-prefixed alias runs as a literal shell command -- Git's own
      // alias docs, not this hook's invention -- so it is judged exactly
      // like a `bash -c` argument, sharing the same depth cap and the same
      // fail-closed behaviour when that cap is reached.
      if (depth >= MAX_NESTED_SHELL_DEPTH) {
        return "nested shell/eval command depth limit reached -- refusing rather than allowing an uninspected command string";
      }
      const nested = evaluateScript(shellText, depth + 1);
      if (nested) return nested;
    }

    if (subcommand === "update-ref") {
      return "git update-ref -- moves a ref with no safety net";
    }

    if (subcommand === "push") {
      const reason = checkGitPush(gitArgv, subcommandIndex);
      if (reason) return reason;
    }
  }

  return null;
}

/** Pull tool_input.command out of the PreToolUse payload. */
export function extractCommand(raw) {
  try {
    const payload = JSON.parse(raw);
    const command = payload?.tool_input?.command;
    if (typeof command === "string") return command;
  } catch {
    // Not JSON, or not the shape we expect. Fall through.
  }
  // Scanning too much text can only cause over-blocking, the safe direction.
  return raw;
}

/**
 * Read the delimiter word of a heredoc opener using Bash's own quoting rules,
 * returning the LITERAL delimiter (what the terminator line must equal, after
 * quote removal) and the index just past the word.
 *
 * This is a scanner rather than a regex because the delimiter is a quoted
 * word, and a regex cannot both find the closing quote and honour escapes
 * inside it. Three revisions of this PR tried: each widened a character class
 * to whatever example had just been produced (`MSG-1`, then `.MSG`/`-MSG`,
 * then `NOTE:1`), and the fourth example broke it again -- `cat <<"A\"B"`,
 * where the escaped quote is not the closing one. Bash's delimiter is
 * `A"B`; a `(['"]?)…\1` shape reads it as `A\` and then hunts for the wrong
 * terminator, deleting real commands that sit between the two. So the word is
 * parsed the way the shell parses it, and there is no character class left to
 * discover.
 *
 * Returns null when the word is absent or its quoting is unterminated -- both
 * mean "not a heredoc opener we can reason about", which leaves the text
 * intact for the rules downstream rather than guessing at a body.
 */
function scanHeredocDelimiter(text, start) {
  let literal = "";
  // Whether a WORD was consumed at all, tracked apart from whether its value
  // is non-empty: `cat <<''` is a valid opener whose delimiter is the empty
  // string (Bash terminates it on the next blank line). Reading "empty value"
  // as "no word" rejected the opener and left an inert body to be judged as
  // commands. (Codex, #488 round 12.)
  let sawWord = false;
  let i = start;
  while (i < text.length) {
    const c = text[i];
    if (c === "\n" || /\s/.test(c) || "<>|&;()".includes(c)) break;

    // `$'...'` is ANSI-C quoting and `$"..."` is locale translation -- both are
    // single quoting FORMS, not a `$` composed with the quote that follows.
    // Treating the `$` as an ordinary character made `<<$'EOF'` scan to
    // `$EOF` while Bash's delimiter is `EOF`, so the terminator search ran
    // past the real one and swallowed the commands in between. (Codex, #488
    // round 12.)
    if (c === "$" && (text[i + 1] === "'" || text[i + 1] === '"')) {
      if (text[i + 1] === "'") {
        const decoded = scanAnsiCQuoted(text, i + 2);
        if (!decoded) return null;
        literal += decoded.value;
        sawWord = true;
        i = decoded.end;
        continue;
      }
      const quoted = scanDoubleQuoted(text, i + 2);
      if (!quoted) return null;
      literal += quoted.value;
      sawWord = true;
      i = quoted.end;
      continue;
    }

    if (c === "'") {
      const close = text.indexOf("'", i + 1);
      if (close === -1) return null;
      const span = text.slice(i + 1, close);
      if (span.includes("\n")) return null;
      literal += span;
      sawWord = true;
      i = close + 1;
      continue;
    }

    if (c === '"') {
      const quoted = scanDoubleQuoted(text, i + 1);
      if (!quoted) return null;
      literal += quoted.value;
      sawWord = true;
      i = quoted.end;
      continue;
    }

    if (c === "\\") {
      const next = text[i + 1];
      if (next === undefined) return null;
      // A backslash-newline is a line continuation: both characters are
      // removed and the word carries on. Ending the scan here treated a
      // legitimately continued delimiter as unreadable. (Codex, #488 round 12.)
      if (next === "\n") {
        sawWord = true;
        i += 2;
        continue;
      }
      literal += next;
      sawWord = true;
      i += 2;
      continue;
    }

    literal += c;
    sawWord = true;
    i += 1;
  }
  if (!sawWord) return null;
  return { literal, end: i };
}

/**
 * Read a double-quoted span, starting just past the opening quote. Returns the
 * quote-removed value and the index past the closing quote, or null if the
 * quoting never closes.
 */
function scanDoubleQuoted(text, start) {
  let value = "";
  let i = start;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') return { value, end: i + 1 };
    if (c === "\\") {
      const next = text[i + 1];
      if (next === undefined) return null;
      // Inside double quotes Bash treats a backslash as an escape before
      // exactly these, plus a newline (a line continuation, removed
      // entirely); anywhere else it is a literal backslash.
      if (next === "\n") {
        i += 2;
        continue;
      }
      if (next === "$" || next === "`" || next === '"' || next === "\\") {
        value += next;
        i += 2;
        continue;
      }
      value += c;
      i += 1;
      continue;
    }
    // A newline inside double quotes is legal in Bash -- the quote simply
    // spans lines -- but a delimiter containing one could never be matched by
    // a single terminator line, so it is not a heredoc this module can read.
    if (c === "\n") return null;
    value += c;
    i += 1;
  }
  return null;
}

/**
 * Read an ANSI-C quoted span (`$'...'`), starting just past the opening quote.
 *
 * Only the escapes whose decoding is unambiguous are handled. Anything else
 * returns null, which means "not a heredoc opener this module can read" and
 * leaves the text intact for the rules downstream -- the over-blocking
 * direction, never the fail-open one.
 */
const ANSI_C_SIMPLE = { n: "\n", t: "\t", r: "\r", a: "\x07", b: "\b", f: "\f", v: "\v", e: "\x1b", E: "\x1b", "\\": "\\", "'": "'", '"': '"', "?": "?" };

/**
 * A byte from a `\xHH` or `\NNN` escape, as a character this module can
 * compare against the command text -- or null, meaning "abstain".
 *
 * ASCII only, and that boundary is the point. Bash emits a RAW BYTE, while
 * this module compares JavaScript strings decoded from UTF-8: `$'\377'` is the
 * single byte FF, but the character `ÿ` in the same command text is the two
 * bytes C3 BF. Below 0x80 the byte and the code unit coincide under UTF-8, so
 * the comparison is sound; at or above it, they do not, and a match here would
 * be an artefact of the decoding rather than something Bash would agree with.
 * (Codex, #488 round 14 -- which caught a MUST_BLOCK row I had written on
 * exactly that wrong assumption.)
 *
 * NUL abstains too: Bash truncates the value there, and modelling that from
 * reading rather than measurement is how the claims in this PR went wrong.
 */
function decodeByte(byte) {
  if (byte === 0 || byte >= 0x80) return null;
  return String.fromCharCode(byte);
}

function scanAnsiCQuoted(text, start) {
  let value = "";
  let i = start;
  while (i < text.length) {
    const c = text[i];
    if (c === "'") return { value, end: i + 1 };
    if (c === "\\") {
      const next = text[i + 1];
      if (next === undefined) return null;
      if (next in ANSI_C_SIMPLE) {
        value += ANSI_C_SIMPLE[next];
        i += 2;
        continue;
      }
      const hex = /^\\x([0-9a-f]{1,2})/i.exec(text.slice(i));
      if (hex) {
        const decoded = decodeByte(parseInt(hex[1], 16));
        if (decoded === null) return null;
        value += decoded;
        i += hex[0].length;
        continue;
      }
      const octal = /^\\([0-7]{1,3})/.exec(text.slice(i));
      if (octal) {
        // Bash emits a BYTE: `\400` and above wrap to 8 bits.
        const decoded = decodeByte(parseInt(octal[1], 8) & 0xff);
        if (decoded === null) return null;
        value += decoded;
        i += octal[0].length;
        continue;
      }
      return null;
    }
    if (c === "\n") return null;
    value += c;
    i += 1;
  }
  return null;
}

/**
 * Find the terminator line for `literal`, searching forward from `from`.
 * Compared as a string rather than built into a pattern, so a delimiter
 * containing regex metacharacters cannot change what counts as the end of
 * the body.
 */
function findHeredocTerminator(text, from, literal, stripTabs) {
  let pos = from;
  while (pos <= text.length) {
    let lineEnd = text.indexOf("\n", pos);
    if (lineEnd === -1) lineEnd = text.length;
    const line = text.slice(pos, lineEnd);
    // Bash's own comparison: the line must EQUAL the delimiter, with leading
    // TABS removed only for `<<-` -- never spaces, and never for plain `<<`.
    // Trimming both ends of every line was inherited from the regex this
    // replaced, and an empty delimiter made it visible: a spaces-only line
    // reduced to "" and ended the body early, leaving the rest of an inert
    // body to be judged as commands. (Codex, #488 round 13.)
    if ((stripTabs ? line.replace(/^\t+/, "") : line) === literal) {
      return { start: pos, end: lineEnd };
    }
    if (lineEnd === text.length) return null;
    pos = lineEnd + 1;
  }
  return null;
}

/**
 * Locate every complete heredoc block in `text`, left to right, each as
 * `{ index, tokenEnd, bodyStart, body, end }` -- `index` at the `<<`,
 * `tokenEnd` just past the delimiter word, and `end` at the close of the
 * terminator line. Shared by `stripHeredocs` (which discards each body) and
 * `checkShellStdinHeredocs` below (which inspects it) so the two stay in
 * sync by construction rather than as two hand-maintained copies.
 *
 * An opener with no terminator yields nothing, matching the previous
 * behaviour: without a terminator there is no body to identify, and assuming
 * one runs to end-of-input would hide every command after it.
 */
function findHeredocs(text) {
  const blocks = [];
  let i = 0;
  while (i < text.length) {
    const at = text.indexOf("<<", i);
    if (at === -1) break;
    if (text[at + 2] === "<") {
      i = at + 3; // `<<<` is a herestring, not a heredoc.
      continue;
    }
    let cursor = at + 2;
    const stripTabs = text[cursor] === "-";
    if (stripTabs) cursor += 1;
    const delimiter = scanHeredocDelimiter(text, cursor);
    if (!delimiter) {
      i = at + 2;
      continue;
    }
    const openerLineEnd = text.indexOf("\n", delimiter.end);
    if (openerLineEnd === -1) {
      i = delimiter.end;
      continue;
    }
    const terminator = findHeredocTerminator(text, openerLineEnd + 1, delimiter.literal, stripTabs);
    if (!terminator) {
      i = delimiter.end;
      continue;
    }
    const raw = text.slice(openerLineEnd + 1, terminator.start);
    blocks.push({
      index: at,
      tokenEnd: delimiter.end,
      bodyStart: openerLineEnd + 1,
      // `<<-` strips leading tabs from EVERY body line, not only the
      // terminator, and the body is what a shell reading stdin then parses.
      // Stripping only the terminator left `\tIN` inside a nested heredoc
      // looking like data, so the nested body ran on to a later bare `IN` and
      // swallowed a real command. (Codex, #488 round 14 -- refuting my own
      // round-13 claim that body tabs could not change a verdict.)
      body: stripTabs ? raw.replace(/^\t+/gm, "") : raw,
      end: terminator.end,
    });
    i = terminator.end;
  }
  return blocks;
}

/**
 * Remove heredoc BODIES before tokenising.
 *
 * A heredoc body is data being fed to a program -- a commit message, a file --
 * not commands to be judged. Leaving it in also broke tokenising outright: an
 * apostrophe in prose ("GitHub's ruleset") reads as an unbalanced quote and
 * throws, dropping every `git commit -F - <<'MSG'` in this repo onto the
 * last-resort path above.
 *
 * Two passes, deliberately. The opener's own line can carry a REAL command
 * after the `<<DELIM` token -- `cat <<EOF && git push -f origin claude/x` runs
 * `cat` (reading the heredoc as its stdin) and THEN, once that finishes,
 * `git push -f origin claude/x`, on the very same logical line. A single
 * regex spanning from `<<DELIM` through the terminator swallowed that trailing
 * command as if it were part of the inert body, which is what let a real force
 * push hide right after a heredoc opener. So the body is stripped first,
 * preserving everything on the opener's own line untouched; only then is the
 * (by-then-orphaned) `<<DELIM` token itself erased.
 */
export function stripHeredocs(input) {
  let withoutBodies = "";
  let cursor = 0;
  for (const block of findHeredocs(input)) {
    // `bodyStart - 1` is the opener line's own newline: everything up to it
    // (the `<<DELIM` token and any command chained after it) survives.
    withoutBodies += input.slice(cursor, block.bodyStart - 1);
    cursor = block.end;
  }
  withoutBodies += input.slice(cursor);

  // Pass two: erase the now-orphaned opener tokens. Scanned with the same
  // grammar rather than a narrower pattern, so a delimiter this module can
  // read is also a delimiter it can remove.
  let withoutOpeners = "";
  let kept = 0;
  let i = 0;
  while (i < withoutBodies.length) {
    const at = withoutBodies.indexOf("<<", i);
    if (at === -1) break;
    if (withoutBodies[at + 2] === "<") {
      i = at + 3;
      continue;
    }
    let start = at + 2;
    if (withoutBodies[start] === "-") start += 1;
    const delimiter = scanHeredocDelimiter(withoutBodies, start);
    if (!delimiter) {
      i = at + 2;
      continue;
    }
    withoutOpeners += withoutBodies.slice(kept, at) + " ";
    kept = delimiter.end;
    i = delimiter.end;
  }
  return withoutOpeners + withoutBodies.slice(kept);
}

/**
 * A heredoc body is inert data -- UNLESS the command it is redirected into
 * is itself a shell interpreter reading from stdin, in which case the body
 * IS the script Bash runs: `bash <<'EOF' ... git push -f ... EOF` feeds the
 * whole body to `bash` the same way `bash -c '...'` feeds it a string, just
 * over stdin instead of an argument. `stripHeredocs` above would discard
 * that body as if it were a commit message, which is why this runs FIRST
 * and independently, recursing into any such body through the same
 * judgement pipeline before the body is ever stripped.
 *
 * Only fires when the opener command has no `-c` (or bundled `-lc`, etc.):
 * a shell given `-c` ignores stdin for its script and this heredoc really
 * is inert, feeding whatever the `-c` command itself reads, not commands.
 */
function checkShellStdinHeredocs(text, depth) {
  if (depth >= MAX_NESTED_SHELL_DEPTH) return null;
  for (const block of findHeredocs(text)) {
    const lineStart = text.lastIndexOf("\n", block.index) + 1;
    const prefix = text.slice(lineStart, block.index).trim();
    const body = block.body;

    let tokens;
    try {
      tokens = tokenize(prefix);
    } catch {
      continue;
    }
    if (!tokens.length) continue;

    const argv = resolveRealCommand(tokens);
    const program = argv[0]?.split("/").pop();
    if (program && SHELL_INTERPRETERS.has(program) && !argv.some(isShortFlagBundleContaining("c"))) {
      const reason = evaluateScript(body, depth + 1);
      if (reason) return reason;
    }
  }
  return null;
}

/**
 * Parse `text` into commands and judge each one, at the given nesting depth.
 * The top level (`decide`, depth 0) and a recursed-into command string
 * (depth 1+, from `checkCommand`'s `-c`/`eval`/`!`-alias dispatch, or from
 * `checkShellStdinHeredocs` above) share this exact pipeline -- a nested
 * shell script is not a different kind of input, it is more text to run the
 * same judgement over.
 */
function evaluateScript(text, depth) {
  const heredocReason = checkShellStdinHeredocs(text, depth);
  if (heredocReason) return heredocReason;

  let parsed;
  try {
    parsed = segments(tokenize(stripHeredocs(text)));
  } catch {
    // Untokenisable text is REFUSED, not scanned for destructive shapes.
    //
    // This used to fall through to a `LOOKS_DESTRUCTIVE` regex -- an
    // enumeration of the shapes worth refusing -- and that is the third
    // enumeration this PR has had to abandon. Codex found the hole by
    // construction: an unreadable heredoc delimiter left an inert body in
    // place, prose apostrophes made tokenising throw, and the fallback did
    // not list `git push origin +main`, so a force refspec was ALLOWED.
    // (Codex, #488 round 14.)
    //
    // The deeper problem was that every "this abstains, which over-blocks"
    // claim in this module depended on that fallback being complete, and it
    // never was. Refusing here makes the claim true by construction: any
    // input this module cannot read is refused, so a scanner that misreads
    // something degrades to a false BLOCK rather than a silent pass.
    //
    // Cost: a genuinely unreadable command is refused with an explanation
    // rather than run. Heredoc bodies are stripped before this point, so the
    // prose-apostrophe case that motivated the old fallback does not reach
    // it -- and when it does, the input really is one this guard cannot
    // judge.
    return depth === 0
      ? "command could not be parsed, so it cannot be judged -- refusing rather than guessing. Simplify it, or put the awkward text in a heredoc body (which is treated as data)."
      : "nested shell command could not be parsed, so it cannot be judged -- refusing rather than guessing.";
  }

  for (const argv of parsed) {
    const reason = checkCommand(argv, depth);
    if (reason) return reason;
  }

  return null;
}

/** Full decision for a raw payload. Returns { blocked, reason }. */
export function decide(raw) {
  const command = extractCommand(raw);
  const reason = evaluateScript(command, 0);
  return reason ? { blocked: true, reason } : { blocked: false, reason: null };
}

async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const { blocked, reason } = decide(Buffer.concat(chunks).toString("utf8"));
  if (blocked) {
    process.stderr.write(`Guard: blocked -- ${reason}\n`);
    return BLOCK;
  }
  return ALLOW;
}

const invokedDirectly =
  process.argv[1] && import.meta.url === `file://${process.argv[1]}`;

if (invokedDirectly) {
  main().then((code) => process.exit(code));
}
