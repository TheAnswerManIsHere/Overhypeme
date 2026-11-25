/**
 * The CSP report collector (launch Phase 15, increment 3b; lib/cspReport.ts),
 * through the real app so its place in the chain is what is tested: ahead of
 * the cookie parser, the origin and CSRF checks and the auth chain.
 *
 * The plan's test: the collector receives a synthetic report and refuses an
 * oversized one. Around that, what it must never do: keep a query string, a
 * cookie or a script sample; echo anything; read another media type; or
 * accept unbounded traffic from one address.
 */
import { describe, it, mock, afterEach } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createApp } from "../app.js";
import { logger } from "../lib/logger.js";
import {
  CSP_REPORT_MAX_BYTES,
  CSP_REPORT_MAX_PER_WINDOW,
  parseCspReportBody,
  stripUrl,
} from "../lib/cspReport.js";

const LEGACY = {
  "csp-report": {
    "document-uri": "https://overhype.me/facts/12?token=SECRET_DOC#frag",
    referrer: "https://elsewhere.example/?ref=SECRET_REF",
    "violated-directive": "script-src-elem",
    "effective-directive": "script-src-elem",
    "original-policy": "default-src 'self'; report-uri /api/csp-report/web",
    disposition: "report",
    "blocked-uri": "https://evil.example/x.js?k=SECRET_BLOCKED",
    "line-number": 12,
    "column-number": 4,
    "source-file": "https://overhype.me/assets/index-abc.js?v=SECRET_SRC",
    "status-code": 200,
    "script-sample": "SECRET_SAMPLE",
  },
};

const REPORTING_API = [
  {
    type: "csp-violation",
    age: 10,
    url: "https://overhype.me/me?session=SECRET_URL",
    user_agent: "UA",
    body: {
      documentURL: "https://overhype.me/me?session=SECRET_URL",
      blockedURL: "inline",
      effectiveDirective: "script-src-elem",
      originalPolicy: "default-src 'self'",
      disposition: "report",
      sample: "SECRET_SAMPLE",
      statusCode: 200,
      lineNumber: 3,
      columnNumber: 9,
    },
  },
  { type: "deprecation", body: { id: "x" } },
];

type Logged = { fields: Record<string, unknown>; msg: unknown };

function captureWarn(): Logged[] {
  const lines: Logged[] = [];
  mock.method(logger, "warn", (fields: Record<string, unknown>, msg: unknown) => {
    lines.push({ fields, msg });
  });
  return lines;
}

afterEach(() => mock.restoreAll());

describe("CSP report collector — accepts a report and logs it bounded", () => {
  it("logs a report-uri report as one line with no query string, fragment or sample, and answers 204 with an empty body", async () => {
    const lines = captureWarn();
    const res = await request(createApp())
      .post("/api/csp-report/web")
      .set("Content-Type", "application/csp-report")
      .set("Cookie", "sid=SECRET_COOKIE")
      .send(JSON.stringify(LEGACY));
    assert.equal(res.status, 204);
    assert.equal(res.text, "");
    assert.equal(res.headers["set-cookie"], undefined, "no cookie issued, not even csrf_token");
    const reports = lines.filter((l) => l.fields["event"] === "csp_report");
    assert.equal(reports.length, 1);
    assert.deepEqual(reports[0]!.fields, {
      event: "csp_report",
      source: "web",
      disposition: "report",
      directive: "script-src-elem",
      blocked: "https://evil.example/x.js",
      document: "https://overhype.me/facts/12",
      sourceFile: "https://overhype.me/assets/index-abc.js",
      line: 12,
      column: 4,
      statusCode: 200,
    });
    assert.doesNotMatch(JSON.stringify(lines), /SECRET/);
  });

  it("logs each csp-violation of a Reporting API batch, ignoring other report types", async () => {
    const lines = captureWarn();
    const res = await request(createApp())
      .post("/api/csp-report/api")
      .set("Content-Type", "application/reports+json")
      .send(JSON.stringify(REPORTING_API));
    assert.equal(res.status, 204);
    const reports = lines.filter((l) => l.fields["event"] === "csp_report");
    assert.equal(reports.length, 1);
    assert.equal(reports[0]!.fields["source"], "api");
    assert.equal(reports[0]!.fields["blocked"], "inline");
    assert.equal(reports[0]!.fields["document"], "https://overhype.me/me");
    assert.doesNotMatch(JSON.stringify(lines), /SECRET/);
  });

  it("accepts a report from another origin and with no CSRF token: the browser sends it itself", async () => {
    captureWarn();
    const res = await request(createApp())
      .post("/api/csp-report/web")
      .set("Origin", "https://not-allowed.example")
      .set("Content-Type", "application/csp-report")
      .send(JSON.stringify(LEGACY));
    assert.equal(res.status, 204);
  });
});

