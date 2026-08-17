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
 * - One false-positive risk, not a bypass: heredoc delimiters that are valid
 *   in Bash but not identifier-shaped (`<<'MSG-1'`) are not recognized by
 *   the stripping regex, so an ordinary commit-message heredoc using one
 *   could be misclassified as a real command and over-blocked.
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
]);

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
  command: new Set(["-p", "-v", "-V"]),
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
};

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
      let next = i + 1;
      while (next < argv.length) {
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
      if (argv[next] === "--") next += 1;
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
 * Options whose NEXT argument is a value, not a transfer URL.
 *
 * Needed because the first version of this rule tested every argument, so
 * `curl -d https://api.github.com/x https://example.com/hook` was blocked even
 * though it only connects to example.com — a POST body that happens to be a
 * URL is data. (Codex, PR #487.) Long forms may also arrive as `--data=...`,
 * which is self-contained and never consumes the following token.
 *
 * `--url` is deliberately ABSENT: its value IS the transfer URL, so it must be
 * checked rather than skipped.
 */
const FETCHER_VALUE_FLAGS = new Set([
  // curl
  "-d", "--data", "--data-raw", "--data-binary", "--data-ascii", "--data-urlencode",
  "-H", "--header", "--proxy-header", "-F", "--form", "--form-string",
  "-o", "--output", "-T", "--upload-file", "-u", "--user", "-U", "--proxy-user",
  "-A", "--user-agent", "-e", "--referer", "-X", "--request", "-b", "--cookie",
  "-c", "--cookie-jar", "-w", "--write-out", "-x", "--proxy", "--preproxy",
  "-E", "--cert", "--key", "--cacert", "--capath", "--resolve", "--connect-to",
  "-m", "--max-time", "--connect-timeout", "--retry", "--retry-delay",
  "--retry-max-time", "-K", "--config", "--interface", "--limit-rate", "-r", "--range",
  // wget
  "-O", "--output-document", "-P", "--directory-prefix", "--post-data",
  "--post-file", "--body-data", "--body-file", "--user-agent", "--referer",
  "--load-cookies", "--save-cookies", "--ca-certificate", "--certificate",
  "--private-key", "-t", "--tries", "-T", "--timeout", "--bind-address",
]);

/**
 * The single-letter forms above, as bare letters.
 *
 * Bundled short flags (`curl -sSd <body> <url>`) put the value-taking letter
 * LAST in the bundle, so the bundle consumes the following token exactly as the
 * unbundled form does. Derived rather than re-listed so the two can't drift.
 */
const SHORT_VALUE_FLAG_LETTERS = new Set(
  [...FETCHER_VALUE_FLAGS].filter((f) => /^-[A-Za-z]$/.test(f)).map((f) => f.slice(1)),
);

/**
 * The hostname a fetcher argument would actually connect to, or null.
 *
 * **Scheme-optional**, because curl guesses a missing scheme: bare
 * `curl api.github.com/repos/o/r` fetches over HTTP and is an ordinary
 * equivalent of every blocked command. Requiring `http(s)://` left that
 * reachable. (Codex, PR #487.)
 *
 * Still PARSED rather than substring-matched, so `./api.github.com.md`, a
 * flag, and a JSON body mentioning the host are not mistaken for a request.
 * Host comparison is case-insensitive and ignores a userinfo prefix, since
 * `https://user@API.GitHub.com/…` reaches the same place.
 */
function fetcherTargetHost(token) {
  if (!token || token.startsWith("-")) return null;
  // A path-ish token is a file operand, not a host: `./api.github.com.md`,
  // `/tmp/x`, `~/y`. curl treats a leading `/` or `.` as a path, not a URL.
  if (/^[./~]/.test(token)) return null;
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(token) ? token : `http://${token}`;
  try {
    const { protocol, hostname } = new URL(candidate);
    if (protocol !== "http:" && protocol !== "https:") return null;
    return hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * True when a curl/wget invocation would actually connect to api.github.com.
 *
 * Walks the arguments so an option's VALUE is never mistaken for a target,
 * and so a schemeless target is still recognised.
 */
function fetchesGitHubApi(rest) {
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === "--") {
      // Everything after `--` is an operand.
      for (const operand of rest.slice(i + 1)) {
        if (fetcherTargetHost(operand) === "api.github.com") return true;
      }
      return false;
    }
    if (arg === "--url") {
      if (fetcherTargetHost(rest[i + 1]) === "api.github.com") return true;
      i += 1;
      continue;
    }
    if (arg.startsWith("--url=")) {
      if (fetcherTargetHost(arg.slice(6)) === "api.github.com") return true;
      continue;
    }
    // `--data=...` and friends are self-contained; they consume no next token.
    if (arg.startsWith("--") && arg.includes("=")) continue;
    if (FETCHER_VALUE_FLAGS.has(arg)) {
      i += 1; // skip the value
      continue;
    }
    if (/^-[A-Za-z]{2,}$/.test(arg) && SHORT_VALUE_FLAG_LETTERS.has(arg.slice(-1))) {
      i += 1; // bundle ending in a value-taking letter, e.g. `-sSd <body>`
      continue;
    }
    if (arg.startsWith("-")) continue; // bare flag, or a bundle like -sS
    if (fetcherTargetHost(arg) === "api.github.com") return true;
  }
  return false;
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
    const cIndex = rest.indexOf("-c");
    return cIndex !== -1 && typeof rest[cIndex + 1] === "string" ? rest[cIndex + 1] : null;
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

  if (HTTP_FETCHERS.has(program)) {
    if (fetchesGitHubApi(rest)) {
      return (
        "api.github.com is not reachable from bash in this container, and the failure is SILENT " +
        "inside a pipeline: curl is intercepted by the agent proxy (HTTP 403 \"GitHub access is not " +
        "enabled for this session\"), so a `grep` over the response body finds nothing and reads as " +
        "\"no results\" rather than as an error. Every CI-wait loop built this way on 2026-08-16 was a " +
        "pure sleep. Use the mcp__github__* tools instead -- pull_request_read (get_check_runs) for CI, " +
        "get_reviews for a review landing, get for merge state, issue_read for labels. " +
        "See .agents/memory/github-rest-api-blocked-from-bash.md."
      );
    }
  }

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
 * Shapes worth refusing when the tokeniser could not read the command at all.
 * Kept deliberately force-specific: broadening it to every `git push` would
 * reject ordinary work like `echo "done $(date)" && git push -u origin ...`.
 *
 * This is a LAST RESORT, reached only when tokenising throws. An earlier
 * revision also used it as a pre-emptive backstop against substitutions hidden
 * in double quotes, and that was wrong: it judged raw text, so it blocked this
 * very commit for quoting force-push examples in its own message. Raw-text
 * matching is the defect this module exists to remove -- reintroducing it as a
 * safety net just moved it.
 */
const LOOKS_DESTRUCTIVE =
  /git\s[^\n]*\bpush\b[^\n]*(?:--force|--mirror|\s-f\b)|git\s[^\n]*\bupdate-ref\b|rm\s+-[rfR]{1,2}\s+\/|drizzle-kit\s+push/;

/**
 * Matches one heredoc block: group 1 is the opener token plus anything
 * chained after it on the SAME line, group 2 the optional quote, group 3 the
 * delimiter word, group 4 the body (everything between the opener line and
 * the terminator line). Shared by `stripHeredocs` (which discards group 4)
 * and `checkShellStdinHeredocs` below (which inspects it) so the two stay in
 * sync by construction rather than by two hand-maintained copies.
 */
const HEREDOC_RE = /(<<-?(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2[^\n]*)\n([\s\S]*?)^[ \t]*\3[ \t]*$/gm;

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
  const withoutBodies = input.replace(HEREDOC_RE, "$1");
  return withoutBodies.replace(/<<-?(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/g, " ");
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
  for (const match of text.matchAll(HEREDOC_RE)) {
    const lineStart = text.lastIndexOf("\n", match.index) + 1;
    const prefix = text.slice(lineStart, match.index).trim();
    const body = match[4];

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
    // Untokenisable. We cannot reason about it, so block only if it shows any
    // sign of the shapes we care about.
    if (LOOKS_DESTRUCTIVE.test(text)) {
      return depth === 0 ? "unparseable command that looks destructive" : "unparseable nested shell command that looks destructive";
    }
    return null;
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
