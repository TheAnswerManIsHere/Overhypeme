/**
 * The acceptance run's parts (Phase 2, increment 6, #631; plan D2, D4, D6,
 * D10): the sink's parsers, the syscall record, the detector's verdict, the
 * image check, the per-operation evidence evaluator, the double's call log
 * and targeted failure, the recorder's upload ledger line and live-mode reuse,
 * the completion rule, and the live check's cap. The runs themselves are the
 * Acceptance workflow's; these pin each rule they rest on.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { evaluateCoverage, readCallRecords, unattributedCalls } from "../testing/acceptance/coverage.js";
import { controlVerdict } from "../testing/acceptance/controls.js";
import { evaluateDetector } from "../testing/acceptance/detector.js";
import { checkImage } from "../testing/acceptance/imageCheck.js";
import { describeTcp, dnsAnswer, httpHost, parseDnsQuery, tlsServerName } from "../testing/acceptance/sink.js";
import { attempts, classify, parseStraceLine, readSyscallRecord } from "../testing/acceptance/syscallRecord.js";
import { redReasons } from "../testing/acceptance/verdict.js";

const API_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PHOTO = fs.readFileSync(path.join(API_ROOT, "scripts/fixtures/ai-baseline/photo.jpg"));
const PREVIEW = fs.readFileSync(path.join(API_ROOT, "scripts/fixtures/ai-baseline/preview.jpg"));
const PHOTO_SHA = createHash("sha256").update(PHOTO).digest("hex");
const COMMITTED = path.join(API_ROOT, "src/lib/aiDouble/recordings");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "acceptance-test-"));

/** A DNS query for `name` (qtype A) as a resolver sends it. */
function dnsQuery(name: string, qtype = 1): Buffer {
  const labels = name.split(".").flatMap((l) => [Buffer.from([l.length]), Buffer.from(l)]);
  const q = Buffer.concat([Buffer.from([0x12, 0x34, 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0]), ...labels, Buffer.from([0, 0, qtype, 0, 1])]);
  return q;
}

/** A minimal TLS ClientHello carrying `sni`. */
function clientHello(sni: string): Buffer {
  const name = Buffer.from(sni);
  const sniExt = Buffer.concat([Buffer.from([0, 0]), u16(name.length + 5), u16(name.length + 3), Buffer.from([0]), u16(name.length), name]);
  const exts = Buffer.concat([Buffer.from([0x00, 0x0b, 0x00, 0x02, 0x01, 0x00]), sniExt]);
  const body = Buffer.concat([Buffer.from([0x03, 0x03]), Buffer.alloc(32), Buffer.from([0]), u16(2), Buffer.from([0x13, 0x01]), Buffer.from([1, 0]), u16(exts.length), exts]);
  const hs = Buffer.concat([Buffer.from([0x01, 0, (body.length >> 8) & 0xff, body.length & 0xff]), body]);
  return Buffer.concat([Buffer.from([0x16, 0x03, 0x01]), u16(hs.length), hs]);
}
function u16(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n);
  return b;
}

