// Install stdio guard so EIO/EPIPE on stdout/stderr (e.g. piped to `head`,
// terminal disconnect, container log-pipe overrun) cannot crash the script.
// CLI scripts intentionally keep using console.* for human-readable output.
import { installStdioGuard } from "../src/lib/stdioGuard.js";
installStdioGuard();

import { objectStorageClient } from "../src/lib/objectStorage";

async function main() {
  const privateDir = process.env.PRIVATE_OBJECT_DIR || "";
  if (!privateDir) { console.error("PRIVATE_OBJECT_DIR not set"); process.exit(1); }

  const trimmed = privateDir.replace(/^\//, "");
  const parts = trimmed.split("/");
  const bucketName = parts[0];
  const prefix = parts.slice(1).join("/") + "/";

  console.log(`Bucket: ${bucketName}`);
  console.log(`Prefix: ${prefix}`);
  console.log("---");

  const [files] = await objectStorageClient.bucket(bucketName).getFiles({ prefix });

  const byFolder: Record<string, number> = {};
  const rootFiles: string[] = [];
  for (const f of files) {
    const rel = f.name.slice(prefix.length);
    const slash = rel.indexOf("/");
    const folder = slash === -1 ? "(root)" : rel.slice(0, slash);
    byFolder[folder] = (byFolder[folder] || 0) + 1;
    if (folder === "(root)") rootFiles.push(rel);
  }

  if (rootFiles.length > 0) {
    console.log("ROOT-LEVEL FILES:");
    rootFiles.forEach(r => console.log("  " + r));
  } else {
    console.log("No root-level files found.");
  }

  console.log("\n--- Summary by folder ---");
  for (const [k, v] of Object.entries(byFolder).sort()) {
    console.log(`  ${k}: ${v} files`);
  }
  console.log(`Total: ${files.length} files`);
}

main().catch(e => { console.error(e); process.exit(1); });
