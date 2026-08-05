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
 * Codex's round-1 review of this module (PR #329) found nine concrete parser
 * gaps, all now fixed: transparent wrappers (`env`/`command`/`sudo` git ...),
 * a leading `NAME=value` environment-assignment prefix, unique long-option
 * abbreviations (`--m` for `--mirror`), a backslash-newline line
 * continuation splitting a bundled short flag, an inline git alias
 * (`git -c alias.p=push p ...`), shell grouping/control keywords hiding the
 * real command (`{ ...; }`, `if ...; then ...; fi`), ANSI-C `$'...'`
 * quoting, an empty-source refspec deleting the destination
 * (`--force-with-lease origin :claude/x`), and a heredoc chained with a real
 * command on its opener line. Each has its own comment at the fix site and
 * its own pinning test.
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
  "case", "esac", "in", "function", "!",
]);

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
 * Peel off constructs Bash resolves before dispatching to a program: leading
 * `NAME=value` environment assignments, and a transparent wrapper with no
 * flags (or only a `--` separator) in front of the real command.
 *
 * Deliberately narrow: a FLAGGED wrapper invocation (`env -u NAME git ...`)
 * is left alone rather than guessed at -- misreading a flag's value as the
 * real command would be worse than not unwrapping at all, and the forms that
 * actually showed up in review (`command git ...`, `env git ...`) are the
 * ones this closes completely.
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
      let next = i + 1;
      if (argv[next] === "--") next += 1;
      if (next < argv.length && !argv[next].startsWith("-")) {
        i = next;
        continue;
      }
      break; // a flagged wrapper invocation: give up, judge the wrapper itself
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
 * True for an `rm` target that resolves to the filesystem root or a
 * root-only glob (`/`, `/*`, `/**`, `//`) -- i.e. no real path component
 * survives stripping every `/` and `*`. A scoped absolute path (`/tmp/x`,
 * `/tmp/*`) is not root-shaped and is left alone, matching this guard's
 * narrowing philosophy: block the catastrophic case, not every absolute
 * path (the pre-narrowing guard's un-anchored regex matched the latter too,
 * which was almost certainly incidental breadth, not an intentional policy
 * -- it would have caught routine scratch cleanup like `rm -rf /tmp/x`).
 */
function isRootShaped(token) {
  if (!token.includes("/")) return false;
  return token.replace(/[/*]/g, "") === "";
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
  if (pushArgs.includes("--delete")) return true;
  const positionals = pushArgs.filter((t) => !t.startsWith("-"));
  const refspecs = positionals.slice(1); // positionals[0] is the remote
  return refspecs.some((r) => r.startsWith(":"));
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
      // recognised as the git program at all.
      i += 2;
      let value = "";
      const ESCAPES = { n: "\n", t: "\t", r: "\r", "\\": "\\", "'": "'", '"': '"', a: "\x07", b: "\b", f: "\f", v: "\v", "0": "\0" };
      while (i < source.length && source[i] !== "'") {
        if (source[i] === "\\" && i + 1 < source.length) {
          const esc = source[i + 1];
          value += esc in ESCAPES ? ESCAPES[esc] : esc;
          i += 2;
        } else {
          value += source[i];
          i += 1;
        }
      }
      if (source[i] !== "'") throw new Error("unbalanced $'...' quote");
      i += 1;
      current += value;
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
  return tokens;
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
 * Locate the subcommand in `git [global opts] <subcommand>`.
 *
 * Returns { name, index } so callers can parse the subcommand's own arguments
 * without the global options bleeding in. That distinction is load-bearing:
 * treating the value of `-C /repo` as a positional made
 * `git -C /repo push --force-with-lease origin claude/x` parse as having two
 * refspecs, and a permitted push was rejected.
 *
 * Also tracks `-c alias.<name>=<expansion>`: git expands <name> to
 * <expansion> when it appears as the subcommand, so
 * `git -c alias.p=push p --force origin claude/x` runs `push`, not some
 * inert command called `p`. Only tracks aliases whose expansion IS (or
 * begins with) "push" -- the one subcommand this guard scrutinises -- and
 * only ones defined via -c on the SAME invocation, since that is the
 * reproducible shape. A pre-existing alias in .gitconfig is a materially
 * different problem this hook has no way to see: arbitrary prior repo or
 * global state, not something visible in the command text at all.
 */
function gitSubcommand(argv) {
  let i = 1;
  const pushAliases = new Set();
  while (i < argv.length) {
    const token = argv[i];
    if (token === "-c" && typeof argv[i + 1] === "string") {
      const match = /^alias\.([^=\s]+)=(.*)$/.exec(argv[i + 1]);
      if (match && /^\s*push\b/.test(match[2])) pushAliases.add(match[1]);
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
    return { name: pushAliases.has(token) ? "push" : token, index: i };
  }
  return { name: null, index: -1 };
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

/** Return a denial reason for one command, or null to allow it. */
export function checkCommand(argv) {
  if (!argv.length) return null;

  // Shell syntax that precedes the real command ({, if/then/fi, ...) and
  // transparent wrappers/env-assignments in front of it are both peeled off
  // before anything is judged, so `if true; then git push -f ...; fi` and
  // `env git push -f ...` are seen as the git command they actually run.
  let start = 0;
  while (start < argv.length && SHELL_KEYWORDS.has(argv[start])) start += 1;
  const afterKeywords = argv.slice(start);
  if (!afterKeywords.length) return null;

  const resolved = resolveRealCommand(afterKeywords);
  if (!resolved.length) return null;

  const program = resolved[0].split("/").pop();
  const rest = resolved.slice(1);

  if (program === "rm") {
    const recursiveForce =
      rest.some((a) => /^-[A-Za-z]+$/.test(a) && a.includes("r") && a.includes("f")) ||
      (rest.includes("-r") && rest.includes("-f")) ||
      (rest.includes("-R") && rest.includes("-f"));
    if (recursiveForce && rest.some((a) => !a.startsWith("-") && isRootShaped(a))) {
      return "rm -rf / (or a root-only glob) -- deletes the filesystem root's contents";
    }
  }

  if ((program.includes("drizzle-kit") || resolved.includes("drizzle-kit")) && resolved.includes("push")) {
    return "drizzle-kit push -- schema changes go through a migration, never a push";
  }

  if (program === "git") {
    const { name: subcommand, index: subcommandIndex } = gitSubcommand(resolved);

    if (subcommand === "update-ref") {
      return "git update-ref -- moves a ref with no safety net";
    }

    if (subcommand === "push") {
      // Abbreviations are expanded to canonical spellings before anything
      // downstream compares against exact strings -- `--m` reads as
      // `--mirror` from here on, `--force-with` as `--force-with-lease`.
      const pushArgs = resolved
        .slice(subcommandIndex + 1)
        .map((t) => (t.startsWith("-") ? expandAbbreviatedLongOption(t) : t));
      const pushArgv = [...resolved.slice(0, subcommandIndex + 1), ...pushArgs];

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

/** Full decision for a raw payload. Returns { blocked, reason }. */
export function decide(raw) {
  const command = extractCommand(raw);

  let parsed;
  try {
    parsed = segments(tokenize(stripHeredocs(command)));
  } catch {
    // Untokenisable. We cannot reason about it, so block only if it shows any
    // sign of the shapes we care about.
    if (LOOKS_DESTRUCTIVE.test(command)) {
      return { blocked: true, reason: "unparseable command that looks destructive" };
    }
    return { blocked: false, reason: null };
  }

  for (const argv of parsed) {
    const reason = checkCommand(argv);
    if (reason) return { blocked: true, reason };
  }

  return { blocked: false, reason: null };
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
