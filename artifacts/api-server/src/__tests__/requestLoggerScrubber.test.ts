import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { Writable } from "node:stream";
import express from "express";
import pinoHttp from "pino-http";
import pino from "pino";
import { scrubObject, scrubUrl } from "@workspace/redact";

function makeTestApp(logLines: string[]) {
  const captureStream = new Writable({
    write(chunk, _enc, cb) {
      logLines.push(chunk.toString());
      cb();
    },
  });

  const testLogger = pino({ level: "info" }, captureStream);

  const app = express();
  app.use(express.json());
  app.use(
    pinoHttp({
      logger: testLogger,
      serializers: {
        req(req) {
          return {
            id: req.id,
            method: req.method,
            url: req.url != null ? scrubUrl(req.url) : req.url,
            body: scrubObject(req.raw?.body),
          };
        },
        res(res) {
          return { statusCode: res.statusCode };
        },
      },
    }),
  );
  app.post("/test", (_req, res) => res.json({ ok: true }));
  app.get("/test", (_req, res) => res.json({ ok: true }));
  return app;
}

function postJson(
  server: http.Server,
  path: string,
  body: unknown,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const addr = server.address() as { port: number };
    const req = http.request(
      {
        host: "127.0.0.1",
        port: addr.port,
        path,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        res.resume();
        res.once("end", () => setTimeout(resolve, 20));
      },
    );
    req.once("error", reject);
    req.end(payload);
  });
}

function getRequest(server: http.Server, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const req = http.request(
      { host: "127.0.0.1", port: addr.port, path, method: "GET" },
      (res) => {
        res.resume();
        res.once("end", () => setTimeout(resolve, 20));
      },
    );
    req.once("error", reject);
    req.end();
  });
}

function listenRandom(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
}

