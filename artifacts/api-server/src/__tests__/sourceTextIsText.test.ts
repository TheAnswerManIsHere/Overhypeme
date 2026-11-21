// A source file holding a raw control character is shown by GitHub as binary,
// so its changes cannot be read in any pull request diff. The name validator
// was such a file (two regular expressions typed with the characters
// themselves), found by the build report on PR #1146. Write them as \uXXXX
// escapes; this test fails, naming the file, if one comes back. The same
// holds for the invisible format characters (zero-width, direction overrides,
// word joiners, the byte-order mark): they diff as nothing, so a reviewer
// cannot see them (build report on Issue #628, 2026-11-21).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..", "..", "..");
const SCAN = ["artifacts", "lib", "scripts"];
const SKIP = new Set(["node_modules", "dist", "build", ".turbo", "coverage"]);
const EXT = /\.(ts|tsx|mts|mjs|js)$/;
// Tab, newline and carriage return are text; every other C0 control, DEL and
// the C1 range are not.
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/;
// Zero-width spaces and joiners, directional marks and overrides, the word
// joiner and invisible operators, directional isolates, and the byte-order mark.
const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/;

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name) || name.startsWith(".")) continue;
    const path = join(dir, name);
    const st = statSync(path);
    if (st.isDirectory()) walk(path, out);
    else if (EXT.test(name)) out.push(path);
  }
}

describe("source files are text", () => {
  it("no source file under artifacts/, lib/ or scripts/ holds a raw control character", () => {
    const files: string[] = [];
    for (const top of SCAN) walk(join(ROOT, top), files);
    assert.ok(files.length > 100, `scanned only ${files.length} files; the walk is broken`);
    const offenders = files.filter((f) => CONTROL.test(readFileSync(f, "utf8"))).map((f) => relative(ROOT, f));
    assert.deepEqual(offenders, []);
  });

  it("no source file under artifacts/, lib/ or scripts/ holds a raw invisible format character", () => {
    const files: string[] = [];
    for (const top of SCAN) walk(join(ROOT, top), files);
    assert.ok(files.length > 100, `scanned only ${files.length} files; the walk is broken`);
    const offenders = files.filter((f) => INVISIBLE.test(readFileSync(f, "utf8"))).map((f) => relative(ROOT, f));
    assert.deepEqual(offenders, []);
  });
});
