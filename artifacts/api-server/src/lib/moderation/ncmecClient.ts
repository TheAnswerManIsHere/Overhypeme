/**
 * NCMEC CyberTipline ISPWS client.
 *
 * A thin, stateless HTTP client — same shape as `arachnid.ts`: no persistence, no
 * decisions, test seams for `fetch` and credentials, a discriminated result type. Every
 * judgement about what a failure *means* for a report belongs to the worker; this module's
 * only judgement is whether a failure is worth retrying.
 *
 * Endpoints (verified 2026-07-30 against <https://report.cybertip.org/ispws/documentation/>,
 * which is publicly readable):
 *
 *   POST /submit    <report> XML          -> <reportResponse> with <reportId>
 *   POST /upload    multipart id + file   -> <reportResponse> with <fileId> + <hash>
 *   POST /fileinfo  <fileDetails> XML     -> <reportResponse>
 *   POST /finish    multipart id          -> <reportDoneResponse> with <files>
 *   POST /retract   multipart id          -> <reportResponse>
 *   GET  /status                          -> <reportResponse>, connectivity only
 *
 * Auth is HTTP Basic with NCMEC-issued credentials, read from
 * `NCMEC_ISPWS_USERNAME` / `NCMEC_ISPWS_PASSWORD`. They are never committed and never
 * logged.
 *
 * **A 2xx HTTP status with a non-zero `<responseCode>` is an error, not a success.** ISPWS
 * signals failure in the body, not the status line, so every call parses the body before
 * deciding anything.
 *
 * **Evidence bytes never leave this process by URL.** `uploadFile` takes the bytes
 * directly. Callers read them via `getObjectEntityFile()` and an in-process read;
 * `ObjectStorageService.getObjectEntityDownloadURL()` signs *any* private subpath with no
 * `restricted/` guard, so reaching for it would mint a time-limited, credential-free bearer
 * URL to suspected CSAM. Signed URLs and proxy routes are forbidden for evidence,
 * categorically.
 */

import { XMLParser } from "fast-xml-parser";

import { logger } from "../logger";

// ─── Endpoints and credentials ──────────────────────────────────────────────

export const NCMEC_ISPWS_BASE_URLS = {
  test: "https://exttest.cybertip.org/ispws",
  production: "https://report.cybertip.org/ispws",
} as const;

export type NcmecEnvironment = keyof typeof NCMEC_ISPWS_BASE_URLS;

export function ncmecBaseUrlFor(environment: NcmecEnvironment): string {
  return NCMEC_ISPWS_BASE_URLS[environment];
}

export interface NcmecCredentials {
  username: string;
  password: string;
}

export function readNcmecCredentials(): NcmecCredentials | null {
  const username = process.env["NCMEC_ISPWS_USERNAME"]?.trim();
  const password = process.env["NCMEC_ISPWS_PASSWORD"]?.trim();
  if (!username || !password) return null;
  return { username, password };
}

export interface NcmecClientOverrides {
  fetchImpl?: typeof fetch;
  credentials?: NcmecCredentials | null;
  baseUrl?: string;
  /**
   * Per-call ceiling. The worker's submission sequence carries a hard deadline that must
   * stay strictly below the queue's stuck-row recovery cutoff, and that arithmetic is only
   * expressible if every individual call is bounded.
   */
  timeoutMs?: number;
}

/**
 * 30 s per call. Six calls at this ceiling still sit inside the sequence deadline with
 * room to spare, and no ISPWS call is a long-running operation — they are XML
 * acknowledgements and one file upload.
 */
export const NCMEC_DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Responses are small XML acknowledgements; this is orders of magnitude of headroom.
 * Enforced *during* the read, because `response.text()` and `arrayBuffer()` buffer the
 * entire remote body before any size check could run.
 */
export const NCMEC_MAX_RESPONSE_BYTES = 1024 * 1024;

/** Depth ceiling handed to the parser. */
export const NCMEC_MAX_NESTED_TAGS = 50;

// ─── Result types ───────────────────────────────────────────────────────────

/**
 * Why a call failed, in the terms the worker actually branches on.
 *
 * `retryable` alone is not enough: the duplicate-filing guard has to tell `5102 Report
 * already finished` from `4100 Validation failed` without parsing an English string, and
 * an alert on bad credentials has to fire without one either.
 */
