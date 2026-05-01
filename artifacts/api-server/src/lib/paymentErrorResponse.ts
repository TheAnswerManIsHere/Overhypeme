import type { Request, Response } from "express";
import * as Sentry from "@sentry/node";
import { logger } from "./logger";

export function paymentErrorResponse(params: {
  req: Request;
  res: Response;
  status?: number;
  clientMessage: string;
  logMessage: string;
  err: unknown;
  extra?: Record<string, unknown>;
}) {
  const { req, res, status = 500, clientMessage, logMessage, err, extra } = params;
  const requestId = req.header("x-request-id") ?? req.header("x-correlation-id") ?? undefined;
  Sentry.captureException(err, {
    extra: {
      requestId,
      ...extra,
    },
  });
  logger.error(
    {
      err,
      requestId,
      ...extra,
    },
    logMessage,
  );
  res.status(status).json({ error: clientMessage, requestId });
}
