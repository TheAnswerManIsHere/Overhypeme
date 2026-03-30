import { type Request, type Response, type NextFunction } from "express";

/**
 * Middleware that authenticates requests using a static API key in the
 * X-API-Key header. This is designed for machine-to-machine callers (e.g.
 * LLM agents) that cannot use a browser session.
 *
 * The expected key is set via the ADMIN_API_KEY environment variable.
 * If the env var is not set, the middleware always rejects (fail-closed).
 */
export function requireApiKey(req: Request, res: Response, next: NextFunction): void {
  const expectedKey = process.env.ADMIN_API_KEY;

  if (!expectedKey) {
    res.status(401).json({ error: "API key auth is not configured on this server" });
    return;
  }

  const provided = req.headers["x-api-key"];
  const key = Array.isArray(provided) ? provided[0] : provided;

  if (!key || key !== expectedKey) {
    res.status(401).json({ error: "Missing or invalid X-API-Key header" });
    return;
  }

  next();
}
