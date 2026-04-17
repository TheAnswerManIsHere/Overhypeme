# Sentry — Configuration & Verification Guide

This project sends three different kinds of telemetry to Sentry, and they
land in **three different places** in the Sentry UI. Most "Sentry isn't
working" reports turn out to be looking in the wrong tab.

## Where each event type appears in Sentry

| What you do | Where it shows up in Sentry |
|---|---|
| Throw an uncaught exception in the browser | **Issues** tab (frontend project) |
| Call `Sentry.captureException(err)` in the browser | **Issues** tab (frontend project) |
| Throw inside an Express handler | **Issues** tab (backend project) |
| Submit the floating "Report a Bug" widget | **User Feedback** tab (frontend project) |
| A page navigation / API call (sampled) | **Performance** / **Traces** tab |

The **User Feedback** tab is a separate inbox from **Issues**. Submitting
the bug-report widget does **not** create an Issue and is **not** an error —
that's by design. If you don't see your test in Issues, check User Feedback.

## Two Sentry projects, one org

| Project | Receives events from | DSN env var |
|---|---|---|
| Frontend (`SENTRY_PROJECT_FRONTEND`) | The Vite/React bundle in the browser | `VITE_SENTRY_DSN` |
| Backend (`SENTRY_PROJECT_BACKEND`) | The Express API server | `SENTRY_DSN_BACKEND` |

Both projects belong to `SENTRY_ORG`. Source-map upload uses
`SENTRY_AUTH_TOKEN` and is enabled automatically when all three secrets are
present (see `vite.config.ts` and `artifacts/api-server/build.mjs`).

## Environment tagging (dev vs prod)

Every event is tagged with an `environment` value so you can filter dev
noise out of production dashboards:

| Code path | Source | Resolves to |
|---|---|---|
| `artifacts/overhype-me/src/lib/sentry.ts` | `import.meta.env.PROD` | `production` in built bundles, `development` under `vite dev` |
| `artifacts/api-server/src/instrument.ts` | `process.env.NODE_ENV === "production"` | `production` only on deployed builds, `development` locally |

In Sentry's left filter sidebar, set **Environment = production** to hide
all dev noise.

## Release naming

Release names are derived from the same expression on both ends:

```
process.env.REPLIT_DEPLOYMENT_ID ?? process.env.REPLIT_GIT_COMMIT_SHA?.slice(0,7) ?? "dev"
```

- In **deployments** the release is the deploy ID — every redeploy gets a
  fresh release, and source maps are uploaded under that release name so
  stack traces symbolicate.
- In **local dev** the release is `"dev"` — events are still captured (if
  you set the DSNs locally) but stack traces won't be symbolicated.

The frontend release is injected into the bundle via
`process.env.VITE_SENTRY_RELEASE` from `vite.config.ts`. The vite plugin
uploads source maps under the same name. **If these two values ever drift,
production stack traces will not symbolicate.**

## How to verify Sentry after a deploy

There's an admin-only **"Sentry diagnostics"** card on the admin dashboard
(`/admin`). It shows the live DSN-configured / environment / release values
for both frontend and backend, and four buttons that each produce a
distinct, debug-tagged event:

1. **Throw frontend exception** — render-throws an `Error`. The
   `Sentry.ErrorBoundary` catches it, swaps in the fallback UI, and reports
   it. Reload the page to recover.
2. **Send handled frontend exception** — calls `Sentry.captureException`
   directly. UI keeps working; an Issue still appears in Sentry.
3. **Trigger backend exception** — `POST /api/admin/_debug/sentry`. The
   route throws synchronously; the Express error handler ships it to
   Sentry. The browser sees an HTTP 500, which is expected.
4. **Open feedback widget** — opens the bug-report dialog programmatically.
   Submitting it sends to **User Feedback**, not Issues.

The first three events (1, 2, 3) are tagged `debug=sentry-test`, so you
can filter them in the Sentry UI search:

```
debug:sentry-test
```

Feedback submissions (4) go to a separate inbox (**User Feedback**) and
do **not** carry the `debug` tag — Sentry's feedback transport doesn't
expose a tagging hook on the form-submit path. To find your test
submission, look in User Feedback rather than Issues.

### Verification checklist

After every meaningful deploy:

- [ ] Open `/admin` on the deployed site and confirm both DSNs show
  **configured**, environment shows **production**, and release shows
  the new deploy ID.
- [ ] Click each of the four diagnostics buttons.
- [ ] In the **frontend** Sentry project: confirm two new Issues appear
  (the thrown one + the handled one), tagged `environment:production` and
  with the matching release. Stack traces should be symbolicated (not
  raw minified `chunk-abc123.js:1:18421`).
- [ ] In the **backend** Sentry project: confirm one new Issue from
  `POST /admin/_debug/sentry`, tagged `environment:production`.
- [ ] In the **User Feedback** tab of the frontend project: confirm your
  feedback submission appears.
- [ ] Repeat against the dev preview to confirm `environment:development`
  tagging.

### Suppressing test events in production

If you want to keep the diagnostics buttons usable on a deployment without
actually reporting test events to Sentry, set:

- `VITE_DROP_DEBUG_EVENTS=true` (build-time, frontend)
- `SENTRY_DROP_DEBUG_EVENTS=true` (runtime, backend)

Both are gated by the `debug=sentry-test` tag, so only the four diagnostics
events are dropped — real production errors are unaffected.
