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

/**
 * C5. MIME-spoofed file is rejected
 *
 * A plain text file sent with Content-Type: image/jpeg must be rejected based
 * on actual file content inspection (sharp metadata probe), NOT by trusting
 * the Content-Type header alone. Trusting the header would be a security bug.
 *
 * Expected: 422 — rejected at the validateAndProbe stage, before any
 * moderation classifier (Arachnid / NSFW) is reached. This is the same
 * "no classifier called" behaviour as C4, because the sharp probe fires first
 * and short-circuits the pipeline.
 */
test("C5: MIME-spoofed file (text/plain bytes sent as image/jpeg) is rejected with 422 based on content inspection", async () => {
  const { url, close } = await startServer();
  try {
    // Simulate not-an-image.txt: plain ASCII text content that is nowhere near
    // a valid JPEG bitstream, but sent with a spoofed Content-Type header.
    const textContent = Buffer.from(
      "This is not an image. It is a plain text file masquerading as a JPEG.",
    );
    const res = await postBuffer(`${url}/storage/upload-meme`, "image/jpeg", textContent);

    // The server must inspect the actual bytes via sharp and reject on content,
    // not accept because the header claims image/jpeg.
    assert.equal(
      res.status,
      422,
      `expected 422 (content inspection failure), got ${res.status} (${res.body})`,
    );
    const parsed = JSON.parse(res.body) as { error?: string };
    // Must return an error about the file not being a valid JPEG — confirming
    // rejection came from content inspection, not Content-Type acceptance.
    assert.ok(parsed.error, "response body must contain an error field");
    assert.match(
      parsed.error ?? "",
      /valid JPEG|not.*JPEG|JPEG.*image/i,
      `error message should mention invalid JPEG content, got: "${parsed.error}"`,
    );
  } finally {
    await close();
  }
});