describe("CSP report collector — refuses what is not a bounded CSP report", () => {
  it("refuses an oversized report (413) without logging it", async () => {
    const lines = captureWarn();
    const big = JSON.stringify({ "csp-report": { "document-uri": "https://overhype.me/", pad: "x".repeat(CSP_REPORT_MAX_BYTES) } });
    const res = await request(createApp())
      .post("/api/csp-report/web")
      .set("Content-Type", "application/csp-report")
      .send(big);
    assert.equal(res.status, 413);
    assert.equal(res.text, "");
    assert.equal(lines.filter((l) => l.fields["event"] === "csp_report").length, 0);
  });

  it("refuses any other media type (415), JSON included", async () => {
    for (const type of ["application/json", "text/plain", "application/x-www-form-urlencoded"]) {
      const res = await request(createApp()).post("/api/csp-report/web").set("Content-Type", type).send("{}");
      assert.equal(res.status, 415, type);
      assert.equal(res.text, "", type);
    }
  });

  it("refuses a policy name it does not know (404) and a body that is not a report (400), echoing nothing", async () => {
    const app = createApp();
    const unknown = await request(app)
      .post("/api/csp-report/other")
      .set("Content-Type", "application/csp-report")
      .send(JSON.stringify(LEGACY));
    assert.equal(unknown.status, 404);
    assert.equal(unknown.text, "");
    for (const body of ["not json <script>", JSON.stringify({ other: 1 }), "[]"]) {
      const res = await request(app).post("/api/csp-report/web").set("Content-Type", "application/csp-report").send(body);
      assert.equal(res.status, 400, body);
      assert.equal(res.text, "", body);
    }
  });

  it(`sheds one address's flood after ${CSP_REPORT_MAX_PER_WINDOW} reports a minute (429)`, async () => {
    captureWarn();
    const app = createApp();
    for (let i = 0; i < CSP_REPORT_MAX_PER_WINDOW; i++) {
      const res = await request(app)
        .post("/api/csp-report/web")
        .set("Content-Type", "application/csp-report")
        .send(JSON.stringify(LEGACY));
      assert.equal(res.status, 204, `report ${i + 1}`);
    }
    const shed = await request(app)
      .post("/api/csp-report/web")
      .set("Content-Type", "application/csp-report")
      .send(JSON.stringify(LEGACY));
    assert.equal(shed.status, 429);
    assert.equal(shed.text, "");
  });
});

describe("CSP report collector — the pure reading of a body", () => {
  it("keeps scheme, host and path of a URL, and only the first word of anything else", () => {
    assert.equal(stripUrl("https://a.example:8443/p/q?x=1#y"), "https://a.example:8443/p/q");
    assert.equal(stripUrl("data:image/png;base64,AAAA"), "data");
    assert.equal(stripUrl("chrome-extension://abc/x.js?y"), "chrome-extension");
    assert.equal(stripUrl("eval"), "eval");
    assert.equal(stripUrl("inline?leak"), "inline");
    assert.equal(stripUrl(""), null);
    assert.equal(stripUrl(42), null);
  });

  it("caps a batch at 20 violations and counts the rest", () => {
    const batch = Array.from({ length: 25 }, () => REPORTING_API[0]);
    const parsed = parseCspReportBody("web", "application/reports+json", JSON.stringify(batch));
    assert.equal(parsed?.violations.length, 20);
    assert.equal(parsed?.dropped, 5);
  });

  it("cuts every logged string to a bounded length", () => {
    const long = { "csp-report": { "effective-directive": "x".repeat(5000), "blocked-uri": `https://a.example/${"p".repeat(5000)}` } };
    const parsed = parseCspReportBody("web", "application/csp-report", JSON.stringify(long));
    assert.ok((parsed?.violations[0]?.directive ?? "").length <= 300);
    assert.ok((parsed?.violations[0]?.blocked ?? "").length <= 300);
  });
});
