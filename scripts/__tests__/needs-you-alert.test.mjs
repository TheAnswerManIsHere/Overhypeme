// SYNCED FROM KITT — do not edit in a consumer repo. Local edits are overwritten by the next sync and their reasoning is lost; change KITT instead.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { decide, send, pushoverBody, sessionUrl, plain, footer, nextForm, needsSomething, WAITING, withoutFences } from "../needs-you-alert.mjs";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "needs-you-alert.mjs");
const env = { CLAUDE_PROJECT_DIR: "/home/user/Overhype.me" };
const stop = (last_assistant_message) => decide({ hook_event_name: "Stop", last_assistant_message }, env);

const FOOTER_RUNNING = "**Done:** wrote the hook. · **Next:** running — the PR's CI, woken by its webhook. · **Needs you:** nothing. · **Spend:** 2 min, 10,000 tokens, $0.15.";
const FOOTER_STOPPED = "**Done:** the plan. · **Next:** stopped — the UAT is yours; a message from David brings me back. · **Needs you:** nothing. · **Spend:** $1.";
const FOOTER_NOTHING = "**Done:** all of it. · **Next:** nothing — the plan is done. · **Needs you:** nothing. · **Spend:** $3.";

test("every alert rings once: high priority, no retry, no expire (David, 2026-11-02)", () => {
  assert.deepEqual(WAITING, { priority: 1, sound: "siren" });
  const body = pushoverBody({ ...WAITING, title: "t", message: "m" }, { PUSHOVER_APP_TOKEN: "a", PUSHOVER_USER_KEY: "u" });
  assert.equal(body.get("priority"), "1");
  assert.equal(body.has("retry"), false);
  assert.equal(body.has("expire"), false);
  for (const alert of [
    stop("🛑 **NEED YOU** — x"),
    stop(FOOTER_STOPPED),
    stop(FOOTER_NOTHING),
    decide({ hook_event_name: "Notification", notification_type: "permission_prompt" }, env),
    decide({ hook_event_name: "StopFailure", error: "e" }, env),
  ]) {
    assert.equal(alert.priority, 1, alert.title);
    assert.equal("retry" in alert || "expire" in alert, false, alert.title);
  }
});

test("a turn ending on the blocking-ask banner alerts, carrying the ask", () => {
  const alert = stop("Context.\n\n---\n🛑 **NEED YOU** — pick the **alert channel**\n\n1. Pushover");
  assert.equal(alert.sound, "siren");
  assert.equal(alert.title, "🛑 Overhype.me: Claude needs you");
  assert.equal(alert.message, "pick the alert channel");
});

test("an unchanged ask's open-ask line alerts", () => {
  assert.equal(stop("Still waiting on you: the Astra code, above.").message, "the Astra code, above.");
});

test("the ask wins over the footer: a turn ending on an ask rings as an ask", () => {
  assert.equal(stop(`${FOOTER_RUNNING}\n\nStill waiting on you: the code, above.`).title, "🛑 Overhype.me: Claude needs you");
});

test("a message that only quotes the ask shapes is not an ask", () => {
  for (const text of [
    "It fires when a turn ends on a `🛑 **NEED YOU** —` ask or a `Still waiting on you:` line.",
    "> 🛑 **NEED YOU** — quoted in a blockquote",
    "- the exact `Still waiting on you:` line",
  ]) {
    assert.equal(stop(text), null, text);
  }
});

test("an ask shape inside a fenced code block is an example, not an ask", () => {
  for (const text of [
    "The banner looks like this:\n```\n🛑 **NEED YOU** — pick a channel\n```\nNothing is blocked.",
    "~~~md\nStill waiting on you: an example\n~~~",
    "Unclosed:\n```\n🛑 **NEED YOU** — still inside",
  ]) {
    assert.equal(stop(text), null, text);
  }
  assert.equal(stop("Code:\n```\nQI8B-3M46N\n```\n🛑 **NEED YOU** — sign in").message, "sign in");
  assert.equal(withoutFences("a\n````\n```\nb\n````\nc"), "a\nc");
});