export type NcmecErrorKind =
  /** No response at all — DNS, connection, timeout, abort. */
  | "network"
  /** A response arrived but the body was absent, oversized, hostile, or unparseable. */
  | "malformed"
  /** A non-2xx HTTP status whose body carried no usable `<responseCode>`. */
  | "http"
  /** `1xxx` — NCMEC's side failed. */
  | "server"
  /** `2xxx`/`3xxx` — credentials or authorization. Terminal, and worth waking someone. */
  | "auth"
  /** `4xxx` — our request is wrong. Retrying cannot fix it. */
  | "request"
  /** `5xxx` — a statement about the report's state. What it means depends on where we are. */
  | "state"
  /** A response code outside every documented family. */
  | "unknown";

export interface NcmecCallErr {
  status: "err";
  /** The ISPWS `<responseCode>`, or null when we never got one. */
  responseCode: number | null;
  message: string;
  retryable: boolean;
  kind: NcmecErrorKind;
  /** True for `2xxx`/`3xxx`: a human has to fix the credentials, so the failure must alert. */
  credentialFailure: boolean;
}

export type NcmecCall<T> = { status: "ok"; data: T } | NcmecCallErr;

export interface NcmecSubmitResult {
  reportId: string;
}
export interface NcmecUploadResult {
  fileId: string;
  /** MD5, as computed by NCMEC on what it received. Compare against ours to prove the upload was complete. */
  hash: string;
}
export interface NcmecFinishResult {
  reportId: string;
  fileIds: string[];
}
export interface NcmecStatusResult {
  responseCode: number;
  description: string | null;
}

// ─── Response-code classification ───────────────────────────────────────────

/**
 * The codes NCMEC names, with the meanings this design depends on.
 *
 * NCMEC's published list is **explicitly non-exhaustive** and already contains codes the
 * plan's table does not: 1100, 1110, 1111, 1210, 1300, 3100, 3300, 4000, 4110, 4200, 5002,
 * 5101. So classification is by *family* with these names taking precedence, rather than an
 * enumeration that silently mis-handles the next code NCMEC adds.
 */
export const NCMEC_RESPONSE_CODES = {
  SUCCESS: 0,
  SERVER_ERROR: 1000,
  AUTHENTICATION_REQUIRED: 2000,
  NOT_AUTHORIZED: 3000,
  VALIDATION_FAILED: 4100,
  REPORT_DOES_NOT_EXIST: 5001,
  REPORT_ALREADY_RETRACTED: 5101,
  REPORT_ALREADY_FINISHED: 5102,
} as const;

/**
 * Classify a response code into the shape the worker branches on.
 *
 * The family rule and why each one lands where it does:
 *
 * - **1xxx — retryable.** Server error, save failed, upload failed. NCMEC's side; ours is
 *   fine. These are exactly what the ~98.6 h retry horizon exists for.
 * - **2xxx/3xxx — terminal, alerting.** Authentication or authorization. Retrying with the
 *   same credentials cannot succeed, and nobody finds out unless the failure alerts.
 * - **4xxx — terminal, silent.** Invalid request, validation failed, malformed XML,
 *   malformed file. Our document is wrong; retrying burns the budget on every report and
 *   buries the real signal. This one being terminal is the whole reason the family split
 *   exists.
 * - **5xxx — non-retryable, context-dependent.** "Report does not exist", "already
 *   retracted", "already finished" are statements about state, not failures to repeat. The
 *   duplicate-filing guard reads the code and decides; blind retrying would be wrong in
 *   every direction.
 * - **anything else — retryable.** An unrecognised code is more likely a transient NCMEC
 *   condition than a permanent defect in our request, and the obligation is to file. A
 *   wrong "terminal" abandons a report that would have gone through; a wrong "retryable"
 *   costs the retry horizon and then lands in the same terminal-plus-alert state anyway.
 *   The asymmetry decides it. Logged loudly so an unclassified code is visible rather than
 *   quietly absorbed.
 */
