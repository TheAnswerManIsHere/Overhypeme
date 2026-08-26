import type { Request, Response } from "express";
import * as Sentry from "@sentry/node";
import { logger } from "./logger";
import { StripeVerificationError } from "./stripeVerificationErrors.js";

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

  // The account guard's refusal is a specific condition, and every call site
  // here passes a FIXED clientMessage — "Unable to start checkout. Please try
  // again." and variants — while the thrown error's own message is logged and
  // discarded. So without this mapping, a customer hitting checkout during a
  // degraded boot is told to retry a condition retrying does not fix.
  //
  // One mapping at the boundary all payment routes already pass through, rather
  // than an edit per route. The client-safe message never carries an account id
  // — a mismatch refusal's diagnostic text names both accounts and stays in the
  // log — and `code` lets the frontend branch without parsing prose.
  const verificationRefusal = err instanceof StripeVerificationError ? err : null;
  const effectiveStatus = verificationRefusal ? 503 : status;
  const effectiveClientMessage = verificationRefusal ? verificationRefusal.clientMessage : clientMessage;
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
  res.status(effectiveStatus).json({
    error: effectiveClientMessage,
    requestId,
    ...(verificationRefusal ? { code: verificationRefusal.code } : {}),
  });
}
