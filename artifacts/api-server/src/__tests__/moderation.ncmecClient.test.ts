/**
 * NCMEC ISPWS client and XML builders — phase 2 of the CyberTipline plan.
 *
 * Every test here runs with `fetchImpl` stubbed against committed fixtures and **no network
 * access at all**. That is what makes the phase independently verifiable, and it is why CI
 * never reaches NCMEC.
 *
 * The fixtures are real `<reportResponse>` / `<reportDoneResponse>` documents transcribed
 * from NCMEC's public documentation, not hand-typed strings — see
 * `fixtures/ncmec/README.md`. Asserting the classification table against invented shapes
 * would make the invention the de-facto contract.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  NcmecClient,
  NCMEC_ISPWS_BASE_URLS,
  NCMEC_MAX_RESPONSE_BYTES,
  NCMEC_RESPONSE_CODES,
  classifyNcmecResponseCode,
  ncmecBaseUrlFor,
} from "../lib/moderation/ncmecClient.js";
import {
  NcmecMappingError,
  buildFileDetailsXml,
  buildReportXml,
  ncmecIncidentTypeFor,
} from "../lib/moderation/ncmecXml.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, "fixtures/ncmec");

function fixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURES, `${name}.xml`), "utf-8");
}

const CREDENTIALS = { username: "usr123", password: "pswd123" };

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A `fetch` that answers with one fixture and records exactly what it was asked. */
function stubFetch(
  body: string,
  init: { status?: number } = {},
): { fetchImpl: typeof fetch; calls: CapturedRequest[] } {
  const calls: CapturedRequest[] = [];
  const fetchImpl = (async (url: string | URL | Request, options: RequestInit = {}) => {
    calls.push({
      url: String(url),
      method: options.method ?? "GET",
      headers: (options.headers ?? {}) as Record<string, string>,
      body: options.body,
    });
    return new Response(body, {
      status: init.status ?? 200,
      headers: { "content-type": "text/xml" },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function client(body: string, init: { status?: number } = {}) {
  const { fetchImpl, calls } = stubFetch(body, init);
  return {
    calls,
    instance: new NcmecClient({
      fetchImpl,
      credentials: CREDENTIALS,
      baseUrl: NCMEC_ISPWS_BASE_URLS.test,
    }),
  };
}

// ─── Happy paths ────────────────────────────────────────────────────────────

describe("NcmecClient — successful calls", () => {
  it("parses the report id out of a /submit response", async () => {
    const { instance, calls } = client(fixture("submit-ok"));
    const result = await instance.submitReport("<report/>");
    assert.equal(result.status, "ok");
    assert.equal(result.status === "ok" && result.data.reportId, "4564654");

    const call = calls[0]!;
    assert.equal(call.url, `${NCMEC_ISPWS_BASE_URLS.test}/submit`);
    assert.equal(call.method, "POST");
    // NCMEC's own documentation calls out the charset: without it non-ASCII characters can
    // be mistransmitted, and a report naming a person is exactly where that matters.
    assert.equal(call.headers["content-type"], "text/xml; charset=utf-8");
    assert.match(call.headers["authorization"] ?? "", /^Basic /);
  });

  it("parses fileId and hash out of an /upload response, and sends multipart id + file", async () => {
    const { instance, calls } = client(fixture("upload-ok"));
    const result = await instance.uploadFile("4564654", new Uint8Array([1, 2, 3]), "image/jpeg", "e.jpg");
    assert.equal(result.status, "ok");
    assert.deepEqual(result.status === "ok" && result.data, {
      fileId: "b0754af766b426f2928a02c651ed4b99",
      hash: "fafa5efeaf3cbe3b23b2748d13e629a1",
    });

    const body = calls[0]!.body as FormData;
    assert.ok(body instanceof FormData, "the upload body must be multipart form data");
    assert.equal(body.get("id"), "4564654");
    assert.ok(body.get("file") instanceof Blob, "the file part must carry the bytes themselves");
    // No hand-set content-type: FormData has to supply its own multipart boundary, and
    // overriding it produces a body the server cannot split.
    assert.equal(calls[0]!.headers["content-type"], undefined);
  });

  it("parses a /fileinfo response", async () => {
    const { instance } = client(fixture("fileinfo-ok"));
    const result = await instance.submitFileInfo("4564654", "<fileDetails><reportId>4564654</reportId></fileDetails>");
    assert.equal(result.status === "ok" && result.data.reportId, "4564654");
  });

  it("reads /finish from its own root element and collects the file ids", async () => {
    // /finish is the one call that answers with <reportDoneResponse> rather than
    // <reportResponse>. A parser keyed only on the latter would treat the single most
    // important call in the sequence as malformed.
    const { instance, calls } = client(fixture("finish-ok"));
    const result = await instance.finishReport("4564654");
    assert.equal(result.status, "ok");
    assert.deepEqual(result.status === "ok" && result.data, {
      reportId: "4564654",
      fileIds: ["b0754af766b426f2928a02c651ed4b99"],
    });
    assert.equal((calls[0]!.body as FormData).get("id"), "4564654");
  });

  it("collects every file id when /finish returns more than one", async () => {
    // A single-element list parses as a scalar, so a one-file fixture alone would hide a
    // mapping that only ever reads the first entry.
    const { instance } = client(fixture("finish-ok-multifile"));
    const result = await instance.finishReport("4564654");
    assert.deepEqual(result.status === "ok" && result.data.fileIds, [
      "b0754af766b426f2928a02c651ed4b99",
      "c1865bf877c537f3039b13d762fe5caa",
    ]);
  });

  it("parses a /retract response", async () => {
    const { instance, calls } = client(fixture("retract-ok"));
    const result = await instance.retractReport("4564654");
    assert.equal(result.status === "ok" && result.data.responseCode, 0);
    assert.equal((calls[0]!.body as FormData).get("id"), "4564654");
  });

  it("checks connectivity with a GET and no body", async () => {
    const { instance, calls } = client(fixture("status-ok"));
    const result = await instance.checkStatus();
    assert.equal(result.status === "ok" && result.data.responseCode, 0);
    assert.match(result.status === "ok" ? (result.data.description ?? "") : "", /Remote User/);
    assert.equal(calls[0]!.method, "GET");
    assert.equal(calls[0]!.body, undefined);
  });
});

// ─── Response-code classification ───────────────────────────────────────────

describe("NcmecClient — response-code classification", () => {
  const cases = [
    { code: 1000, kind: "server", retryable: true, credentialFailure: false },
    { code: 2000, kind: "auth", retryable: false, credentialFailure: true },
    { code: 3000, kind: "auth", retryable: false, credentialFailure: true },
    { code: 4100, kind: "request", retryable: false, credentialFailure: false },
    { code: 5001, kind: "state", retryable: false, credentialFailure: false },
    { code: 5102, kind: "state", retryable: false, credentialFailure: false },
  ] as const;

  for (const expected of cases) {
    it(`classifies ${expected.code} from its real response document`, async () => {
      const { instance } = client(fixture(`err-${expected.code}`));
      const result = await instance.submitReport("<report/>");
      assert.equal(result.status, "err");
      if (result.status !== "err") return;
      assert.equal(result.responseCode, expected.code);
      assert.equal(result.kind, expected.kind);
      assert.equal(result.retryable, expected.retryable);
      assert.equal(result.credentialFailure, expected.credentialFailure);
      // Classification never depends on parsing the English description.
      assert.ok(result.message.length > 0);
    });
  }

  it("4100 is terminal — a validation bug must not burn the retry budget on every report", async () => {
    const { instance } = client(fixture("err-4100"));
    const result = await instance.submitReport("<report/>");
    assert.equal(result.status === "err" && result.retryable, false);
  });

  it("classifies by family, so NCMEC's undocumented codes are not mis-handled", () => {
    // NCMEC's published list is explicitly non-exhaustive and already contains these.
    assert.equal(classifyNcmecResponseCode(1100).retryable, true, "save failed is NCMEC's side");
    assert.equal(classifyNcmecResponseCode(1111).retryable, true, "file upload failed is NCMEC's side");
    assert.equal(classifyNcmecResponseCode(3100).credentialFailure, true, "no submission authorization must alert");
    assert.equal(classifyNcmecResponseCode(4110).retryable, false, "malformed XML cannot be fixed by repeating it");
    assert.equal(classifyNcmecResponseCode(4200).kind, "request");
    assert.equal(classifyNcmecResponseCode(5002).kind, "state");
    assert.equal(classifyNcmecResponseCode(5101).kind, "state", "already retracted is a state, not a failure to repeat");
  });

  it("treats a code outside every documented family as retryable", () => {
    // The asymmetry decides it: a wrong "terminal" abandons a report that would have gone
    // through, while a wrong "retryable" costs the horizon and lands in the same
    // terminal-plus-alert state anyway.
    const verdict = classifyNcmecResponseCode(9999);
    assert.equal(verdict.kind, "unknown");
    assert.equal(verdict.retryable, true);
  });

  it("refuses to call at all when credentials are unconfigured", async () => {
    const { fetchImpl, calls } = stubFetch(fixture("submit-ok"));
    const instance = new NcmecClient({ fetchImpl, credentials: null });
    const result = await instance.submitReport("<report/>");
    assert.equal(result.status, "err");
    assert.equal(result.status === "err" && result.retryable, false);
    assert.equal(result.status === "err" && result.credentialFailure, true);
    assert.equal(calls.length, 0, "an unconfigured client must not reach the network");
  });

  it("treats a transport failure on /finish as retryable — the id makes a retry a no-op", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;
    const instance = new NcmecClient({ fetchImpl, credentials: CREDENTIALS });
    const result = await instance.finishReport("4564654");
    assert.equal(result.status === "err" && result.retryable, true);
    assert.equal(result.status === "err" && result.kind, "network");
    assert.equal(result.status === "err" && result.responseCode, null);
  });

  it("does NOT treat a transport failure on /submit as retryable — no reportId to reconcile against", async () => {
    // /submit is the one call in the sequence with no id yet. A retry after a lost response
    // cannot tell "NCMEC never saw it" from "NCMEC opened a report and the ack was lost" —
    // and in the second case a retry files a second report for the same hit with no way to
    // find the first.
    const fetchImpl = (async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;
    const instance = new NcmecClient({ fetchImpl, credentials: CREDENTIALS });
    const result = await instance.submitReport("<report/>");
    assert.equal(result.status === "err" && result.retryable, false);
    assert.equal(result.status === "err" && result.kind, "ambiguous");
    assert.equal(result.status === "err" && result.responseCode, null);
    assert.match(result.status === "err" ? result.message : "", /not retrying automatically/);
  });

  it("treats success-with-a-missing-element as terminal, not as something to repeat", async () => {
    // NCMEC said the call succeeded, so repeating /submit would open a SECOND report rather
    // than recover the id of the first — the exact duplicate this design exists to prevent.
    const { instance } = client(
      '<?xml version="1.0"?><reportResponse><responseCode>0</responseCode></reportResponse>',
    );
    const result = await instance.submitReport("<report/>");
    assert.equal(result.status, "err");
    assert.equal(result.status === "err" && result.retryable, false);
    assert.equal(result.status === "err" && result.responseCode, NCMEC_RESPONSE_CODES.SUCCESS);
    assert.match(result.status === "err" ? result.message : "", /omitted <reportId>/);
  });

  it("treats a non-2xx with an unusable body on /finish as a retryable HTTP failure", async () => {
    // A gateway's error page in front of NCMEC is transient, and /finish carries its own
    // reportId — a retry is a safe no-op here, unlike /submit below.
    const { instance } = client("<html><body>502 Bad Gateway</body></html>", { status: 502 });
    const result = await instance.finishReport("4564654");
    assert.equal(result.status === "err" && result.kind, "http");
    assert.equal(result.status === "err" && result.retryable, true);
  });

  it("does NOT treat a non-2xx with an unusable body on /submit as retryable either", async () => {
    // The same gateway 502 can equally follow an upstream accept: NCMEC's own verdict, if it
    // rendered one at all, never reached this process either way. /submit's ambiguity gate
    // has to catch both transport failure shapes ("network" AND "http"), not just one — a
    // 502 here is exactly as unconfirmed as a dropped connection, and either can leave a
    // report open with no id recovered to reconcile a retry against.
    const { instance } = client("<html><body>502 Bad Gateway</body></html>", { status: 502 });
    const result = await instance.submitReport("<report/>");
    assert.equal(result.status === "err" && result.kind, "ambiguous");
    assert.equal(result.status === "err" && result.retryable, false);
    assert.equal(result.status === "err" && result.responseCode, null);
    assert.match(result.status === "err" ? result.message : "", /not retrying automatically/);
  });
});

// ─── Parser hardening ───────────────────────────────────────────────────────

describe("NcmecClient — parser hardening", () => {
  // Every rejection in this block that flows through submitReport() shows up here with
  // kind "ambiguous", not "malformed": a 2xx response body this client cannot parse is the
  // same fact for /submit as a dropped connection — NCMEC's own verdict, if it rendered one,
  // never reached this process. call() now reports that as retryable, and submitReport()'s
  // existing ambiguity downgrade (tested above under "response-code classification") is what
  // turns it into the non-retryable, manual-review "ambiguous" a caller actually sees — kept
  // as one shared mechanism rather than a second endpoint-specific "is this safe to retry"
  // check. The endpoints that already carry a reportId (asserted separately below) stay
  // genuinely retryable, since a retry there is a safe no-op.

  it("rejects a response carrying a DOCTYPE with an entity declaration", async () => {
    const { instance } = client(fixture("hostile-doctype-entity"));
    const result = await instance.submitReport("<report/>");
    assert.equal(result.status, "err");
    assert.equal(result.status === "err" && result.kind, "ambiguous");
    assert.equal(result.status === "err" && result.retryable, false);
    assert.match(result.status === "err" ? result.message : "", /DOCTYPE/);
  });

  it("rejects a HARMLESS DOCTYPE too — the gate is ours, not the parser's", async () => {
    // This is the assertion that makes the previous one mean something. `processEntities:
    // false` disables entity EXPANSION but does not reject a document containing a DOCTYPE,
    // so without this case the entity test could pass merely because expansion happened to
    // be off, while the gate it is supposed to prove does not exist.
    const { instance } = client(fixture("hostile-doctype-harmless"));
    const result = await instance.submitReport("<report/>");
    assert.equal(result.status, "err");
    assert.equal(result.status === "err" && result.kind, "ambiguous");
    assert.equal(result.status === "err" && result.retryable, false);
    assert.match(result.status === "err" ? result.message : "", /DOCTYPE/);
  });

  it("rejects a response nested past the depth cap", async () => {
    const { instance } = client(fixture("hostile-deep-nesting"));
    const result = await instance.submitReport("<report/>");
    assert.equal(result.status, "err");
    assert.equal(result.status === "err" && result.kind, "ambiguous");
    assert.equal(result.status === "err" && result.retryable, false);
  });

  it("abandons an oversized body during the read rather than after it", async () => {
    // Generated rather than committed: it has to exceed 1 MiB, and a megabyte of filler in
    // version control costs more than the four lines that produce it. Served as a stream
    // because the cap can only work during the read — response.text() and arrayBuffer()
    // buffer the entire remote body before any size check could run.
    const chunk = new TextEncoder().encode("x".repeat(64 * 1024));
    let served = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (served > NCMEC_MAX_RESPONSE_BYTES * 2) {
          controller.close();
          return;
        }
        served += chunk.byteLength;
        controller.enqueue(chunk);
      },
    });
    const fetchImpl = (async () =>
      new Response(stream, { status: 200, headers: { "content-type": "text/xml" } })) as unknown as typeof fetch;

    const instance = new NcmecClient({ fetchImpl, credentials: CREDENTIALS });
    const result = await instance.submitReport("<report/>");
    assert.equal(result.status, "err");
    assert.equal(result.status === "err" && result.kind, "ambiguous");
    assert.equal(result.status === "err" && result.retryable, false);
    assert.match(result.status === "err" ? result.message : "", /exceeded/);
    assert.ok(
      served <= NCMEC_MAX_RESPONSE_BYTES + chunk.byteLength * 2,
      `read should abort near the cap, but consumed ${served} bytes`,
    );
  });

  function streamThatErrorsMidRead(): ReadableStream<Uint8Array> {
    // Headers arrive (the Response is constructed successfully), but reader.read() rejects
    // partway through — a connection reset after the request reached something, distinct
    // from readBoundedText's own NcmecResponseError path (oversized/no-body), and distinct
    // from fetchImpl throwing outright (no response at all).
    let sent = false;
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sent) {
          sent = true;
          controller.enqueue(new TextEncoder().encode("<reportResponse><responseCode>0"));
          return;
        }
        controller.error(new Error("ECONNRESET mid-stream"));
      },
    });
  }

  it("converts a response-stream error into a retryable network failure", async () => {
    const fetchImpl = (async () =>
      new Response(streamThatErrorsMidRead(), { status: 200, headers: { "content-type": "text/xml" } })) as unknown as typeof fetch;
    const instance = new NcmecClient({ fetchImpl, credentials: CREDENTIALS });
    const result = await instance.finishReport("4564654");
    assert.equal(result.status, "err");
    assert.equal(result.status === "err" && result.kind, "network");
    assert.equal(result.status === "err" && result.retryable, true);
    assert.match(result.status === "err" ? result.message : "", /response stream failed/);
  });

  it("downgrades a response-stream error on /submit to ambiguous, same as a dropped connection", async () => {
    const fetchImpl = (async () =>
      new Response(streamThatErrorsMidRead(), { status: 200, headers: { "content-type": "text/xml" } })) as unknown as typeof fetch;
    const instance = new NcmecClient({ fetchImpl, credentials: CREDENTIALS });
    const result = await instance.submitReport("<report/>");
    assert.equal(result.status, "err");
    assert.equal(result.status === "err" && result.kind, "ambiguous");
    assert.equal(result.status === "err" && result.retryable, false);
  });

  it("treats a malformed 2xx body on /finish as retryable — the id makes a retry a no-op", async () => {
    // NCMEC answered 2xx (it received the /finish call) but the body didn't survive transit
    // intact. Unlike /submit, this call already carries a reportId, so repeating it is a safe
    // no-op — the same reasoning that already makes a dropped connection retryable here.
    const { instance } = client(
      "<reportDoneResponse><responseCode>0</responseCode><reportId>123</wrong></reportDoneResponse>",
    );
    const result = await instance.finishReport("4564654");
    assert.equal(result.status, "err");
    assert.equal(result.status === "err" && result.kind, "malformed");
    assert.equal(result.status === "err" && result.retryable, true);
  });

  // /upload is the second endpoint (after /submit) whose unconfirmed responses are NOT safe to
  // retry, and it is the exception to the "carries a reportId, so a retry is a no-op" rule the
  // /finish and /retract cases above rely on. Carrying the report id is what makes those two
  // idempotent — ISPWS resolves the repeat against the same keyed report. /upload's request
  // carries the id AND the file bytes but no upload idempotency key, so ISPWS cannot recognize
  // a repeat: a second POST attaches a SECOND copy of the evidence to a live report. That is
  // the same reasoning missingElement() already applied to /upload's success-with-missing-field
  // case, which had left the strictly less-confirmed cases below classified the other way.

  it("downgrades a malformed 2xx body on /upload to ambiguous — no idempotency key to retry against", async () => {
    const { instance } = client(
      "<reportResponse><responseCode>0</responseCode><fileId>abc</wrong></reportResponse>",
    );
    const result = await instance.uploadFile("4564654", new Uint8Array([1, 2, 3]), "image/jpeg");
    assert.equal(result.status, "err");
    assert.equal(result.status === "err" && result.kind, "ambiguous");
    assert.equal(result.status === "err" && result.retryable, false);
    assert.match(result.status === "err" ? result.message : "", /retracting report 4564654/);
  });

  it("downgrades a dropped connection on /upload to ambiguous", async () => {
    const fetchImpl = (async () => {
      throw new Error("socket hang up");
    }) as unknown as typeof fetch;
    const instance = new NcmecClient({ fetchImpl, credentials: CREDENTIALS });
    const result = await instance.uploadFile("4564654", new Uint8Array([1, 2, 3]), "image/jpeg");
    assert.equal(result.status, "err");
    assert.equal(result.status === "err" && result.kind, "ambiguous");
    assert.equal(result.status === "err" && result.retryable, false);
  });

  it("downgrades a response-stream error on /upload to ambiguous", async () => {
    const fetchImpl = (async () =>
      new Response(streamThatErrorsMidRead(), { status: 200, headers: { "content-type": "text/xml" } })) as unknown as typeof fetch;
    const instance = new NcmecClient({ fetchImpl, credentials: CREDENTIALS });
    const result = await instance.uploadFile("4564654", new Uint8Array([1, 2, 3]), "image/jpeg");
    assert.equal(result.status, "err");
    assert.equal(result.status === "err" && result.kind, "ambiguous");
    assert.equal(result.status === "err" && result.retryable, false);
  });

  it("refuses to retry an /upload answered with the wrong root", async () => {
    // Not routed through the ambiguity downgrade — a wrong-root response carries a real
    // responseCode, so it fails the `responseCode === null` condition — which is exactly why
    // retryableIfWrongRoot has to be false for this endpoint independently.
    const { instance } = client(
      '<?xml version="1.0"?><reportDoneResponse><responseCode>0</responseCode><reportId>4564654</reportId></reportDoneResponse>',
    );
    const result = await instance.uploadFile("4564654", new Uint8Array([1, 2, 3]), "image/jpeg");
    assert.equal(result.status, "err");
    assert.equal(result.status === "err" && result.kind, "malformed");
    assert.equal(result.status === "err" && result.retryable, false);
  });

  it("treats a malformed 2xx body on /retract as retryable, same as /finish", async () => {
    const { instance } = client(
      "<reportResponse><responseCode>0</responseCode></reportResponse><reportResponse><responseCode>0</responseCode></reportResponse>",
    );
    const result = await instance.retractReport("4564654");
    assert.equal(result.status, "err");
    assert.equal(result.status === "err" && result.kind, "malformed");
    assert.equal(result.status === "err" && result.retryable, true);
  });

  it("rejects a body that is well-formed XML but not an ISPWS envelope", async () => {
    const { instance } = client('<?xml version="1.0"?><somethingElse><responseCode>0</responseCode></somethingElse>');
    const result = await instance.submitReport("<report/>");
    assert.equal(result.status === "err" && result.kind, "ambiguous");
    assert.equal(result.status === "err" && result.retryable, false);
  });

  it("rejects a mismatched closing tag instead of trusting the fields it can still find", async () => {
    // XMLParser.parse() does not validate well-formedness by default: fed a body whose
    // <reportId> is closed by an unrelated tag, it still returns the responseCode it managed
    // to read, and a caller trusting that would have reported /finish as successful for a
    // truncated or corrupted document. XMLValidator must catch this before any field is read.
    const { instance } = client(
      "<reportDoneResponse><responseCode>0</responseCode><reportId>123</wrong></reportDoneResponse>",
    );
    const result = await instance.submitReport("<report/>");
    assert.equal(result.status, "err");
    assert.equal(result.status === "err" && result.kind, "ambiguous");
    assert.equal(result.status === "err" && result.retryable, false);
    assert.match(result.status === "err" ? result.message : "", /well-formed/);
  });

  it("rejects a document with more than one root element", async () => {
    const { instance } = client(
      "<reportResponse><responseCode>0</responseCode></reportResponse><reportResponse><responseCode>0</responseCode></reportResponse>",
    );
    const result = await instance.submitReport("<report/>");
    assert.equal(result.status, "err");
    assert.equal(result.status === "err" && result.kind, "ambiguous");
    assert.equal(result.status === "err" && result.retryable, false);
    assert.match(result.status === "err" ? result.message : "", /well-formed/);
  });

  it("rejects a /finish response carrying the wrong root, but treats it as retryable", async () => {
    // /finish is documented to answer with <reportDoneResponse> alone. A well-formed
    // <reportResponse> with responseCode 0 and a reportId would otherwise look exactly like
    // a successful completion — parseEnvelope() accepts either root, so the endpoint-specific
    // contract has to be enforced by the caller that knows which one it asked for. Retryable:
    // /finish already carries this call's own reportId, so completion of THIS report is
    // unconfirmed but a retry is a safe no-op — the same reasoning as the malformed-body fix.
    const { instance } = client(
      "<reportResponse><responseCode>0</responseCode><reportId>4564654</reportId></reportResponse>",
    );
    const result = await instance.finishReport("4564654");
    assert.equal(result.status, "err");
    assert.equal(result.status === "err" && result.kind, "malformed");
    assert.equal(result.status === "err" && result.retryable, true);
    assert.match(result.status === "err" ? result.message : "", /reportDoneResponse/);
  });

  it("rejects a /submit response carrying <reportDoneResponse> instead of the documented root, and it stays terminal", async () => {
    // /submit is the one endpoint with no reportId yet to reconcile a retry against — a
    // wrong-root response here must stay non-retryable, unlike every other endpoint above.
    const { instance } = client(
      "<reportDoneResponse><responseCode>0</responseCode><reportId>4564654</reportId></reportDoneResponse>",
    );
    const result = await instance.submitReport("<report/>");
    assert.equal(result.status, "err");
    assert.equal(result.status === "err" && result.kind, "malformed");
    assert.equal(result.status === "err" && result.retryable, false);
    assert.match(result.status === "err" ? result.message : "", /reportResponse/);
  });
});

