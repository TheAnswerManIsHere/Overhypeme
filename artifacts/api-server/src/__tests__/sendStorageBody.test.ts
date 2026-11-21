// #894: a storage failure partway through sending an object must end only that
// response. A bare `Readable.fromWeb(body).pipe(res)` lets the error reach the
// process's uncaught-exception handler, which exits the whole API server.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import express from "express";
import request from "supertest";
import { sendStorageBody } from "../lib/sendStorageBody.js";

function failingBody(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array([137, 80, 78, 71])); },
    pull(controller) { controller.error(new Error("storage failed mid-body")); },
  });
}

function appServing(body: () => ReadableStream<Uint8Array> | null) {
  const app = express();
  app.get("/object", async (_req, res) => {
    res.status(200).setHeader("Content-Type", "image/png");
    await sendStorageBody(res, body());
  });
  app.get("/health", (_req, res) => { res.json({ ok: true }); });
  return app;
}

describe("sendStorageBody", () => {
  it("a stream that fails mid-body cuts off that response and nothing escapes to the process", async () => {
    const uncaught: unknown[] = [];
    const onUncaught = (err: unknown) => { uncaught.push(err); };
    process.on("uncaughtException", onUncaught);
    try {
      const app = appServing(failingBody);
      await assert.rejects(request(app).get("/object"), "the response is cut off, not completed");
      await new Promise((r) => setTimeout(r, 50));
      assert.deepEqual(uncaught, [], "no error escaped to the process");
      assert.equal((await request(app).get("/health")).status, 200, "the server still answers");
    } finally {
      process.off("uncaughtException", onUncaught);
    }
  });

  it("a healthy stream is sent whole", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const app = appServing(() => new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(bytes); controller.close(); },
    }));
    const res = await request(app).get("/object").buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on("data", (c: Buffer) => chunks.push(c));
      r.on("end", () => cb(null, Buffer.concat(chunks)));
    });
    assert.equal(res.status, 200);
    assert.deepEqual([...(res.body as Buffer)], [...bytes]);
  });

  it("no body ends the response", async () => {
    const res = await request(appServing(() => null)).get("/object");
    assert.equal(res.status, 200);
  });
});

// The class, not the six examples: no route may pipe a web stream into a
// response unawaited. A new route that does fails here and names its file.
describe("every route streams stored objects through an awaited pipeline", () => {
  it("no route uses Readable.fromWeb(...).pipe(...)", () => {
    const dir = join(import.meta.dirname, "..", "routes");
    const offenders: string[] = [];
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".ts")) continue;
      const text = readFileSync(join(dir, name), "utf8");
      if (/Readable\.fromWeb\([\s\S]{0,200}?\)\s*\.pipe\(|nodeStream\.pipe\(/.test(text)) offenders.push(name);
    }
    assert.deepEqual(offenders, []);
  });
});