export function classifyNcmecResponseCode(code: number): {
  kind: NcmecErrorKind;
  retryable: boolean;
  credentialFailure: boolean;
} {
  if (code >= 1000 && code < 2000) return { kind: "server", retryable: true, credentialFailure: false };
  if (code >= 2000 && code < 4000) return { kind: "auth", retryable: false, credentialFailure: true };
  if (code >= 4000 && code < 5000) return { kind: "request", retryable: false, credentialFailure: false };
  if (code >= 5000 && code < 6000) return { kind: "state", retryable: false, credentialFailure: false };
  logger.warn({ responseCode: code }, "[ncmec] response code outside every documented family — treating as retryable");
  return { kind: "unknown", retryable: true, credentialFailure: false };
}

// ─── Response reading and parsing ───────────────────────────────────────────

class NcmecResponseError extends Error {
  constructor(readonly kind: NcmecErrorKind, message: string) {
    super(message);
    this.name = "NcmecResponseError";
  }
}

/**
 * Read a response body with a hard byte ceiling, enforced as it arrives.
 *
 * The obvious `await response.text()` cannot work: it buffers the entire remote body before
 * returning, so a size check afterwards has already paid the memory cost it was supposed to
 * prevent. This consumes the stream and aborts the moment the threshold is crossed.
 */
async function readBoundedText(response: Response, limit: number): Promise<string> {
  const body = response.body;
  if (!body) {
    // A bodyless response is legitimate for some HTTP statuses but never for ISPWS, which
    // answers every request with an XML document.
    throw new NcmecResponseError("malformed", "ISPWS response carried no body");
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > limit) {
        throw new NcmecResponseError(
          "malformed",
          `ISPWS response exceeded ${limit} bytes and was abandoned mid-read`,
        );
      }
      chunks.push(value);
    }
  } finally {
    // Releasing before cancelling would throw; cancel first so an abandoned oversized read
    // does not leave the socket held open.
    await reader.cancel().catch(() => {});
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8").decode(joined);
}

/**
 * Reject any document carrying a DOCTYPE declaration, before the parser sees it.
 *
 * This gate is ours on purpose. `processEntities: false` disables entity *expansion* but
 * does **not** reject a document containing a DOCTYPE — fast-xml-parser 5.5.9 parses
 * `<!DOCTYPE foo [<!ENTITY x "boom">]><foo>&x;</foo>` under that option and hands back the
 * literal reference. So the parser option is defence in depth; this is the control.
 *
 * A DOCTYPE with no entity declaration is rejected too. Allowing the harmless case would
 * make the hostile test pass for the wrong reason — because expansion happened to be off,
 * rather than because a gate exists.
 */
function assertNoDoctype(xml: string): void {
  if (/<!DOCTYPE/i.test(xml)) {
    throw new NcmecResponseError("malformed", "ISPWS response contained a DOCTYPE declaration and was rejected");
  }
}

const parser = new XMLParser({
  ignoreAttributes: true,
  parseTagValue: false,
  trimValues: true,
  processEntities: false,
  maxNestedTags: NCMEC_MAX_NESTED_TAGS,
});

interface ParsedEnvelope {
  root: "reportResponse" | "reportDoneResponse";
  responseCode: number;
  description: string | null;
  values: Record<string, unknown>;
}

