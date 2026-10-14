/**
 * The detector's self-test (Launch Phase 2, increment 6, #631; plan D4).
 *
 * Runs inside the namespace before anything else, so the coverage the run
 * claims is checked on every run rather than asserted: four deliberate
 * attempts, each in its own time window, that both observers must record.
 * The windows go to a file the host side reads; everything either observer
 * records after the last window counts against the run.
 */
import dgram from "node:dgram";
import fs from "node:fs";

export const SELF_TEST_HOST = "acceptance-selftest.example";
export const SELF_TEST_IPV4 = "192.0.2.10";
export const SELF_TEST_IPV6 = "2001:db8::10";
export const SELF_TEST_UDP = { address: "192.0.2.20", port: 9999, payload: "acceptance-selftest-udp" } as const;

export type AttemptKey = "hostname" | "ipv4" | "ipv6" | "udp";

export interface SelfTestWindow {
  key: AttemptKey;
  start: number;
  end: number;
  /** What the attempt itself saw: an error code, or a status. */
  outcome: string;
}

export interface SelfTestRecord {
  windows: SelfTestWindow[];
  /** Everything after this time belongs to the run. */
  end: number;
}

const now = () => Date.now() / 1000;

async function httpAttempt(url: string): Promise<string> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    return `status ${res.status}`;
  } catch (err) {
    const cause = (err as { cause?: { code?: string; message?: string } }).cause;
    return `error ${cause?.code ?? cause?.message ?? (err as Error).message}`;
  }
}

function udpAttempt(): Promise<string> {
  return new Promise((resolve) => {
    const s = dgram.createSocket("udp4");
    s.on("error", (e) => { s.close(); resolve(`error ${(e as NodeJS.ErrnoException).code ?? e.message}`); });
    s.send(Buffer.from(SELF_TEST_UDP.payload), SELF_TEST_UDP.port, SELF_TEST_UDP.address, (e) => {
      s.close();
      resolve(e ? `error ${(e as NodeJS.ErrnoException).code ?? e.message}` : "sent");
    });
  });
}

const settle = () => new Promise((r) => setTimeout(r, 300));

export async function runSelfTest(out: string): Promise<SelfTestRecord> {
  const windows: SelfTestWindow[] = [];
  const attempts: Array<[AttemptKey, () => Promise<string>]> = [
    ["hostname", () => httpAttempt(`https://${SELF_TEST_HOST}/acceptance-selftest`)],
    ["ipv4", () => httpAttempt(`http://${SELF_TEST_IPV4}/acceptance-selftest`)],
    ["ipv6", () => httpAttempt(`http://[${SELF_TEST_IPV6}]/acceptance-selftest`)],
    ["udp", udpAttempt],
  ];
  for (const [key, attempt] of attempts) {
    const start = now();
    const outcome = await attempt();
    await settle();
    windows.push({ key, start, end: now(), outcome });
  }
  const record = { windows, end: now() };
  fs.writeFileSync(out, JSON.stringify(record, null, 2));
  return record;
}
