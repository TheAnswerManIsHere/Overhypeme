#!/usr/bin/env node
// SYNCED FROM AI-Handbook — do not edit in a consumer repo. Local edits are overwritten by the next sync and their reasoning is lost; change the handbook instead.
/**
 * needs-you-alert — David's phone says so whenever a session hands control
 * back to him or writes something he might act on, and it keeps saying so,
 * for up to three hours, whenever the session is idle until he acts.
 *
 * WHY THIS EXISTS (David, 2026-10-30, #259: "make it so that it is absolutely
 * impossible for me to miss a fact that you need me"; widened the same day,
 * #264: "any time that control is being handed back to me or anytime there's
 * something I should be made aware of … I'd rather be notified more than less
 * because I can always ignore the notification, I can't respond to one that I
 * never received"). Three things stood between a session and David, and any
 * one was enough:
 *
 *   1. The harness's own `PushNotification` tool withholds itself when it
 *      judges him active — its specification: "When the user is actively at
 *      the terminal ... the tool skips it". With the Claude app open on a
 *      different session, that is exactly when he needs it.
 *   2. iOS rarely bannered a notification for an app already in the
 *      foreground, so the same app's channel could not reach him there.
 *   3. Whether a push fired at all rested on my remembering the contract rule.
 *
 * So the alert is sent by the HARNESS, through hooks, to an app that is not
 * Claude's: Pushover. My remembering is no longer on the path.
 *
 * WHAT FIRES IT, AND HOW LOUDLY. The goal the tiers serve (David, 2026-10-30):
 * "minimize the idle time that you incur waiting on me … while also giving me
 * notification the instant there is something that I might care about". So
 * anything that leaves the session idle until he acts REPEATS until he
 * acknowledges it; everything else rings once.
 *
 *   EMERGENCY (repeats every minute, three hours, until acknowledged):
 *   - Stop: the turn's last message carries the blocking-ask banner
 *     (`🛑 **NEED YOU**`) or the open-ask line (`Still waiting on you:`).
 *   - Stop: the hand-back footer says the session is idle — `**Next:**` in
 *     its `stopped —` or `nothing —` form, or `**Needs you:**` naming anything
 *     but nothing (`claude-core.md`, *A reversible choice proceeds*, rule 2;
 *     *Waiting, and scheduled check-ins*, item 0 fixes the four forms).
 *   - Notification: a permission or input dialog the session is parked on.
 *   - StopFailure: the turn ended on an error, so nothing will resume it.
 *   HIGH (once, bypasses Pushover quiet hours):
 *   - Stop: a build report landed (`**Build report — …**`, the first line
 *     `build-report.mjs`'s `chatReport` writes).
 *   - Stop: a hand-back whose footer's `Next:` is in none of the four forms.
 *   NORMAL (once; a Pushover quiet-hours window silences it, which is the
 *   one knob David tunes himself):
 *   - Stop: a hand-back that continues — `Next:` in its `running —` or
 *     `after <event> —` form — or a message with no footer at all.
 *   - PostToolUse and Stop: a `👀 **FYI** —` line written since the last scan,
 *     read from the session transcript the hook input names, so an FYI
 *     written between tool calls reaches him when it is written, not when the
 *     turn ends an hour later. Text between tool calls never reaches him in
 *     chat except paraphrased (`chat-text-between-tool-calls-is-summarised.md`).
 *   NOTHING: a turn that writes no text (a webhook echo, a silent wake).
 *
 * The lock screen tells the tiers apart by the title's first glyph and by the
 * sound: 🛑 siren for anything idle on him, 📋 for a build report, 👀 for an
 * FYI, ✅ for a hand-back that continues, ⚠️ for an error stop.
 *
 * WHAT IT NEVER DOES: block a stop or a tool call. It always exits 0. A hook
 * that exited 2 here would feed its message back to me and keep the turn
 * running, which turns a missing credential into a loop.
 *
 * A CONTROL THAT CANNOT EVALUATE SAYS SO — WHERE THE HARNESS LETS IT. When an
 * alert is owed and cannot be sent — no credentials, or Pushover refuses —
 * the hook prints a `systemMessage`. On `Stop` the harness shows it in the
 * session. On `StopFailure` it does not: the harness describes that event as
 * "Fire-and-forget — hook output and exit codes are ignored", so a failed
 * error-stop alert goes unreported, and only one there. A persistent cause
 * (keys unset, a refused token) still surfaces on the next `Stop` in the
 * same environment; a transient one (Pushover unreachable at that moment)
 * leaves no trace. That gap is recorded rather than built for (PR #260 round
 * 1: a channel with no reader is the ledger #89 removed). `Notification`
 * discards it too — the reference: "Claude Code discards their
 * `systemMessage` and `continue` fields" — and `PostToolUse` is documented
 * as neither showing nor discarding it. The message is printed on every
 * event regardless, so a harness that starts honouring it needs no change
 * here.
 *
 * A FAILED SEND IS FINAL, FOR EVERY TIER — recorded rather than built for
 * (PR #265 round 1, Codex finding 4428725274; the Fable assessor held the
 * tie-break against a retry). An FYI's cursor entry is written before
 * Pushover accepts it, so one request that fails in its window drops that
 * ring for good. What remains: the FYI's text is in chat and, under
 * interaction rule 7, on the workstream issue, so David misses the ring and
 * not the fact; on `Stop` the failure prints the `systemMessage` above. A
 * retry — holding the cursor back until acceptance — would turn a persistent
 * failure (an invalid token, Pushover down) into a Pushover round-trip and a
 * hang of up to one send window on every tool call for the rest of the
 * session, and bounding that needs an attempt count or a transient-versus-
 * permanent split in a script whose contract is "exit 0, never block". No
 * transient Pushover failure is on record; if one is observed, the retry is
 * worth revisiting with a bound.
 *
 * DELIVERY IS CONCURRENT, THE EVENT'S OWN ALERT FIRST (PR #265 round 1,
 * Codex finding 4428725288, both assessors). One hook event can owe several
 * alerts — FYIs found in the transcript, then the ask or hand-back the event
 * itself owes. Sent one after another, two slow FYI requests could spend the
 * hook's whole time budget (20 s on `Stop`, 10 s on `PostToolUse`) before the
 * ask's request started — the one alert the budget exists to deliver, and
 * the one that had the budget to itself before FYIs rang. So every request
 * is started at once, the highest tier first, and the batch takes one send
 * window (`SEND_TIMEOUT_MS`, under the shorter hook budget) however many
 * alerts it holds.
 *
 * THE TRANSCRIPT CURSOR. The FYI scan remembers how far into the transcript
 * it has read, and the text of every FYI it has rung for, in a small state
 * file under the OS temp directory keyed by session id, so one FYI rings once
 * across the many `PostToolUse` events that follow it and the `Stop` that
 * ends the turn. The file is per container and dies with it, which is the
 * right life: the transcript it indexes does too. A cursor that cannot be
 * read starts from the beginning of the file; a missed alert costs more than
 * a repeated one (David, above).
 *
 * CREDENTIALS: `PUSHOVER_USER_KEY` and `PUSHOVER_APP_TOKEN`, set as
 * environment variables in the cloud environment's settings. They can only
 * send David notifications, which is why the environment — readable by
 * anyone using it — is an acceptable home for them.
 */

import { closeSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";

export const PUSHOVER_URL = "https://api.pushover.net/1/messages.json";
/** One request's window. Under the shortest hook budget (10 s, `PostToolUse`) with room for the process itself. */
export const SEND_TIMEOUT_MS = 8_000;

/**
 * Emergency priority repeats every `retry` seconds until acknowledged or
 * `expire` passes. Three hours is Pushover's maximum; an hour stopped ringing
 * while David was away for longer (PR #260 build report).
 */
export const EMERGENCY = { priority: 2, retry: 60, expire: 10800, sound: "siren" };
/** Once, and through Pushover's quiet hours. */
export const HIGH = { priority: 1, sound: "magic" };
/** Once; quiet hours silence it. */
export const NORMAL = { priority: 0, sound: "pushover" };

// Anchored to the start of a line, after at most a heading mark, a bullet or
// emphasis: an ask is written as its own line, while a message that merely
// quotes the shape (mid-sentence, in backticks, in a blockquote) is not an ask
// and must not ring David's phone. A missed ask costs more than a false alarm,
// so the prefixes an ask is plausibly dressed in are allowed (PR #261 build report).
const LINE_START = String.raw`^[ \t]*(?:#{1,6}[ \t]+|[-*+][ \t]+|\d+\.[ \t]+)?(?:\*\*|__|\*|_)?[ \t]*`;
const ASK_BANNER = new RegExp(`${LINE_START}🛑\\s*\\*\\*NEED YOU\\*\\*\\s*[—–-]\\s*(.+)`, "m");
const OPEN_ASK = new RegExp(`${LINE_START}Still waiting on you:\\s*(.+)`, "m");
/** The FYI's summary line, the same shape rule as the ask (interaction rule 7). */
const FYI = new RegExp(`${LINE_START}👀\\s*\\*\\*FYI\\*\\*\\s*[—–-]\\s*(.+)`, "gm");
/** The first line `chatReport` writes (`build-report.mjs`). */
const BUILD_REPORT = new RegExp(`${LINE_START}\\*\\*Build report — ([^*\\n]+)\\*\\*`, "m");
/** The four footer fields, in any order, on one line separated by `·` or on their own lines. */
const FOOTER_FIELD = /\*\*(Done|Next|Needs you|Spend):\*\*/g;

/** Notification types that park a session on David. `idle_prompt` is not one: it fires after every hand-back, which `Stop` already reads. */
export const BLOCKING_NOTIFICATIONS = new Set([
  "permission_prompt",
  "worker_permission_prompt",
  "elicitation_dialog",
  "elicitation_url_dialog",
  "agent_needs_input",
]);

/**
 * The message with fenced code blocks removed: an ask shape inside one is an
 * example being shown, not an ask (Overhype.me PR #794, Codex). An unclosed
 * fence runs to the end, as Markdown renders it.
 */
export function withoutFences(text) {
  const kept = [];
  let fence = null;
  for (const line of String(text).split("\n")) {
    const open = line.match(/^[ \t]*(`{3,}|~{3,})/);
    if (fence) {
      if (open && open[1][0] === fence[0] && open[1].length >= fence.length) fence = null;
      continue;
    }
    if (open) {
      fence = open[1];
      continue;
    }
    kept.push(line);
  }
  return kept.join("\n");
}

/** Markdown to one plain line, for a lock screen. */
export function plain(text, max = 240) {
  const line = String(text)
    .replace(/\*\*|__|`/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/**
 * The hand-back footer's fields, or null when the message carries none.
 * Each value runs to the next field or a blank line, with a separating `·`
 * dropped, so the one-block form and the one-field-per-line form read alike.
 * The LAST occurrence of a field wins: the footer is the message's last block
 * (`claude-core.md`, *A reversible choice proceeds*, rule 2 — last, except
 * before a 🛑 ask or an open-ask line, which `decide` reads first), and a
 * build report opens with a `**Needs you:**` section of its own, the role's
 * account of the unit rather than the session's state. Reading the first
 * occurrence let that line shadow the footer's in both directions (PR #265
 * round 2, Codex finding 4428858035; the Fable assessor measured the reverse).
 */
export function footer(text) {
  const src = String(text);
  const marks = [...src.matchAll(FOOTER_FIELD)];
  if (!marks.length) return null;
  const out = {};
  marks.forEach((m, i) => {
    const start = m.index + m[0].length;
    const end = i + 1 < marks.length ? marks[i + 1].index : src.length;
    let value = src.slice(start, end);
    const para = value.search(/\n[ \t]*\n/);
    if (para !== -1) value = value.slice(0, para);
    value = value.replace(/^[\s·]+|[\s·]+$/g, "");
    const key = m[1] === "Needs you" ? "needsYou" : m[1].toLowerCase();
    out[key] = value;
  });
  return out;
}

/** `Needs you:` names something, or says nothing. */
export function needsSomething(value) {
  const v = plain(value ?? "").replace(/^[^\p{L}]+/u, "");
  return v !== "" && !/^(nothing|none|no)\b/i.test(v);
}

/** Which of the four `Next:` forms item 0 fixes, or null for none of them. */
export function nextForm(value) {
  const m = plain(value ?? "").match(/^(running|after|stopped|nothing)\b/i);
  return m ? m[1].toLowerCase() : null;
}

/** Every FYI summary line in a text, fences already removed by the caller or here. */
export function fyisIn(text) {
  return [...withoutFences(text).matchAll(FYI)].map((m) => plain(m[1]));
}

/**
 * The session's own page, from the remote session id the cloud harness sets
 * (`cse_X` is reached at `claude.ai/code/session_X`). Absent locally.
 */
export function sessionUrl(env) {
  const id = env.CLAUDE_CODE_REMOTE_SESSION_ID;
  if (!id || !/^cse_[A-Za-z0-9]+$/.test(id)) return null;
  return `https://claude.ai/code/session_${id.slice(4)}`;
}

/** The repository the alert is about, for the title. */
export function repoName(input, env = {}) {
  return basename(env.CLAUDE_PROJECT_DIR || input?.cwd || "") || "a session";
}

/** One FYI, as the alert it owes. */
export function fyiAlert(summary, repo) {
  return { ...NORMAL, title: `👀 ${repo}: FYI`, message: plain(summary) };
}

/**
 * Pure: from a hook's input, the alert the turn's end or the event owes, or
 * null when none is. FYIs are the transcript scan's (`scanTranscript`), not
 * this function's, so one FYI is not alerted twice. Kept free of I/O so the
 * tests exercise the rule rather than the network.
 */
export function decide(input, env = {}) {
  const repo = repoName(input, env);
  const event = input?.hook_event_name;

  if (event === "Stop") {
    const text = withoutFences(input.last_assistant_message ?? "");
    if (text.trim() === "") return null;

    const ask = text.match(ASK_BANNER) ?? text.match(OPEN_ASK);
    if (ask) return { ...EMERGENCY, title: `🛑 ${repo}: Claude needs you`, message: plain(ask[1]) };

    const f = footer(text);
    const report = text.match(BUILD_REPORT);
    const form = f ? nextForm(f.next) : null;
    const idle = Boolean(f) && (form === "stopped" || form === "nothing" || needsSomething(f.needsYou));
    const parts = [];
    if (report) parts.push(`Build report — ${report[1]}`);
    if (f && needsSomething(f.needsYou)) parts.push(`Needs you: ${f.needsYou}`);
    if (f?.done) parts.push(`Done: ${f.done}`);
    if (f?.next && !needsSomething(f.needsYou)) parts.push(`Next: ${f.next}`);
    const message = plain(parts.length ? parts.join(" · ") : text.split("\n").find((l) => l.trim() !== "") ?? "");

    if (idle) return { ...EMERGENCY, title: `🛑 ${repo}: idle until you act`, message };
    if (report) return { ...HIGH, title: `📋 ${repo}: build report ready`, message };
    if (f && form === null) return { ...HIGH, title: `✅ ${repo}: handed back`, message };
    if (f) return { ...NORMAL, title: `✅ ${repo}: handed back, work continues`, message };
    return { ...NORMAL, title: `💬 ${repo}: Claude wrote back`, message };
  }
  if (event === "Notification") {
    if (!BLOCKING_NOTIFICATIONS.has(input.notification_type)) return null;
    return { ...EMERGENCY, title: `🛑 ${repo}: Claude is waiting on a prompt`, message: plain(input.message || input.notification_type) };
  }
  if (event === "StopFailure") {
    return {
      ...EMERGENCY,
      title: `⚠️ ${repo}: session stopped on an error`,
      message: plain(`It will not resume on its own. ${input.error_details || input.error || ""}`),
    };
  }
  return null;
}

/** Where the scan's cursor for one session lives. */
export function cursorPath(input, env = {}) {
  const dir = env.NEEDS_YOU_ALERT_STATE_DIR || join(tmpdir(), "needs-you-alert");
  const id = String(input?.session_id || basename(String(input?.transcript_path || ""), ".jsonl") || "session").replace(/[^A-Za-z0-9._-]/g, "_");
  return join(dir, `${id}.json`);
}

function readCursor(path) {
  try {
    const c = JSON.parse(readFileSync(path, "utf8"));
    return { offset: Number.isInteger(c.offset) && c.offset >= 0 ? c.offset : 0, seen: Array.isArray(c.seen) ? c.seen : [] };
  } catch {
    return { offset: 0, seen: [] };
  }
}

function writeCursor(path, cursor) {
  try {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, JSON.stringify({ offset: cursor.offset, seen: cursor.seen.slice(-500) }));
  } catch {}
}

/** The FYIs in `fyis` not alerted before, each now recorded in `seen` (a Set, mutated). */
export function fresh(fyis, seen) {
  const out = [];
  for (const f of fyis) {
    const key = `fyi:${f}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}

/**
 * The FYI summaries written to the transcript since the cursor, and the
 * cursor to store. Reads only the bytes appended since last time; a final
 * line without its newline is still being written and is left for the next
 * scan. Only this session's own text counts: a subagent's entries are marked
 * `isSidechain`, and a user's text is never mine. Every FYI alerted is kept
 * by its text, so a cursor reset (a truncated or rewritten file) and the
 * `Stop` read of the last message (which the transcript may not hold yet:
 * the harness documents the file as written asynchronously) never ring the
 * same FYI twice.
 */
export function scanTranscript(path, cursor = { offset: 0, seen: [] }) {
  const found = [];
  let size;
  try {
    size = statSync(path).size;
  } catch {
    return { found, cursor };
  }
  const offset = cursor.offset > size ? 0 : cursor.offset;
  if (offset === size) return { found, cursor: { offset, seen: cursor.seen } };
  let raw;
  try {
    const fd = openSync(path, "r");
    try {
      const buf = Buffer.alloc(size - offset);
      const n = readSync(fd, buf, 0, buf.length, offset);
      raw = buf.subarray(0, n).toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return { found, cursor };
  }
  const complete = raw.endsWith("\n") ? raw : raw.slice(0, raw.lastIndexOf("\n") + 1);
  const seen = new Set(cursor.seen);
  for (const line of complete.split("\n")) {
    if (line.trim() === "") continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry?.type !== "assistant" || entry.isSidechain) continue;
    const blocks = Array.isArray(entry.message?.content) ? entry.message.content : [];
    const text = blocks
      .filter((b) => b?.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("\n");
    found.push(...fresh(fyisIn(text), seen));
  }
  return { found, cursor: { offset: offset + Buffer.byteLength(complete, "utf8"), seen: [...seen] } };
}

/**
 * Every alert one hook event owes, in the order they happened: the FYIs the
 * transcript holds since the last scan (`Stop` and `PostToolUse`), then on
 * `Stop` the last message's own FYIs — read from `last_assistant_message`,
 * which the harness documents as the reliable source for the just-completed
 * turn — then the event's own alert. Advances the cursor. An event fired
 * inside a subagent (`agent_id` present: the harness runs these hooks there
 * too) owes nothing — a subagent's text is for me, not David.
 */
export function alertsFor(input, env = {}) {
  const alerts = [];
  const event = input?.hook_event_name;
  if (input?.agent_id) return alerts;
  const repo = repoName(input, env);
  if (event === "Stop" || event === "PostToolUse") {
    const path = cursorPath(input, env);
    let cursor = readCursor(path);
    if (typeof input.transcript_path === "string" && input.transcript_path !== "") {
      const scanned = scanTranscript(input.transcript_path, cursor);
      cursor = scanned.cursor;
      alerts.push(...scanned.found.map((s) => fyiAlert(s, repo)));
    }
    if (event === "Stop") {
      const seen = new Set(cursor.seen);
      alerts.push(...fresh(fyisIn(input.last_assistant_message ?? ""), seen).map((s) => fyiAlert(s, repo)));
      cursor = { offset: cursor.offset, seen: [...seen] };
    }
    writeCursor(path, cursor);
  }
  const own = decide(input, env);
  if (own) alerts.push(own);
  return alerts;
}

/** The Pushover form for one alert. */
export function pushoverBody(alert, env) {
  const body = new URLSearchParams({
    token: env.PUSHOVER_APP_TOKEN,
    user: env.PUSHOVER_USER_KEY,
    title: alert.title,
    message: alert.message || alert.title,
    priority: String(alert.priority),
  });
  if (alert.sound) body.set("sound", alert.sound);
  if (alert.priority === 2) {
    body.set("retry", String(alert.retry));
    body.set("expire", String(alert.expire));
  }
  const url = sessionUrl(env);
  if (url) {
    body.set("url", url);
    body.set("url_title", "Open the session");
  }
  return body;
}

/** Send one alert. Resolves to null on success, else the reason it was not sent. */
export async function send(alert, env, fetchImpl = fetch, timeoutMs = SEND_TIMEOUT_MS) {
  if (!env.PUSHOVER_USER_KEY || !env.PUSHOVER_APP_TOKEN) {
    return "PUSHOVER_USER_KEY and PUSHOVER_APP_TOKEN are not set in this environment";
  }
  try {
    const res = await fetchImpl(PUSHOVER_URL, {
      method: "POST",
      body: pushoverBody(alert, env),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.ok) return null;
    let detail = "";
    try {
      detail = ((await res.json()).errors ?? []).join("; ");
    } catch {}
    return `Pushover answered ${res.status}${detail ? `: ${detail}` : ""}`;
  } catch (error) {
    return `could not reach Pushover: ${error.cause?.code || error.message}`;
  }
}

/** The alerts in sending order: highest tier first, otherwise as given. */
export function deliveryOrder(alerts) {
  return alerts.map((a, i) => [a, i]).sort((x, y) => y[0].priority - x[0].priority || x[1] - y[1]).map(([a]) => a);
}

/**
 * Send every alert at once, the highest tier first, so the batch takes one
 * send window and the event's own alert never waits behind an FYI. Resolves
 * to the failures, one line each, in that order.
 */
export async function deliver(alerts, env, fetchImpl = fetch, timeoutMs = SEND_TIMEOUT_MS) {
  const ordered = deliveryOrder(alerts);
  const results = await Promise.all(ordered.map((alert) => send(alert, env, fetchImpl, timeoutMs)));
  return results.flatMap((failure, i) => (failure ? [`David was NOT alerted (${ordered[i].title}): ${failure}.`] : []));
}

async function main() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    return;
  }
  const failures = await deliver(alertsFor(input, process.env), process.env);
  if (failures.length) {
    process.stdout.write(`${JSON.stringify({ systemMessage: failures.join(" ") })}\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {}).finally(() => process.exit(0));
}
