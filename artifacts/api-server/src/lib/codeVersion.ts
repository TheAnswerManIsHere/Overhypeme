/**
 * @purpose The code version a picture was made under (image tracing, plan docs/plans/PLAN_IMAGE_TRACING.md, Settled Decision 6): the full source commit, its date and subject, and the deployment id. The production bundle carries them as constants `build.mjs` writes at build time; a dev or test run reads git once, and a run with neither reports itself as unversioned rather than inventing a version.
 *
 * Overhype.me keeps no hand-numbered version: the commit pins the meme
 * generator, the prompt compiler and every other piece of code at once, so a
 * separate number would be a second source of truth for the same fact
 * (David, 2026-11-10). The subject is the pull request's title for a squash
 * merge, which is what makes the version readable on the trace screen.
 */
import { execFileSync } from "node:child_process";
import { logger } from "./logger";
import { isProductionEnv } from "./env";

export interface CodeVersion {
  /** Full 40-character commit, or null for an unversioned run. */
  commit: string | null;
  committedAt: Date | null;
  title: string | null;
  deploymentId: string | null;
}

// Replaced by esbuild's `define` in the production bundle (build.mjs). Under
// tsx they are plain property reads that return undefined.
const BUILT_COMMIT = process.env.OVERHYPE_SOURCE_COMMIT;
const BUILT_COMMIT_AT = process.env.OVERHYPE_SOURCE_COMMIT_AT;
const BUILT_COMMIT_TITLE = process.env.OVERHYPE_SOURCE_COMMIT_TITLE;

const FULL_SHA = /^[0-9a-f]{40}$/;

let cached: CodeVersion | null = null;

function fromGit(): Pick<CodeVersion, "commit" | "committedAt" | "title"> {
  try {
    const out = execFileSync("git", ["log", "-1", "--format=%H%n%cI%n%s"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    }).trim().split("\n");
    if (FULL_SHA.test(out[0] ?? "")) {
      return { commit: out[0]!, committedAt: out[1] ? new Date(out[1]) : null, title: out[2] ?? null };
    }
  } catch {
    // No git, or not a checkout: an unversioned run.
  }
  return { commit: null, committedAt: null, title: null };
}

/** The version this process was built from. Computed once per process. */
export function codeVersion(): CodeVersion {
  if (cached) return cached;
  const deploymentId = process.env.REPLIT_DEPLOYMENT_ID ?? null;
  if (BUILT_COMMIT && FULL_SHA.test(BUILT_COMMIT)) {
    cached = {
      commit: BUILT_COMMIT,
      committedAt: BUILT_COMMIT_AT ? new Date(BUILT_COMMIT_AT) : null,
      title: BUILT_COMMIT_TITLE || null,
      deploymentId,
    };
  } else {
    cached = { ...fromGit(), deploymentId };
  }
  if (!cached.commit && isProductionEnv()) {
    // A production record without a known commit is a defect (plan, Settled 6).
    logger.error("[codeVersion] the published server carries no source commit; provenance records will say unversioned");
  }
  return cached;
}

/** The columns every provenance and generation-request row carries. */
export function codeVersionColumns(): {
  sourceCommit: string | null;
  sourceCommitAt: Date | null;
  sourceCommitTitle: string | null;
  deploymentId: string | null;
} {
  const v = codeVersion();
  return { sourceCommit: v.commit, sourceCommitAt: v.committedAt, sourceCommitTitle: v.title, deploymentId: v.deploymentId };
}

/** Test seam: forget the cached version. */
export function resetCodeVersionForTest(): void {
  cached = null;
}