test("an ask dressed in a heading, bullet or emphasis still rings", () => {
  for (const text of [
    "## 🛑 **NEED YOU** — pick a channel",
    "- 🛑 **NEED YOU** — pick a channel",
    "1. Still waiting on you: pick a channel",
    "**Still waiting on you:** pick a channel",
  ]) {
    assert.match(stop(text)?.message ?? "", /pick a channel/, text);
  }
});

test("the footer's four fields are read in either layout", () => {
  const one = footer(FOOTER_RUNNING);
  assert.equal(one.done, "wrote the hook.");
  assert.equal(one.next, "running — the PR's CI, woken by its webhook.");
  assert.equal(one.needsYou, "nothing.");
  assert.equal(one.spend, "2 min, 10,000 tokens, $0.15.");
  const lines = footer("Report.\n\n**Done:** a thing\n**Next:** after the merge — close-out\n**Needs you:** the sign-in code\n**Spend:** $2\n\nTrailing prose.");
  assert.equal(lines.next, "after the merge — close-out");
  assert.equal(lines.needsYou, "the sign-in code");
  assert.equal(footer("no footer here"), null);
});

test("the Next form and the Needs-you reading are what the decision rests on", () => {
  assert.equal(nextForm("running — CI, woken by webhook"), "running");
  assert.equal(nextForm("**after** the merge — close-out"), "after");
  assert.equal(nextForm("stopped — waiting on UAT"), "stopped");
  assert.equal(nextForm("nothing — the plan is done"), "nothing");
  assert.equal(nextForm("open the PR"), null);
  for (const v of ["nothing", "nothing.", "none", "", "**nothing** for now"]) assert.equal(needsSomething(v), false, v);
  assert.equal(needsSomething("the sign-in code"), true);
});

test("a section done and waiting on David's word alerts", () => {
  const alert = stop(FOOTER_STOPPED);
  assert.equal(alert.title, "🛑 Overhype.me: waiting on you");
  assert.match(alert.message, /^Done: the plan\. · Next: stopped — the UAT is yours/);
  const needs = stop("**Done:** x. · **Next:** running — CI. · **Needs you:** the Astra sign-in code. · **Spend:** $1.");
  assert.equal(needs.title, "🛑 Overhype.me: waiting on you");
  assert.equal(needs.message, "Needs you: the Astra sign-in code. · Done: x.");
});

test("everything I know to do is done alerts", () => {
  const alert = stop(FOOTER_NOTHING);
  assert.equal(alert.title, "✅ Overhype.me: done — over to you");
  assert.match(alert.message, /Next: nothing — the plan is done/);
});

test("nothing that is not waiting on David alerts: work that continues, a build report, an FYI, a stray footer, plain text, silence", () => {
  for (const text of [
    `Merged.\n\n${FOOTER_RUNNING}`,
    "**Done:** x · **Next:** after the webhook — close-out · **Needs you:** nothing · **Spend:** $1",
    "**Done:** x · **Next:** open the PR · **Needs you:** nothing · **Spend:** $1",
    "**Build report — PR #263 — Sync · merged**\n\n*About the unit.*\n\n**Needs you:** nothing\n\n**What was built**\n\nA thing.",
    "---\n👀 **FYI** — **Pushover chosen** as the channel\nspecifics\n---",
    "Merged **both**, nothing else to say.",
    "",
    "   \n",
    "```\nonly code\n```",
  ]) {
    assert.equal(stop(text), null, text);
  }
  assert.equal(decide({ hook_event_name: "Stop" }, env), null);
  assert.equal(decide({ hook_event_name: "PostToolUse", tool_name: "Bash" }, env), null);
});

test("the footer governs whatever precedes it: a build report's own Needs-you line never shadows the footer's, in either direction", () => {
  const report = (needsYou) => `**Build report — PR #9 — x · merged**\n\n*About.*\n\n**Needs you:** ${needsYou}\n\n**What was built**\n\nA thing.\n\n`;
  const a = stop(`${report("nothing")}**Done:** merged. · **Next:** after CI — the next increment. · **Needs you:** approve the purchase. · **Spend:** $1.`);
  assert.match(a.message, /Needs you: approve the purchase\./);
  assert.equal(stop(`${report("walk the UAT")}**Done:** merged. · **Next:** running — increment 3, woken by its CI. · **Needs you:** nothing. · **Spend:** $1.`), null);
  assert.equal(footer(`${report("nothing")}**Done:** d · **Next:** n · **Needs you:** y · **Spend:** s`).needsYou, "y");
});

