# No GitHub label-creation tool in this environment's MCP surface

The GitHub MCP server available here (Claude Code on the web) has `get_label`
but no `create_label` or `update_label` call — confirmed by exhausting
`ToolSearch` for every label-management keyword and by `get_label` 404ing on
a genuinely nonexistent label name (`queue:now`, before it existed) rather
than the request silently no-opping.

**This blocks any workflow that introduces a new label convention.** Adding
a label to an issue via `issue_write` requires the label to already exist in
the repo — GitHub's API does not auto-create it — so a new `stage:`/
`waiting:`/`mode:`/`queue:`-style prefix needs a human to create the actual
labels through the GitHub web UI (repo → **Issues** tab → **Labels** button,
top right) before any agent can apply them.

**Avoid:** assuming label creation is automatable and discovering the gap
mid-task. If a plan or build introduces a new label family, flag the
creation step to David up front — it's a two-minute manual task, but it's a
hard blocker until done, and finding out partway through a retrofit (as
happened building `/next`'s `queue:` labels, PR #453) costs a round-trip
that a one-line heads-up at design time would have avoided.
