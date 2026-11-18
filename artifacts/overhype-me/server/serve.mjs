/**
 * @purpose Serves the built web app (dist/public) in the published deployment from a process of our own instead of Replit's static service, so increment 3 of launch Phase 14 can refuse a request that did not come through Cloudflare for the app's files as well as its API (plan PLAN_PHASE14_COMPLIANCE.md, S-e2, the feasibility step).
 * @subsystem public-site
 *
 * It reproduces what the static service did (measured 2026-11-18 on the
 * Replit hostname): a file under dist/public is answered as itself with
 * `cache-control: private`, and every other GET is answered with index.html
 * so in-app navigation works. One deliberate difference: a missing file under
 * /assets/ or /fonts/ is a 404, not index.html served as a script.
 *
 * Node built-ins only, and no build step: the published run command starts
 * it directly, so it depends on nothing the API's build produces. The
 * workspace preview is unchanged: development still runs Vite.
 */
import { createServer } from "node:http";
import { createReadStream, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
};

/** Paths whose missing files answer 404 rather than the app's page. */
const FILE_ONLY_PREFIXES = ["/assets/", "/fonts/"];

function fileAt(root, urlPath) {
  const resolved = path.resolve(root, `.${urlPath}`);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
  try {
    const stat = statSync(resolved);
    return stat.isFile() ? { file: resolved, stat } : null;
  } catch {
    return null;
  }
}

function send(req, res, { file, stat }) {
  res.writeHead(200, {
    "content-type": CONTENT_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream",
    "content-length": stat.size,
    "cache-control": "private",
    "last-modified": stat.mtime.toUTCString(),
  });
  if (req.method === "HEAD") return res.end();
  createReadStream(file)
    .on("error", () => res.destroy())
    .pipe(res);
}

/** The request handler for a built app at `root` (an absolute directory). */
export function createHandler(root) {
  const absoluteRoot = path.resolve(root);
  return (req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { allow: "GET, HEAD" });
      return res.end();
    }
    let urlPath;
    try {
      urlPath = decodeURIComponent(new URL(req.url ?? "/", "http://local").pathname);
    } catch {
      res.writeHead(400);
      return res.end();
    }
    const hit = urlPath.endsWith("/") ? null : fileAt(absoluteRoot, urlPath);
    if (hit) return send(req, res, hit);
    if (FILE_ONLY_PREFIXES.some((p) => urlPath.startsWith(p))) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8", "cache-control": "private" });
      return res.end("Not found");
    }
    const index = fileAt(absoluteRoot, "/index.html");
    if (!index) {
      res.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
      return res.end("The app has not been built");
    }
    return send(req, res, index);
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = process.env.WEB_PUBLIC_DIR ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist/public");
  const port = Number(process.env.PORT ?? 26169);
  createServer(createHandler(root)).listen(port, "0.0.0.0", () => {
    console.log(`[web] serving ${root} on 0.0.0.0:${port}`);
  });
}
