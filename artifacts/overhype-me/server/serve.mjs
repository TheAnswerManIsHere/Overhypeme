/**
 * @purpose Serves the built web app (dist/public) in the published deployment from a process of our own instead of Replit's static service, so increment 3 of launch Phase 14 can send a visitor on Replit's own address to overhype.me, where Cloudflare's country rule applies (plan PLAN_PHASE14_COMPLIANCE.md, the feasibility step; scope as slimmed by David, Q20, 2026-11-19).
 * @subsystem public-site
 *
 * It reproduces what the static service did (measured 2026-11-18 on the
 * Replit hostname): a file under dist/public is answered as itself with
 * `cache-control: private`, and every other GET is answered with index.html
 * so in-app navigation works. One deliberate difference: a missing file under
 * /assets/ or /fonts/ is a 404, not index.html served as a script.
 *
 * In the published deployment a request addressed to a Replit hostname
 * (`*.replit.app`) is sent to the canonical host, so an ordinary visitor
 * never reaches the app around Cloudflare. It is an address check, not a
 * proof: a deliberate visitor can still go around Cloudflare, as a VPN goes
 * around any country rule (David, Q20: a shared secret with Cloudflare is a
 * hardening item before Full US launch). The health path is answered first.
 *
 * Node built-ins only, and no build step: the published run command starts
 * it directly, so it depends on nothing the API's build produces. The
 * workspace preview is unchanged: development still runs Vite.
 */
import { createServer } from "node:http";
import { createReadStream, statSync } from "node:fs";
import { pipeline } from "node:stream";
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

/** The platform's start-up health check (artifact.toml); answered before the host check, whatever address the platform uses. */
const HEALTH_PATH = "/__health";

/** Replit's own published hostnames; a request addressed to one is sent to the canonical host. */
const REPLIT_HOST = /\.replit\.app$/;

/** The explanation page Cloudflare's country rule sends a refused visitor to; a script-free file in the build. Same path as the API's lib/geography.ts. */
const EXPLANATION_PATH = "/unavailable";
const EXPLANATION_FILE = "/unavailable.html";

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
  // pipeline, not pipe: when the visitor goes away mid-download, pipe leaves
  // the file open for the life of the process; pipeline closes it.
  pipeline(createReadStream(file), res, () => {});
}

/** True when the request is addressed to one of Replit's own hostnames rather than the canonical one. */
export function onReplitHost(req) {
  const host = String(req.headers.host ?? "").toLowerCase().split(":")[0];
  return REPLIT_HOST.test(host);
}

/**
 * The request handler for a built app at `root` (an absolute directory).
 * When `options.redirectReplitHost` is true (the published deployment), a
 * request on a Replit hostname is sent to `options.canonicalOrigin`.
 */
export function createHandler(root, options = {}) {
  const absoluteRoot = path.resolve(root);
  const { redirectReplitHost = false, canonicalOrigin = "https://overhype.me" } = options;
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
    if (urlPath === HEALTH_PATH) {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      return res.end("ok");
    }
    if (redirectReplitHost && onReplitHost(req)) {
      // Plain concatenation, never new URL(req.url, origin): a target such as
      // //evil.example would then replace the host (an open redirect).
      res.writeHead(308, { location: canonicalOrigin + (req.url ?? "/"), "cache-control": "no-store" });
      return res.end();
    }
    if (urlPath === EXPLANATION_PATH) {
      const page = fileAt(absoluteRoot, EXPLANATION_FILE);
      if (page) return send(req, res, page);
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
  const handler = createHandler(root, {
    redirectReplitHost: process.env.REPLIT_DEPLOYMENT === "1",
    // Mirrors the API's getSiteBaseUrl() for the deployment (lib/siteUrl.ts).
    canonicalOrigin: (process.env.SITE_BASE_URL ?? "https://overhype.me").replace(/\/$/, ""),
  });
  createServer(handler).listen(port, "0.0.0.0", () => {
    console.log(`[web] serving ${root} on 0.0.0.0:${port}`);
  });
}
