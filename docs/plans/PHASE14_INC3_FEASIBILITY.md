# Launch Phase 14, increment 3 — feasibility record

The inventory and measurements increment 3's feasibility step owes
(`PLAN_PHASE14_COMPLIANCE.md`, increment 3; S-d, S-e, S-e2). Taken
2026-11-18. Dashboard facts are David's screens in the Cloudflare and Google
Analytics dashboards; outside measurements are `curl -sS -D -` from a cloud
container.

## The app's files (S-e2): done

- The published app's pages are served by `artifacts/overhype-me/server/serve.mjs`
  (PR #1049, PR #1050), not Replit's static service. Proven after David's
  publish of 2026-11-18: a missing `/assets/x.js` answers 404 `text/plain` on
  both `overhype.me` and `overhypeme.replit.app`.
- So the origin-secret check goes into `serve.mjs` as well as the API, with the
  platform health check exempt. Replit's private deployment is not needed.

## Origin inventory

| Address | What answers | Measured | After increment 3 |
| --- | --- | --- | --- |
| `overhype.me` | Cloudflare → Replit | `HTTP/2 200`, `server: cloudflare`, `cf-cache-status: DYNAMIC` (page and `/api/healthz`) | redirect rule, then origin secret |
| `www.overhype.me` | Cloudflare redirect rule "Redirect from WWW to root [Template]" | `HTTP/2 301`, `location: https://overhype.me/` | unchanged |
| `overhypeme.replit.app` | Replit directly | `HTTP/2 200`, `server: Google Frontend` | refused: no origin secret |
| og-router Worker's `*.workers.dev` | — | not enabled: the Worker's Domains tab lists only its three `overhype.me` routes (`/m/*`, `/api/og/*`, `/api/memes/*`) | nothing to close |
| dev preview `*.spock.replit.dev` | Replit | publicly addressable: `HTTP/1.1 502`, `Replit-Cluster: spock`, while the dev app was not running | measured while running: see below |

The dev preview row's reachability while the dev app runs is still to be
measured. If it serves the app publicly it is protected in increment 3, not
accepted (plan, *Risks*).

## Cache (S-e2)

- Probes of stored-object addresses (`/api/storage/public-objects/<x>.png`,
  `/api/storage/objects/<x>.jpg`, twice each) answered `cf-cache-status:
  BYPASS`; an extensionless `/api/storage/objects/uploads/<x>` and `/m/<x>`
  answered `DYNAMIC`.
- Every origin response sets cookies (`csrf_token` from the app, `GAESA` from
  the platform), and Cloudflare does not cache a response that sets a cookie
  (Cloudflare docs, *Investigating uncached responses*, read 2026-11-18). That
  is why the public-object route's `public, s-maxage=86400` does not lead to
  edge caching today.
- `unable to verify: a 200 for a real stored object` — production holds no
  facts or pictures (`GET /api/facts` → `{"facts":[],"total":0}`). The cookie
  explanation predicts the same result for a 200.
- Consequence for the design: nothing rests on the cookie. The region and
  country refusal runs in the redirect phase, ahead of every cache (below), so
  a later change that makes a response cacheable cannot serve it to a refused
  visitor.

## What the Free plan offers (S-d)

| Feature | Free | Evidence |
| --- | --- | --- |
| Redirect rules | 10 (1 used: WWW) | Cloudflare docs, *URL forwarding: Availability*; dashboard "1 out of 10" |
| Country field in a redirect | yes | dashboard builder offers *Country* (`ip.src.country`) |
| Region field in a redirect | yes, typed in the expression editor | probe rule `(ip.src.region_code eq "43" and ip.src.country eq "ZZ")` deployed and enabled on the `free` zone 2026-11-18, then deleted; the builder's dropdown does not list it |
| Subdivision fields (`ip.src.subdivision_1_iso_code`) | no | docs: "Requires a Cloudflare Business or Enterprise plan" |
| Transform Rules | 10 active | docs, *Transform Rules: Availability* |
| *Add visitor location headers* (`cf-ipcountry`, `cf-region-code`) | yes; does not count against the 10 | docs, *Managed Transforms* |
| Request header set by a Transform Rule | any name not starting `cf-` / `x-cf-` | docs, *Request Header Transform Rules* |

### Design consequence (taken on recommendation, 2026-11-18)

Redirect rules run before Workers and the cache, so one redirect rule refuses
both the blocked countries and the three Ukrainian regions for every address,
the Worker's routes included. The Worker's own region check (S-d) is dropped.
The API keeps a region check on requests carrying the origin secret, as the
backstop S-e describes. Undo: restore the Worker check.

## Mail (Q9)

Cloudflare Email Routing for `overhype.me`: `legal@`, `support@`, `privacy@`
and `copyright@` all Active, forwarding to David's inbox (`privacy@` and
`copyright@` created 2026-11-18). Catch-all disabled.

## Google Analytics

Web stream "Overhype.me", Enhanced measurement: *Page changes based on browser
history events* unticked and *Site search* off (2026-11-18), so page views come
only from the app's own cleaned `page_location`, and Google never reads search
words from the address.

## Dev data check (PR #1056's build report)

Dev `image_prompt_attempts`, one failed and one finished row: `error`,
`identity_policy` and `generated_image_object_path` hold no name or appearance
description. `render_controls` holds a name — the moderation preview subject
(`reviewRenderSubject`), set only on admin moderation renders, which have no
owner (`routes/reviews.ts`: `userId: null`). No member's name survives the
account purge there.
