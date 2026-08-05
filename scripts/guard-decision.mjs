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
 * KNOWN LIMIT, stated rather than hidden
 * --------------------------------------
 * A command substitution nested inside DOUBLE QUOTES -- `echo "$(git push -f
 * origin main)"` -- is not decomposed. The quotes swallow the operators that
 * would otherwise make the substitution its own segment, and resolving that
 * properly needs a real shell parser. Unquoted substitutions and backticks ARE
 * handled, as is a force push whose target is computed rather than named.
 *
 * This is left open deliberately. Closing it by scanning raw text is what the
 * previous version did, and that is the defect this module exists to remove --
 * an earlier revision of THIS file tried it as a "backstop" and immediately
 * blocked the commit introducing it, for quoting force-push examples in its own
 * message. The gap needs a contrived command to reach, it is not an accident
 * shape, and `main` is covered by GitHub's ruleset regardless. A hook that
 * blocks real work to defeat a hypothetical gets turned off, which protects
 * nothing at all.
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

    if (c === "\\") {
      if (i + 1 < source.length) current += source[i + 1];
      i += 2;
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
 */
function gitSubcommand(argv) {
  let i = 1;
  while (i < argv.length) {
    const token = argv[i];
    if (GIT_GLOBAL_WITH_VALUE.has(token)) {
      i += 2;
      continue;
    }
    if (token.startsWith("-")) {
      i += 1;
      continue;
    }
    return { name: token, index: i };
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
  const destination = refspec.split(":").pop();
  return OWNED_BRANCH.test(destination);
}

/** Return a denial reason for one command, or null to allow it. */
export function checkCommand(argv) {
  if (!argv.length) return null;

  const program = argv[0].split("/").pop();
  const rest = argv.slice(1);

  if (program === "rm") {
    const recursiveForce =
      rest.some((a) => /^-[A-Za-z]+$/.test(a) && a.includes("r") && a.includes("f")) ||
      (rest.includes("-r") && rest.includes("-f")) ||
      (rest.includes("-R") && rest.includes("-f"));
    if (recursiveForce && rest.includes("/")) {
      return "rm -rf /";
    }
  }

  if ((program.includes("drizzle-kit") || argv.includes("drizzle-kit")) && argv.includes("push")) {
    return "drizzle-kit push -- schema changes go through a migration, never a push";
  }

  if (program === "git") {
    const { name: subcommand, index: subcommandIndex } = gitSubcommand(argv);

    if (subcommand === "update-ref") {
      return "git update-ref -- moves a ref with no safety net";
    }

    if (subcommand === "push") {
      const forcing =
        argv.some((t) => t.startsWith("-") && (BARE_FORCE.has(t) || isLease(t) || isBundledShortForce(t))) ||
        argv.slice(1).some((t) => !t.startsWith("-") && t.startsWith("+"));

      if (forcing && !pushIsSafe(argv, subcommandIndex)) {
        return [
          "force push outside the permitted shape.",
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
 */
export function stripHeredocs(input) {
  return input.replace(
    /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[\s\S]*?^[ \t]*\2[ \t]*$/gm,
    " ",
  );
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
