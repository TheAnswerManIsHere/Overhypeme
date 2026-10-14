/**
 * The host side of the outbound-request detector (Launch Phase 2, increment 6,
 * #631; plan D4): choose how the namespace is created, launch a payload inside
 * it, and judge what the two observers recorded.
 *
 * The rule: a run is red when the namespace could not be built as described,
 * when the self-test did not register on an observer that should have seen
 * it, or when either observer recorded a non-permitted attempt after the
 * self-test ended. The report lists every sink event and every syscall line
 * that addressed a non-local destination, with a count of the permitted ones.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SINK_ANSWER_ADDRESS, type SinkEvent } from "./sink";
import { SELF_TEST_HOST, SELF_TEST_IPV4, SELF_TEST_IPV6, SELF_TEST_UDP, type AttemptKey, type SelfTestRecord } from "./selfTest";
import { attempts, classify, readSyscallRecord, type SyscallLine } from "./syscallRecord";

const WRAPPER = path.join(path.dirname(fileURLToPath(import.meta.url)), "netns-run.sh");

export type NamespaceRoute = { kind: "user-namespace" } | { kind: "sudo"; drop: string };

/** How this host can create the namespace, or why it cannot. */
export function namespaceRoute(): NamespaceRoute | { kind: "unavailable"; reason: string } {
  const probe = ["ip", "link", "set", "lo", "up"];
  const user = spawnSync("unshare", ["-rnm", ...probe], { encoding: "utf8" });
  if (user.status === 0) return { kind: "user-namespace" };
  const sudo = spawnSync("sudo", ["-n", "unshare", "-nm", ...probe], { encoding: "utf8" });
  if (sudo.status === 0) return { kind: "sudo", drop: `${process.getuid!()}:${process.getgid!()}` };
  return {
    kind: "unavailable",
    reason:
      `unprivileged: ${(user.stderr || user.error?.message || `exit ${user.status}`).trim()}; ` +
      `sudo: ${(sudo.stderr || sudo.error?.message || `exit ${sudo.status}`).trim()}`,
  };
}

/** Launch `node <args>` inside the namespace, with both observers attached. */
export function launchInNamespace(route: NamespaceRoute, work: string, apiRoot: string, nodeArgs: string[]): ChildProcess {
  const inner = [WRAPPER, work, route.kind === "sudo" ? route.drop : "", process.execPath, apiRoot, "--", ...nodeArgs];
  return route.kind === "sudo"
    ? spawn("sudo", ["-n", "unshare", "-nm", "--propagation", "private", "bash", ...inner], { stdio: ["ignore", "pipe", "pipe"] })
    : spawn("unshare", ["-rnm", "--propagation", "private", "bash", ...inner], { stdio: ["ignore", "pipe", "pipe"] });
}

export interface AttemptCheck {
  key: AttemptKey;
  /** Whether this host can observe the attempt at all (IPv6 needs a kernel with IPv6). */
  observable: boolean;
  syscall: boolean;
  sink: boolean;
  outcome: string;
}

export interface DetectorVerdict {
  ok: boolean;
  /** Why the boundary or the self-test failed; empty when both held. */
  problems: string[];
  netns: { ok: boolean; ipv6?: boolean; privilege?: string; error?: string } | null;
  selfTest: AttemptCheck[];
  violations: { sink: SinkEvent[]; syscall: SyscallLine[] };
  /** Failed socket() calls after the self-test: information, never a violation (see syscallRecord.ts). */
  info: SyscallLine[];
  /**
   * What each observer recorded across the whole run, so the report outlives
   * the scratch directory: every sink event, every syscall line that addressed
   * a non-local destination (the self-test's included), the self-test windows
   * that interpret them, and a count of the permitted local lines left out.
   */
  records: {
    selfTestWindows: SelfTestRecord["windows"];
    selfTestEnd: number | null;
    sink: SinkEvent[];
    syscall: SyscallLine[];
    permittedSyscallLines: number;
  };
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

function readSink(file: string): SinkEvent[] {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as SinkEvent);
}

