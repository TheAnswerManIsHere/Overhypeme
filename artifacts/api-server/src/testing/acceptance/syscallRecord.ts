/**
 * The syscall record (Launch Phase 2, increment 6, #631; plan D4, observer 2).
 *
 * The acceptance run's process tree runs under
 *   strace -f -ttt --seccomp-bpf -e trace=socket,connect,sendto,sendmsg,sendmmsg
 * and this module reads what strace wrote. An attempt to reach a non-local
 * address is recorded whether or not a packet followed, which is what the
 * packet sink alone cannot see: a connect the kernel refused, a datagram with
 * no route.
 *
 * What is permitted: unix and netlink sockets (the database relay, Node's
 * interface queries), and loopback TCP or UDP to any port but 53 (the server,
 * the driver's requests to it, the sink). A DNS query is never permitted:
 * resolving a host is the first step of reaching it.
 *
 * A failed `socket()` carries no destination. Node's `listen()` probes
 * `socket(AF_INET6)` and falls back to IPv4 on a kernel without IPv6, so a
 * failed socket call is reported as information, never as an attempt; an
 * IPv6-literal request on such a kernel therefore cannot be observed, and the
 * self-test says so rather than claiming coverage it does not have.
 */

export interface SyscallLine {
  tid: number;
  /** Seconds since the epoch, from strace's `-ttt`. */
  t: number;
  call: string;
  family: string | null;
  address: string | null;
  port: number | null;
  /** The return text after `=`, when the line carries one. */
  result: string | null;
  raw: string;
}

const LINE = /^(\d+)\s+(\d+\.\d+)\s+(socket|connect|sendto|sendmsg|sendmmsg)\((.*)$/;

export function parseStraceLine(raw: string): SyscallLine | null {
  const m = LINE.exec(raw.trim());
  if (!m) return null;
  const [, tid, t, call, rest] = m;
  const fam = /sa_family=(AF_[A-Z0-9]+)/.exec(rest!) ?? (call === "socket" ? /^(AF_[A-Z0-9]+)/.exec(rest!) : null);
  const port = /sin6?_port=htons\((\d+)\)/.exec(rest!);
  const v4 = /sin_addr=inet_addr\("([^"]+)"\)/.exec(rest!);
  const v6 = /inet_pton\(AF_INET6, "([^"]+)"/.exec(rest!);
  const unix = /sun_path=(?:@)?"([^"]*)"/.exec(rest!);
  const result = /\)\s*=\s*(.+)$/.exec(rest!);
  return {
    tid: Number(tid),
    t: Number(t),
    call: call!,
    family: fam ? fam[1]! : null,
    address: v4?.[1] ?? v6?.[1] ?? unix?.[1] ?? null,
    port: port ? Number(port[1]) : null,
    result: result ? result[1]!.trim() : null,
    raw: raw.trim(),
  };
}

function isLoopback(family: string, address: string | null): boolean {
  if (!address) return false;
  if (family === "AF_INET") return address.startsWith("127.");
  if (family === "AF_INET6") return address === "::1" || address.startsWith("::ffff:127.");
  return false;
}

export type Classification = "permitted" | "attempt" | "info";

/** Whether one line is an outbound attempt. A line with no destination is never one. */
export function classify(line: SyscallLine): Classification {
  if (line.call === "socket") return line.result?.startsWith("-1") ? "info" : "permitted";
  if (!line.family) return "info"; // e.g. a connected socket's send, which names no address
  if (line.family === "AF_UNIX" || line.family === "AF_NETLINK") return "permitted";
  if (line.family === "AF_INET" || line.family === "AF_INET6") {
    if (line.port === 53) return "attempt";
    return isLoopback(line.family, line.address) ? "permitted" : "attempt";
  }
  if (line.family === "AF_UNSPEC") return "info"; // connect(AF_UNSPEC) dissolves an association
  return "attempt";
}

export function readSyscallRecord(text: string): SyscallLine[] {
  return text
    .split("\n")
    .map(parseStraceLine)
    .filter((l): l is SyscallLine => l !== null);
}

export function attempts(lines: SyscallLine[]): SyscallLine[] {
  return lines.filter((l) => classify(l) === "attempt");
}
