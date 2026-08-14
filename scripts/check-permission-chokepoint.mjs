#!/usr/bin/env node
/**
 * The permission chokepoint guard.
 * ────────────────────────────────────────────────────────────────────────────
 * "The wrong call must become impossible, not merely discouraged."
 *
 * A tier-keyed `hasFeature(tier, key)` reachable from route code is how the
 * PR #402 bug class reproduces: the meme builder mapped `admin → legendary`
 * client-side and offered a Private pill, while the save path resolved the same
 * entitlement from the tier column, found `registered`, and coerced the meme
 * public. Two surfaces, two vocabularies, no chokepoint.
 *
 * This guard enforces two things:
 *
 *   1. The tier-keyed lookup stays inside `featureAccess.ts`. Nothing else may
 *      reference `hasFeature` or read the grid tables directly.
 *   2. Every product-feature gate resolves through the resolver, so a NEW
 *      inline role comparison in a product path fails the build.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO. It does not try to enumerate every route
 * and demand each be classified — that inventory goes stale the moment someone
 * adds a route, and a guard that is wrong half the time gets disabled. It
 * checks the two properties that actually carry the invariant, and it names the
 * one grandfathered exception explicitly so the exception cannot spread
 * silently.
 *
 * THIS IS A TRIPWIRE FOR THE FORMS A DEVELOPER OR AGENT WOULD WRITE BY HABIT —
 * NOT A PROOF THAT NO INLINE COMPARISON CAN EXIST. Rounds 4 and 6 of PR #425's
 * review closed real gaps in that habitual space: `!==` and a
 * formatter-wrapped multi-line comparison are both things a normal author
 * reaches for without thinking. Round 7 found the pattern also misses a
 * REVERSED operand (`"legendary" === membershipTier`) and declined to chase
 * it: nobody on this team or Codex writes Yoda conditions in this codebase,
 * and the space of syntactically-valid-but-never-actually-written forms is
 * unbounded regardless — a real parser would still miss a new helper function
 * or an array `.includes()` check. The actual defense is architectural: the
 * correct call (`can(principal, '<feature_key>')`) is the obvious, documented,
 * already-modeled-everywhere thing to reach for, so the accidental habitual
 * regression is what this guard exists to catch, not adversarial evasion.
 *
 * ALLOWLIST matching is per-LINE, not per-file: an entry only suppresses the
 * violation on the exact line whose text it matches, not the rest of its
 * file — round 3 of PR #425's review found this guard sharing the identical
 * file-level bug its frontend sibling
 * (`scripts/check-permission-chokepoint-frontend.mjs`) was fixed for in
 * round 2, so a new inline gate added anywhere else in `admin.ts` or
 * `videos.ts` would otherwise pass CI unnoticed.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const API_SRC = join(REPO_ROOT, "artifacts/api-server/src");

/** The one module allowed to read the grid and to own the tier-keyed lookup. */
const CHOKEPOINT = "artifacts/api-server/src/lib/featureAccess.ts";

/**
 * Named, temporary exceptions. Each MUST carry the plan that will remove it —
 * an exception without an owner is just a hole. Matching is per-line (see
 * below): an entry only exempts the exact line its pattern matches.
 */
const ALLOWLIST = [
  {
    file: "artifacts/api-server/src/routes/videos.ts",
    pattern: /realUserRole === "admin"/,
    reason:
      "GET /engines' catalogue filter is an inline admin product-feature check. " +
      "Must Not Change keeps engine access untouched until Plan 3, which removes " +
      "this exception along with engine_experiments and tierRequirement.",
  },
  {
    file: "artifacts/api-server/src/lib/moderation/uploadRateLimit.ts",
    pattern: /membershipTier === "legendary"/,
    reason:
      "A NUMERIC per-tier limit (daily upload cap), not a boolean gate. Must Not " +
      "Change keeps numeric limits exactly as they are today — Plan 2's scope. " +
      "Plan 2 removes this exception when limits move into the grid.",
  },
  {
    file: "artifacts/api-server/src/routes/admin.ts",
    pattern: /membershipTier === "legendary" \? "registered"/,
    reason:
      "Membership GRANT logic in POST /admin/users, not a permission gate: it " +
      "refuses to write `legendary` directly because that tier is granted " +
      "through the entitlement model. Permanent — this is the derived-tier " +
      "invariant, not an inline role check.",
  },
  {
    file: "artifacts/api-server/src/routes/admin.ts",
    pattern: /if \(membershipTier === "legendary"\) \{/,
    reason:
      "The second half of the same POST /admin/users grant logic (Settled " +
      "decision 8): having refused to write `legendary` directly onto the new " +
      "row (the entry above), this decides whether to ALSO write the admin " +
      "grant record — because the requested tier was legendary, not because " +
      "anything is being gated. Found by round 3 of PR #425's review, which " +
      "caught the file-level allowlist letting this second occurrence of the " +
      "same pattern through unexamined. Permanent, same as the entry above.",
  },
];

// Grid tables. Reading these outside the chokepoint reintroduces the second
// vocabulary this whole architecture exists to remove.
const GRID_TABLES = [
  "tierFeaturePermissionsTable",
  "tier_feature_permissions",
];

/**
 * Inline role comparisons used as PRODUCT-FEATURE gates.
 *
 * `realUserRole`/`isRealAdmin` comparisons are NOT matched: those are the
 * privilege rail, which is supposed to be a code-level role check and must
 * never move into the grid — that separation is what makes admin lockout
 * impossible by configuration.
 *
 * `[!=]==` matches both `===` and `!==` in one pattern — round 4 of PR #425's
 * review found this guard still only matching `===`, three rounds after its
 * frontend sibling (`check-permission-chokepoint-frontend.mjs`) was fixed for
 * the identical gap in round 2: the per-line-allowlist rewrite in round 3
 * ported the matching mechanics but not this pattern. Loose `==`/`!=` aren't
 * matched: this repo's lint config forbids loose equality, so they can't
 * occur, and `!(membershipTier === "legendary")` still contains a literal
 * `===` substring the pattern already catches.
 */
const INLINE_ROLE_GATES = [
  {
    pattern: /\bisAtLeastLegendary\s*\(/,
    hint: "isAtLeastLegendary() as a product gate — use can(principal, '<feature_key>') instead",
  },
  {
    pattern: /membershipTier\s*[!=]==\s*["']legendary["']/,
    hint: "a raw membershipTier === / !== 'legendary' comparison — use can(principal, '<feature_key>') instead",
  },
  {
    pattern: /\brequireLegendary\b/,
    hint: "requireLegendary as a product gate — use requireFeature('<feature_key>') instead",
  },
];

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry === "__tests__") continue;
      walk(full, out);
    } else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Blanks out comment bodies (block and full-line) while preserving every
 * newline, so a rule NAMED in prose doesn't look like a violation AND the
 * line numbers reported below still point at the real line.
 */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ""))
    .replace(/^(\s*)\/\/.*$/gm, "$1");
}

