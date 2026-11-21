/**
 * @purpose Stream a stored object's body into an HTTP response so that a storage failure partway through ends only that response: the copy is an awaited `pipeline`, and an error after the copy starts is logged and the response destroyed, never thrown to the caller or left to reach the process's uncaught-exception handler (#894).
 */
import type { Response } from "express";
import { Readable } from "node:stream";
import type { ReadableStream } from "node:stream/web";
import { pipeline } from "node:stream/promises";
import { logger } from "./logger";

/**
 * Send `body` as the rest of `res`, or end `res` when there is no body.
 *
 * Never rejects. A bare `Readable.fromWeb(body).pipe(res)` has no error
 * listener, so a storage error after the handler's awaited work has finished
 * escapes every `try/catch` and exits the whole server. `pipeline` surfaces the
 * error here instead; by then the status and headers are committed (or the
 * response already destroyed by `pipeline`), so the only honest end is to cut
 * the response off and log it.
 */
export async function sendStorageBody(
  res: Response,
  body: ReadableStream<Uint8Array> | globalThis.ReadableStream<Uint8Array> | null,
  context: Record<string, unknown> = {},
): Promise<void> {
  if (!body) { res.end(); return; }
  try {
    await pipeline(Readable.fromWeb(body as ReadableStream<Uint8Array>), res);
  } catch (err) {
    logger.warn({ err, ...context }, "[storage] object stream failed mid-body; response cut off");
    if (!res.destroyed) res.destroy();
  }
}
