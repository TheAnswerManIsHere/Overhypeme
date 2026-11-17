/**
 * Writes `directCompileBaseline.json`: the prompt each pin case compiles to
 * under each family's baseline wording (see `directCompileCases.ts`). Run only
 * for a deliberate wording change: `node --import tsx
 * src/__tests__/fixtures/captureDirectCompileBaseline.ts` from
 * artifacts/api-server.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { compileDirect } from "../../lib/imagePrompt/compilers/nanoBanana2.js";
import { baselineRecipeFor } from "../../lib/imagePrompt/recipe.js";
import { DIRECT_COMPILE_CASES, DIRECT_COMPILE_FAMILIES } from "./directCompileCases.js";

const prompts: Record<string, Record<string, string>> = {};
for (const family of DIRECT_COMPILE_FAMILIES) {
  prompts[family] = {};
  for (const c of DIRECT_COMPILE_CASES) {
    prompts[family]![c.name] = compileDirect({ ...structuredClone(c.args), recipe: baselineRecipeFor(family) }).prompt;
  }
}
const out = fileURLToPath(new URL("./directCompileBaseline.json", import.meta.url));
writeFileSync(out, `${JSON.stringify({ prompts }, null, 2)}\n`);
console.log(`wrote ${out}`);
