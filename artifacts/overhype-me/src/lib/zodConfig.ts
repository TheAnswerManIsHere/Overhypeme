/**
 * @purpose Turns off zod's JIT for the whole app before any schema is built, so zod never probes `new Function` and the web CSP (no 'unsafe-eval') files no report on every page load.
 * @subsystem security
 *
 * zod 4 checks once whether it may compile parsers with `new Function`, and
 * falls back to the interpreter when it may not. The check alone is a CSP
 * violation under a policy without 'unsafe-eval', reported even though zod
 * swallows the error (zod's own note, v4/core/util.js `allowsEval`). Under
 * `jitless` the check is skipped and every parse takes the path an enforced
 * policy would force anyway. Launch Phase 15, increment 3a.
 *
 * Imported first in main.tsx: ES modules evaluate in import order, and an
 * object schema reads the setting when it is built, which for the generated
 * API schemas is at module load.
 */
import { z } from "zod";

z.config({ jitless: true });