describe("pino-http request body scrubbing (integration)", () => {
  it("replaces password field with [Filtered] in log output", async () => {
    const logLines: string[] = [];
    const app = makeTestApp(logLines);
    const server = http.createServer(app);
    await listenRandom(server);

    try {
      await postJson(server, "/test", { username: "alice", password: "s3cr3t" });
      const log = logLines.find((l) => l.includes('"req"'));
      assert.ok(log, "expected a request log line");
      const parsed = JSON.parse(log) as { req: { body: Record<string, unknown> } };
      assert.equal(parsed.req.body.password, "[Filtered]", "password must be filtered");
      assert.equal(parsed.req.body.username, "alice", "username must be preserved");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("replaces email and token fields with [Filtered] in log output", async () => {
    const logLines: string[] = [];
    const app = makeTestApp(logLines);
    const server = http.createServer(app);
    await listenRandom(server);

    try {
      await postJson(server, "/test", {
        email: "alice@example.com",
        accessToken: "tok-abc",
        action: "login",
      });
      const log = logLines.find((l) => l.includes('"req"'));
      assert.ok(log, "expected a request log line");
      const parsed = JSON.parse(log) as { req: { body: Record<string, unknown> } };
      assert.equal(parsed.req.body.email, "[Filtered]");
      assert.equal(parsed.req.body.accessToken, "[Filtered]");
      assert.equal(parsed.req.body.action, "login");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("logs non-sensitive body fields without modification", async () => {
    const logLines: string[] = [];
    const app = makeTestApp(logLines);
    const server = http.createServer(app);
    await listenRandom(server);

    try {
      await postJson(server, "/test", { title: "Hello", count: 42 });
      const log = logLines.find((l) => l.includes('"req"'));
      assert.ok(log, "expected a request log line");
      const parsed = JSON.parse(log) as { req: { body: Record<string, unknown> } };
      assert.equal(parsed.req.body.title, "Hello");
      assert.equal(parsed.req.body.count, 42);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("replaces raw Buffer body with [Buffer] marker instead of serializing bytes", async () => {
    const logLines: string[] = [];

    const capture = new Writable({
      write(chunk, _enc, cb) { logLines.push(chunk.toString()); cb(); },
    });
    const testLogger = pino({ level: "info" }, capture);

    const app2 = express();
    app2.use(express.raw({ type: "*/*" }));
    app2.use(
      pinoHttp({
        logger: testLogger,
        serializers: {
          req(req) {
            return {
              id: req.id,
              method: req.method,
              url: req.url != null ? scrubUrl(req.url) : req.url,
              body: Buffer.isBuffer(req.raw?.body) ? "[Buffer]" : scrubObject(req.raw?.body),
            };
          },
          res(res) { return { statusCode: res.statusCode }; },
        },
      }),
    );
    app2.post("/test", (_req, res) => res.json({ ok: true }));

    const server2 = http.createServer(app2);
    await listenRandom(server2);

    try {
      const payload = Buffer.from("sensitive webhook payload");
      await new Promise<void>((resolve, reject) => {
        const addr = server2.address() as { port: number };
        const req = http.request(
          {
            host: "127.0.0.1",
            port: addr.port,
            path: "/test",
            method: "POST",
            headers: { "content-type": "application/octet-stream", "content-length": payload.length },
          },
          (res) => { res.resume(); res.once("end", () => setTimeout(resolve, 20)); },
        );
        req.once("error", reject);
        req.end(payload);
      });
      const log = logLines.find((l) => l.includes('"req"'));
      assert.ok(log, "expected a request log line");
      const parsed = JSON.parse(log) as { req: { body: unknown } };
      assert.equal(parsed.req.body, "[Buffer]", "Buffer body must be replaced with [Buffer] marker");
      assert.ok(!log.includes("sensitive webhook payload"), "raw payload bytes must not appear in the log");
    } finally {
      await new Promise<void>((r) => server2.close(() => r()));
    }
  });

  it("logs body as undefined when there is no request body", async () => {
    const logLines: string[] = [];
    const app = makeTestApp(logLines);
    const server = http.createServer(app);
    await listenRandom(server);

    try {
      await new Promise<void>((resolve, reject) => {
        const addr = server.address() as { port: number };
        const req = http.request(
          { host: "127.0.0.1", port: addr.port, path: "/test", method: "POST" },
          (res) => { res.resume(); res.once("end", () => setTimeout(resolve, 20)); },
        );
        req.once("error", reject);
        req.end();
      });
      const log = logLines.find((l) => l.includes('"req"'));
      assert.ok(log, "expected a request log line");
      const parsed = JSON.parse(log) as { req: { body?: unknown } };
      assert.equal(parsed.req.body, undefined);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

describe("pino-http URL query parameter scrubbing (integration)", () => {
  it("filters sensitive query params and preserves non-sensitive ones", async () => {
    const logLines: string[] = [];
    const app = makeTestApp(logLines);
    const server = http.createServer(app);
    await listenRandom(server);

    try {
      await getRequest(server, "/test?token=abc123&page=2&sort=asc");
      const log = logLines.find((l) => l.includes('"req"'));
      assert.ok(log, "expected a request log line");
      const parsed = JSON.parse(log) as { req: { url: string } };
      assert.ok(parsed.req.url.includes("token=%5BFiltered%5D"), "token param must be filtered");
      assert.ok(parsed.req.url.includes("page=2"), "page param must be preserved");
      assert.ok(parsed.req.url.includes("sort=asc"), "sort param must be preserved");
      assert.ok(!parsed.req.url.includes("abc123"), "token value must not appear in log URL");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("filters code and email query params", async () => {
    const logLines: string[] = [];
    const app = makeTestApp(logLines);
    const server = http.createServer(app);
    await listenRandom(server);

    try {
      await getRequest(server, "/test?code=oauth-code&email=alice%40example.com&redirect=home");
      const log = logLines.find((l) => l.includes('"req"'));
      assert.ok(log, "expected a request log line");
      const parsed = JSON.parse(log) as { req: { url: string } };
      assert.ok(!parsed.req.url.includes("oauth-code"), "code value must not appear in log URL");
      assert.ok(!parsed.req.url.includes("alice"), "email value must not appear in log URL");
      assert.ok(parsed.req.url.includes("redirect=home"), "redirect param must be preserved");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("preserves the full URL unchanged when there are no query params", async () => {
    const logLines: string[] = [];
    const app = makeTestApp(logLines);
    const server = http.createServer(app);
    await listenRandom(server);

    try {
      await getRequest(server, "/test");
      const log = logLines.find((l) => l.includes('"req"'));
      assert.ok(log, "expected a request log line");
      const parsed = JSON.parse(log) as { req: { url: string } };
      assert.equal(parsed.req.url, "/test", "URL without query string must be logged as-is");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("preserves non-sensitive query params verbatim when no sensitive params are present", async () => {
    const logLines: string[] = [];
    const app = makeTestApp(logLines);
    const server = http.createServer(app);
    await listenRandom(server);

    try {
      await getRequest(server, "/test?page=3&limit=10&sort=desc");
      const log = logLines.find((l) => l.includes('"req"'));
      assert.ok(log, "expected a request log line");
      const parsed = JSON.parse(log) as { req: { url: string } };
      assert.ok(parsed.req.url.includes("page=3"), "page must be preserved");
      assert.ok(parsed.req.url.includes("limit=10"), "limit must be preserved");
      assert.ok(parsed.req.url.includes("sort=desc"), "sort must be preserved");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
