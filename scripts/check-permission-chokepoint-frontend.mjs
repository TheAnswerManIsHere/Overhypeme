#!/usr/bin/env node
/**
 * The frontend half of the permission chokepoint guard.
 * ────────────────────────────────────────────────────────────────────────────
 * "The wrong call must become impossible, not merely discouraged."
 *
 * PR #402's bug class isn't only a backend shape: the client contract
 * ("told, not derived" — `useAuth()` exposes a server-resolved
 * `entitlements` map and `can(featureKey)`) exists precisely so the client
 * never re-derives a product-feature gate from `tier`/`role` on its own. A
 * NEW `tier === "legendary"` (or `role === "legendary"`, or
 * `membershipTier === "legendary"`) guarding what renders or what a user can
 * do is the same two-vocabulary shape PR #402 shipped with, just on the
 * other side of the wire — and PR #425's review round found six of them
 * already in the tree.
 *
 * This guard does NOT flag `role === "admin"` (or `isRealAdmin`-style
 * checks). Those are the privilege rail — operational/debug UI, not a
 * product entitlement — and the backend guard draws the identical line for
 * `realUserRole`/`isRealAdmin`.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO. Membership-status *display* (a badge,
 * a settings-panel label, an admin tier column) legitimately reads tier —
 * that's describing the account, not gating a feature. Rather than try to
 * infer "display vs. gate" from syntax, this guard names each legitimate
 * display site explicitly in the allowlist, the same discipline the backend
 * guard uses for its own three exceptions. A pattern with no matching
 * allowlist entry fails the build.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const FRONTEND_SRC = join(REPO_ROOT, "artifacts/overhype-me/src");

/**
 * Named, permanent exceptions — membership-status display, UX-default
 * pickers, and the one identity-mapper chokepoint that legitimately derives
 * a legacy tier label from `role`. Each carries why it isn't a product
 * gate, mirroring the backend guard's ALLOWLIST discipline.
 */
const ALLOWLIST = [
  {
    file: "artifacts/overhype-me/src/components/meme-builder/integration/studioAdapter.ts",
    pattern: /role === "legendary" \|\| role === "admin"\) return "legendary"/,
    reason:
      "roleToIdentity() is the identity-prerequisite mapper itself — it collapses " +
      "role into a legacy tier label for downstream UX-default pickers, and " +
      "deliberately does not gate any feature. The actual gates it feeds (AI " +
      "stylize, video) resolve through can().",
  },
  {
    file: "artifacts/overhype-me/src/pages/memePage/useViewerCell.ts",
    pattern: /role === "legendary" \|\| role === "admin"/,
    reason: "Membership badge on the meme detail view — status display, not a feature gate.",
  },
  {
    file: "artifacts/overhype-me/src/components/layout/AccountMenu.tsx",
    pattern: /role === "legendary" \|\| role === "admin"/,
    reason: "UserAvatar crown/ring styling — status display, not a feature gate.",
  },
  {
    file: "artifacts/overhype-me/src/pages/Profile.tsx",
    pattern: /role === "legendary" \|\| role === "admin"/,
    reason: "isLegendaryMember profile badge — status display, not a feature gate.",
  },
  {
    file: "artifacts/overhype-me/src/pages/Profile.tsx",
    pattern: /data\.tier === "legendary"/,
    reason:
      "Stripe checkout-completion polling reads the tier the webhook already " +
      "wrote, to know when to stop polling and refresh — it doesn't gate a " +
      "feature, it detects that a write finished.",
  },
  {
    file: "artifacts/overhype-me/src/components/SubscriptionPanel.tsx",
    pattern: /membershipTier === "legendary"/,
    reason: "Billing-panel membership status display, not a feature gate.",
  },
  {
    file: "artifacts/overhype-me/src/pages/admin/users.tsx",
    pattern: /tier === "legendary"/,
    reason: "Admin user-list tier badge/label rendering, not a feature gate.",
  },
  {
    file: "artifacts/overhype-me/src/pages/admin/users.tsx",
    pattern: /membershipTier === "legendary"/,
    reason: "Admin user-list tier badge/label rendering, not a feature gate.",
  },
  {
    file: "artifacts/overhype-me/src/components/meme-builder/behaviorMatrix.ts",
    pattern: /const granted = tier === "legendary"/,
    reason:
      "demoEntitlementsForTier() is a test/demo-only fixture generator (the matrix " +
      "harness and the enumerateMatrix() test helper) — production behavior reads " +
      "entitlementsFromViewerContext() off the server-resolved grid, never this " +
      "function.",
  },
  {
    file: "artifacts/overhype-me/src/components/meme-builder/wizard/step2-image/SourceSegmentedControl.tsx",
    pattern: /if \(tier === "legendary"\) return "ai-you"/,
    reason:
      "pickDefaultSourceTab() only picks which tab shows first — a UX default, not " +
      "a gate. The control's actual lock reads canPulidStylize, the resolved " +
      "entitlement.",
  },
];

/**
 * Inline tier/role comparisons used as PRODUCT-FEATURE gates. `role ===
 * "admin"` is deliberately NOT matched — that's the privilege rail.
 */
const INLINE_TIER_GATES = [
  {
    pattern: /\bmembershipTier\s*===\s*["']legendary["']/,
    hint: "a raw membershipTier === 'legendary' comparison — use can('<feature_key>') instead",
  },
  {
    pattern: /\btier\s*===\s*["']legendary["']/,
    hint: "a raw tier === 'legendary' comparison — use can('<feature_key>') instead",
  },
  {
    pattern: /\brole\s*===\s*["']legendary["']/,
    hint: "a raw role === 'legendary' comparison — use can('<feature_key>') instead",
  },
];

const SKIP_DIRS = new Set(["node_modules", "__tests__", "__demo__"]);
const SKIP_FILE = /\.(test|draft\.test|stories)\.(ts|tsx)$/;

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (SKIP_DIRS.has(entry)) continue;
      walk(full, out);
    } else if (/\.(ts|tsx)$/.test(entry) && !entry.endsWith(".d.ts") && !SKIP_FILE.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/** Strips comments so a rule NAMED in prose doesn't look like a violation. */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const violations = [];
const files = walk(FRONTEND_SRC);

for (const file of files) {
  const rel = relative(REPO_ROOT, file).split(sep).join("/");
  const raw = readFileSync(file, "utf8");
  const source = stripComments(raw);

  for (const { pattern, hint } of INLINE_TIER_GATES) {
    if (!pattern.test(source)) continue;

    const allowed = ALLOWLIST.some((entry) => entry.file === rel && entry.pattern.test(raw));
    if (allowed) continue;

    violations.push({ file: rel, message: hint });
  }
}

if (violations.length > 0) {
  console.error("[check-permission-chokepoint-frontend] FAILED\n");
  for (const v of violations) {
    console.error(`  ${v.file}\n    ${v.message}\n`);
  }
  console.error(
    "Every product-feature gate must resolve through useAuth().can('<feature_key>') — " +
      "told by the server, not derived from tier/role client-side.\n" +
      "See docs/plans/PLAN_ADMIN_PERMISSIONS_CORE.md and docs/ai-context/membership-entitlements.md.\n",
  );
  process.exit(1);
}

console.log(
  `[check-permission-chokepoint-frontend] OK: ${files.length} files checked, ` +
    `${ALLOWLIST.length} declared exception(s).`,
);
