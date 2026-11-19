/**
 * @purpose Run by sentryFilter.leak.test.ts in its own process: sends real requests carrying marker credentials (a custom secret header, a `sid` cookie, the dev preview key, an authorization header) through the real @sentry/node SDK with this repo's scrubber and a stub transport, and prints, as JSON, every place in each captured event where a marker value survived.
 * @subsystem security
 *
 * A separate process because Sentry.init is global and would leak into other
 * tests sharing a process. Mirrors instrument.ts's options; nothing leaves the
 * machine (the transport is a stub). Search is by value, not key, so a new
 * place the SDK copies headers to is caught too (PR #1063 round 1).
 */
import * as Sentry from "@sentry/node";
import express from "express";
import { scrubSentryEvent } from "../lib/sentryFilter";

const MARKERS = {
  origin: "MARKER-ORIGIN-SECRET-0123456789",
  sid: "MARKER-SID-COOKIE-0123456789",
  devKey: "MARKER-DEV-PREVIEW-KEY-0123",
  auth: "MARKER-AUTH-0123456789",
};
const captured: Array<{ kind: string; event: unknown }> = [];

Sentry.init({
  dsn: "https://public@o0.ingest.sentry.invalid/0",
  environment: "production",
  tracesSampleRate: 1.0,
  sendDefaultPii: false,
  transport: () => ({ send: async () => ({ statusCode: 200 }), flush: async () => true }),
  beforeSend(event) { scrubSentryEvent(event); captured.push({ kind: "error", event }); return event; },
  beforeSendTransaction(event) { scrubSentryEvent(event); captured.push({ kind: "transaction", event }); return event; },
});

function paths(o: unknown, needle: string, p = "event", out: string[] = []): string[] {
  if (typeof o === "string") { if (o.includes(needle)) out.push(p); }
  else if (o && typeof o === "object") for (const [k, v] of Object.entries(o)) paths(v, needle, `${p}[${JSON.stringify(k)}]`, out);
  return out;
}

const app = express();
app.get("/api/ok", (_req, res) => { res.json({ ok: true }); });
app.get("/api/boom", () => { throw new Error("probe failure inside an admitted request"); });
Sentry.setupExpressErrorHandler(app);
app.use((_e: unknown, _req: express.Request, res: express.Response, _n: express.NextFunction) => { res.status(500).json({ error: "x" }); });

const server = app.listen(0, "127.0.0.1", async () => {
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  for (const path of ["/api/ok", "/api/boom"]) {
    await fetch(`http://127.0.0.1:${port}${path}`, {
      headers: {
        "x-overhype-origin": MARKERS.origin,
        "x-dev-preview-key": MARKERS.devKey,
        authorization: `Bearer ${MARKERS.auth}`,
        cookie: `sid=${MARKERS.sid}`,
        "user-agent": "probe-agent",
      },
    });
  }
  await new Promise((r) => setTimeout(r, 300));
  await Sentry.flush(2000);
  const report = captured.map(({ kind, event }) => ({
    kind,
    leaks: Object.fromEntries(Object.entries(MARKERS).map(([name, value]) => [name, paths(event, value)])),
    userAgentKept: paths(event, "probe-agent").length > 0,
  }));
  process.stdout.write(JSON.stringify(report) + "\n");
  server.close();
  process.exit(0);
});
