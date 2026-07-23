---
name: A valid Sentry (or any third-party) API token isn't enough — the environment's egress policy must allow the host too
description: Claude Code's egress proxy can block a destination host even with a correct credential; a 403 on the CONNECT tunnel is a network-policy denial, not an auth problem.
---

Reading Sentry's API from a Claude Code session (e.g. the `/maintenance`
skill's issue read) needs **two independent things**, and a failure can look
identical from either one going wrong:

1. A `SENTRY_AUTH_TOKEN` in the environment (session env var), scoped at least
   `Issue & Event: Read` on a Sentry Internal Integration.
2. The environment's **network egress policy** allowing `sentry.io`.

**Why this is confusing:** both failure modes surface as an HTTP `403`, but
from different layers:

- A **proxy-level** 403 shows up as `curl: (56) CONNECT tunnel failed,
  response 403` (the TLS tunnel never even establishes) and is recorded in the
  proxy's own status endpoint
  (`curl "$HTTPS_PROXY/__agentproxy/status"` →
  `recentRelayFailures: [{kind: "connect_rejected", host: "sentry.io:443", ...}]`).
  This means the destination host isn't on the org's egress allowlist — a
  policy decision, not a credential problem. Per the environment's own guard
  README (`/root/.ccr/README.md`), **report it, never retry it** — retrying a
  policy denial doesn't change the answer.
- An **application-level** 403 shows up as a normal HTTP response with a body
  (e.g. `{"detail":"You do not have permission to perform this action."}`)
  after the CONNECT tunnel succeeds — that's the token's scope, not the
  network. Distinguish the two by whether `curl -v` shows `CONNECT tunnel
  established, response 200` before the 403.

**How to apply:** if a token-gated third-party API call fails with a 403 from
inside a Claude Code session, check the proxy status endpoint's
`recentRelayFailures` *before* assuming the token is wrong — it names the
exact blocked host. The fix for a policy denial is the environment owner
adding the host to the environment's network policy (via the environment
settings in the Claude Code web UI), not anything fixable from inside the
session. This generalizes beyond Sentry to any new third-party API a future
integration wants to call from this environment.
