/**
 * fal request-history visibility probe (plan docs/plans/PLAN_JOB_RESUME.md §C,
 * Issue #1000 increment 1).
 *
 * Question it answers: when a render's receipt (fal's request id) is lost —
 * the server stopped between submit and storing it — can the request be found
 * again in fal's request history WHILE it is still queued or running, with its
 * input? Increment 2's lost-receipt recovery relies on the answer. If it does
 * not appear reliably, every lost-receipt case is ambiguous (and re-runs, Q13).
 *
 * What it does, with the app's own key (FAL_AI_API_KEY, falling back to
 * FAL_KEY):
 *   1. Submits ONE image request to the queue with a single POST (a paid run:
 *      fal-ai/nano-banana-2, $0.08 per image at fal's listed price on
 *      2026-11-17). Never retried.
 *   2. Every 2 s until 60 s after it completes (max 6 min), reads the queue
 *      status and the history (`GET https://api.fal.ai/v1/models/requests/by-endpoint`,
 *      every page from 1 minute before the submit, with `expand=payloads`), and
 *      records whether the request appears, by id and by its unique input.
 *   3. Prints one JSON report.
 *
 * Run (on the Repl, which holds the app's key):
 *   pnpm --filter @workspace/api-server exec tsx scripts/fal-history-probe.ts
 */

const ENDPOINT = process.argv[2] ?? "fal-ai/nano-banana-2";
const QUEUE_BASE = "https://queue.fal.run";
const HISTORY_URL = "https://api.fal.ai/v1/models/requests/by-endpoint";
const POLL_MS = 2_000;
const MAX_MS = 6 * 60_000;
const AFTER_COMPLETE_MS = 60_000;

interface Observation {
  tMs: number;
  queueStatus: string;
  byIdFound: boolean;
  byInputMatches: number;
  historyRowStatus?: unknown;
  historyError?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function key(): string {
  if (process.env["CI"]) throw new Error("this probe makes a paid call and never runs in CI");
  const k = process.env["FAL_AI_API_KEY"] ?? process.env["FAL_KEY"];
  if (!k || !k.trim()) throw new Error("FAL_AI_API_KEY (or FAL_KEY) is not set");
  return k;
}

async function getJson(url: string, auth: string): Promise<{ ok: boolean; status: number; body: unknown }> {
  const res = await fetch(url, { headers: { Authorization: `Key ${auth}` } });
  const text = await res.text();
  let body: unknown = text;
  try { body = JSON.parse(text); } catch { /* keep text */ }
  return { ok: res.ok, status: res.status, body };
}

type HistoryRow = Record<string, unknown>;

/** Every page of the endpoint's history since `start`. */
async function readHistory(auth: string, start: string, extra = ""): Promise<{ rows: HistoryRow[]; error?: string; firstPageRaw?: unknown }> {
  const rows: HistoryRow[] = [];
  let cursor: string | null = null;
  let firstPageRaw: unknown;
  for (let page = 0; page < 20; page++) {
    const qs = new URLSearchParams({ endpoint_id: ENDPOINT, start, limit: "100", expand: "payloads" });
    if (cursor) qs.set("cursor", cursor);
    const r = await getJson(`${HISTORY_URL}?${qs}${extra}`, auth);
    if (!r.ok) return { rows, error: `${r.status}: ${JSON.stringify(r.body).slice(0, 300)}`, firstPageRaw };
    if (page === 0) firstPageRaw = r.body;
    const body = r.body as { items?: HistoryRow[]; requests?: HistoryRow[]; data?: HistoryRow[]; next_cursor?: string | null; has_more?: boolean };
    const items = body.items ?? body.requests ?? body.data ?? [];
    rows.push(...items);
    cursor = body.next_cursor ?? null;
    if (!cursor) break;
  }
  return { rows, firstPageRaw };
}

/** Redact URLs (signed file links) from a value before it is printed. */
function redact(v: unknown): unknown {
  return JSON.parse(JSON.stringify(v ?? null, (_k, val) =>
    typeof val === "string" && /^https?:\/\//.test(val) ? "<url>" : val));
}

async function main(): Promise<void> {
  const auth = key();
  const nonce = `overhype-history-probe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const input = {
    prompt: `A plain red apple on a white table. (${nonce})`,
    num_images: 1,
  };
  const start = new Date(Date.now() - 60_000).toISOString();

  const submitAt = Date.now();
  const res = await fetch(`${QUEUE_BASE}/${ENDPOINT}`, {
    method: "POST",
    headers: { Authorization: `Key ${auth}`, "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const submitText = await res.text();
  if (!res.ok) throw new Error(`submit returned ${res.status}: ${submitText.slice(0, 300)}`);
  const requestId = (JSON.parse(submitText) as { request_id: string }).request_id;

  const observations: Observation[] = [];
  let completedAt: number | null = null;
  let sampleRow: unknown;
  let sampleRowById: unknown;
  let firstPageRaw: unknown;

  while (Date.now() - submitAt < MAX_MS) {
    const st = await getJson(`${QUEUE_BASE}/${ENDPOINT}/requests/${requestId}/status`, auth);
    const queueStatus = (st.body as { status?: string })?.status ?? `HTTP ${st.status}`;
    if (queueStatus === "COMPLETED" && completedAt === null) completedAt = Date.now();

    const all = await readHistory(auth, start);
    firstPageRaw ??= all.firstPageRaw;
    const byId = await readHistory(auth, start, `&request_id=${encodeURIComponent(requestId)}`);
    const idRow = [...all.rows, ...byId.rows].find((r) => r["request_id"] === requestId);
    const inputMatches = all.rows.filter((r) => JSON.stringify(r).includes(nonce));
    if (idRow && !sampleRow) sampleRow = idRow;
    if (byId.rows[0] && !sampleRowById) sampleRowById = byId.rows[0];

    observations.push({
      tMs: Date.now() - submitAt,
      queueStatus,
      byIdFound: Boolean(idRow),
      byInputMatches: inputMatches.length,
      historyRowStatus: idRow ? (idRow["status"] ?? idRow["state"] ?? null) : undefined,
      ...(all.error || byId.error ? { historyError: all.error ?? byId.error } : {}),
    });

    if (completedAt !== null && Date.now() - completedAt > AFTER_COMPLETE_MS) break;
    await sleep(POLL_MS);
  }

  const during = (s: string) => observations.filter((o) => o.queueStatus === s);
  const summary = (s: string) => {
    const obs = during(s);
    return { polls: obs.length, foundById: obs.filter((o) => o.byIdFound).length, foundByInput: obs.filter((o) => o.byInputMatches > 0).length };
  };
  const report = {
    endpoint: ENDPOINT,
    requestId,
    nonce,
    completedAfterMs: completedAt === null ? null : completedAt - submitAt,
    whileQueued: summary("IN_QUEUE"),
    whileInProgress: summary("IN_PROGRESS"),
    afterCompleted: summary("COMPLETED"),
    sampleHistoryRow: redact(sampleRow ?? sampleRowById ?? null),
    historyPageShape: redact(firstPageRaw && typeof firstPageRaw === "object" ? Object.keys(firstPageRaw as object) : firstPageRaw),
    observations,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch((err) => {
  process.stderr.write(`fal-history-probe failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
