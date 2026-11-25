// @vitest-environment node
/**
 * The published web server's browser protections (launch Phase 15,
 * increment 3a): every response carries nosniff and a referrer policy; the
 * published deployment also refuses framing; every HTML page carries the web
 * app's CSP as report-only, admitting exactly the inline scripts the build
 * shipped and reporting to the API's collector.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHandler, inlineScriptHashes, buildWebCsp, WEB_REPORT_URL } from "./serve.mjs";

const HISTORY = "(function(){ window.a = 1; })();";
const ADSENSE = "\n      (function(){ var x = \"%VITE_ADSENSE_PUBLISHER_ID%\"; })();\n    ";
const INDEX = `<!doctype html><head><script id="history-patch">${HISTORY}</script><script id="adsense-init">${ADSENSE}</script></head><body><script type="module" src="/assets/index-abc.js"></script></body>`;

const sha = (s) => `'sha256-${createHash("sha256").update(s, "utf8").digest("base64")}'`;

let root;
const servers = [];

async function serve(options) {
  const server = createServer(createHandler(root, options));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}

/** The directives of a policy, by name. */
function directives(policy) {
  return Object.fromEntries(
    policy.split(";").map((d) => d.trim()).filter(Boolean).map((d) => {
      const [name, ...values] = d.split(/\s+/);
      return [name, values];
    }),
  );
}

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), "web-headers-"));
  mkdirSync(path.join(root, "assets"));
  writeFileSync(path.join(root, "index.html"), INDEX);
  writeFileSync(path.join(root, "unavailable.html"), "<!doctype html><title>unavailable</title>");
  writeFileSync(path.join(root, "assets", "index-abc.js"), "console.log(1)");
});

afterAll(async () => {
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
  rmSync(root, { recursive: true, force: true });
});

describe("inlineScriptHashes", () => {
  it("hashes each inline script's exact text and skips scripts loaded by src", () => {
    expect(inlineScriptHashes(INDEX)).toEqual([sha(HISTORY), sha(ADSENSE)]);
  });

  it("reads an end tag written with whitespace before its bracket", () => {
    expect(inlineScriptHashes(`<script>${HISTORY}</script >`)).toEqual([sha(HISTORY)]);
  });

  it("finds none in a script-free page", () => {
    expect(inlineScriptHashes("<!doctype html><title>x</title>")).toEqual([]);
  });
});

describe("the web policy", () => {
  it("allows no inline script but the hashed ones, no eval, no plugins, and reports to the collector", () => {
    const d = directives(buildWebCsp({ scriptHashes: [sha(HISTORY)] }));
    expect(d["script-src"]).toContain("'self'");
    expect(d["script-src"]).toContain(sha(HISTORY));
    expect(d["script-src"]).not.toContain("'unsafe-inline'");
    expect(d["script-src"]).not.toContain("'unsafe-eval'");
    expect(d["object-src"]).toEqual(["'none'"]);
    expect(d["base-uri"]).toEqual(["'self'"]);
    expect(d["form-action"]).toEqual(["'self'"]);
    expect(d["report-uri"]).toEqual([WEB_REPORT_URL]);
    expect(d["report-to"]).toBeUndefined();
    expect(WEB_REPORT_URL).toBe("/api/csp-report/web");
  });

  it("names frame-ancestors only when framing is refused", () => {
    expect(directives(buildWebCsp())["frame-ancestors"]).toBeUndefined();
    expect(directives(buildWebCsp({ denyFraming: true }))["frame-ancestors"]).toEqual(["'none'"]);
  });
});

describe("the published deployment's headers", () => {
  it("sends the app page a report-only policy with its own inline-script hashes, never an enforced one", async () => {
    const base = await serve({ denyFraming: true });
    for (const p of ["/", "/facts/12"]) {
      const res = await fetch(`${base}${p}`);
      expect(res.status, p).toBe(200);
      expect(res.headers.get("content-security-policy"), p).toBeNull();
      const policy = res.headers.get("content-security-policy-report-only");
      expect(policy, p).toBeTruthy();
      const d = directives(policy);
      expect(d["script-src"]).toContain(sha(HISTORY));
      expect(d["script-src"]).toContain(sha(ADSENSE));
      expect(d["frame-ancestors"]).toEqual(["'none'"]);
      expect(d["report-uri"]).toEqual([WEB_REPORT_URL]);
    }
  });

  it("sends the explanation page the policy too", async () => {
    const base = await serve({ denyFraming: true });
    const res = await fetch(`${base}/unavailable`);
    expect(res.headers.get("content-security-policy-report-only")).toContain("default-src 'self'");
  });

  it("refuses framing and sniffing, and sets a referrer policy, on every kind of response", async () => {
    const base = await serve({ denyFraming: true });
    for (const p of ["/", "/assets/index-abc.js", "/assets/missing.js", "/__health"]) {
      const res = await fetch(`${base}${p}`);
      expect(res.headers.get("x-content-type-options"), p).toBe("nosniff");
      expect(res.headers.get("x-frame-options"), p).toBe("DENY");
      expect(res.headers.get("referrer-policy"), p).toBe("strict-origin-when-cross-origin");
    }
    const post = await fetch(`${base}/`, { method: "POST" });
    expect(post.status).toBe(405);
    expect(post.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("puts no policy on a script or other non-HTML file", async () => {
    const base = await serve({ denyFraming: true });
    const res = await fetch(`${base}/assets/index-abc.js`);
    expect(res.headers.get("content-security-policy-report-only")).toBeNull();
  });
});

describe("outside the published deployment", () => {
  it("allows framing, so a preview iframe still shows the app, and keeps the rest", async () => {
    const base = await serve({});
    const res = await fetch(`${base}/`);
    expect(res.headers.get("x-frame-options")).toBeNull();
    expect(directives(res.headers.get("content-security-policy-report-only"))["frame-ancestors"]).toBeUndefined();
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });
});
