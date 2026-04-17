import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import express, { type Request, type Response, type NextFunction } from "express";
import { fallbackErrorHandler, type AppError } from "../lib/errorHandler.js";

function buildTestApp() {
  const app = express();
  app.use(express.json());

  app.post("/echo-error", (req: Request, _res: Response, next: NextFunction) => {
    const err: AppError = Object.assign(new Error("Validation failed"), {
      details: req.body,
    });
    next(err);
  });

  app.use(fallbackErrorHandler);

  return app;
}

function getRandomPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address() as net.AddressInfo;
      srv.close((err) => {
        if (err) reject(err);
        else resolve(addr.port);
      });
    });
  });
}

function listenOn(server: http.Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
}

function postJson(port: number, path: string, payload: unknown): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const options: http.RequestOptions = {
      host: "127.0.0.1",
      port,
      path,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(data),
      },
    };
    const req = http.request(options, (res) => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { raw += chunk; });
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) });
        } catch {
          resolve({ status: res.statusCode ?? 0, body: raw });
        }
      });
    });
    req.once("error", reject);
    req.write(data);
    req.end();
  });
}

describe("fallbackErrorHandler PII scrubbing", () => {
  it("does not echo a password field verbatim in the error response", async () => {
    const port = await getRandomPort();
    const server = http.createServer(buildTestApp());
    await listenOn(server, port);

    try {
      const { status, body } = await postJson(port, "/echo-error", {
        email: "user@example.com",
        password: "s3cr3tP@ssword!",
        username: "testuser",
      });

      assert.equal(status, 500, "should return 500 status");

      const bodyStr = JSON.stringify(body);
      assert.ok(
        !bodyStr.includes("s3cr3tP@ssword!"),
        `password must not appear verbatim in error response; got: ${bodyStr}`,
      );
      assert.ok(
        !bodyStr.includes("user@example.com"),
        `email must not appear verbatim in error response; got: ${bodyStr}`,
      );

      const details = (body as Record<string, unknown>)["details"] as Record<string, unknown> | undefined;
      assert.ok(details !== undefined, "response should include scrubbed details");
      assert.equal(details?.["password"], "[Filtered]", "password field should be replaced with [Filtered]");
      assert.equal(details?.["email"], "[Filtered]", "email field should be replaced with [Filtered]");
      assert.equal(details?.["username"], "testuser", "non-sensitive field should pass through");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("returns a generic error message with no details when none are attached", async () => {
    const port = await getRandomPort();

    const app = express();
    app.get("/boom", (_req: Request, _res: Response, next: NextFunction) => {
      next(new Error("Something exploded"));
    });
    app.use(fallbackErrorHandler);

    const server = http.createServer(app);
    await listenOn(server, port);

    try {
      const { status, body } = await new Promise<{ status: number; body: unknown }>((resolve, reject) => {
        http.get({ host: "127.0.0.1", port, path: "/boom" }, (res) => {
          let raw = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => { raw += chunk; });
          res.on("end", () => {
            try { resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) }); }
            catch { resolve({ status: res.statusCode ?? 0, body: raw }); }
          });
        }).once("error", reject);
      });

      assert.equal(status, 500, "should return 500 status");
      assert.equal((body as Record<string, unknown>)["error"], "Internal server error");
      assert.equal((body as Record<string, unknown>)["details"], undefined, "details should be absent");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
