/**
 * Reads the email the production-mode launcher captured instead of sending
 * (`artifacts/api-server/src/testing/mailSink.ts`): one JSON file per message
 * in `E2E_MAIL_SINK_DIR`.
 */
import fs from "node:fs";
import path from "node:path";
import { expect } from "@playwright/test";

interface CapturedEmail {
  to: string;
  subject: string;
  text: string;
  html: string;
  capturedAt: string;
}

export function mailSinkDir(): string {
  const dir = process.env["E2E_MAIL_SINK_DIR"];
  if (!dir) {
    throw new Error(
      "E2E_MAIL_SINK_DIR is not set. This spec runs only against the production-mode stack " +
        "(src/testing/productionModeLauncher.ts), which captures email there; see the CI E2E job.",
    );
  }
  return dir;
}

function readAll(dir: string): CapturedEmail[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")) as CapturedEmail);
}

/**
 * Wait for the newest message to `to` whose body contains a link under `linkPath`,
 * captured after `since`, and return that link. The email goes through the real
 * queue (enqueue → worker claim → job handler), so it arrives on the worker's
 * poll interval, not instantly.
 */
export async function waitForEmailLink(opts: { to: string; linkPath: string; since: Date }): Promise<string> {
  const dir = mailSinkDir();
  const escapedPath = opts.linkPath.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  const pattern = new RegExp(`https?://[^\\s"'<>]+${escapedPath}\\?token=[0-9a-f]+`);
  let link: string | undefined;
  await expect
    .poll(
      () => {
        const match = readAll(dir)
          .filter((m) => m.to.toLowerCase() === opts.to.toLowerCase() && new Date(m.capturedAt) >= opts.since)
          .map((m) => m.text.match(pattern)?.[0])
          .filter((found): found is string => !!found)
          .pop();
        link = match;
        return match ?? null;
      },
      { message: `an email to ${opts.to} carrying a ${opts.linkPath} link`, timeout: 45_000, intervals: [1_000] },
    )
    .not.toBeNull();
  return link!;
}
