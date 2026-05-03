// Install stdio guard so EIO/EPIPE on stdout/stderr (e.g. piped to `head`,
// terminal disconnect, container log-pipe overrun) cannot crash the script.
// CLI scripts intentionally keep using console.* for human-readable output.
import { installStdioGuard } from "../src/lib/stdioGuard.js";
installStdioGuard();

import { objectStorageClient } from "../src/lib/objectStorage";

async function main() {
  const privateDir = process.env.PRIVATE_OBJECT_DIR || "";
  const publicPaths = (process.env.PUBLIC_OBJECT_SEARCH_PATHS || "").split(",").map(s => s.trim()).filter(Boolean);
  
  const trimmed = privateDir.replace(/^\//, "");
  const bucketName = trimmed.split("/")[0];
  const bucket = objectStorageClient.bucket(bucketName);

  console.log(`Bucket: ${bucketName}`);
  console.log(`PRIVATE_OBJECT_DIR prefix: ${trimmed.slice(bucketName.length + 1) || "(root)"}`);
  console.log(`PUBLIC_OBJECT_SEARCH_PATHS: ${publicPaths.join(", ")}`);
  console.log("---");

  // List ALL files in the bucket with no prefix filter
  const [allFiles] = await bucket.getFiles();
  console.log(`Total files in bucket: ${allFiles.length}`);

  // Group by top-level folder
  const byFolder: Record<string, number> = {};
  for (const f of allFiles) {
    const slash = f.name.indexOf("/");
    const folder = slash === -1 ? "(root)" : f.name.slice(0, slash);
    byFolder[folder] = (byFolder[folder] || 0) + 1;
  }

  console.log("\n--- By top-level folder ---");
  for (const [k, v] of Object.entries(byFolder).sort()) {
    console.log(`  ${k}: ${v} files`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
