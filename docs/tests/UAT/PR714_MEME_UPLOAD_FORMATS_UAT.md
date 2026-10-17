# PR #714 — PNG and WebP photos upload in the meme builder — UAT

**Workstream:** #702

The meme builder's "upload your own photo" zone offered JPEG, PNG and WebP, but the server accepts JPEG only, so a PNG or WebP was refused as "invalid format" after it had already uploaded. The builder now turns a PNG or WebP into a JPEG in your browser before sending it. A JPEG still goes up untouched. The small thumbnail now shows the converted image, so what you see is what was stored.

A transparent area in a PNG or WebP, such as a background-removed cutout, becomes black. That is how every other upload in the app already treats transparency, and whether it should change product-wide is your open question in #717, not this fix. Every step below is checked by a machine, so nothing here needs you.

## Setup

None. Every step is an automated check: the unit tests run in the per-PR gate, and the real-browser conversion runs in CI's described-screens suite against the dev server.

## Steps

### 1. A PNG is sent as a JPEG

**Do:** Upload a PNG through the meme builder's upload zone.

**Expect:** The request to `/api/storage/upload-meme` carries `Content-Type: image/jpeg` and the converted bytes, and the zone reaches ready.

**Lane:** ci

**Check:** `artifacts/overhype-me/src/components/meme-builder/__tests__/useUploadModeration.test.ts:converts image/png to JPEG before uploading (#702)`

### 2. A WebP is sent as a JPEG

**Do:** Upload a WebP through the meme builder's upload zone.

**Expect:** The same as step 1: sent as `image/jpeg`, and the zone reaches ready.

**Lane:** ci

**Check:** `artifacts/overhype-me/src/components/meme-builder/__tests__/useUploadModeration.test.ts:converts image/webp to JPEG before uploading (#702)`

### 3. The browser really produces a JPEG under the limit

**Do:** In a real Chromium, convert a PNG and a WebP that the browser itself drew, using the app's own conversion helper.

**Expect:** Each result is `image/jpeg`, starts with the JPEG marker `ffd8`, and is no larger than 15 MB.

**Lane:** ci

**Check:** `artifacts/overhype-me/e2e/uploadConversion.spec.ts:a image/png becomes a JPEG under the 15 MB limit` `artifacts/overhype-me/e2e/uploadConversion.spec.ts:a image/webp becomes a JPEG under the 15 MB limit`

### 4. Transparency becomes black, and colour is kept

**Do:** In a real Chromium, convert a PNG whose left half is solid red and whose right half is fully transparent.

**Expect:** The formerly transparent area reads as opaque black, and the red half stays red.

**Lane:** ci

**Check:** `artifacts/overhype-me/e2e/uploadConversion.spec.ts:a transparent region becomes black and an opaque region keeps its colour`

### 5. The thumbnail shows what was stored

**Do:** Upload a PNG, then a JPEG.

**Expect:** The thumbnail for the PNG is made from the converted JPEG that was sent; the thumbnail for the JPEG is made from the file itself.

**Lane:** ci

**Check:** `artifacts/overhype-me/src/components/meme-builder/__tests__/useUploadModeration.test.ts:builds the preview from the converted JPEG for a PNG, and from the file itself for a JPEG`

### 6. A converted file still over 15 MB is refused before upload

**Do:** Upload a WebP whose converted JPEG is still over 15 MB.

**Expect:** The zone shows the too-large error and nothing is sent to the server.

**Lane:** ci

**Check:** `artifacts/overhype-me/src/components/meme-builder/__tests__/useUploadModeration.test.ts:refuses a converted file still over 15 MB without hitting the network`

## Regression

### R1. A JPEG goes up unchanged

**Do:** Upload a JPEG.

**Expect:** It is not re-encoded: the request carries the file's own bytes, at the file's own size, as `image/jpeg`.

**Lane:** ci

**Check:** `artifacts/overhype-me/src/components/meme-builder/__tests__/useUploadModeration.test.ts:sends a JPEG unchanged, without re-encoding it`

### R2. An undecodable file is still refused as invalid format

**Do:** Pick a file that claims to be a PNG but does not decode as an image.

**Expect:** The zone shows invalid-format and nothing is sent.

**Lane:** ci

**Check:** `artifacts/overhype-me/src/components/meme-builder/__tests__/useUploadModeration.test.ts:maps a failed conversion to invalid-format without hitting the network`

### R3. The existing error mapping is unchanged

**Do:** Have the server answer 422 (moderation refusal) and 503.

**Expect:** 422 shows the generic rejection and 503 shows the network error, as before.

**Lane:** ci

**Check:** `artifacts/overhype-me/src/components/meme-builder/__tests__/useUploadModeration.test.ts:maps HTTP 422 → moderation rejection (generic)` `artifacts/overhype-me/src/components/meme-builder/__tests__/useUploadModeration.test.ts:maps HTTP 503 → network error class`

## Not bugs

- **A transparent PNG's background turns black.** Every upload surface in the app already does this; whether it should become white or something else is #717.
- **A file that is under 15 MB as picked can still be refused as too large.** It happens only when its converted JPEG is still over the limit after the converter's shrinking attempts, which is rare (a near-15 MB, very detailed WebP). The upload stays refused locally rather than failing after sending.
