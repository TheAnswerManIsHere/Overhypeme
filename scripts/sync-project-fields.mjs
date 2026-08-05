#!/usr/bin/env node
/**
 * Mirror an issue's workstream labels into the Projects v2 board's fields.
 *
 * The board is the surface David scans to answer "where is each workstream and
 * which ones need me". Its Status / Waiting on / Mode fields are the columns he
 * groups and filters by — but no available MCP or REST tool can write a
 * Projects v2 field value, so an agent updating an issue can only reach the
 * board through labels. This script closes that gap: labels are the writable
 * truth, and this turns them into field values.
 *
 * Label -> field mapping is by PREFIX, and the option is resolved by NAME at
 * run time rather than by a hardcoded node ID, so renaming an option (or adding
 * a stage) in the project UI does not silently stop the sync. Matching is
 * normalized, so the label `stage:plan-approval` finds the option
 * "🛑 Plan approval" and `stage:test-run` finds "Test run (Replit)".
 *
 * Fails loudly on anything it cannot map. A board that silently stops tracking
 * is worse than no board — it reads as "nothing needs you" either way.
 *
 * Auth: Projects v2 is unreachable from GITHUB_TOKEN (repo-scoped), and
 * fine-grained PATs have no account-level Projects permission at all, so a
 * user-owned project requires a classic PAT with the `project` scope. That
 * token is used ONLY for the GraphQL calls here; issue reads go through the
 * ordinary GITHUB_TOKEN so the PAT never needs `repo`.
 */

const GRAPHQL = "https://api.github.com/graphql";

/** Label prefix -> project field name. Order is the order fields are written. */
export const LABEL_FIELDS = [
  { prefix: "stage:", field: "Status" },
  { prefix: "waiting:", field: "Waiting on" },
  { prefix: "mode:", field: "Mode" },
];

/**
 * Collapse a label value or option name to a comparable form: drop
 * parentheticals ("Test run (Replit)" -> "test run"), then reduce everything
 * that is not a letter or digit — emoji, hyphens, punctuation — to single
 * spaces. This is what lets the labels stay plain ASCII while the board's
 * option names carry the 🛑 marker David scans for.
 */
export function normalize(value) {
  return String(value)
    .replace(/\([^)]*\)/g, " ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Reduce an issue's labels to the field writes they imply. Every configured
 * field is always represented — `wanted: null` means "no matching label,
 * clear this field" — so a removed `waiting:*` label (an `unlabeled` event
 * with nothing to replace it) clears the board's stale owner instead of
 * leaving it untouched. Labels are the source of truth; the board must never
 * be able to disagree with them by omission.
 *
 * Throws when a prefix appears more than once — two `stage:` labels means the
 * issue is in two places at once, and guessing which one wins would put a
 * wrong-but-confident value on the board.
 */
export function labelsToFieldValues(labels) {
  const names = labels.map((l) => (typeof l === "string" ? l : l.name));

  return LABEL_FIELDS.map(({ prefix, field }) => {
    const hits = names.filter((n) => n.startsWith(prefix));
    if (hits.length > 1) {
      throw new Error(
        `${hits.length} "${prefix}" labels (${hits.join(", ")}) — exactly one expected`,
      );
    }
    return { field, wanted: hits.length === 1 ? hits[0].slice(prefix.length) : null };
  });
}

/** Find a single-select option whose name normalizes to `wanted`. */
export function resolveOption(fieldDef, wanted) {
  const want = normalize(wanted);
  const hit = fieldDef.options.find((o) => normalize(o.name) === want);
  if (!hit) {
    const available = fieldDef.options.map((o) => `"${o.name}"`).join(", ");
    throw new Error(
      `no option on field "${fieldDef.name}" matches "${wanted}" — available: ${available}`,
    );
  }
  return hit.id;
}