// ─── Report id correlation ──────────────────────────────────────────────────

describe("NcmecClient — response reportId correlation", () => {
  it("rejects /finish confirming a different report than the one asked for, but treats it as retryable", async () => {
    // The sharpest version of this bug: reading this uncritically would mark the WRONG
    // report finished off another report's acknowledgement. Retryable: completion of THIS
    // report remains genuinely unconfirmed, and a retry is a safe no-op — resolved through
    // 5102 if it turns out the first attempt actually landed.
    const { instance } = client(
      '<?xml version="1.0"?><reportDoneResponse><responseCode>0</responseCode><reportId>9999999</reportId></reportDoneResponse>',
    );
    const result = await instance.finishReport("4564654");
    assert.equal(result.status, "err");
    assert.equal(result.status === "err" && result.kind, "malformed");
    assert.equal(result.status === "err" && result.retryable, true);
    assert.match(result.status === "err" ? result.message : "", /9999999.*4564654|4564654.*9999999/);
  });

  it("rejects /retract confirming a different report than the one asked for, but treats it as retryable", async () => {
    const { instance } = client(
      '<?xml version="1.0"?><reportResponse><responseCode>0</responseCode><reportId>9999999</reportId></reportResponse>',
    );
    const result = await instance.retractReport("4564654");
    assert.equal(result.status, "err");
    assert.equal(result.status === "err" && result.kind, "malformed");
    assert.equal(result.status === "err" && result.retryable, true);
  });

  it("rejects /upload confirming a different report than the one asked for, but treats it as retryable", async () => {
    const { instance } = client(
      '<?xml version="1.0"?><reportResponse><responseCode>0</responseCode><reportId>9999999</reportId>' +
        "<fileId>b0754af766b426f2928a02c651ed4b99</fileId><hash>fafa5efeaf3cbe3b23b2748d13e629a1</hash></reportResponse>",
    );
    const result = await instance.uploadFile("4564654", new Uint8Array([1, 2, 3]), "image/jpeg");
    assert.equal(result.status, "err");
    assert.equal(result.status === "err" && result.kind, "malformed");
    assert.equal(result.status === "err" && result.retryable, true);
  });

  it("accepts /retract with no echoed reportId at all — correlation is verified, not required", async () => {
    const { instance } = client('<?xml version="1.0"?><reportResponse><responseCode>0</responseCode></reportResponse>');
    const result = await instance.retractReport("4564654");
    assert.equal(result.status, "ok");
  });

  it("rejects /fileinfo confirming a different report than the one asked for, but treats it as retryable", async () => {
    // /fileinfo has no fileId/hash of its own to sanity-check against, unlike /upload — the
    // echoed reportId is the only signal this response actually answers the right request.
    const { instance } = client(
      '<?xml version="1.0"?><reportResponse><responseCode>0</responseCode><reportId>9999999</reportId></reportResponse>',
    );
    const result = await instance.submitFileInfo("4564654", "<fileDetails><reportId>4564654</reportId></fileDetails>");
    assert.equal(result.status, "err");
    assert.equal(result.status === "err" && result.kind, "malformed");
    assert.equal(result.status === "err" && result.retryable, true);
    assert.match(result.status === "err" ? result.message : "", /9999999.*4564654|4564654.*9999999/);
  });

  it("refuses to send /fileinfo when the outbound document's reportId doesn't match the call's own", async () => {
    // Caught before the request goes out, unlike the response-side check above: without
    // this, ISPWS would attach the file metadata to whichever report the XML itself names,
    // and the response-side check would only notice after the fact.
    const { instance, calls } = client(fixture("fileinfo-ok"));
    const result = await instance.submitFileInfo(
      "4564654",
      "<fileDetails><reportId>9999999</reportId></fileDetails>",
    );
    assert.equal(result.status, "err");
    assert.equal(result.status === "err" && result.kind, "malformed");
    assert.equal(result.status === "err" && result.retryable, false);
    assert.match(result.status === "err" ? result.message : "", /9999999.*4564654|4564654.*9999999/);
    assert.equal(calls.length, 0, "must never reach the network with mismatched arguments");
  });

  it("refuses to send /fileinfo when the outbound document carries no reportId at all", async () => {
    const { instance, calls } = client(fixture("fileinfo-ok"));
    const result = await instance.submitFileInfo("4564654", "<fileDetails/>");
    assert.equal(result.status, "err");
    assert.equal(result.status === "err" && result.kind, "malformed");
    assert.equal(calls.length, 0);
  });
});

