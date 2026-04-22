import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express, { type Request, type Response, type NextFunction } from "express";
import storageRouter from "../routes/storage.js";

/**
 * Boots a minimal Express app that mounts the real storage router with a
 * stubbed authentication middleware. Lets us exercise the upload-meme route's
 * validation (415, 413) without touching the DB or object storage — both 415
 * and 413 short-circuit before any persistence work.
 */
function startServer(): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const app = express();
    app.use((req: Request, _res: Response, next: NextFunction) => {
      const r = req as unknown as Record<string, unknown>;
      r["isAuthenticated"] = () => true;
      r["user"] = { id: "test-user-id" };
      const noop = () => {};
      r["log"] = { error: noop, warn: noop, info: noop, debug: noop, trace: noop, fatal: noop };
      next();
    });
    app.use(storageRouter);
    const server = app.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise<void>((r) => {
            server.close(() => r());
          }),
      });
    });
  });
}

function postBuffer(
  url: string,
  contentType: string,
  body: Buffer,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request(
      {
        method: "POST",
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        headers: {
          "Content-Type": contentType,
          "Content-Length": String(body.length),
        },
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

test("/storage/upload-meme rejects non-JPEG content types with 415", async () => {
  const { url, close } = await startServer();
  try {
    // Minimal PNG signature + a few bytes of payload.
    const pngBuf = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(64, 0),
    ]);
    const res = await postBuffer(`${url}/storage/upload-meme`, "image/png", pngBuf);
    assert.equal(res.status, 415, `expected 415 for PNG upload, got ${res.status} (${res.body})`);
    const parsed = JSON.parse(res.body) as { error?: string };
    assert.match(parsed.error ?? "", /JPEG/i);
  } finally {
    await close();
  }
});

test("/storage/upload-meme rejects oversized JPEG with 413", async () => {
  const { url, close } = await startServer();
  try {
    // Slightly above the 15 MB default cap. Content-Type is image/jpeg so we
    // exercise the body-parser size limit, not the content-type guard.
    const oversized = Buffer.alloc(16 * 1024 * 1024, 0xff);
    const res = await postBuffer(`${url}/storage/upload-meme`, "image/jpeg", oversized);
    assert.equal(res.status, 413, `expected 413 for oversized JPEG, got ${res.status} (${res.body})`);
    const parsed = JSON.parse(res.body) as { error?: string };
    assert.match(parsed.error ?? "", /too large/i);
  } finally {
    await close();
  }
});
