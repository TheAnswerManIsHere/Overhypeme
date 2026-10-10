/**
 * The email transport a test harness installs in place of Resend: each message
 * becomes one JSON file in a directory the harness names, which the browser
 * test reads to follow a verification or password-reset link.
 *
 * Only `productionModeLauncher.ts` constructs one. The captured messages carry
 * live sign-in links, so the directory is created private to this user, it is
 * never served over HTTP, and the CI job never uploads it as an artefact.
 */
import fs from "node:fs";
import path from "node:path";

import type { EmailTransport, OutgoingEmail } from "../lib/email";

export interface CapturedEmail extends OutgoingEmail {
  capturedAt: string;
}

export function createMailSink(directory: string): EmailTransport {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  let sequence = 0;
  return {
    async send(message: OutgoingEmail) {
      sequence += 1;
      const captured: CapturedEmail = { ...message, capturedAt: new Date().toISOString() };
      const name = `${Date.now()}-${String(sequence).padStart(4, "0")}.json`;
      fs.writeFileSync(path.join(directory, name), JSON.stringify(captured, null, 2), { mode: 0o600 });
      return { error: null };
    },
  };
}