test("prompts that park the session alert; the idle reminder does not", () => {
  assert.equal(decide({ hook_event_name: "Notification", notification_type: "permission_prompt", message: "Allow Bash?" }, env).message, "Allow Bash?");
  assert.ok(decide({ hook_event_name: "Notification", notification_type: "agent_needs_input", message: "?" }, env));
  assert.equal(decide({ hook_event_name: "Notification", notification_type: "idle_prompt" }, env), null);
  assert.equal(decide({ hook_event_name: "Notification", notification_type: "agent_completed" }, env), null);
});

test("a turn that died on an error alerts, since nothing resumes it until David does", () => {
  const alert = decide({ hook_event_name: "StopFailure", error: "rate_limit" }, env);
  assert.equal(alert.sound, "siren");
  assert.match(alert.message, /rate_limit/);
});

test("an event inside a subagent owes nothing", () => {
  assert.equal(decide({ hook_event_name: "Stop", agent_id: "sub-1", last_assistant_message: "Still waiting on you: b" }, env), null);
});

test("the alert links to the session's own page", () => {
  assert.equal(sessionUrl({ CLAUDE_CODE_REMOTE_SESSION_ID: "cse_01UMMrrtc5X9qhtL3gSdnmnY" }), "https://claude.ai/code/session_01UMMrrtc5X9qhtL3gSdnmnY");
  assert.equal(sessionUrl({}), null);
  const body = pushoverBody({ ...WAITING, title: "t", message: "m" }, { PUSHOVER_APP_TOKEN: "a", PUSHOVER_USER_KEY: "u", CLAUDE_CODE_REMOTE_SESSION_ID: "cse_X1" });
  assert.equal(body.get("url"), "https://claude.ai/code/session_X1");
  assert.equal(body.get("sound"), "siren");
});

test("markdown is flattened to one line for a lock screen", () => {
  assert.equal(plain("**a** `b`\n[c](http://x)"), "a b c");
  assert.equal(plain("x".repeat(300)).length, 240);
});

test("missing credentials are a reason, never a silent success", async () => {
  assert.match(await send({ ...WAITING, title: "t" }, {}), /PUSHOVER_USER_KEY/);
});

test("a refusal from Pushover is reported with its reason", async () => {
  const fake = async () => ({ ok: false, status: 400, json: async () => ({ errors: ["application token is invalid"] }) });
  const creds = { PUSHOVER_APP_TOKEN: "a", PUSHOVER_USER_KEY: "u" };
  assert.equal(await send({ ...WAITING, title: "t" }, creds, fake), "Pushover answered 400: application token is invalid");
  assert.equal(await send({ ...WAITING, title: "t" }, creds, async () => ({ ok: true, status: 200 })), null);
});

test("as a hook: owed but unsendable prints one systemMessage, and still exits 0", () => {
  const r = spawnSync("node", [SCRIPT], {
    input: JSON.stringify({ hook_event_name: "Stop", last_assistant_message: "👀 **FYI** — a\n\n🛑 **NEED YOU** — x" }),
    env: { PATH: process.env.PATH },
    encoding: "utf8",
  });
  assert.equal(r.status, 0);
  const msg = JSON.parse(r.stdout).systemMessage;
  assert.match(msg, /NOT alerted \(🛑 .*needs you\)/);
  assert.doesNotMatch(msg, /FYI/);
});

test("as a hook: nothing owed prints nothing, and bad input never blocks a stop or a tool call", () => {
  for (const input of [
    JSON.stringify({ hook_event_name: "Stop", last_assistant_message: "" }),
    JSON.stringify({ hook_event_name: "Stop", last_assistant_message: `Done.\n\n${FOOTER_RUNNING}` }),
    JSON.stringify({ hook_event_name: "PostToolUse", tool_name: "Bash" }),
    JSON.stringify({ hook_event_name: "Notification", notification_type: "idle_prompt" }),
    "not json",
  ]) {
    const r = spawnSync("node", [SCRIPT], { input, env: { PATH: process.env.PATH }, encoding: "utf8" });
    assert.equal(r.status, 0, input);
    assert.equal(r.stdout, "", input);
  }
});