describe("the sink's parsers", () => {
  it("reads the name a DNS query asks for and answers an A query with the TEST-NET address", () => {
    const q = parseDnsQuery(dnsQuery("api.openai.com"));
    assert.equal(q?.name, "api.openai.com");
    const answer = dnsAnswer(dnsQuery("api.openai.com"), q!);
    assert.equal(answer.readUInt16BE(6), 1, "one answer");
    assert.deepEqual([...answer.subarray(-4)], [198, 51, 100, 7]);
    const aaaa = parseDnsQuery(dnsQuery("api.openai.com", 28))!;
    assert.equal(dnsAnswer(dnsQuery("api.openai.com", 28), aaaa).readUInt16BE(6), 0, "no AAAA answer");
  });

  it("refuses to read a response or a short datagram as a query", () => {
    const resp = dnsQuery("x.example");
    resp[2] = 0x81;
    assert.equal(parseDnsQuery(resp), null);
    assert.equal(parseDnsQuery(Buffer.from("acceptance-selftest-udp")), null);
  });

  it("reads the TLS server name by structure, and the HTTP Host", () => {
    assert.equal(tlsServerName(clientHello("fal.run")), "fal.run");
    assert.deepEqual(describeTcp(clientHello("api.stripe.com")), { name: "api.stripe.com", detail: "tls" });
    assert.equal(httpHost(Buffer.from("GET /x HTTP/1.1\r\nHost: 192.0.2.10\r\n\r\n")), "192.0.2.10");
    assert.equal(httpHost(Buffer.from("POST / HTTP/1.0\r\nAccept: */*\r\nhOsT:\t api.openai.com \r\n\r\n")), "api.openai.com");
    assert.equal(httpHost(Buffer.from("GET / HTTP/1.1\r\nAccept: */*\r\n\r\nHost: in-the-body\r\n")), null);
    // Arbitrary bytes, parsed in linear time.
    const started = Date.now();
    assert.equal(httpHost(Buffer.from("GET / HTTP/1.1\r\nhost:" + " ".repeat(200_000) + "\r")), null);
    assert.ok(Date.now() - started < 1000);
    assert.deepEqual(describeTcp(Buffer.from("\x00\x01binary")), { name: null, detail: "other" });
  });
});

describe("the syscall record", () => {
  const lines = [
    `101 1791945059.482346 connect(21, {sa_family=AF_INET, sin_port=htons(53), sin_addr=inet_addr("192.0.2.53")}, 16) = 0`,
    `102 1791945059.483393 connect(21, {sa_family=AF_INET, sin_port=htons(443), sin_addr=inet_addr("198.51.100.7")}, 16) = -1 EINPROGRESS (Operation now in progress)`,
    `103 1791945059.5 connect(22, {sa_family=AF_INET6, sin6_port=htons(80), sin6_flowinfo=htonl(0), inet_pton(AF_INET6, "2001:db8::10", &sin6_addr), sin6_scope_id=0}, 28) = -1 EINPROGRESS (Operation now in progress)`,
    `104 1791945059.6 sendmsg(21, {msg_name={sa_family=AF_INET, sin_port=htons(9999), sin_addr=inet_addr("203.0.113.1")}, msg_namelen=16}, 0) = 5`,
    `105 1791945059.7 connect(23, {sa_family=AF_INET, sin_port=htons(8080), sin_addr=inet_addr("127.0.0.1")}, 16) = 0`,
    `106 1791945059.8 connect(24, {sa_family=AF_UNIX, sun_path="/tmp/pg/.s.PGSQL.5432"}, 110) = 0`,
    `107 1791945059.9 socket(AF_INET6, SOCK_STREAM|SOCK_CLOEXEC|SOCK_NONBLOCK, IPPROTO_IP) = -1 EAFNOSUPPORT (Address family not supported by protocol)`,
    `108 1791945060.0 connect(25, {sa_family=AF_INET, sin_port=htons(53), sin_addr=inet_addr("127.0.0.53")}, 16) = 0`,
  ].join("\n");

  it("parses each traced call's destination", () => {
    const l = parseStraceLine(`103 1791945059.5 connect(22, {sa_family=AF_INET6, sin6_port=htons(80), sin6_flowinfo=htonl(0), inet_pton(AF_INET6, "2001:db8::10", &sin6_addr), sin6_scope_id=0}, 28) = -1 EINPROGRESS`);
    assert.deepEqual([l?.family, l?.address, l?.port], ["AF_INET6", "2001:db8::10", 80]);
  });

  it("counts every non-loopback destination and every DNS query, loopback included, as an attempt", () => {
    const got = attempts(readSyscallRecord(lines)).map((l) => `${l.address}:${l.port}`);
    assert.deepEqual(got, ["192.0.2.53:53", "198.51.100.7:443", "2001:db8::10:80", "203.0.113.1:9999", "127.0.0.53:53"]);
  });

  it("permits loopback traffic and unix sockets, and reports a failed socket() as information, never an attempt", () => {
    const parsed = readSyscallRecord(lines);
    assert.equal(classify(parsed.find((l) => l.tid === 105)!), "permitted");
    assert.equal(classify(parsed.find((l) => l.tid === 106)!), "permitted");
    assert.equal(classify(parsed.find((l) => l.tid === 107)!), "info");
  });
});

