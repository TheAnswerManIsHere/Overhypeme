/**
 * The outbound-request sink (Launch Phase 2, increment 6, #631; plan D4,
 * observer 1).
 *
 * Runs inside the acceptance run's private network namespace, where NAT rules
 * redirect every TCP connection and UDP datagram not addressed to loopback,
 * and every DNS query wherever it is addressed, to the two ports it listens
 * on. It records one JSON line per event — the DNS name queried, or, for TCP,
 * the TLS server name or HTTP Host the first bytes carry — then closes the
 * connection. It answers an A query with a TEST-NET address so the caller
 * proceeds to the TCP connect, which lands here too and yields the name a
 * second time. Nothing it receives ever leaves the namespace.
 *
 * Pure parsers are exported for the unit test; the listener starts only when
 * this file is run directly:
 *
 *   node --import tsx/esm src/testing/acceptance/sink.ts <log> <tcpPort> <udpPort> <readyFile> [ipv6]
 */
import dgram from "node:dgram";
import fs from "node:fs";
import net from "node:net";
import { fileURLToPath } from "node:url";

/** Where an answered A query points: TEST-NET-2, never routable. */
export const SINK_ANSWER_ADDRESS = [198, 51, 100, 7] as const;

export interface DnsQuestion {
  id: number;
  name: string;
  qtype: number;
  /** Offset just past the question's QCLASS: the header plus question is `buf.subarray(0, end)`. */
  end: number;
}

/** The first question of a DNS query, or null when the datagram is not one. */
export function parseDnsQuery(buf: Buffer): DnsQuestion | null {
  if (buf.length < 17) return null;
  const flags = buf.readUInt16BE(2);
  if (flags & 0x8000) return null; // a response, not a query
  if (buf.readUInt16BE(4) < 1) return null;
  const labels: string[] = [];
  let i = 12;
  for (;;) {
    if (i >= buf.length) return null;
    const len = buf[i]!;
    if (len === 0) { i += 1; break; }
    if (len > 63 || i + 1 + len > buf.length) return null;
    labels.push(buf.subarray(i + 1, i + 1 + len).toString("latin1"));
    i += 1 + len;
  }
  if (i + 4 > buf.length) return null;
  return { id: buf.readUInt16BE(0), name: labels.join("."), qtype: buf.readUInt16BE(i), end: i + 4 };
}

/** A response to `q`: one TEST-NET A record for an A query, an empty NOERROR answer otherwise. */
export function dnsAnswer(query: Buffer, q: DnsQuestion): Buffer {
  const head = Buffer.from(query.subarray(0, q.end));
  head.writeUInt16BE(0x8180, 2); // response, recursion desired + available, NOERROR
  head.writeUInt16BE(1, 4); // one question
  head.writeUInt16BE(q.qtype === 1 ? 1 : 0, 6);
  head.writeUInt16BE(0, 8);
  head.writeUInt16BE(0, 10); // drop any EDNS additional record
  if (q.qtype !== 1) return head;
  const answer = Buffer.alloc(16);
  answer.writeUInt16BE(0xc00c, 0); // the name, by pointer to the question
  answer.writeUInt16BE(1, 2); // A
  answer.writeUInt16BE(1, 4); // IN
  answer.writeUInt32BE(30, 6);
  answer.writeUInt16BE(4, 10);
  Buffer.from(SINK_ANSWER_ADDRESS).copy(answer, 12);
  return Buffer.concat([head, answer]);
}

/** The server_name of a TLS ClientHello, or null. Parsed by structure, never by scanning. */
export function tlsServerName(buf: Buffer): string | null {
  try {
    if (buf[0] !== 0x16 || buf[5] !== 0x01) return null;
    let i = 9 + 2 + 32; // record header (5) + handshake header (4) + version + random
    i += 1 + buf[i]!; // session id
    i += 2 + buf.readUInt16BE(i); // cipher suites
    i += 1 + buf[i]!; // compression methods
    const extEnd = i + 2 + buf.readUInt16BE(i);
    i += 2;
    while (i + 4 <= extEnd && i + 4 <= buf.length) {
      const type = buf.readUInt16BE(i);
      const len = buf.readUInt16BE(i + 2);
      if (type === 0) {
        let j = i + 4 + 2; // server_name_list length
        while (j + 3 <= i + 4 + len) {
          const nameType = buf[j]!;
          const nameLen = buf.readUInt16BE(j + 1);
          if (nameType === 0) return buf.subarray(j + 3, j + 3 + nameLen).toString("latin1");
          j += 3 + nameLen;
        }
        return null;
      }
      i += 4 + len;
    }
    return null;
  } catch {
    return null;
  }
}

