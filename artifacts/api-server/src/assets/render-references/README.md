# Default reference images for moderation i2i test renders

The Step-2 visual-review grid renders image-to-image scenarios against these
canonical default reference images, one per identity type. They are uploaded to
fal.storage on first use (see `src/lib/defaultReferenceResolver.ts`).

## Required files

Drop a real, licensed/synthetic image at each path below. Real photographs of a
clear subject work best (a portrait for the human types; a clear single subject
for the non-human types). Minimum useful size is well above 4 KB — a 1×1 or
near-empty placeholder is rejected by the health check.

| Identity type             | File                          | What it should depict                     |
| ------------------------- | ----------------------------- | ----------------------------------------- |
| `male`                    | *(reuses `../test-face.jpg`)* | Already provided — bundled male portrait. |
| `female`                  | `female.jpg`                  | A clear female portrait.                  |
| `nonhuman_animal`         | `nonhuman-animal.jpg`         | A clear single animal (e.g. a cat).       |
| `nonhuman_object_vehicle` | `nonhuman-object-vehicle.jpg` | A clear object/vehicle (e.g. a car).      |

## Rules

- **Licensing:** only commit explicitly-licensed or synthetic images. Do not
  commit real third-party people's photos without rights/consent.
- **Versioning:** when you swap an asset, bump its entry in
  `DEFAULT_REFERENCE_ASSET_VERSION` (`src/lib/factRenderScenarios.ts`) so prior
  i2i attempts that used the old asset correctly go stale.
- Until a file is present, its scenario fails with a clear "reference not
  configured" message and `GET /api/admin/render-references/health` reports it
  missing. The generic (t2i) scenario needs no reference and works immediately.
