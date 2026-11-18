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
 * In the published deployment it refuses any request without the secret only
 * Cloudflare adds (plan S-e; the API's middlewares/originGuard.ts is its
 * twin): such a request is sent to the canonical host, or refused there. The
 * health path and nothing else is answered first.
 *
 * Node built-ins only, and no build step: the published run command starts
 * it directly, so it depends on nothing the API's build produces. The
 * workspace preview is unchanged: development still runs Vite.
 */
import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
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

/** The platform's start-up health check (artifact.toml); answered before the origin check. */
const HEALTH_PATH = "/__health";

/** Header only Cloudflare's transform rule adds; its value is ORIGIN_SECRET (launch Phase 14, increment 3, plan S-e). */
const ORIGIN_HEADER = "x-overhype-origin";

/** The explanation page every refused visitor is sent to; a script-free file in the build. Same path as the API's lib/geography.ts and the web app's lib/admission.ts. */
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

/**
 * True when the request carries the secret only Cloudflare adds, compared in
 * constant time. `secret` is the configured value as bytes, or null. The API's
 * middlewares/originGuard.ts holds the same check; this file cannot import it.
 */
export function cameThroughCloudflare(req, secret) {
  const given = req.headers[ORIGIN_HEADER];
  if (!secret || typeof given !== "string" || given.length === 0) return false;
  const a = Buffer.from(given);
  return a.length === secret.length && timingSafeEqual(a, secret);
}

/**
 * A request that did not come through Cloudflare gets none of the app's
 * files. One addressed to another host is sent to the canonical one; one
 * already addressed to it (a direct connection to the origin with the real
 * hostname, or a deployment missing its secret) gets a refusal page with a
 * link, so it can never loop.
 */
function refuse(req, res, canonicalOrigin, canonicalHost) {
  const host = String(req.headers.host ?? "").toLowerCase();
  if (host && host !== canonicalHost) {
    res.writeHead(308, { location: canonicalOrigin + (req.url ?? "/"), "cache-control": "no-store" });
    return res.end();
  }
  res.writeHead(403, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  return res.end(`<!doctype html><meta charset="utf-8"><title>Overhype.me</title><p>Please visit <a href="${canonicalOrigin}">${canonicalOrigin}</a>.</p>`);
}

/**
 * The request handler for a built app at `root` (an absolute directory).
 * `options.originSecret`, when `options.guarded` is true (the published
 * deployment), must arrive in the x-overhype-origin header.
 */
export function createHandler(root, options = {}) {
  const absoluteRoot = path.resolve(root);
  const { guarded = false, originSecret, canonicalOrigin = "https://overhype.me" } = options;
  const secret = originSecret ? Buffer.from(originSecret) : null;
  const canonicalHost = new URL(canonicalOrigin).host;
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
    if (guarded && !cameThroughCloudflare(req, secret)) return refuse(req, res, canonicalOrigin, canonicalHost);
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
    guarded: process.env.REPLIT_DEPLOYMENT === "1",
    originSecret: process.env.ORIGIN_SECRET,
    // Mirrors the API's getSiteBaseUrl() for the deployment (lib/siteUrl.ts).
    canonicalOrigin: (process.env.SITE_BASE_URL ?? "https://overhype.me").replace(/\/$/, ""),
  });
  createServer(handler).listen(port, "0.0.0.0", () => {
    console.log(`[web] serving ${root} on 0.0.0.0:${port}`);
  });
}
