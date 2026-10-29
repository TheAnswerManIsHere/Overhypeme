/**
 * Every media delete and ACL write goes through the preserve-first path
 * (Launch Phase 3, increment 5; plan Testing Plan, "CI checks", and Risks: "A
 * new delete or ACL path skips the media preservation. The call-site test
 * fails CI").
 *
 * A storage mutation is a call that destroys or replaces an object's state:
 * a File's `delete`, `setMetadata`, `copy`, `move`, `rename`, `save` or
 * `createWriteStream`, or a bucket's `upload` or `deleteFiles`. Only the
 * modules named below may make one, each for a stated reason; any other file
 * under `src/` or `scripts/` that makes one fails here, naming the line.
 *
 * The scan is textual on purpose: the receiver of a storage call is typed as
 * `File`, but `Map#delete`, a Drizzle `db.delete(table)` and a canvas
 * `ctx.save()` and `fs.createWriteStream` share the method names, so the patterns are the storage shapes
 * (`.delete()`, `.delete({`, `.save(<data>`, …), each checked against these
 * files when this test was written.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const API_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** The files allowed to mutate storage directly, and why. */
const ALLOWED: Record<string, string> = {
  "src/lib/mediaBackup/preserve.ts": "the preserve-first path itself, and its tombstones in the backup bucket",
  "src/lib/mediaBackup/capture.ts": "writes once into the backup bucket (markers, dump, manifest, state copies)",
  "src/lib/mediaBackup/restore.ts": "copies into an isolated restore target, write-once",
  "src/lib/mediaBackup/expiry.ts": "deletes only in the backup bucket, never the live one",
  "src/lib/objectStorage.ts": "uploadObjectBuffer: a write-once first write (ifGenerationMatch: 0)",
  "src/lib/localObjectStorage.ts": "the storage double implements these methods",
  "src/lib/productionReset.ts": "writes the reset's case record and final capture once (ifGenerationMatch: 0) under cases/ in the backup bucket",
  "scripts/snapshot-database.ts": "writes a frozen snapshot write-once (ifGenerationMatch: 0) under _snapshots/",
  // Historical one-off key migrations, run before preservation existed. A
  // re-run would move objects without preserving them: retire or rewrite them
  // through lib/mediaBackup/preserve.ts before any further run.
  "scripts/migrate-ai-backgrounds.ts": "historical key migration (see above)",
  "scripts/migrate-ai-backgrounds-v2.ts": "historical key migration (see above)",
  "scripts/migrate-storage-keys.ts": "historical key migration (see above)",
};

const PATTERNS: Array<[string, RegExp]> = [
  ["File#delete", /\.delete\(\s*(\)|\{)/],
  ["File#setMetadata", /\.setMetadata\(/],
  ["File#copy", /\.copy\(\s*[a-zA-Z_$][\w$.]*\s*(,|\))/],
  ["File#move/rename", /\.(move|rename)\(\s*[a-zA-Z_$"'`]/],
  ["File#save", /\.save\(\s*[a-zA-Z_$][\w$.]*\s*(,|\))/],
  ["File#createWriteStream", /(?<!\bfs)\.createWriteStream\(/],
  ["Bucket#upload", /\bbucket(\([^)]*\))?\.upload\(|\.upload\(\s*path\./],
  ["Bucket#deleteFiles", /\.deleteFiles\(/],
];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(path.join(API_ROOT, dir), { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "node_modules") continue;
      out.push(...sourceFiles(rel));
    } else if (/\.(ts|mts|mjs|js)$/.test(entry.name) && !entry.name.endsWith(".test.ts")) {
      out.push(rel.split(path.sep).join("/"));
    }
  }
  return out;
}

/** Calls that share a storage method's shape but are not storage: a typed-array copy, the canvas. */
function isNotStorage(line: string): boolean {
  return /Buffer\.from\([^)]*\)\.copy\(/.test(line) || /\bctx\.save\(\)/.test(line);
}

export function storageMutations(file: string): string[] {
  const hits: string[] = [];
  fs.readFileSync(path.join(API_ROOT, file), "utf8")
    .split("\n")
    .forEach((line, i) => {
      const code = line.replace(/\/\/.*$/, "");
      if (/^\s*\*/.test(code) || isNotStorage(code)) return;
      for (const [kind, re] of PATTERNS) if (re.test(code)) hits.push(`${file}:${i + 1} ${kind}: ${line.trim()}`);
    });
  return hits;
}

describe("media preservation call sites", () => {
  const files = [...sourceFiles("src"), ...sourceFiles("scripts")];

  it("only the named modules mutate stored media directly; everything else goes through ObjectStorageService", () => {
    const offenders = files.filter((f) => !(f in ALLOWED)).flatMap(storageMutations);
    assert.deepEqual(offenders, [], `storage mutations outside the preserve-first path:\n${offenders.join("\n")}`);
  });

  it("every allowed module still exists, so the list cannot go stale", () => {
    for (const f of Object.keys(ALLOWED)) assert.ok(fs.existsSync(path.join(API_ROOT, f)), f);
  });

  it("the scan sees the shapes it guards (it would catch a new direct delete or ACL write)", () => {
    const probe = path.join(API_ROOT, "src", "__probe_media_callsite.ts");
    fs.writeFileSync(
      probe,
      [
        "await file.delete();",
        "await file.delete({ ignoreNotFound: true });",
        "await objectFile.setMetadata({ metadata: {} });",
        "await src.copy(dest);",
        "await file.save(buffer, { resumable: false });",
        "await storage.bucket(name).upload(local);",
        "db.delete(usersTable);",
        "map.delete(key);",
        "ctx.save();",
      ].join("\n"),
    );
    try {
      const hits = storageMutations("src/__probe_media_callsite.ts").map((h) => h.split(" ")[1]);
      assert.deepEqual(hits, ["File#delete:", "File#delete:", "File#setMetadata:", "File#copy:", "File#save:", "Bucket#upload:"]);
    } finally {
      fs.rmSync(probe);
    }
  });

  it("ObjectStorageService routes deletes and ACL writes through the preserving functions", () => {
    const src = fs.readFileSync(path.join(API_ROOT, "src/lib/objectStorage.ts"), "utf8");
    assert.match(src, /await deletePreserved\(/);
    assert.match(src, /await setMetadataPreserved\(/);
    assert.match(src, /preconditionOpts: \{ ifGenerationMatch: 0 \}/);
    assert.doesNotMatch(src, /\.delete\(\s*\)/);
    assert.doesNotMatch(src, /\.setMetadata\(/);
  });
});
