# PR212 — Video Object IDOR (C2) — UAT

In-app acceptance test for David. This closes a privacy hole in **video
generation**: previously a user could make the server pull *someone else's*
private image and use it as the source for a video. Now the server checks that
you're allowed to read an image before it will use it.

## What changed, in plain terms

When you generate a video from one of your uploaded/private images, the server
fetches that image and hands it to the video engine. It used to do that for
**any** image path a request named — including another user's private upload.
Now it first confirms the image is yours (or public) and refuses with a "no
access" error otherwise.

## How to check it (happy path still works)

1. **Generate a video from your own uploaded image** (the normal Legendary
   flow): pick/upload an image, start a video → it works exactly as before.
2. **Generate a video from a public/template image** → still works.

## What you should NOT be able to do

- Use another user's **private** image as a video source. (This isn't something
  the normal UI lets you do — it required hand-crafting a request with someone
  else's storage path — but the server now refuses it with a 403 regardless.)

## Regression smoke table

| Flow | Expect |
|------|--------|
| Legendary generates video from own uploaded image | Works |
| Legendary generates video from a public/template image | Works |
| Generate from own image via base64 upload | Works |
| Viewing / serving your own private images elsewhere in the app | Unchanged |
| (Crafted) generate from another user's private storage path | **403 "You don't have access to that image."** |

## Known non-bugs / limitations

- **Public images are still usable by anyone** — that's intended; the fix only
  protects **private** images.
- If you ever get a "no access" error generating a video from an image that is
  genuinely **yours**, that's a bug — report it (older uploads that predate
  access-control tagging are covered by an ownership fallback, so this
  shouldn't happen, but flag it if it does).
- This PR only covers the **video generator**. Private-meme page/link privacy is
  a separate change (tracked as C3 / PR-2B).

## Bug report template

```
Flow: (which row of the table)
Steps: (what you did)
Expected: (from the table)
Actual: (what happened)
Account/role: (registered / legendary / admin)
Image: (your own upload / public template / other)
Environment: (production / Replit preview)
```
