#!/usr/bin/env node
// SYNCED FROM KITT — do not edit in a consumer repo. Local edits are overwritten by the next sync and their reasoning is lost; change KITT instead.
/**
 * needs-you-alert — David's phone rings when, and only when, a session is
 * waiting on him: it has stopped and will not continue until he answers or
 * acts. Each alert rings once; none repeats.
 *
 * WHY THIS EXISTS (David, 2026-10-30, #259: "make it so that it is absolutely
 * impossible for me to miss a fact that you need me"). Three things stood
 * between a session and David, and any one was enough:
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
 * WHAT FIRES IT (David, 2026-11-02, narrowing #264's "every hand-back rings"):
 * "what I really need alerting on is not when any given bit of information is
 * ready for me to review, but rather when there is something where I will be
 * holding you up … I don't think it's necessary for me to be alerted
 * repeatedly if I don't acknowledge the alert. Because I'm now able to see the
 * history of the alerts in Pushover, it's easy for me to catch up." So:
 *
 *   - Stop: the turn's last message carries the blocking-ask banner
 *     (`🛑 **NEED YOU**`) or the open-ask line (`Still waiting on you:`).
 *   - Stop: the turn's last message carries the plan-done line
 *     (`✅ **PLAN DONE** —`): the approved work is finished and nothing of
 *     mine is scheduled after it (David, 2026-11-04: "that's a pretty
 *     important milestone that I'd like to be aware of" — it is his cue to
 *     run /archive or choose what is next).
 *   - Notification: a permission or input dialog the session is parked on —
 *     an ask the harness makes on my behalf, holding the session up the same
 *     way.
 *   - StopFailure: the turn ended on an error, so nothing resumes the session
 *     until he does.
 *
 * ONE ASK, ONE RING (David, 2026-11-03: a session that kept working past an
 * unanswered ask re-rang it on every hand-back). So on `Stop`:
 *   - a `Still waiting on you:` line rings nothing — by definition it marks
 *     an ask already rung and unchanged;
 *   - a banner or a plan-done line rings only when its text differs from the
 *     last thing that rang in this session. The hook keeps that one key in a
 *     small file under the OS temp directory, keyed by session id, and clears
 *     it on any other hand-back, so the next ask — even a word-for-word
 *     repeat of an answered one — rings.
 * A file that cannot be read or written rings, never drops: a duplicate is
 * cheaper than a missed ask. `Notification` and `StopFailure` are not
 * deduplicated; each is a new event.
 *
 * THE FOOTER IS GONE (David, 2026-11-04). Until then the hook also read a
 * four-field hand-back footer — `Done:`, `Next:` in four fixed forms,
 * `Needs you:`, `Spend:` — and rang on `Next: stopped`, `Next: nothing` and a
 * `Needs you:` naming something. The footer was replaced by a sentence or two
 * of plain English, which nothing parses; what it signalled now travels in
 * the two shapes above.
 *
 * Nothing else rings: not a 👀 FYI, not a build report, not a hand-back whose
 * work continues, not a summary of a finished increment with more to come,
 * not plain text. Each alert goes once, at Pushover's high
 * priority (through his quiet hours, as the repeating tier it replaced did),
 * with the siren sound; Pushover's history is where a missed one is caught up.
 * The `PostToolUse` hook that scanned the transcript for FYIs is gone with
 * the FYI alert.
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
 * same environment; a transient one leaves no trace. That gap is recorded
 * rather than built for (PR #260 round 1). `Notification` discards it too.
 * A failed send is final: there is no retry (PR #265 round 1).
 *
 * CREDENTIALS: `PUSHOVER_USER_KEY` and `PUSHOVER_APP_TOKEN`, set as
 * environment variables in the cloud environment's settings. They can only
 * send David notifications, which is why the environment — readable by
 * anyone using it — is an acceptable home for them.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";

export const PUSHOVER_URL = "https://api.pushover.net/1/messages.json";
/** One request's window. Under the `Stop` hook's 20 s budget with room for the process itself. */
export const SEND_TIMEOUT_MS = 8_000;

/**
 * The one tier: rings once, through Pushover's quiet hours, with the siren
 * David already knows as "Claude is waiting on me". No retry and no expire:
 * a priority-2 alert that repeats until acknowledged is what David retired
 * on 2026-11-02, and Pushover's history keeps a missed one.
 */
export const WAITING = { priority: 1, sound: "siren" };

