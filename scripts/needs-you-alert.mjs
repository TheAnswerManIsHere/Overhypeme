#!/usr/bin/env node
// SYNCED FROM AI-Handbook — do not edit in a consumer repo. Local edits are overwritten by the next sync and their reasoning is lost; change the handbook instead.
/**
 * needs-you-alert — when a session stops because it needs David, his phone says so,
 * and it keeps saying so until he acknowledges it, for up to three hours.
 *
 * WHY THIS EXISTS (David, 2026-10-30: "make it so that it is absolutely
 * impossible for me to miss a fact that you need me"). Three things stood
 * between a blocked session and David, and any one was enough:
 *
 *   1. The harness's own `PushNotification` tool withholds itself when it
 *      judges him active — its specification: "When the user is actively at
 *      the terminal ... the tool skips it". With the Claude app open on a
 *      different session, that is exactly when he needs it.
 *   2. iOS rarely bannered a notification for an app already in the
 *      foreground, so the same app's channel could not reach him there.
 *   3. Whether a push fired at all rested on my remembering the contract rule.
 *
 * So the alert is sent by the HARNESS, through a hook, to an app that is not
 * Claude's: Pushover, at emergency priority, which repeats until he taps
 * acknowledge. My remembering is no longer on the path.
 *
 * WHAT FIRES IT
 *   - Stop: the turn's last message carries the blocking-ask banner
 *     (`🛑 **NEED YOU**`) or the open-ask line (`Still waiting on you:`) —
 *     the two shapes `claude-core.md` interaction rule 6 fixes.
 *   - Notification: a permission or input dialog the session is parked on.
 *   - StopFailure: the turn ended on an error, so nothing will resume it.
 *
 * WHAT IT NEVER DOES: block a stop. It always exits 0. A hook that exited 2
 * here would feed its message back to me and keep the turn running, which
 * turns a missing credential into a loop.
 *
 * A CONTROL THAT CANNOT EVALUATE SAYS SO — WHERE THE HARNESS LETS IT. When an
 * alert is owed and cannot be sent — no credentials, or Pushover refuses —
 * the hook prints a `systemMessage`. On `Stop` the harness shows it in the
 * session. On `StopFailure` it does not: the harness describes that event as
 * "Fire-and-forget — hook output and exit codes are ignored", so a failed
 * error-stop alert goes unreported, and only one there. A persistent cause
 * (keys unset, a refused token) still surfaces on the next `Stop` ask in the
 * same environment; a transient one (Pushover unreachable at that moment)
 * leaves no trace. That gap is recorded rather than built for (PR #260 round
 * 1: a channel with no reader is the ledger #89 removed). Whether
 * `Notification` shows it is unsettled: the bundled reference says
 * `systemMessage` displays "(all hooks)", and the online one is read as
 * discarding it there. The message is printed on every event regardless, so
 * a harness that starts honouring it needs no change here.
 *
 * CREDENTIALS: `PUSHOVER_USER_KEY` and `PUSHOVER_APP_TOKEN`, set as
 * environment variables in the cloud environment's settings. They can only
 * send David notifications, which is why the environment — readable by
 * anyone using it — is an acceptable home for them.
 */

import { basename } from "node:path";
import { pathToFileURL } from "node:url";

export const PUSHOVER_URL = "https://api.pushover.net/1/messages.json";

/**
 * Emergency priority repeats every `retry` seconds until acknowledged or
 * `expire` passes. Three hours is Pushover's maximum; an hour stopped ringing
 * while David was away for longer (PR #260 build report).
 */
export const EMERGENCY = { priority: 2, retry: 60, expire: 10800 };

// Anchored to the start of a line, after at most a heading mark, a bullet or
// emphasis: an ask is written as its own line, while a message that merely
// quotes the shape (mid-sentence, in backticks, in a blockquote) is not an ask
// and must not ring David's phone. A missed ask costs more than a false alarm,
// so the prefixes an ask is plausibly dressed in are allowed (PR #261 build report).
const LINE_START = String.raw`^[ \t]*(?:#{1,6}[ \t]+|[-*+][ \t]+|\d+\.[ \t]+)?(?:\*\*|__|\*|_)?[ \t]*`;
const ASK_BANNER = new RegExp(`${LINE_START}🛑\\s*\\*\\*NEED YOU\\*\\*\\s*[—–-]\\s*(.+)`, "m");
const OPEN_ASK = new RegExp(`${LINE_START}Still waiting on you:\\s*(.+)`, "m");

/** Notification types that park a session on David. `idle_prompt` is not one: it fires after every hand-back. */
export const BLOCKING_NOTIFICATIONS = new Set([
  "permission_prompt",
  "worker_permission_prompt",
  "elicitation_dialog",
  "elicitation_url_dialog",
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

/**
 * Pure: from a hook's input, the alert owed, or null when none is.
 * Kept free of I/O so the tests exercise the rule rather than the network.
 */
export function decide(input, env = {}) {
  const repo = basename(env.CLAUDE_PROJECT_DIR || input?.cwd || "") || "a session";
  const event = input?.hook_event_name;

  if (event === "Stop") {
    const text = withoutFences(input.last_assistant_message ?? "");
    const ask = text.match(ASK_BANNER) ?? text.match(OPEN_ASK);
    if (!ask) return null;
    return { ...EMERGENCY, title: `🛑 ${repo}: Claude needs you`, message: plain(ask[1]) };
  }
  if (event === "Notification") {
    if (!BLOCKING_NOTIFICATIONS.has(input.notification_type)) return null;
    return { ...EMERGENCY, title: `🛑 ${repo}: Claude is waiting on a prompt`, message: plain(input.message || input.notification_type) };
  }
  if (event === "StopFailure") {
    return {
      priority: 1,
      title: `⚠️ ${repo}: session stopped on an error`,
      message: plain(`It will not resume on its own. ${input.error_details || input.error || ""}`),
    };
  }
  return null;
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
export async function send(alert, env, fetchImpl = fetch) {
  if (!env.PUSHOVER_USER_KEY || !env.PUSHOVER_APP_TOKEN) {
    return "PUSHOVER_USER_KEY and PUSHOVER_APP_TOKEN are not set in this environment";
  }
  try {
    const res = await fetchImpl(PUSHOVER_URL, {
      method: "POST",
      body: pushoverBody(alert, env),
      signal: AbortSignal.timeout(10_000),
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
  const alert = decide(input, process.env);
  if (!alert) return;
  const failure = await send(alert, process.env);
  if (failure) {
    process.stdout.write(
      `${JSON.stringify({ systemMessage: `David was NOT alerted (${alert.title}): ${failure}.` })}\n`,
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {}).finally(() => process.exit(0));
}