/** The Host header of a plain HTTP request, or null. */
export function httpHost(buf: Buffer): string | null {
  const text = buf.toString("latin1");
  if (!/^[A-Z]+ \S+ HTTP\/1\.[01]\r\n/.test(text)) return null;
  const m = /\r\nhost:[ \t]*([^\r\n]+)/i.exec(text);
  return m ? m[1]!.trim() : null;
}

export interface SinkEvent {
  t: number;
  kind: "dns" | "tcp" | "udp";
  /** The DNS name, TLS server name or HTTP Host; null when the bytes carry none. */
  name: string | null;
  /** For TCP: "tls", "http" or "other". For UDP that is not DNS: a printable preview. */
  detail?: string;
  family: "ipv4" | "ipv6";
}

/** What a TCP connection's first bytes say about where it was going. */
export function describeTcp(first: Buffer): Pick<SinkEvent, "name" | "detail"> {
  const sni = tlsServerName(first);
  if (first[0] === 0x16) return { name: sni, detail: "tls" };
  const host = httpHost(first);
  if (host !== null) return { name: host, detail: "http" };
  return { name: null, detail: "other" };
}

function familyOf(address: string | undefined): "ipv4" | "ipv6" {
  return address && address.includes(":") && !address.startsWith("::ffff:") ? "ipv6" : "ipv4";
}

export function startSink(opts: { log: string; tcpPort: number; udpPort: number; ipv6: boolean }): Promise<() => void> {
  const record = (e: Omit<SinkEvent, "t">) => fs.appendFileSync(opts.log, JSON.stringify({ t: Date.now() / 1000, ...e }) + "\n");
  const closers: Array<() => void> = [];
  const hosts = opts.ipv6 ? ["127.0.0.1", "::1"] : ["127.0.0.1"];
  const started: Promise<void>[] = [];
  for (const host of hosts) {
    const tcp = net.createServer((s) => {
      s.on("error", () => {});
      const timer = setTimeout(() => {
        record({ kind: "tcp", name: null, detail: "silent", family: familyOf(s.remoteAddress) });
        s.destroy();
      }, 2000);
      s.once("data", (b: Buffer) => {
        clearTimeout(timer);
        record({ kind: "tcp", ...describeTcp(b), family: familyOf(s.remoteAddress) });
        s.destroy();
      });
    });
    started.push(new Promise((r) => tcp.listen(opts.tcpPort, host, () => r())));
    closers.push(() => tcp.close());
    const udp = dgram.createSocket(host.includes(":") ? "udp6" : "udp4");
    udp.on("message", (m, rinfo) => {
      const q = parseDnsQuery(m);
      if (q) {
        record({ kind: "dns", name: q.name, family: familyOf(rinfo.address) });
        udp.send(dnsAnswer(m, q), rinfo.port, rinfo.address);
      } else {
        record({ kind: "udp", name: null, detail: m.subarray(0, 64).toString("latin1").replace(/[^\x20-\x7e]/g, "."), family: familyOf(rinfo.address) });
      }
    });
    started.push(new Promise((r) => udp.bind(opts.udpPort, host, () => r())));
    closers.push(() => udp.close());
  }
  return Promise.all(started).then(() => () => closers.forEach((c) => c()));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [log, tcp, udp, ready, v6] = process.argv.slice(2);
  await startSink({ log: log!, tcpPort: Number(tcp), udpPort: Number(udp), ipv6: v6 === "ipv6" });
  fs.writeFileSync(ready!, String(process.pid));
  process.on("SIGTERM", () => process.exit(0));
}