function textOf(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

/** Coerce a parsed child into the list form callers want, whether it arrived as one or many. */
function listOf(value: unknown): string[] {
  if (value == null) return [];
  const items = Array.isArray(value) ? value : [value];
  return items.map(textOf).filter((v): v is string => v != null && v !== "");
}

function parseEnvelope(xml: string): ParsedEnvelope {
  assertNoDoctype(xml);

  let parsed: Record<string, unknown>;
  try {
    parsed = parser.parse(xml) as Record<string, unknown>;
  } catch (err) {
    throw new NcmecResponseError("malformed", `ISPWS response could not be parsed: ${(err as Error).message}`);
  }

  const root = (["reportResponse", "reportDoneResponse"] as const).find((r) => parsed[r] != null);
  if (!root) {
    throw new NcmecResponseError(
      "malformed",
      "ISPWS response had neither a <reportResponse> nor a <reportDoneResponse> root",
    );
  }
  const values = parsed[root] as Record<string, unknown>;

  const rawCode = textOf(values["responseCode"]);
  if (rawCode == null || !/^-?\d+$/.test(rawCode.trim())) {
    throw new NcmecResponseError("malformed", "ISPWS response carried no numeric <responseCode>");
  }

  return {
    root,
    responseCode: Number.parseInt(rawCode.trim(), 10),
    description: textOf(values["responseDescription"]),
    values,
  };
}

function errFromCode(code: number, description: string | null): NcmecCallErr {
  const { kind, retryable, credentialFailure } = classifyNcmecResponseCode(code);
  return {
    status: "err",
    responseCode: code,
    message: description ?? `ISPWS response code ${code}`,
    retryable,
    kind,
    credentialFailure,
  };
}

// ─── The client ─────────────────────────────────────────────────────────────

function basicAuthHeader(credentials: NcmecCredentials): string {
  return `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString("base64")}`;
}

export class NcmecClient {
  private readonly fetchImpl: typeof fetch;
  private readonly credentials: NcmecCredentials | null;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(overrides: NcmecClientOverrides = {}) {
    this.fetchImpl = overrides.fetchImpl ?? globalThis.fetch;
    this.credentials =
      overrides.credentials !== undefined ? overrides.credentials : readNcmecCredentials();
    // Defaults to the TEST host. Production is always passed explicitly by the worker,
    // resolved from the uncached config read — a default in the other direction would let a
    // missing value file real reports.
    this.baseUrl = (overrides.baseUrl ?? NCMEC_ISPWS_BASE_URLS.test).replace(/\/+$/, "");
    this.timeoutMs = overrides.timeoutMs ?? NCMEC_DEFAULT_TIMEOUT_MS;
  }

  /** Which host this instance is talking to. The admin surface reports it; it is never inferred. */
  get endpoint(): string {
    return this.baseUrl;
  }

  get hasCredentials(): boolean {
    return this.credentials != null;
  }

  private async call(
    path: string,
    init: { method: "GET" | "POST"; body?: string | FormData; contentType?: string },
  ): Promise<ParsedEnvelope | NcmecCallErr> {
    if (!this.credentials) {
      // Not classified as `auth`: that kind means NCMEC rejected us, which is a different
      // remedy from never having been configured.
      return {
        status: "err",
        responseCode: null,
        message: "NCMEC ISPWS credentials are not configured (NCMEC_ISPWS_USERNAME / NCMEC_ISPWS_PASSWORD)",
        retryable: false,
        kind: "network",
        credentialFailure: true,
      };
    }

    const headers: Record<string, string> = {
      authorization: basicAuthHeader(this.credentials),
      accept: "text/xml",
    };
    if (init.contentType) headers["content-type"] = init.contentType;

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: init.method,
        headers,
        ...(init.body !== undefined ? { body: init.body } : {}),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      // Includes the timeout abort. Retryable: nothing about the request is known to be
      // wrong, and NCMEC may not even have seen it.
      return {
        status: "err",
        responseCode: null,
        message: `ISPWS request failed: ${(err as Error).message}`,
        retryable: true,
        kind: "network",
        credentialFailure: false,
      };
    }

    let envelope: ParsedEnvelope;
    try {
      envelope = parseEnvelope(await readBoundedText(response, NCMEC_MAX_RESPONSE_BYTES));
    } catch (err) {
      if (err instanceof NcmecResponseError) {
        // A non-2xx with an unreadable body is an HTTP-level failure and may well be
        // transient (a gateway page in front of NCMEC); a 2xx with an unreadable body means
        // the document itself is wrong, and repeating the request will produce it again.
        const httpLevel = !response.ok;
        return {
          status: "err",
          responseCode: null,
          message: httpLevel ? `ISPWS returned HTTP ${response.status}: ${err.message}` : err.message,
          retryable: httpLevel,
          kind: httpLevel ? "http" : err.kind,
          credentialFailure: false,
        };
      }
      throw err;
    }

    if (envelope.responseCode !== NCMEC_RESPONSE_CODES.SUCCESS) {
      return errFromCode(envelope.responseCode, envelope.description);
    }
    return envelope;
  }

  /** Connectivity and credential check. Reports nothing about any individual report. */
  async checkStatus(): Promise<NcmecCall<NcmecStatusResult>> {
    const result = await this.call("/status", { method: "GET" });
    if ("status" in result) return result;
    return { status: "ok", data: { responseCode: result.responseCode, description: result.description } };
  }

  /** Open a report. The returned id keys every later call in the sequence. */
  async submitReport(reportXml: string): Promise<NcmecCall<NcmecSubmitResult>> {
    const result = await this.call("/submit", {
      method: "POST",
      body: reportXml,
      // The charset is explicit because NCMEC's own documentation calls it out: without it
      // non-ASCII characters can be mistransmitted.
      contentType: "text/xml; charset=utf-8",
    });
    if ("status" in result) return result;
    const reportId = textOf(result.values["reportId"]);
    if (!reportId) {
      return missingElement("/submit", "reportId");
    }
    return { status: "ok", data: { reportId } };
  }

  /**
   * Upload evidence bytes. Takes the bytes themselves — never a URL, never a path the
   * remote end would resolve.
   */
  async uploadFile(
    reportId: string,
    bytes: Uint8Array,
    mimeType: string,
    fileName = "evidence",
  ): Promise<NcmecCall<NcmecUploadResult>> {
    const form = new FormData();
    form.append("id", reportId);
    // `Blob` accepts only `Uint8Array<ArrayBuffer>`, while a view read from object storage
    // is `Uint8Array<ArrayBufferLike>` — the difference is `SharedArrayBuffer`, which
    // nothing in this path can produce. Asserted rather than copied: the alternative is
    // duplicating the whole evidence buffer to satisfy a variance rule.
    form.append("file", new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mimeType }), fileName);
    // No explicit content-type: FormData must set its own multipart boundary.
    const result = await this.call("/upload", { method: "POST", body: form });
    if ("status" in result) return result;
    const fileId = textOf(result.values["fileId"]);
    const hash = textOf(result.values["hash"]);
    if (!fileId || !hash) {
      return missingElement("/upload", !fileId ? "fileId" : "hash");
    }
    return { status: "ok", data: { fileId, hash } };
  }

  /** Attach details and annotations to an already-uploaded file. */
  async submitFileInfo(fileDetailsXml: string): Promise<NcmecCall<NcmecSubmitResult>> {
    const result = await this.call("/fileinfo", {
      method: "POST",
      body: fileDetailsXml,
      contentType: "text/xml; charset=utf-8",
    });
    if ("status" in result) return result;
    const reportId = textOf(result.values["reportId"]);
    if (!reportId) {
      return missingElement("/fileinfo", "reportId");
    }
    return { status: "ok", data: { reportId } };
  }

  /**
   * Complete the submission. This is the call that makes the report a filing, and its
   * response uses a different root element (`<reportDoneResponse>`) from every other call.
   */
  async finishReport(reportId: string): Promise<NcmecCall<NcmecFinishResult>> {
    const form = new FormData();
    form.append("id", reportId);
    const result = await this.call("/finish", { method: "POST", body: form });
    if ("status" in result) return result;
    const returnedId = textOf(result.values["reportId"]);
    if (!returnedId) {
      return missingElement("/finish", "reportId");
    }
    const files = result.values["files"] as Record<string, unknown> | undefined;
    return {
      status: "ok",
      data: { reportId: returnedId, fileIds: listOf(files?.["fileId"]) },
    };
  }

  /** Cancel an unfinished report. The duplicate-filing guard's first move on a restart. */
  async retractReport(reportId: string): Promise<NcmecCall<NcmecStatusResult>> {
    const form = new FormData();
    form.append("id", reportId);
    const result = await this.call("/retract", { method: "POST", body: form });
    if ("status" in result) return result;
    return { status: "ok", data: { responseCode: result.responseCode, description: result.description } };
  }
}

/**
 * A `responseCode` of 0 with the element we needed absent. Not retryable: NCMEC said the
 * call succeeded, so repeating it would open a second report rather than recover the id of
 * the first — which is precisely the duplicate this design exists to prevent.
 */
function missingElement(path: string, element: string): NcmecCallErr {
  return {
    status: "err",
    responseCode: NCMEC_RESPONSE_CODES.SUCCESS,
    message: `ISPWS ${path} reported success but omitted <${element}>`,
    retryable: false,
    kind: "malformed",
    credentialFailure: false,
  };
}