const violations = [];
const files = walk(API_SRC);

for (const file of files) {
  const rel = relative(REPO_ROOT, file).split(sep).join("/");
  if (rel === CHOKEPOINT) continue;

  const raw = readFileSync(file, "utf8");
  const rawLines = raw.split("\n");
  const strippedSource = stripComments(raw);
  const sourceLines = strippedSource.split("\n");
  const fileAllowlist = ALLOWLIST.filter((entry) => entry.file === rel);

  // The privilege rail legitimately owns these two modules — file-level,
  // not per-line, since neither carries any allowlisted product gate at all.
  const isPrivilegeRailModule =
    rel === "artifacts/api-server/src/middlewares/tierMiddleware.ts" ||
    rel === "artifacts/api-server/src/lib/userRole.ts";

  for (let i = 0; i < sourceLines.length; i++) {
    const line = sourceLines[i];

    // 1. The tier-keyed lookup is module-private.
    if (/\bhasFeature\s*\(/.test(line)) {
      violations.push({
        file: rel,
        line: i + 1,
        message:
          "references hasFeature(). The tier-keyed lookup is private to featureAccess.ts — " +
          "ask can(principal, key) instead, so admin resolves through the grid's union " +
          "rather than through a hand-written exception.",
      });
    }

    // 2. Nothing else reads the grid tables.
    for (const table of GRID_TABLES) {
      if (line.includes(table)) {
        violations.push({
          file: rel,
          line: i + 1,
          message:
            `reads the grid directly (${table}). featureAccess.ts is the only module ` +
            "permitted to touch tier_feature_permissions.",
        });
        break;
      }
    }
  }

  // 3. No new inline role comparisons in product-feature paths.
  //
  // Scanned over the WHOLE comment-stripped source, not line by line: round 6
  // of PR #425's review demonstrated (with an injected probe) that a gate
  // formatter-wrapped across two lines — the identifier and `===` on one
  // line, `"legendary"` on the next — passed the old per-line scan even
  // though every pattern's own `\s*` already matches across newlines; the
  // per-line SPLIT, not the patterns, was what defeated them. Match offsets
  // are mapped back to the lines they span so allowlisting stays
  // occurrence-scoped rather than reverting to file-level.
  if (!isPrivilegeRailModule) {
    for (const { pattern, hint } of INLINE_ROLE_GATES) {
      const globalPattern = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
      let match;
      while ((match = globalPattern.exec(strippedSource)) !== null) {
        const startLine = strippedSource.slice(0, match.index).split("\n").length - 1;
        const endLine = strippedSource.slice(0, match.index + match[0].length).split("\n").length - 1;
        const rawSpan = rawLines.slice(startLine, endLine + 1).join("\n");

        const allowed = fileAllowlist.some((entry) => entry.pattern.test(rawSpan));
        if (!allowed) {
          violations.push({ file: rel, line: startLine + 1, message: hint });
        }

        if (globalPattern.lastIndex === match.index) globalPattern.lastIndex++;
      }
    }
  }
}

if (violations.length > 0) {
  console.error("[check-permission-chokepoint] FAILED\n");
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}\n    ${v.message}\n`);
  }
  console.error(
    "Every product-feature permission must resolve through artifacts/api-server/src/lib/featureAccess.ts.\n" +
      "See docs/plans/PLAN_ADMIN_PERMISSIONS_CORE.md and docs/ai-context/membership-entitlements.md.\n",
  );
  process.exit(1);
}

console.log(
  `[check-permission-chokepoint] OK: ${files.length} files checked, ` +
    `${ALLOWLIST.length} declared exception(s).`,
);
