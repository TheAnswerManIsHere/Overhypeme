/**
 * A port to hand to a child server process that a boot test then watches.
 *
 * Boot tests assert "the port never opened" (or "it did") by connecting to it,
 * so the answer is only about the child if nobody else can be listening there.
 * The usual trick — `listen(0)`, read the port, close — returns a port from the
 * kernel's ephemeral pool, and puts it straight back: the suite runs as four
 * shards whose supertest requests each `listen(0)`, so one of them can be handed
 * that same port while a refusing child is being watched. Its server accepts the
 * probe and the test fails on a refusal that worked (#642).
 *
 * The kernel only gives out ephemeral ports to `listen(0)` and outbound
 * `connect()`, so a port below that range is never handed to anyone who did not
 * name it. This picks one at random below the range and checks it is free.
 *
 * Known residual, accepted: the check is a moment, not a reservation, so two
 * shards booting a child at once could draw the same port (about 1 in 22,000
 * per overlapping pair; within a shard, files run one at a time). Revisit if a
 * collision is ever observed or the suite gains within-shard concurrency.
 */
import { readFileSync } from "node:fs";
import { createServer } from "node:net";

const LOWEST = 10_000;
/** Linux's default floor; also below macOS's 49152, so it holds where /proc is absent. */
const DEFAULT_FLOOR = 32_768;

/** The lowest port the kernel may assign on its own. */
export function ephemeralPortFloor(): number {
  try {
    const [low] = readFileSync("/proc/sys/net/ipv4/ip_local_port_range", "utf8").trim().split(/\s+/);
    const parsed = Number(low);
    if (Number.isInteger(parsed) && parsed > 0) return Math.min(parsed, DEFAULT_FLOOR);
  } catch {
    // Not Linux: fall through to the default floor.
  }
  return DEFAULT_FLOOR;
}

function bindable(port: number): Promise<boolean> {
  return new Promise((resolveP) => {
    const probe = createServer();
    probe.once("error", () => resolveP(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolveP(true)));
  });
}

/** The first candidate that can be bound right now. Exported for its test. */
export async function firstBindable(candidates: Iterable<number>): Promise<number> {
  for (const port of candidates) {
    if (await bindable(port)) return port;
  }
  throw new Error("no free port among the candidates");
}

function* randomCandidates(floor: number, tries: number): Generator<number> {
  for (let i = 0; i < tries; i++) yield LOWEST + Math.floor(Math.random() * (floor - LOWEST));
}

export async function portForChildProcess(): Promise<number> {
  const floor = ephemeralPortFloor();
  if (floor <= LOWEST) {
    throw new Error(`the ephemeral range starts at ${floor}; no port below it is left to pick from`);
  }
  return await firstBindable(randomCandidates(floor, 50));
}