describe("the detector's verdict", () => {
  function workdir(opts: { ipv6: boolean; afterSelfTest?: boolean; missSink?: string }): string {
    const w = tmp();
    fs.writeFileSync(path.join(w, "netns.json"), JSON.stringify({ ok: true, ipv6: opts.ipv6, privilege: "user-namespace" }));
    const windows = [
      { key: "hostname", start: 10, end: 11, outcome: "error ECONNRESET" },
      { key: "ipv4", start: 11, end: 12, outcome: "error UND_ERR_SOCKET" },
      { key: "ipv6", start: 12, end: 13, outcome: opts.ipv6 ? "error UND_ERR_SOCKET" : "error EAFNOSUPPORT" },
      { key: "udp", start: 13, end: 14, outcome: "sent" },
    ];
    fs.writeFileSync(path.join(w, "selftest.json"), JSON.stringify({ windows, end: 14 }));
    const sink = [
      { t: 10.2, kind: "dns", name: "acceptance-selftest.example", family: "ipv4" },
      { t: 11.2, kind: "tcp", name: "192.0.2.10", detail: "http", family: "ipv4" },
      ...(opts.ipv6 ? [{ t: 12.2, kind: "tcp", name: "[2001:db8::10]", detail: "http", family: "ipv6" }] : []),
      { t: 13.2, kind: "udp", name: null, detail: "acceptance-selftest-udp", family: "ipv4" },
      ...(opts.afterSelfTest ? [{ t: 14.0, kind: "dns", name: "api.openai.com", family: "ipv4" }] : []),
    ].filter((e) => opts.missSink === undefined || (e.name !== opts.missSink && e.detail !== opts.missSink));
    fs.writeFileSync(path.join(w, "sink.log"), sink.map((e) => JSON.stringify(e)).join("\n") + "\n");
    const strace = [
      `1 10.2 connect(21, {sa_family=AF_INET, sin_port=htons(53), sin_addr=inet_addr("192.0.2.53")}, 16) = 0`,
      `1 11.2 connect(21, {sa_family=AF_INET, sin_port=htons(80), sin_addr=inet_addr("192.0.2.10")}, 16) = -1 EINPROGRESS`,
      opts.ipv6
        ? `1 12.2 connect(22, {sa_family=AF_INET6, sin6_port=htons(80), inet_pton(AF_INET6, "2001:db8::10", &sin6_addr)}, 28) = -1 EINPROGRESS`
        : `1 12.2 socket(AF_INET6, SOCK_STREAM, IPPROTO_IP) = -1 EAFNOSUPPORT`,
      `1 13.2 sendto(21, "x", 1, 0, {sa_family=AF_INET, sin_port=htons(9999), sin_addr=inet_addr("192.0.2.20")}, 16) = 1`,
      ...(opts.afterSelfTest ? [`2 14.0 connect(21, {sa_family=AF_INET, sin_port=htons(53), sin_addr=inet_addr("192.0.2.53")}, 16) = 0`] : []),
    ];
    fs.writeFileSync(path.join(w, "strace.log"), strace.join("\n") + "\n");
    return w;
  }

  it("is clean when both observers saw every observable self-test attempt and nothing after it", () => {
    for (const ipv6 of [true, false]) {
      const v = evaluateDetector(workdir({ ipv6 }));
      assert.equal(v.ok, true, JSON.stringify(v.problems));
      assert.equal(v.selfTest.find((c) => c.key === "ipv6")?.observable, ipv6);
    }
  });

  it("is red on any attempt at or after the self-test's end, with no grace at that boundary", () => {
    const v = evaluateDetector(workdir({ ipv6: false, afterSelfTest: true }));
    assert.equal(v.ok, false);
    assert.equal(v.violations.sink.length, 1);
    assert.equal(v.violations.syscall.length, 1);
  });

  it("is red when an observer missed a self-test attempt it should have seen", () => {
    const v = evaluateDetector(workdir({ ipv6: true, missSink: "[2001:db8::10]" }));
    assert.equal(v.ok, false);
    assert.match(v.problems.join(), /sink did not record the ipv6 self-test attempt/);
  });

  it("keeps what each observer recorded, the self-test's lines included, for the report", () => {
    const v = evaluateDetector(workdir({ ipv6: false, afterSelfTest: true }));
    assert.equal(v.records.selfTestWindows.length, 4);
    assert.equal(v.records.selfTestEnd, 14);
    assert.deepEqual(v.records.sink.map((e) => e.name), ["acceptance-selftest.example", "192.0.2.10", null, "api.openai.com"]);
    // Every syscall line that addressed a non-local destination, before and after
    // the self-test's end; the failed IPv6 socket() names none, so it is not one.
    assert.deepEqual(v.records.syscall.map((l) => l.t), [10.2, 11.2, 13.2, 14.0]);
  });

  it("is red when the boundary or the self-test never happened", () => {
    const w = tmp();
    assert.match(evaluateDetector(w).problems.join(), /never built.*self-test never ran/);
  });
});

