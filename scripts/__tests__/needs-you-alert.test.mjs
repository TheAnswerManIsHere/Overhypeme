// SYNCED FROM AI-Handbook — do not edit in a consumer repo. Local edits are overwritten by the next sync and their reasoning is lost; change the handbook instead.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, appendFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  decide,
  alertsFor,
  send,
  pushoverBody,
  sessionUrl,
  plain,
  footer,
  nextForm,
  needsSomething,
  fyisIn,
  scanTranscript,
  cursorPath,
  deliver,
  deliveryOrder,
  EMERGENCY,
  HIGH,
  NORMAL,
  SEND_TIMEOUT_MS,
  withoutFences,
} from "../needs-you-alert.mjs";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "needs-you-alert.mjs");
const env = { CLAUDE_PROJECT_DIR: "/home/user/Overhype.me" };
const stop = (last_assistant_message) => decide({ hook_event_name: "Stop", last_assistant_message }, env);

const FOOTER_RUNNING = "**Done:** wrote the hook. · **Next:** running — the PR's CI, woken by its webhook. · **Needs you:** nothing. · **Spend:** 2 min, 10,000 tokens, $0.15.";
const FOOTER_STOPPED = "**Done:** the plan. · **Next:** stopped — the UAT is yours; a message from David brings me back. · **Needs you:** nothing. · **Spend:** $1.";

test("a turn ending on the blocking-ask banner owes an emergency alert carrying the ask", () => {
  const alert = stop("Context.\n\n---\n🛑 **NEED YOU** — pick the **alert channel**\n\n1. Pushover");
  assert.equal(alert.priority, 2);
  assert.equal(alert.retry, EMERGENCY.retry);
  assert.equal(alert.sound, "siren");
  assert.equal(alert.title, "🛑 Overhype.me: Claude needs you");
  assert.equal(alert.message, "pick the alert channel");
});

test("an unchanged ask's open-ask line re-alerts", () => {
  const alert = stop("Still waiting on you: the Astra code, above.");
  assert.equal(alert.priority, 2);
  assert.equal(alert.message, "the Astra code, above.");
});

test("the ask wins over the footer: a turn ending on an ask rings as an ask", () => {
  const alert = stop(`${FOOTER_RUNNING}\n\nStill waiting on you: the code, above.`);
  assert.equal(alert.title, "🛑 Overhype.me: Claude needs you");
});

test("a message that only quotes the ask shapes is not an ask", () => {
  for (const text of [
    "It fires when a turn ends on a `🛑 **NEED YOU** —` ask or a `Still waiting on you:` line.",
    "> 🛑 **NEED YOU** — quoted in a blockquote",
    "- the exact `Still waiting on you:` line",
  ]) {
    assert.notEqual(stop(text).title, "🛑 Overhype.me: Claude needs you", text);
  }
});

test("an ask shape inside a fenced code block is an example, not an ask", () => {
  for (const text of [
    "The banner looks like this:\n```\n🛑 **NEED YOU** — pick a channel\n```\nNothing is blocked.",
    "~~~md\nStill waiting on you: an example\n~~~",
    "Unclosed:\n```\n🛑 **NEED YOU** — still inside",
  ]) {
    assert.notEqual(stop(text)?.title, "🛑 Overhype.me: Claude needs you", text);
  }
  const real = "Code:\n```\nQI8B-3M46N\n```\n🛑 **NEED YOU** — sign in";
  assert.equal(stop(real).message, "sign in");
  assert.equal(withoutFences("a\n````\n```\nb\n````\nc"), "a\nc");
});

test("an ask dressed in a heading, bullet or emphasis still rings", () => {
  for (const text of [
    "## 🛑 **NEED YOU** — pick a channel",
    "- 🛑 **NEED YOU** — pick a channel",
    "1. Still waiting on you: pick a channel",
    "**Still waiting on you:** pick a channel",
  ]) {
    const alert = stop(text);
    assert.equal(alert?.priority, 2, text);
    assert.match(alert.message, /pick a channel/, text);
  }
});

test("the emergency alert repeats for Pushover's maximum of three hours", () => {
  assert.equal(EMERGENCY.expire, 10800);
});

