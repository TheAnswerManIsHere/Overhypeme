// @vitest-environment node
/**
 * The published web server (server/serve.mjs): it must answer as Replit's
 * static service did, so moving the app's files behind our own process
 * (launch Phase 14, increment 3, the feasibility step) changes nothing a
 * visitor sees.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, get } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHandler } from "./serve.mjs";

let root;
let server;
let base;

beforeAll(async () => {
  root = mkdtempSync(path.join(tmpdir(), "web-serve-"));
  mkdirSync(path.join(root, "assets"));
  mkdirSync(path.join(root, "fonts"));
  writeFileSync(path.join(root, "index.html"), "<!doctype html><title>app</title>");
  writeFileSync(path.join(root, "assets", "index-abc.js"), "console.log(1)");
  writeFileSync(path.join(root, "fonts", "inter.woff2"), "w2");
  writeFileSync(path.join(root, "favicon.svg"), "<svg/>");
  writeFileSync(path.join(root, "unavailable.html"), "<!doctype html><title>unavailable</title>");
  writeFileSync(path.join(root, "assets", "big.js"), Buffer.alloc(8 * 1024 * 1024, 97));
  writeFileSync(path.join(path.dirname(root), "outside-secret.txt"), "secret");
  server = createServer(createHandler(root));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
  rmSync(root, { recursive: true, force: true });
  rmSync(path.join(path.dirname(root), "outside-secret.txt"), { force: true });
});

describe("the published web server", () => {
  it("answers the home page with index.html, privately cached", async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("private");
    expect(await res.text()).toContain("<title>app</title>");
  });

  it("answers an in-app address with index.html, so navigation and deep links work", async () => {
    for (const p of ["/facts/12", "/facts/12/memes", "/m/some-slug", "/admin/help/rate-limits", "/profile/"]) {
      const res = await fetch(`${base}${p}`);
      expect(res.status, p).toBe(200);
      expect(await res.text(), p).toContain("<title>app</title>");
    }
  });

  it("answers a built file as itself, with its type", async () => {
    const js = await fetch(`${base}/assets/index-abc.js`);
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(await js.text()).toBe("console.log(1)");
    expect((await fetch(`${base}/fonts/inter.woff2`)).headers.get("content-type")).toBe("font/woff2");
    expect((await fetch(`${base}/favicon.svg`)).headers.get("content-type")).toBe("image/svg+xml");
  });

  it("answers a missing script or font with 404, not the app's page", async () => {
    expect((await fetch(`${base}/assets/index-gone.js`)).status).toBe(404);
    expect((await fetch(`${base}/fonts/gone.woff2`)).status).toBe(404);
  });

  it("never serves a file outside the built app", async () => {
    for (const p of ["/../outside-secret.txt", "/%2e%2e/outside-secret.txt", "/assets/..%2f..%2foutside-secret.txt"]) {
      const res = await fetch(`${base}${p}`);
      expect(await res.text(), p).not.toContain("secret");
    }
  });

  it("answers HEAD without a body and refuses other methods", async () => {
    const head = await fetch(`${base}/`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    const post = await fetch(`${base}/`, { method: "POST" });
    expect(post.status).toBe(405);
  });

  // PR #1049's build report: a download cut off part-way left its file open
  // for the life of the process.
  it.runIf(existsSync("/proc/self/fd"))("closes the file when a visitor goes away mid-download", async () => {
    const openFiles = () => readdirSync("/proc/self/fd").length;
    const abortOne = () => new Promise((resolve) => {
      const req = get(`${base}/assets/big.js`, (res) => {
        res.once("data", () => { req.destroy(); resolve(undefined); });
      });
      req.on("error", () => resolve(undefined));
    });
    const before = openFiles();
    for (let i = 0; i < 20; i++) await abortOne();
    await new Promise((r) => setTimeout(r, 300));
    expect(openFiles() - before).toBeLessThan(5);
  });
});


describe("the published web server's front door (launch Phase 14, increment 3)", () => {
  const SECRET = "origin-secret-for-tests-0123456789";
  let guarded;
  let gbase;

  /** A raw request, so the Host header can be set (fetch forbids it). */
  function hit(p, headers = {}) {
    return new Promise((resolve, reject) => {
      const u = new URL(p, gbase);
      get({ hostname: u.hostname, port: u.port, path: u.pathname, headers }, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
      }).on("error", reject);
    });
  }

  beforeAll(async () => {
    guarded = createServer(createHandler(root, { guarded: true, originSecret: SECRET, canonicalOrigin: "https://overhype.me" }));
    await new Promise((r) => guarded.listen(0, "127.0.0.1", r));
    gbase = `http://127.0.0.1:${guarded.address().port}`;
  });
  afterAll(async () => {
    await new Promise((r) => guarded.close(r));
  });

  it("serves the app to a request that came through Cloudflare", async () => {
    const res = await hit("/facts/1", { host: "overhype.me", "x-overhype-origin": SECRET });
    expect(res.status).toBe(200);
    expect(res.body).toContain("<title>app</title>");
  });

  it("sends a request on another host to the canonical one, with none of the app's files", async () => {
    for (const p of ["/", "/assets/index-abc.js", "/facts/1"]) {
      const res = await hit(p, { host: "overhypeme.replit.app" });
      expect(res.status, p).toBe(308);
      expect(res.headers.location, p).toBe(`https://overhype.me${p}`);
      expect(res.body, p).not.toContain("console.log");
    }
  });

  it("refuses, without a redirect loop, a request on the canonical host that skipped Cloudflare", async () => {
    const res = await hit("/", { host: "overhype.me" });
    expect(res.status).toBe(403);
    expect(res.headers.location).toBeUndefined();
    expect(res.body).not.toContain("<title>app</title>");
  });

  it("refuses a wrong secret, including one of another length", async () => {
    expect((await hit("/", { host: "overhype.me", "x-overhype-origin": "short" })).status).toBe(403);
    expect((await hit("/", { host: "overhype.me", "x-overhype-origin": SECRET.replace("o", "O") })).status).toBe(403);
  });

  it("refuses everything when the deployment has no secret configured", async () => {
    const bare = createServer(createHandler(root, { guarded: true }));
    await new Promise((r) => bare.listen(0, "127.0.0.1", r));
    const res = await fetch(`http://127.0.0.1:${bare.address().port}/`, { headers: { "x-overhype-origin": "" }, redirect: "manual" });
    await new Promise((r) => bare.close(r));
    expect(res.status).toBe(308);
    expect(await res.text()).not.toContain("<title>app</title>");
  });

  it("answers the health check without the secret", async () => {
    const res = await hit("/__health", { host: "overhypeme.replit.app" });
    expect(res.status).toBe(200);
    expect(res.body).toBe("ok");
  });

  it("serves the explanation page at /unavailable", async () => {
    const res = await hit("/unavailable", { host: "overhype.me", "x-overhype-origin": SECRET });
    expect(res.status).toBe(200);
    expect(res.body).toContain("<title>unavailable</title>");
  });

  it("is unguarded unless told otherwise, as in development", async () => {
    expect((await fetch(`${base}/`)).status).toBe(200);
  });
});