// ─── /finish: missing reportId is retryable ─────────────────────────────────

describe("NcmecClient — /finish omitting reportId", () => {
  it("treats a /finish success with no <reportId> as retryable, not a dead end", async () => {
    // Unlike /submit (where a missing reportId means a possible SECOND report on retry),
    // /finish already carries the caller's own reportId — retrying is the same safe no-op
    // the malformed-2xx-body fix already relies on for this endpoint.
    const { instance } = client('<?xml version="1.0"?><reportDoneResponse><responseCode>0</responseCode></reportDoneResponse>');
    const result = await instance.finishReport("4564654");
    assert.equal(result.status, "err");
    assert.equal(result.status === "err" && result.kind, "malformed");
    assert.equal(result.status === "err" && result.retryable, true);
    assert.match(result.status === "err" ? result.message : "", /omitted <reportId>/);
  });
});

// ─── Endpoint selection ─────────────────────────────────────────────────────

describe("NcmecClient — endpoint selection", () => {
  it("defaults to the test host, never production", async () => {
    // A default in the other direction would let a missing or unresolved configuration file
    // real reports. Production is always passed explicitly.
    const { fetchImpl } = stubFetch(fixture("status-ok"));
    const instance = new NcmecClient({ fetchImpl, credentials: CREDENTIALS });
    assert.equal(instance.endpoint, NCMEC_ISPWS_BASE_URLS.test);
  });

  it("maps both environments to their documented hosts", () => {
    assert.equal(ncmecBaseUrlFor("test"), "https://exttest.cybertip.org/ispws");
    assert.equal(ncmecBaseUrlFor("production"), "https://report.cybertip.org/ispws");
  });
});