describe("the image check", () => {
  it("decodes the pixels, not the header, and checks the type and aspect", async () => {
    assert.equal((await checkImage(PHOTO, "image/jpeg")).ok, true);
    assert.match(JSON.stringify(await checkImage(PHOTO.subarray(0, PHOTO.length >> 1), "image/jpeg")), /does not decode/);
    assert.match(JSON.stringify(await checkImage(PHOTO, "image/png")), /says image\/png/);
    assert.match(JSON.stringify(await checkImage(Buffer.from("not an image"), "image/jpeg")), /does not decode/);
    assert.match(JSON.stringify(await checkImage(PHOTO, "image/jpeg", "landscape")), /is not landscape/);
  });
});

describe("evidence per operation", () => {
  const recs = () => fs.readdirSync(COMMITTED).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(fs.readFileSync(path.join(COMMITTED, f), "utf8")));
  // The calls a fresh run makes: every answered recording but the duplicate judge, which only the fixture reaches.
  const isJudge = (r: any) => JSON.stringify(r.request).includes("You are a duplicate detector");
  const fresh = () => recs().filter((r) => r.kind !== "fal.pricing" && !r.error && !isJudge(r)).map((r) => ({ kind: r.kind, target: r.target, fingerprint: r.fingerprint, ok: true, outcome: "replayed" }));
  const fixture = () => recs().filter((r) => r.kind !== "fal.pricing" && !r.error).map((r) => ({ kind: r.kind, target: r.target, fingerprint: r.fingerprint, ok: true, outcome: "replayed" }));

  it("finds a usable answer for every operation a fresh run expects in the committed recordings", () => {
    const rows = evaluateCoverage({ mode: "acceptance", variant: "fresh", calls: fresh(), recordingsDir: COMMITTED, photoSha256: PHOTO_SHA });
    assert.deepEqual(rows.filter((r) => r.status === "missing").map((r) => r.key), []);
    assert.equal(rows.find((r) => r.key === "duplicate-judge")?.status, "not-required");
  });

  it("requires the duplicate judge over the fixture, and marks it missing when it never happened", () => {
    const without = evaluateCoverage({ mode: "acceptance", variant: "fixture", calls: fresh(), recordingsDir: COMMITTED, photoSha256: PHOTO_SHA });
    assert.deepEqual(without.filter((r) => r.status === "missing").map((r) => r.key), ["duplicate-judge"]);
    const withJudge = evaluateCoverage({ mode: "acceptance", variant: "fixture", calls: fixture(), recordingsDir: COMMITTED, photoSha256: PHOTO_SHA });
    assert.deepEqual(withJudge.filter((r) => r.status === "missing").map((r) => r.key), []);
  });

  it("marks an operation missing when its call failed, even though its recording exists", () => {
    const calls = fresh().map((c) => (c.kind === "fal.storage.upload" && recs().find((r) => r.fingerprint === c.fingerprint)?.request.sha256 === PHOTO_SHA ? { ...c, ok: false, outcome: "failed-on-request" } : c));
    const rows = evaluateCoverage({ mode: "acceptance", variant: "fresh", calls, recordingsDir: COMMITTED, photoSha256: PHOTO_SHA });
    assert.deepEqual(rows.filter((r) => r.status === "missing").map((r) => r.key), ["photo-upload"]);
  });

  it("marks an operation missing when its response is not usable by the product's reader", () => {
    const dir = tmp();
    for (const f of fs.readdirSync(COMMITTED)) fs.copyFileSync(path.join(COMMITTED, f), path.join(dir, f));
    const nsfw = recs().find((r) => r.kind === "fal.subscribe" && /nsfw/.test(r.target) && r.request.input.image_url.endsWith(PHOTO_SHA))!;
    fs.writeFileSync(path.join(dir, `fal.subscribe--${nsfw.fingerprint}.json`), JSON.stringify({ ...nsfw, response: { data: { unexpected: "shape" } } }));
    const rows = evaluateCoverage({ mode: "live", variant: "fresh", calls: fresh(), recordingsDir: dir, photoSha256: PHOTO_SHA });
    assert.deepEqual(rows.filter((r) => r.status === "missing").map((r) => r.key), ["photo-classifier"]);
  });

  it("reads the recorder's ledger and the double's call log as the same records, and reports calls nothing recorded", () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "ledger.json"), JSON.stringify({ limitUsd: 5, committedUsd: 0, lines: [{ kind: "openai.chat", target: "m", fingerprint: "abc", outcome: "error" }, { kind: "openai.chat", target: "m", fingerprint: "abc", outcome: "reused" }] }));
    fs.writeFileSync(path.join(dir, "calls.jsonl"), JSON.stringify({ t: 1, kind: "openai.chat", target: "m", fingerprint: "abc", outcome: "replayed" }) + "\n");
    assert.deepEqual(readCallRecords(path.join(dir, "ledger.json")).map((c) => c.ok), [false, true]);
    assert.deepEqual(readCallRecords(path.join(dir, "calls.jsonl")).map((c) => c.ok), [true]);
    assert.equal(unattributedCalls({ calls: readCallRecords(path.join(dir, "calls.jsonl")), recordingsDir: COMMITTED }).length, 1);
  });
});

