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
 * Codex's rounds 1 and 2 of this module (PR #329) found twenty concrete
 * parser gaps across two passes, eighteen now fixed: transparent wrappers,
 * including past their own bare flags (`env -i`/`command -p`), a leading
 * `NAME=value` environment-assignment prefix, unique long-option
 * abbreviations, a backslash-newline line continuation splitting a bundled
 * short flag, an inline git alias -- including one whose EXPANSION itself
 * carries the dangerous flags, not just a renamed subcommand -- shell
 * grouping/control keywords (including `coproc`) hiding the real command,
 * ANSI-C `$'...'` quoting with its full escape set (octal/hex/unicode/
 * control-character, not just the single-letter forms), brace expansion
 * (`-{f,u}` is two arguments), an empty-source or short `-d` refspec
 * deleting the destination, a heredoc chained with a real command on its
 * opener line, a root-only glob using dot/bracket syntax (`/.*`, `/[be]*`),
 * case- and long-flag-insensitive recursive+force detection on `rm`, a
 * versioned `drizzle-kit@<version>` package spec, and a nested shell
 * invocation (`bash -c '...'`) whose `-c` argument is recursively judged by
 * this same pipeline. Each has its own comment at the fix site and its own
 * pinning test.
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

/** git global options that consume a following value, e.g. `git -C /path push`. */
const GIT_GLOBAL_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace"]);

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
 * Peel off constructs Bash resolves before dispatching to a program: leading
 * `NAME=value` environment assignments, and a transparent wrapper in front
 * of the real command, skipping past any of that wrapper's KNOWN bare
 * (non-value-taking) flags -- `env -i git push -f ...` and
 * `command -p git push -f ...` still run `git`, and Bash resolves that
 * regardless of how many bare flags sit between the wrapper and it.
 *
 * Deliberately narrow: an UNRECOGNISED or value-taking flag stops the
 * unwrap rather than guessing past it -- misreading a flag's value as the
 * real command would be worse than not unwrapping at all.
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
      let next = i + 1;
      while (next < argv.length && bareFlags.has(argv[next])) next += 1;
      if (argv[next] === "--") next += 1;
      if (next < argv.length && !argv[next].startsWith("-")) {
        i = next;
        continue;
      }
      break; // an unrecognised or value-taking flag: give up, judge the wrapper itself
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
 * True for an `rm` target whose FIRST path component (right after the
 * leading `/`) is composed entirely of glob syntax with no literal name in
 * it -- `/`, `/*`, `/**`, `//`, `/.*`, `/[be]*`. Such a target can match
 * many or all top-level entries, which is the shape this guard treats as
 * root-equivalent. A scoped absolute path (`/tmp/x`, `/tmp/*`) has a real
 * literal first component and is left alone, matching this guard's
 * narrowing philosophy: block the catastrophic case, not every absolute
 * path (the pre-narrowing guard's un-anchored regex matched the latter too,
 * which was almost certainly incidental breadth, not an intentional policy
 * -- it would have caught routine scratch cleanup like `rm -rf /tmp/x`).
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
  if (token === "/" || token === "//") return true;
  if (!token.startsWith("/")) return false;
  const firstSegment = token.slice(1).split("/")[0];
  if (firstSegment === "") return true;
  const stripped = firstSegment.replace(/\[[^\]]*\]/g, "").replace(/[*?.]/g, "");
  return stripped === "";
}

/**
 * True when the push's own arguments (i.e. everything after `push`) name or
 * imply deletion: an explicit `--delete`, or a refspec with an empty
 * `<src>` (`:claude/x`), which Git's own refspec rules define as deleting
 * the remote `<dst>`. Checked independently of `forcing` below so a
 * deletion is refused even without an accompanying force flag -- the
 * concern this closes is specifically a delete-shaped push slipping past
 * because it does not use the word "force" at all.
 */
function looksLikeDeletion(pushArgs) {
  if (pushArgs.includes("--delete") || pushArgs.includes("-d")) return true;
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
 * Locate the subcommand in `git [global opts] <subcommand>`, expanding an
 * inline alias (`-c alias.<name>=<expansion>`) invoked in the same command.
 *
 * Returns { name, index, argv }. `argv` is normally the input unchanged, but
 * an alias invocation returns a NEW argv with the alias token spliced out
 * and the FULL tokenized expansion spliced in -- `index` then points at
 * "push" within that new array. Splicing the whole expansion, not just its
 * first word, matters: `git -c alias.p='push --force' p origin claude/x`
 * carries the force flag inside the alias value itself, not just a renamed
 * subcommand, so dropping everything after the alias's own first word would
 * silently discard the part that makes the push dangerous.
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
    if (aliases.has(token) && /^\s*push\b/.test(aliases.get(token))) {
      let expansion;
      try {
        expansion = tokenize(aliases.get(token).trim());
      } catch {
        return { name: "push", index: i, argv }; // unparseable expansion: still flag it as push
      }
      const spliced = [...argv.slice(0, i), ...expansion, ...argv.slice(i + 1)];
      return { name: "push", index: i, argv: spliced };
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
function isDrizzleKitToken(token) {
  const base = token.split("/").pop();
  return base === "drizzle-kit" || base.startsWith("drizzle-kit@") || base.includes("drizzle-kit");
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

  if (SHELL_INTERPRETERS.has(program) && depth < MAX_NESTED_SHELL_DEPTH) {
    const cIndex = rest.indexOf("-c");
    if (cIndex !== -1 && typeof rest[cIndex + 1] === "string") {
      const nested = evaluateScript(rest[cIndex + 1], depth + 1);
      if (nested) return nested;
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

  if (program === "git") {
    // gitSubcommand may return a NEW argv with an inline alias's full
    // expansion spliced in -- e.g. `-c alias.p='push --force'` -- so every
    // reference to the git command from here on uses ITS returned argv, not
    // `resolved`.
    const { name: subcommand, index: subcommandIndex, argv: gitArgv } = gitSubcommand(resolved);

    if (subcommand === "update-ref") {
      return "git update-ref -- moves a ref with no safety net";
    }

    if (subcommand === "push") {
      // Abbreviations are expanded to canonical spellings before anything
      // downstream compares against exact strings -- `--m` reads as
      // `--mirror` from here on, `--force-with` as `--force-with-lease`.
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
  const withoutBodies = input.replace(
    /(<<-?(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2[^\n]*)\n[\s\S]*?^[ \t]*\3[ \t]*$/gm,
    "$1",
  );
  return withoutBodies.replace(/<<-?(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/g, " ");
}

/**
 * Parse `text` into commands and judge each one, at the given nesting depth.
 * The top level (`decide`, depth 0) and a recursed-into `bash -c STRING`
 * (depth 1+, from `checkCommand` above) share this exact pipeline -- a
 * nested shell script is not a different kind of input, it is more text to
 * run the same judgement over.
 */
function evaluateScript(text, depth) {
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