const SLACK = 0.05;

export function evaluateDetector(work: string): DetectorVerdict {
  const problems: string[] = [];
  const netns = readJson<DetectorVerdict["netns"]>(path.join(work, "netns.json"));
  if (!netns) problems.push("the namespace wrapper wrote no status: the boundary was never built");
  else if (!netns.ok) problems.push(`the namespace could not be built: ${netns.error}`);
  const self = readJson<SelfTestRecord>(path.join(work, "selftest.json"));
  if (!self) problems.push("the self-test never ran: nothing shows the observers work");
  const sink = readSink(path.join(work, "sink.log"));
  const strace = fs.existsSync(path.join(work, "strace.log")) ? readSyscallRecord(fs.readFileSync(path.join(work, "strace.log"), "utf8")) : [];
  if (netns?.ok && strace.length === 0) problems.push("strace recorded nothing: the syscall observer was not attached");

  const ipv6 = netns?.ipv6 === true;
  const selfTest: AttemptCheck[] = (self?.windows ?? []).map((w) => {
    const inWindow = (t: number) => t >= w.start - SLACK && t <= w.end + SLACK;
    const mine = (l: SyscallLine) =>
      w.key === "hostname" ? l.port === 53 || l.address === SINK_ANSWER_ADDRESS.join(".")
      : w.key === "ipv4" ? l.address === SELF_TEST_IPV4
      : w.key === "ipv6" ? l.address === SELF_TEST_IPV6
      : l.address === SELF_TEST_UDP.address && l.port === SELF_TEST_UDP.port;
    const syscall = attempts(strace).some((l) => inWindow(l.t) && mine(l));
    const events = sink.filter((e) => inWindow(e.t));
    const sinkSaw =
      w.key === "hostname" ? events.some((e) => e.name === SELF_TEST_HOST)
      : w.key === "ipv4" ? events.some((e) => e.name === SELF_TEST_IPV4)
      : w.key === "ipv6" ? events.some((e) => e.name === `[${SELF_TEST_IPV6}]`)
      : events.some((e) => e.kind === "udp" && (e.detail ?? "").startsWith(SELF_TEST_UDP.payload));
    return { key: w.key, observable: w.key !== "ipv6" || ipv6, syscall, sink: sinkSaw, outcome: w.outcome };
  });
  for (const c of selfTest) {
    if (!c.observable) {
      if (!c.outcome.startsWith("error")) problems.push(`the ${c.key} self-test attempt succeeded on a host that cannot observe it (${c.outcome})`);
      continue;
    }
    if (!c.syscall) problems.push(`the syscall observer did not record the ${c.key} self-test attempt`);
    if (!c.sink) problems.push(`the sink did not record the ${c.key} self-test attempt`);
  }
  if (self && selfTest.length !== 4) problems.push(`the self-test made ${selfTest.length} of 4 attempts`);

  // No grace at this boundary: each window already ends after a settle delay, so
  // every self-test line precedes `end`, and anything at or after it is the run's.
  const after = self?.end ?? Number.NEGATIVE_INFINITY;
  const violations = {
    sink: sink.filter((e) => e.t >= after),
    syscall: attempts(strace).filter((l) => l.t >= after),
  };
  const info = strace.filter((l) => l.t >= after && classify(l) === "info" && l.call === "socket");
  const ok = problems.length === 0 && violations.sink.length === 0 && violations.syscall.length === 0;
  const recordedAttempts = attempts(strace);
  const records = {
    selfTestWindows: self?.windows ?? [],
    selfTestEnd: self?.end ?? null,
    sink,
    syscall: recordedAttempts,
    permittedSyscallLines: strace.filter((l) => classify(l) === "permitted").length,
  };
  return { ok, problems, netns, selfTest, violations, info, records };
}