/**
 * Find a field definition whose name normalizes to `name`. Case-insensitive
 * for the same reason `resolveOption` is: the field was created by hand in
 * the project UI ("Waiting On", not "Waiting on" as configured here), and an
 * exact-string match turned that harmless casing difference into every
 * workstream failing to sync on the very first real run.
 */
export function resolveField(fields, name) {
  const want = normalize(name);
  const hit = fields.find((f) => normalize(f.name) === want);
  if (!hit) {
    const available = fields.map((f) => `"${f.name}"`).join(", ");
    throw new Error(
      `project has no single-select field named "${name}" — available: ${available}`,
    );
  }
  return hit;
}

async function graphql(query, variables, token) {
  const res = await fetch(GRAPHQL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    const hint =
      res.status === 401 || res.status === 403
        ? "\n  PROJECTS_TOKEN must be a CLASSIC personal access token with the `project` scope." +
          "\n  Fine-grained tokens cannot reach a user-owned project at all."
        : "";
    throw new Error(`GraphQL HTTP ${res.status}: ${await res.text()}${hint}`);
  }

  const body = await res.json();
  if (body.errors?.length) {
    throw new Error(`GraphQL: ${body.errors.map((e) => e.message).join("; ")}`);
  }
  return body.data;
}

export async function fetchProject(owner, number, token) {
  const data = await graphql(
    `query ($login: String!, $number: Int!) {
      user(login: $login) {
        projectV2(number: $number) {
          id
          title
          fields(first: 50) {
            nodes {
              ... on ProjectV2SingleSelectField {
                id
                name
                options { id name }
              }
            }
          }
        }
      }
    }`,
    { login: owner, number },
    token,
  );

  const project = data.user?.projectV2;
  if (!project) {
    throw new Error(`no project number ${number} owned by user "${owner}"`);
  }

  // Non-single-select fields (title, assignees, dates) come back as empty
  // objects through this fragment; drop them.
  project.fields = project.fields.nodes.filter((f) => f?.name && f.options);
  return project;
}

/** Add the issue to the project. Idempotent — returns the existing item if present. */
async function ensureItem(projectId, contentId, token) {
  const data = await graphql(
    `mutation ($project: ID!, $content: ID!) {
      addProjectV2ItemById(input: { projectId: $project, contentId: $content }) {
        item { id }
      }
    }`,
    { project: projectId, content: contentId },
    token,
  );
  return data.addProjectV2ItemById.item.id;
}

async function writeField(projectId, itemId, fieldId, optionId, token) {
  await graphql(
    `mutation ($project: ID!, $item: ID!, $field: ID!, $option: String!) {
      updateProjectV2ItemFieldValue(input: {
        projectId: $project
        itemId: $item
        fieldId: $field
        value: { singleSelectOptionId: $option }
      }) {
        projectV2Item { id }
      }
    }`,
    { project: projectId, item: itemId, field: fieldId, option: optionId },
    token,
  );
}

async function clearField(projectId, itemId, fieldId, token) {
  await graphql(
    `mutation ($project: ID!, $item: ID!, $field: ID!) {
      clearProjectV2ItemFieldValue(input: {
        projectId: $project
        itemId: $item
        fieldId: $field
      }) {
        projectV2Item { id }
      }
    }`,
    { project: projectId, item: itemId, field: fieldId },
    token,
  );
}

/**
 * REST GET, following `Link: rel="next"` pagination until exhausted. Without
 * this a repo whose open-issue count crosses a page boundary would silently
 * drop later workstreams from a full reconcile — the exact failure mode this
 * board exists to prevent, just moved one layer down.
 */
export async function restAll(path, token) {
  const results = [];
  let next = `https://api.github.com${path}`;

  while (next) {
    const res = await fetch(next, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
      },
    });
    if (!res.ok) {
      throw new Error(`REST ${next} -> HTTP ${res.status}: ${await res.text()}`);
    }
    results.push(...(await res.json()));

    const link = res.headers.get("link") ?? "";
    const nextMatch = link.split(",").find((part) => part.includes('rel="next"'));
    next = nextMatch ? nextMatch.trim().match(/^<(.*)>/)?.[1] : undefined;
  }

  return results;
}