test("the footer's four fields are read in either layout", () => {
  const one = footer(FOOTER_RUNNING);
  assert.equal(one.done, "wrote the hook.");
  assert.equal(one.next, "running — the PR's CI, woken by its webhook.");
  assert.equal(one.needsYou, "nothing.");
  assert.equal(one.spend, "2 min, 10,000 tokens, $0.15.");
  const lines = footer("Report.\n\n**Done:** a thing\n**Next:** after the merge — close-out\n**Needs you:** the sign-in code\n**Spend:** $2\n\nTrailing prose.");
  assert.equal(lines.done, "a thing");
  assert.equal(lines.next, "after the merge — close-out");
  assert.equal(lines.needsYou, "the sign-in code");
  assert.equal(footer("no footer here"), null);
});

test("the Next form and the Needs-you reading are what the tier rests on", () => {
  assert.equal(nextForm("running — CI, woken by webhook"), "running");
  assert.equal(nextForm("**after** the merge — close-out"), "after");
  assert.equal(nextForm("stopped — waiting on UAT"), "stopped");
  assert.equal(nextForm("nothing — the plan is done"), "nothing");
  assert.equal(nextForm("open the PR"), null);
  assert.equal(needsSomething("nothing"), false);
  assert.equal(needsSomething("nothing."), false);
  assert.equal(needsSomething("none"), false);
  assert.equal(needsSomething(""), false);
  assert.equal(needsSomething("the sign-in code"), true);
  assert.equal(needsSomething("**nothing** for now"), false);
});

test("a hand-back that leaves the session idle until David acts repeats like an ask", () => {
  for (const text of [
    FOOTER_STOPPED,
    "**Done:** all of it. · **Next:** nothing — the plan is done. · **Needs you:** nothing. · **Spend:** $3.",
    "**Done:** x. · **Next:** running — CI. · **Needs you:** the Astra sign-in code. · **Spend:** $1.",
  ]) {
    const alert = stop(text);
    assert.equal(alert.priority, 2, text);
    assert.equal(alert.title, "🛑 Overhype.me: idle until you act", text);
  }
  assert.match(stop(FOOTER_STOPPED).message, /^Done: the plan\. · Next: stopped — the UAT is yours/);
  assert.match(stop("**Done:** x. · **Next:** running — CI. · **Needs you:** the Astra sign-in code. · **Spend:** $1.").message, /^Needs you: the Astra sign-in code\. · Done: x\.$/);
});

test("a hand-back whose work continues rings once, quietly", () => {
  const alert = stop(`Merged.\n\n${FOOTER_RUNNING}`);
  assert.equal(alert.priority, 0);
  assert.equal(alert.sound, NORMAL.sound);
  assert.equal(alert.title, "✅ Overhype.me: handed back, work continues");
  assert.equal(alert.message, "Done: wrote the hook. · Next: running — the PR's CI, woken by its webhook.");
  assert.equal(stop("**Done:** x · **Next:** after the webhook — close-out · **Needs you:** nothing · **Spend:** $1").priority, 0);
});

test("a footer whose Next is in none of the four forms rings once, loudly", () => {
  const alert = stop("**Done:** x · **Next:** open the PR · **Needs you:** nothing · **Spend:** $1");
  assert.equal(alert.priority, 1);
  assert.equal(alert.title, "✅ Overhype.me: handed back");
});