// ─── Evidence read path ─────────────────────────────────────────────────────

describe("evidence never leaves this process by URL", () => {
  it("the client module never references the signed-URL helper", () => {
    // getObjectEntityDownloadURL signs ANY private subpath with no `restricted/` guard, so
    // reaching for it here would mint a time-limited, credential-free bearer URL to
    // suspected CSAM — breaking the no-signed-URL invariant without anyone adding a route,
    // which is exactly the violation route-level review would miss.
    for (const file of ["ncmecClient.ts", "ncmecXml.ts"]) {
      const source = fs.readFileSync(path.join(__dirname, "../lib/moderation", file), "utf-8");
      const code = source.replace(/\/\*\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      assert.doesNotMatch(code, /getObjectEntityDownloadURL/, `${file} must not reach for a signed URL`);
      assert.doesNotMatch(code, /signObjectURL/, `${file} must not sign object URLs`);
    }
  });

  it("uploadFile takes bytes, so there is no path that could pass a URL instead", async () => {
    const { instance, calls } = client(fixture("upload-ok"));
    const bytes = new Uint8Array([0xff, 0xd8, 0xff]);
    await instance.uploadFile("4564654", bytes, "image/jpeg");
    const file = (calls[0]!.body as FormData).get("file");
    assert.ok(file instanceof Blob);
    assert.equal(await (file as Blob).slice().arrayBuffer().then((b) => new Uint8Array(b).length), 3);
  });
});

// ─── XML builders ───────────────────────────────────────────────────────────

const ESP = {
  organizationName: "Availeron Consulting, Inc.",
  contactEmail: "cybertip@example.test",
  contactFirstName: "Jane",
  contactLastName: "Doe",
};

const BASE_REPORT = {
  matchSource: "arachnid",
  incidentAt: new Date("2026-07-30T12:00:00.000Z"),
  platform: { name: "Overhype.me", url: "https://overhype.me/m/abc" },
  esp: ESP,
  reportedPerson: { email: "uploader@example.test", espIdentifier: "user_42" },
} as const;

describe("buildReportXml", () => {
  it("emits the documented element order, exactly", () => {
    // The ISPWS schema is a sequence, so a correctly-populated document with its children
    // in the wrong order is rejected with 4100 — which this design classifies as terminal.
    // A wrong order therefore burns a report rather than a retry, which is why this asserts
    // the whole document rather than element presence.
    assert.equal(
      buildReportXml({ ...BASE_REPORT }),
      `<?xml version="1.0" encoding="UTF-8"?>
<report xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="https://report.cybertip.org/ispws/xsd">
    <incidentSummary>
        <incidentType>Child Pornography (possession, manufacture, and distribution)</incidentType>
        <platform>Overhype.me</platform>
        <incidentDateTime>2026-07-30T12:00:00.000Z</incidentDateTime>
    </incidentSummary>
    <internetDetails>
        <webPageIncident>
            <url>https://overhype.me/m/abc</url>
        </webPageIncident>
    </internetDetails>
    <reporter>
        <reportingPerson>
            <firstName>Jane</firstName>
            <lastName>Doe</lastName>
            <email>cybertip@example.test</email>
        </reportingPerson>
        <companyTemplate>Availeron Consulting, Inc.</companyTemplate>
    </reporter>
    <personOrUserReported>
        <personOrUserReportedPerson>
            <email>uploader@example.test</email>
        </personOrUserReportedPerson>
        <espIdentifier>user_42</espIdentifier>
    </personOrUserReported>
</report>
`,
    );
  });

  it("omits <personOrUserReported> entirely for an anonymous upload", () => {
    // An omitted element is visibly incomplete and can be corrected. An empty one asserts a
    // suspect record with nothing in it.
    const xml = buildReportXml({ ...BASE_REPORT, reportedPerson: null });
    assert.doesNotMatch(xml, /personOrUserReported/);
  });

  it("omits it for a snapshot that carries nothing reportable, rather than emitting an empty shell", () => {
    const xml = buildReportXml({
      ...BASE_REPORT,
      reportedPerson: { email: null, displayName: null, espIdentifier: null },
    });
    assert.doesNotMatch(xml, /personOrUserReported/);
  });

  it("refuses to build a classifier report at all", () => {
    // A hard block, not a default. If the classifier flag were merely default-off, turning
    // it on would leave three bad options: guess an incident type, omit a required element,
    // or send reports NCMEC rejects with 4100. Refusing to produce the document means the
    // flag is a live control rather than a trapdoor.
    assert.equal(ncmecIncidentTypeFor("classifier"), null);
    assert.throws(
      () => buildReportXml({ ...BASE_REPORT, matchSource: "classifier" }),
      (err: unknown) =>
        err instanceof NcmecMappingError && err.reason === "incident-type-unresolved",
    );
  });

  it("refuses to build without a registered reporting contact email", () => {
    // NCMEC requires <email> on <reportingPerson>, and there is no safe placeholder: a wrong
    // address means the statutory notification of receipt goes nowhere.
    assert.throws(
      () => buildReportXml({ ...BASE_REPORT, esp: { ...ESP, contactEmail: "  " } }),
      (err: unknown) => err instanceof NcmecMappingError && err.reason === "reporter-contact-missing",
    );
  });

  it("escapes XML metacharacters rather than emitting them raw", () => {
    const xml = buildReportXml({
      ...BASE_REPORT,
      platform: { name: "Overhype.me", url: "https://overhype.me/m?a=1&b=<2>" },
    });
    assert.match(xml, /<url>https:\/\/overhype\.me\/m\?a=1&amp;b=&lt;2&gt;<\/url>/);
  });

  it("omits <internetDetails> when there is no meaningful URL", () => {
    const xml = buildReportXml({ ...BASE_REPORT, platform: { name: "Overhype.me", url: null } });
    assert.doesNotMatch(xml, /internetDetails/);
  });

  it("uses the incident time it was given, not the current clock", () => {
    const xml = buildReportXml({ ...BASE_REPORT, incidentAt: new Date("2024-01-02T03:04:05.000Z") });
    assert.match(xml, /<incidentDateTime>2024-01-02T03:04:05\.000Z<\/incidentDateTime>/);
  });
});

describe("buildFileDetailsXml", () => {
  it("emits the documented element order, exactly", () => {
    assert.equal(
      buildFileDetailsXml({
        reportId: "4564654",
        fileId: "b0754af766b426f2928a02c651ed4b99",
        originalFileName: "meme.jpg",
        contentOrigin: "generated",
        potentialMeme: true,
        ipCapture: { ipAddress: "203.0.113.7", capturedAt: new Date("2026-07-30T12:00:00.000Z") },
        additionalInfo: "Quarantined on upload",
      }),
      `<?xml version="1.0" encoding="UTF-8"?>
<fileDetails xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="https://report.cybertip.org/ispws/xsd">
    <reportId>4564654</reportId>
    <fileId>b0754af766b426f2928a02c651ed4b99</fileId>
    <originalFileName>meme.jpg</originalFileName>
    <fileRelevance>Reported</fileRelevance>
    <fileAnnotations>
        <potentialMeme>1</potentialMeme>
        <generativeAi>1</generativeAi>
    </fileAnnotations>
    <ipCaptureEvent>
        <ipAddress>203.0.113.7</ipAddress>
        <eventName>Upload</eventName>
        <dateTime>2026-07-30T12:00:00.000Z</dateTime>
    </ipCaptureEvent>
    <additionalInfo>Quarantined on upload</additionalInfo>
</fileDetails>
`,
    );
  });

  it("writes annotations as 0|1 values, not as empty marker elements", () => {
    // The report-level <reportAnnotations> ARE empty markers and the two are easy to
    // conflate; <fileAnnotations> children are 0|1.
    const xml = buildFileDetailsXml({
      reportId: "1",
      fileId: "f",
      contentOrigin: "user_upload",
      potentialMeme: false,
    });
    assert.match(xml, /<potentialMeme>0<\/potentialMeme>/);
    assert.match(xml, /<generativeAi>0<\/generativeAi>/);
    assert.doesNotMatch(xml, /<generativeAi\s*\/>/);
  });

  it("sets <generativeAi> only from persisted provenance", () => {
    const generated = buildFileDetailsXml({ reportId: "1", fileId: "f", contentOrigin: "generated" });
    assert.match(generated, /<generativeAi>1<\/generativeAi>/);
    for (const origin of ["user_upload", "stock", "template", "identity"] as const) {
      const xml = buildFileDetailsXml({ reportId: "1", fileId: "f", contentOrigin: origin });
      assert.match(xml, /<generativeAi>0<\/generativeAi>/, `${origin} must not be reported as AI-generated`);
    }
  });

  it("omits <generativeAi> when provenance is genuinely unknown", () => {
    // `0` is a positive claim that the file is NOT AI-generated. Where the origin was never
    // captured, omission is the honest answer.
    const xml = buildFileDetailsXml({ reportId: "1", fileId: "f", contentOrigin: null });
    assert.doesNotMatch(xml, /generativeAi/);
  });

  it("omits <fileAnnotations> entirely when there is nothing to annotate", () => {
    const xml = buildFileDetailsXml({ reportId: "1", fileId: "f", contentOrigin: null });
    assert.doesNotMatch(xml, /fileAnnotations/);
  });

  it("never emits an industry classification", () => {
    // The A1/A2/B1/B2 mapping from an Arachnid classification is an open question with
    // NCMEC. A categorization scale is not something to infer onto a federal report.
    const xml = buildFileDetailsXml({
      reportId: "1",
      fileId: "f",
      contentOrigin: "generated",
      potentialMeme: true,
    });
    assert.doesNotMatch(xml, /industryClassification/);
  });

  it("emits <fileRelevance>Reported</fileRelevance>, which the annotations depend on", () => {
    // "Only 'Reported' files may be identified as potential meme or be given an industry
    // classification" — so the relevance is a precondition for the annotation, not decoration.
    const xml = buildFileDetailsXml({
      reportId: "1",
      fileId: "f",
      contentOrigin: "generated",
      potentialMeme: true,
    });
    assert.match(xml, /<fileRelevance>Reported<\/fileRelevance>/);
  });

  it("omits <ipCaptureEvent> when no request context was captured", () => {
    const xml = buildFileDetailsXml({ reportId: "1", fileId: "f", contentOrigin: "generated", ipCapture: null });
    assert.doesNotMatch(xml, /ipCaptureEvent/);
  });
});