async function rest(path, token) {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
    },
  });
  if (!res.ok) {
    throw new Error(`REST ${path} -> HTTP ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

/**
 * Sync one issue. Returns a one-line summary of what was written.
 *
 * Runs even when every field resolves to `null` — an issue that just lost its
 * last workstream label still needs its stale Status/Waiting on/Mode values
 * cleared from a board row that already exists. Skipping here would leave
 * exactly the stale-value bug this script exists to prevent, just for the
 * all-labels-removed case instead of the some-labels-removed case.
 */
export async function syncIssue(issue, project, token) {
  const writes = labelsToFieldValues(issue.labels);

  // Resolve every option BEFORE writing anything, so a typo in one label can't
  // leave the board half-updated and internally inconsistent. A `null` wanted
  // value needs no option — it clears the field instead of setting one.
  const resolved = writes.map(({ field, wanted }) => {
    const fieldDef = resolveField(project.fields, field);
    const optionId = wanted === null ? null : resolveOption(fieldDef, wanted);
    return { fieldDef, optionId, wanted };
  });

  const itemId = await ensureItem(project.id, issue.node_id, token);
  for (const { fieldDef, optionId } of resolved) {
    if (optionId === null) {
      await clearField(project.id, itemId, fieldDef.id, token);
    } else {
      await writeField(project.id, itemId, fieldDef.id, optionId, token);
    }
  }

  const summary = resolved
    .map((r) => `${r.fieldDef.name}=${r.wanted === null ? "(cleared)" : r.wanted}`)
    .join(", ");
  return `#${issue.number} — ${summary}`;
}

async function main() {
  const projectsToken = process.env.PROJECTS_TOKEN;
  const githubToken = process.env.GITHUB_TOKEN;
  const owner = process.env.PROJECT_OWNER;
  const number = Number(process.env.PROJECT_NUMBER);
  const repository = process.env.GITHUB_REPOSITORY;
  const only = process.env.ISSUE_NUMBER;

  const missing = Object.entries({
    PROJECTS_TOKEN: projectsToken,
    GITHUB_TOKEN: githubToken,
    PROJECT_OWNER: owner,
    PROJECT_NUMBER: process.env.PROJECT_NUMBER,
    GITHUB_REPOSITORY: repository,
  })
    .filter(([, v]) => !v)
    .map(([k]) => k);

  if (missing.length) {
    // A guard that silently passes when its inputs are absent is not a guard.
    throw new Error(`missing required environment: ${missing.join(", ")}`);
  }

  const project = await fetchProject(owner, number, projectsToken);

  const issues = only
    ? [await rest(`/repos/${repository}/issues/${only}`, githubToken)]
    : (await restAll(`/repos/${repository}/issues?state=open&per_page=100`, githubToken)).filter(
        // The issues endpoint returns PRs too; they are artifacts of a
        // workstream, not workstreams, and never belong on this board.
        (i) => !i.pull_request,
      );

  console.log(`Project "${project.title}" (#${number}) — syncing ${issues.length} issue(s)\n`);

  const failures = [];
  for (const issue of issues) {
    try {
      console.log(`  ✓ ${await syncIssue(issue, project, projectsToken)}`);
    } catch (err) {
      failures.push(`#${issue.number}: ${err.message}`);
      console.error(`  ✗ #${issue.number} — ${err.message}`);
    }
  }

  if (failures.length) {
    console.error(
      `\n✗ ${failures.length} issue(s) did not sync. Each label must match a project` +
        `\n  option by name (emoji, hyphens, and parentheticals are ignored when matching).\n`,
    );
    process.exitCode = 1;
    return;
  }

  console.log(`\n✓ ${issues.length} issue(s) in sync with the board.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`✗ ${err.message}`);
    process.exitCode = 1;
  });
}
