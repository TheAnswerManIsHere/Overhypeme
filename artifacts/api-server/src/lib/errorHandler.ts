import type { Request, Response, NextFunction } from "express";
import { scrubObject } from "@workspace/redact";
import { logger } from "./logger.js";

export interface AppError extends Error {
  details?: unknown;
}

export function fallbackErrorHandler(
  err: AppError,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  logger.error({ err, url: req.url, method: req.method }, "Unhandled route error");
  if (res.headersSent) return;
  const scrubbed = err.details !== undefined ? scrubObject(err.details) : undefined;
  const body: Record<string, unknown> = {
    error: "Internal server error",
    eventId: (res as Response & { sentry?: string }).sentry,
  };
  if (scrubbed !== undefined) {
    body["details"] = scrubbed;
  }
  res.status(500).json(body);
}