test("a build report landing rings once, loudly, naming the unit", () => {
  const alert = stop("**Build report — PR #263 — Sync: say loudly when a repo's own hooks keep the alert out · merged**\n\n*About the unit.*\n\n**Needs you:** nothing\n\n**What was built**\n\nA thing.");
  assert.equal(alert.priority, 1);
  assert.equal(alert.sound, HIGH.sound);
  assert.equal(alert.title, "📋 Overhype.me: build report ready");
  assert.match(alert.message, /^Build report — PR #263 — Sync: say loudly/);
  const idle = stop(`**Build report — PR #1 — x**\n\n**Needs you:** nothing\n\n${FOOTER_STOPPED}`);
  assert.equal(idle.priority, 2, "a report on a turn that then idles still nags");
  assert.match(idle.message, /^Build report — PR #1 — x · Done: the plan/);
});

test("the footer governs whatever precedes it: a build report's own Needs-you line never shadows the footer's, in either direction", () => {
  const report = (needsYou) => `**Build report — PR #9 — x · merged**\n\n*About.*\n\n**Needs you:** ${needsYou}\n\n**What was built**\n\nA thing.\n\n`;
  // A: the report says nothing is needed; the footer says something is. The footer's request rings and repeats.
  const a = stop(`${report("nothing")}**Done:** merged. · **Next:** after CI — the next increment. · **Needs you:** approve the purchase. · **Spend:** $1.`);
  assert.equal(a.priority, 2);
  assert.equal(a.title, "🛑 Overhype.me: idle until you act");
  assert.match(a.message, /Needs you: approve the purchase\./);
  // B: the report names the one thing only David can do; the footer says the session carries on. No siren.
  const b = stop(`${report("walk the UAT when you have a moment")}**Done:** merged. · **Next:** running — increment 3, woken by its CI. · **Needs you:** nothing. · **Spend:** $1.`);
  assert.equal(b.priority, 1);
  assert.equal(b.title, "📋 Overhype.me: build report ready");
  // The one-field-per-line layout reads the same way.
  const c = stop(`${report("nothing")}**Done:** merged.\n**Next:** running — CI.\n**Needs you:** the sign-in code\n**Spend:** $1.`);
  assert.equal(c.priority, 2);
  assert.deepEqual(footer(`${report("nothing")}**Done:** d · **Next:** n · **Needs you:** y · **Spend:** s`).needsYou, "y");
});

test("any other text handed back rings once, quietly; a turn that writes nothing owes nothing", () => {
  const alert = stop("Merged **both**, nothing else to say.");
  assert.equal(alert.priority, 0);
  assert.equal(alert.title, "💬 Overhype.me: Claude wrote back");
  assert.equal(alert.message, "Merged both, nothing else to say.");
  assert.equal(stop(""), null);
  assert.equal(stop("   \n"), null);
  assert.equal(stop("```\nonly code\n```"), null);
  assert.equal(decide({ hook_event_name: "Stop" }, env), null);
});

test("FYI summary lines are found by the ask's shape rule, and never in a fence or mid-line", () => {
  assert.deepEqual(
    fyisIn("---\n👀 **FYI** — **Pushover chosen** as the channel\nspecifics\n---\n- 👀 **FYI** — a second one\nThe rule says `👀 **FYI** —` opens it.\n```\n👀 **FYI** — an example\n```"),
    ["Pushover chosen as the channel", "a second one"],
  );
  assert.deepEqual(fyisIn("nothing here"), []);
});

test("prompts that park the session alert, a background agent asking for input included; the idle reminder does not", () => {
  assert.equal(decide({ hook_event_name: "Notification", notification_type: "permission_prompt", message: "Allow Bash?" }, env).priority, 2);
  assert.equal(decide({ hook_event_name: "Notification", notification_type: "agent_needs_input", message: "?" }, env).priority, 2);
  assert.equal(decide({ hook_event_name: "Notification", notification_type: "idle_prompt" }, env), null);
  assert.equal(decide({ hook_event_name: "Notification", notification_type: "agent_completed" }, env), null);
});

test("a turn that died on an error nags like an ask, since nothing will resume it", () => {
  const alert = decide({ hook_event_name: "StopFailure", error: "rate_limit" }, env);
  assert.equal(alert.priority, 2);
  assert.equal(alert.sound, "siren");
  assert.match(alert.message, /rate_limit/);
});

const entry = (text, extra = {}) =>
  `${JSON.stringify({ type: "assistant", uuid: Math.random().toString(36).slice(2), message: { content: [{ type: "text", text }] }, ...extra })}\n`;

test("the transcript scan returns each FYI once across scans, skips subagent and user entries, and leaves a half-written line", () => {
  const dir = mkdtempSync(join(tmpdir(), "nya-"));
  const t = join(dir, "s.jsonl");
  writeFileSync(t, `${JSON.stringify({ type: "user", message: { content: "👀 **FYI** — David pasted this" } })}\n` + entry("plain progress") + entry("👀 **FYI** — **first**"));
  const a = scanTranscript(t);
  assert.deepEqual(a.found, ["first"]);
  const b = scanTranscript(t, a.cursor);
  assert.deepEqual(b.found, [], "nothing new, nothing rung");
  assert.equal(b.cursor.offset, a.cursor.offset);
  appendFileSync(t, entry("👀 **FYI** — from a subagent", { isSidechain: true }) + entry("👀 **FYI** — second") + '{"type":"assistant","message":{"content":[{"type":"text","text":"👀 **FYI** — half');
  const c = scanTranscript(t, b.cursor);
  assert.deepEqual(c.found, ["second"]);
  appendFileSync(t, ' written"}]}}\n');
  const d = scanTranscript(t, c.cursor);
  assert.deepEqual(d.found, ["half written"], "the completed line is read on the next scan");
  assert.deepEqual(scanTranscript(t, { offset: 0, seen: d.cursor.seen }).found, [], "a cursor reset re-reads the file without ringing twice");
  assert.deepEqual(scanTranscript(join(dir, "missing.jsonl")).found, []);
});

test("alertsFor: FYIs first, then the event's own alert; the last message's FYI is read from the input and never rung twice", () => {
  const dir = mkdtempSync(join(tmpdir(), "nya-"));
  const t = join(dir, "s.jsonl");
  const e = { ...env, NEEDS_YOU_ALERT_STATE_DIR: join(dir, "state") };
  writeFileSync(t, entry("👀 **FYI** — mid-turn"));
  const post = alertsFor({ hook_event_name: "PostToolUse", session_id: "abc", transcript_path: t, tool_name: "Bash" }, e);
  assert.deepEqual(post.map((a) => [a.title, a.message, a.priority]), [["👀 Overhype.me: FYI", "mid-turn", 0]]);
  assert.deepEqual(alertsFor({ hook_event_name: "PostToolUse", session_id: "abc", transcript_path: t, tool_name: "Read" }, e), [], "the next tool call rings nothing");
  // The transcript lags: the last message is not in the file yet at Stop time.
  const last = `👀 **FYI** — **in the hand-back**\n\n${FOOTER_RUNNING}`;
  const end = alertsFor({ hook_event_name: "Stop", session_id: "abc", transcript_path: t, last_assistant_message: last }, e);
  assert.deepEqual(end.map((a) => a.title), ["👀 Overhype.me: FYI", "✅ Overhype.me: handed back, work continues"]);
  assert.equal(end[0].message, "in the hand-back");
  // Then the file catches up, and the next event must not ring that FYI again.
  appendFileSync(t, entry(last));
  assert.deepEqual(alertsFor({ hook_event_name: "PostToolUse", session_id: "abc", transcript_path: t, tool_name: "Bash" }, e), []);
  const state = JSON.parse(readFileSync(cursorPath({ session_id: "abc" }, e), "utf8"));
  assert.ok(state.seen.includes("fyi:in the hand-back"));
});

test("alertsFor: no transcript named still reads the last message; an event inside a subagent owes nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "nya-"));
  const e = { ...env, NEEDS_YOU_ALERT_STATE_DIR: dir };
  const alerts = alertsFor({ hook_event_name: "Stop", session_id: "x", last_assistant_message: "👀 **FYI** — a\n\nStill waiting on you: b" }, e);
  assert.deepEqual(alerts.map((a) => a.message), ["a", "b"]);
  assert.deepEqual(alertsFor({ hook_event_name: "Stop", agent_id: "sub-1", last_assistant_message: "Still waiting on you: b" }, e), []);
  assert.deepEqual(alertsFor({ hook_event_name: "PostToolUse", agent_id: "sub-1", transcript_path: "/nowhere" }, e), []);
});

test("the alert links to the session's own page and names its sound", () => {
  assert.equal(sessionUrl({ CLAUDE_CODE_REMOTE_SESSION_ID: "cse_01UMMrrtc5X9qhtL3gSdnmnY" }), "https://claude.ai/code/session_01UMMrrtc5X9qhtL3gSdnmnY");
  assert.equal(sessionUrl({}), null);
  const body = pushoverBody(
    { ...EMERGENCY, title: "t", message: "m" },
    { PUSHOVER_APP_TOKEN: "a", PUSHOVER_USER_KEY: "u", CLAUDE_CODE_REMOTE_SESSION_ID: "cse_X1" },
  );
  assert.equal(body.get("url"), "https://claude.ai/code/session_X1");
  assert.equal(body.get("priority"), "2");
  assert.equal(body.get("sound"), "siren");
  assert.equal(body.get("expire"), String(EMERGENCY.expire));
  const quiet = pushoverBody({ ...NORMAL, title: "t" }, { PUSHOVER_APP_TOKEN: "a", PUSHOVER_USER_KEY: "u" });
  assert.equal(quiet.get("priority"), "0");
  assert.equal(quiet.has("retry"), false);
});

test("markdown is flattened to one line for a lock screen", () => {
  assert.equal(plain("**a** `b`\n[c](http://x)"), "a b c");
  assert.equal(plain("x".repeat(300)).length, 240);
});

test("delivery is concurrent and the event's own alert goes first: slow FYIs cannot delay the ask, and the batch takes one send window", async () => {
  const creds = { PUSHOVER_APP_TOKEN: "a", PUSHOVER_USER_KEY: "u" };
  const fyis = [fyiAlertFor("one"), fyiAlertFor("two"), fyiAlertFor("three")];
  const ask = { ...EMERGENCY, title: "🛑 r: Claude needs you", message: "sign in" };
  assert.deepEqual(deliveryOrder([...fyis, ask]).map((a) => a.title), [ask.title, ...fyis.map((a) => a.title)]);
  assert.deepEqual(deliveryOrder([NORMAL, HIGH, EMERGENCY].map((t, i) => ({ ...t, title: String(i) }))).map((a) => a.title), ["2", "1", "0"]);

  const started = [];
  let resolvedFyis = 0;
  // Every FYI request hangs until its abort; the ask's request answers at once.
  const fetchImpl = (url, { body, signal }) =>
    new Promise((resolve, reject) => {
      const title = body.get("title");
      started.push(title);
      if (title === ask.title) return resolve({ ok: true, status: 200 });
      signal.addEventListener("abort", () => {
        resolvedFyis += 1;
        reject(Object.assign(new Error("aborted"), { cause: { code: "ABORT_ERR" } }));
      });
    });
  const window = 120;
  // `AbortSignal.timeout` keeps no timer referenced, so hold the loop open for the window ourselves.
  const keepAlive = setTimeout(() => {}, window * 4);
  const t0 = Date.now();
  const failures = await deliver([...fyis, ask], creds, fetchImpl, window);
  const elapsed = Date.now() - t0;
  clearTimeout(keepAlive);
  assert.equal(started[0], ask.title, "the ask's request is the first one started");
  assert.equal(started.length, 4, "every request is started");
  assert.equal(resolvedFyis, 3, "every FYI request ran to its abort");
  assert.ok(elapsed < window * 2, `the batch took ${elapsed}ms, more than one send window of ${window}ms`);
  assert.equal(failures.length, 3, "the three FYIs failed and the ask did not");
  assert.match(failures[0], /NOT alerted \(👀 r: FYI\): could not reach Pushover: ABORT_ERR/);
  assert.ok(SEND_TIMEOUT_MS < 10_000, "one send window fits under the shortest hook budget, PostToolUse's 10 s");
});

function fyiAlertFor(summary) {
  return { ...NORMAL, title: `👀 r: FYI`, message: summary };
}

test("missing credentials are a reason, never a silent success", async () => {
  assert.match(await send({ ...EMERGENCY, title: "t" }, {}), /PUSHOVER_USER_KEY/);
});

test("a refusal from Pushover is reported with its reason", async () => {
  const fake = async () => ({ ok: false, status: 400, json: async () => ({ errors: ["application token is invalid"] }) });
  const reason = await send({ ...EMERGENCY, title: "t" }, { PUSHOVER_APP_TOKEN: "a", PUSHOVER_USER_KEY: "u" }, fake);
  assert.equal(reason, "Pushover answered 400: application token is invalid");
  const ok = async () => ({ ok: true, status: 200 });
  assert.equal(await send({ ...EMERGENCY, title: "t" }, { PUSHOVER_APP_TOKEN: "a", PUSHOVER_USER_KEY: "u" }, ok), null);
});

test("as a hook: owed but unsendable prints one systemMessage naming every alert, and still exits 0", () => {
  const r = spawnSync("node", [SCRIPT], {
    input: JSON.stringify({ hook_event_name: "Stop", session_id: "hook-test", last_assistant_message: "👀 **FYI** — a\n\n🛑 **NEED YOU** — x" }),
    env: { PATH: process.env.PATH, NEEDS_YOU_ALERT_STATE_DIR: mkdtempSync(join(tmpdir(), "nya-")) },
    encoding: "utf8",
  });
  assert.equal(r.status, 0);
  const msg = JSON.parse(r.stdout).systemMessage;
  assert.match(msg, /NOT alerted \(👀 .*FYI\)/);
  assert.match(msg, /NOT alerted \(🛑 .*needs you\)/);
});

test("as a hook: nothing owed prints nothing, and bad input never blocks a stop or a tool call", () => {
  for (const input of [
    JSON.stringify({ hook_event_name: "Stop", last_assistant_message: "" }),
    JSON.stringify({ hook_event_name: "PostToolUse", tool_name: "Bash" }),
    JSON.stringify({ hook_event_name: "Notification", notification_type: "idle_prompt" }),
    "not json",
  ]) {
    const r = spawnSync("node", [SCRIPT], { input, env: { PATH: process.env.PATH, NEEDS_YOU_ALERT_STATE_DIR: mkdtempSync(join(tmpdir(), "nya-")) }, encoding: "utf8" });
    assert.equal(r.status, 0, input);
    assert.equal(r.stdout, "", input);
  }
});