// Anchored to the start of a line, after at most a heading mark, a bullet or
// emphasis: an ask is written as its own line, while a message that merely
// quotes the shape (mid-sentence, in backticks, in a blockquote) is not an ask
// and must not ring David's phone. A missed ask costs more than a false alarm,
// so the prefixes an ask is plausibly dressed in are allowed (PR #261 build report).
const LINE_START = String.raw`^[ \t]*(?:#{1,6}[ \t]+|[-*+][ \t]+|\d+\.[ \t]+)?(?:\*\*|__|\*|_)?[ \t]*`;
const ASK_BANNER = new RegExp(`${LINE_START}🛑\\s*\\*\\*NEED YOU\\*\\*\\s*[—–-]\\s*(.+)`, "m");
const OPEN_ASK = new RegExp(`${LINE_START}Still waiting on you:\\s*(.+)`, "m");
const PLAN_DONE = new RegExp(`${LINE_START}✅\\s*\\*\\*PLAN DONE\\*\\*\\s*[—–-]\\s*(.+)`, "m");

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

/**
 * The banner's own block: from its heading line to its closing rule (`---`,
 * `***` or `___` on a line of its own — the ask's shape in `claude-core.md`
 * interaction rule 6), or to the end of the message when it has none. The
 * whole block keys the ask, so a changed decision under the same heading rings
 * (Codex, PR #279 round 2); text after the closing rule does not, so `/status`
 * reproducing an unchanged ask inside a longer briefing rings nothing
 * (Codex, DojoOS PR #74).
 */
export function bannerBlock(text, start) {
  const rest = text.slice(start);
  const close = rest.slice(rest.indexOf("\n") + 1).search(/^[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*$/m);
  if (rest.indexOf("\n") === -1 || close === -1) return rest;
  return rest.slice(0, rest.indexOf("\n") + 1 + close);
}

/**
 * Pure: from a hook's input, the alert the event owes — one only when the
 * session is waiting on David — or null; on `Stop`, also the `key` naming
 * what it waits on, which `alertFor` deduplicates against. `clear: true`
 * marks a hand-back that waits on nothing. Kept free of I/O so the tests
 * exercise the rule rather than the network.
 */
export function decide(input, env = {}) {
  if (input?.agent_id) return null; // a subagent's events are for me, not David
  const repo = repoName(input, env);
  const event = input?.hook_event_name;

  if (event === "Stop") {
    const text = withoutFences(input.last_assistant_message ?? "");
    if (text.trim() === "") return null;

    const banner = text.match(ASK_BANNER);
    if (banner) return { ...WAITING, title: `🛑 ${repo}: Claude needs you`, message: plain(banner[1]), key: `ask:${plain(bannerBlock(text, banner.index), Infinity)}` };
    if (OPEN_ASK.test(text)) return null; // an ask already rung, unchanged

    const done = text.match(PLAN_DONE);
    if (done) return { ...WAITING, title: `✅ ${repo}: plan done — over to you`, message: plain(done[1]), key: `done:${plain(done[1], Infinity)}` };
    return { clear: true };
  }
  if (event === "Notification") {
    if (!BLOCKING_NOTIFICATIONS.has(input.notification_type)) return null;
    return { ...WAITING, title: `🛑 ${repo}: Claude is waiting on a prompt`, message: plain(input.message || input.notification_type) };
  }
  if (event === "StopFailure") {
    return {
      ...WAITING,
      title: `⚠️ ${repo}: session stopped on an error`,
      message: plain(`It will not resume on its own. ${input.error_details || input.error || ""}`),
    };
  }
  return null;
}

/** Where one session's last-rung key lives. */
export function statePath(input, env = {}) {
  const dir = env.NEEDS_YOU_ALERT_STATE_DIR || join(tmpdir(), "needs-you-alert");
  const id = String(input?.session_id || basename(String(input?.transcript_path || ""), ".jsonl") || "session").replace(/[^A-Za-z0-9._-]/g, "_");
  return join(dir, `${id}.last`);
}

function readKey(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function writeKey(path, key) {
  try {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, key);
  } catch {}
}

/**
 * The alert the event owes after deduplication, or null. A `Stop` whose key
 * matches the last one rung in this session owes nothing; a hand-back that
 * waits on nothing forgets the last key.
 */
export function alertFor(input, env = {}) {
  const d = decide(input, env);
  if (!d) return null;
  const path = statePath(input, env);
  if (d.clear) {
    writeKey(path, "");
    return null;
  }
  if (!d.key) return d;
  if (readKey(path) === d.key) return null;
  writeKey(path, d.key);
  const { key, ...alert } = d;
  return alert;
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

async function main() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    return;
  }
  const alert = alertFor(input, process.env);
  if (!alert) return;
  const failure = await send(alert, process.env);
  if (failure) {
    process.stdout.write(`${JSON.stringify({ systemMessage: `David was NOT alerted (${alert.title}): ${failure}.` })}\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {}).finally(() => process.exit(0));
}