describe("the double's call log and targeted failure", () => {
  const saved: Record<string, string | undefined> = {};
  let log = "";
  before(() => {
    for (const k of ["AI_RECORDINGS_DIR", "AI_DOUBLE_CALL_LOG", "AI_DOUBLE_FAIL", "AI_DOUBLE_MISS_LOG"]) saved[k] = process.env[k];
    log = path.join(tmp(), "calls.jsonl");
    process.env.AI_RECORDINGS_DIR = COMMITTED;
    process.env.AI_DOUBLE_CALL_LOG = log;
    delete process.env.AI_DOUBLE_MISS_LOG;
  });
  after(() => {
    for (const [k, v] of Object.entries(saved)) (v === undefined ? delete process.env[k] : (process.env[k] = v));
  });

  it("fails only the upload whose bytes the qualifier names, and logs every call", async () => {
    const { falDouble } = await import("../lib/aiDouble/doubles.js");
    process.env.AI_DOUBLE_FAIL = `fal.storage.upload:storage@${PHOTO_SHA}`;
    await assert.rejects(falDouble.storage.upload(new Blob([new Uint8Array(PHOTO)], { type: "image/jpeg" })), /failed on request/);
    const url = await falDouble.storage.upload(new Blob([new Uint8Array(PREVIEW)], { type: "image/jpeg" }));
    assert.match(url, /^https:\/\/fal-double\.invalid\/files\//);
    const lines = fs.readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(lines.map((l) => l.outcome), ["failed-on-request", "replayed"]);
    assert.ok(lines.every((l) => l.kind === "fal.storage.upload" && /^[0-9a-f]{64}$/.test(l.fingerprint)));
  });
});

describe("the recorder in the live check", () => {
  const saved: Record<string, string | undefined> = {};
  before(() => {
    for (const k of ["AI_RECORDINGS_DIR", "AI_RECORDER_LIVE"]) saved[k] = process.env[k];
  });
  after(() => {
    for (const [k, v] of Object.entries(saved)) (v === undefined ? delete process.env[k] : (process.env[k] = v));
  });

  it("writes a ledger line for every upload, an error line for one that throws", async () => {
    const { Allowance, recordingFal } = await import("../lib/aiDouble/recorder.js");
    process.env.AI_RECORDINGS_DIR = tmp();
    const ledger = path.join(tmp(), "ledger.json");
    const allowance = new Allowance(1, ledger);
    let fail = true;
    const real = {
      subscribe: async () => ({}),
      storage: { upload: async () => { if (fail) throw new Error("upload refused"); return "https://v3.fal.media/files/x.jpg"; } },
      queue: { submit: async () => ({}), status: async () => ({}), result: async () => ({}) },
      config: () => {},
    };
    const fal = recordingFal(real as never, allowance, { clients: {} }, async () => 0.08);
    await assert.rejects(fal.storage.upload(new Blob([new Uint8Array(PHOTO)], { type: "image/jpeg" })), /upload refused/);
    fail = false;
    await fal.storage.upload(new Blob([new Uint8Array(PHOTO)], { type: "image/jpeg" }));
    const lines = (JSON.parse(fs.readFileSync(ledger, "utf8")) as { lines: Array<{ kind: string; outcome: string; reservedUsd: number }> }).lines;
    assert.deepEqual(lines.map((l) => `${l.kind} ${l.outcome} ${l.reservedUsd}`), ["fal.storage.upload error 0", "fal.storage.upload ok 0"]);
  });

  it("sends a request to the vendor again in live mode even when this run already recorded it", async () => {
    const { Allowance, recordingFal } = await import("../lib/aiDouble/recorder.js");
    process.env.AI_RECORDINGS_DIR = tmp();
    let sent = 0;
    const real = {
      subscribe: async () => { sent += 1; return { data: { nsfw_probability: 0.01 }, requestId: "r" }; },
      storage: { upload: async () => "u" },
      queue: { submit: async () => ({}), status: async () => ({}), result: async () => ({}) },
      config: () => {},
    };
    const allowance = new Allowance(1);
    const fal = recordingFal(real as never, allowance, { clients: {} }, async () => 0.001);
    const opts = { input: { image_url: "https://fal-double.invalid/files/x" } };
    delete process.env.AI_RECORDER_LIVE;
    await fal.subscribe("fal-ai/imageutils/nsfw", opts);
    await fal.subscribe("fal-ai/imageutils/nsfw", opts);
    assert.equal(sent, 1, "a recording run reuses what it already holds");
    assert.deepEqual(allowance.lines.map((l) => l.outcome), ["ok", "reused"], "and its ledger names the reused answer");
    process.env.AI_RECORDER_LIVE = "1";
    await fal.subscribe("fal-ai/imageutils/nsfw", opts);
    assert.equal(sent, 2, "the live check never does");
  });
});

describe("the completion rule", () => {
  const passed = (j: string) => ({ journey: j as never, status: "passed" as const, evidence: {} });
  const all = () => ["2", "3", "4", "5", "6", "7"].map(passed);

  it("is green only with six passed journeys and nothing else wrong", () => {
    assert.deepEqual(redReasons({ journeys: all(), coverage: [], uncovered: [] }), []);
  });

  it("names every non-pass, a missing journey, a missing operation, an uncovered call and an outbound attempt", () => {
    const journeys = all().filter((j) => j.journey !== "4").map((j) => (j.journey === "6" ? { ...j, status: "not-run" as const, error: "journey 3 did not pass" } : j));
    const red = redReasons({
      journeys,
      coverage: [{ key: "photo-upload", journey: "7", description: "", status: "missing", calls: 1, detail: "0 usable" }],
      uncovered: ["openai.chat gpt-6-luna"],
      detector: { problems: [], violations: { sink: [{}], syscall: [] } },
      requirePexelsMeme: true,
      pexelsMeme: { ok: false },
    });
    assert.deepEqual(
      red.map((r) => r.split(":")[0]),
      ["journey 4 was never reported", "journey 6 not-run", "operation photo-upload (journey 7)", "uncovered AI call", "detector", "the Pexels-only meme read"],
    );
  });
});

describe("a negative control's verdict", () => {
  const passed = (j: string) => ({ journey: j as never, status: "passed" as const, evidence: {} });
  const all = () => ["2", "3", "4", "5", "6", "7"].map(passed);
  const outbound = "detector: 4 outbound attempt(s) recorded after the self-test";
  const forbidden = (red: string[]) =>
    controlVerdict("forbidden-request", { journeys: all(), coverage: [], red, detector: { violations: { sink: [{ name: "api.openai.com" }], syscall: [{}] } } });

  it("forbidden-request behaves on its own violation alone, and not beside an unrelated failure", () => {
    assert.equal(forbidden([outbound]).behaved, true);
    for (const extra of ["journey 5 failed: 500", "operation hashtags (journey 2): 0 usable", "setup: host-side: boom", "detector: the sink did not record the ipv4 self-test attempt", "uncovered AI call: openai.chat x"]) {
      const v = forbidden([outbound, extra]);
      assert.equal(v.behaved, false, extra);
      assert.match(v.why, /other red reasons/);
    }
  });

  it("render-failure accepts only what stopping at journey 3 explains", () => {
    const stopped = [
      "operation image-prompts (journey 3, 6): 3 usable of 3 attributed call(s), 4 needed",
      "operation photo-upload (journey 7): 0 usable of 0 attributed call(s), 1 needed",
      "journey 3 not-run: the render-failure control stops the run here",
      "journey 7 not-run: not reached",
    ];
    const run = (journeys: ReturnType<typeof all>, red: string[]) => controlVerdict("render-failure", { journeys, coverage: [], red, control: { ok: true, detail: "the render failed" } });
    const two = [passed("2")];
    assert.equal(run(two, stopped).behaved, true);
    assert.equal(run(two, [...stopped, "operation hashtags (journey 2): 0 usable"]).behaved, false);
    assert.equal(run(two, [...stopped, "journey 4 failed: 500"]).behaved, false);
    assert.equal(run([], stopped).behaved, false);
  });

  it("corrupt-source behaves on journey 4's composed-image failure alone", () => {
    const four = "journey 4 failed: [journey 4] anyone reads the public meme image: 502 from /api/memes/x/image";
    const journeys = all().map((j) => (j.journey === "4" ? { ...j, status: "failed" as const, error: "[journey 4] anyone reads the public meme image: 502" } : j));
    assert.equal(controlVerdict("corrupt-source", { journeys, coverage: [], red: [four] }).behaved, true);
    assert.equal(controlVerdict("corrupt-source", { journeys, coverage: [], red: [four, "uncovered AI call: openai.chat x"] }).behaved, false);
  });
});

describe("the live check's cap", () => {
  it("refuses more than $5 without the date David raised it", () => {
    const r = spawnSync(process.execPath, ["--import", "tsx/esm", "scripts/acceptance-run.ts", "--mode", "live", "--allowance", "6"], {
      cwd: API_ROOT,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, DATABASE_URL: process.env.DATABASE_URL, FAL_AI_API_KEY: "x", OPENAI_API_KEY: "x", PEXELS_API_KEY: "x" },
      encoding: "utf8",
    });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /cap is \$5 per run/);
    const raised = spawnSync(process.execPath, ["--import", "tsx/esm", "scripts/acceptance-run.ts", "--mode", "live", "--allowance", "6", "--allowance-raised-by-david", "2026-10-14"], {
      cwd: API_ROOT,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, DATABASE_URL: process.env.DATABASE_URL, CI: "true" },
      encoding: "utf8",
    });
    assert.doesNotMatch(raised.stderr, /cap is \$5 per run/);
    assert.match(raised.stderr, /never runs in CI/);
  });
});
