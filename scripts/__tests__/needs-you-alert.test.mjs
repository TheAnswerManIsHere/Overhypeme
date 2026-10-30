// SYNCED FROM AI-Handbook — do not edit in a consumer repo. Local edits are overwritten by the next sync and their reasoning is lost; change the handbook instead.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { decide, send, pushoverBody, sessionUrl, plain, EMERGENCY } from "../needs-you-alert.mjs";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "needs-you-alert.mjs");
const env = { CLAUDE_PROJECT_DIR: "/home/user/Overhype.me" };

test("a turn ending on the blocking-ask banner owes an emergency alert carrying the ask", () => {
  const alert = decide(
    { hook_event_name: "Stop", last_assistant_message: "Context.\n\n---\n🛑 **NEED YOU** — pick the **alert channel**\n\n1. Pushover" },
    env,
  );
  assert.equal(alert.priority, 2);
  assert.equal(alert.retry, EMERGENCY.retry);
  assert.equal(alert.title, "🛑 Overhype.me: Claude needs you");
  assert.equal(alert.message, "pick the alert channel");
});

test("an unchanged ask's open-ask line re-alerts", () => {
  const alert = decide({ hook_event_name: "Stop", last_assistant_message: "Still waiting on you: the Astra code, above." }, env);
  assert.equal(alert.priority, 2);
  assert.equal(alert.message, "the Astra code, above.");
});

test("a message that only quotes the ask shapes owes nothing", () => {
  for (const text of [
    "It fires when a turn ends on a `🛑 **NEED YOU** —` ask or a `Still waiting on you:` line.",
    "> 🛑 **NEED YOU** — quoted in a blockquote",
    "- the exact `Still waiting on you:` line",
  ]) {
    assert.equal(decide({ hook_event_name: "Stop", last_assistant_message: text }, env), null, text);
  }
});

test("an ask dressed in a heading, bullet or emphasis still rings", () => {
  for (const text of [
    "## 🛑 **NEED YOU** — pick a channel",
    "- 🛑 **NEED YOU** — pick a channel",
    "1. Still waiting on you: pick a channel",
    "**Still waiting on you:** pick a channel",
  ]) {
    const alert = decide({ hook_event_name: "Stop", last_assistant_message: text }, env);
    assert.equal(alert?.priority, 2, text);
    assert.match(alert.message, /pick a channel/, text);
  }
});

test("the emergency alert repeats for Pushover's maximum of three hours", () => {
  assert.equal(EMERGENCY.expire, 10800);
});

test("an ordinary hand-back owes nothing", () => {
  assert.equal(decide({ hook_event_name: "Stop", last_assistant_message: "**Needs you:** nothing" }, env), null);
  assert.equal(decide({ hook_event_name: "Stop" }, env), null);
});

test("only prompts that park the session alert; the idle reminder after every hand-back does not", () => {
  assert.equal(decide({ hook_event_name: "Notification", notification_type: "permission_prompt", message: "Allow Bash?" }, env).priority, 2);
  assert.equal(decide({ hook_event_name: "Notification", notification_type: "idle_prompt" }, env), null);
});

test("a turn that died on an error alerts, since nothing will resume it", () => {
  const alert = decide({ hook_event_name: "StopFailure", error: "rate_limit" }, env);
  assert.equal(alert.priority, 1);
  assert.match(alert.message, /rate_limit/);
});

test("the alert links to the session's own page", () => {
  assert.equal(sessionUrl({ CLAUDE_CODE_REMOTE_SESSION_ID: "cse_01UMMrrtc5X9qhtL3gSdnmnY" }), "https://claude.ai/code/session_01UMMrrtc5X9qhtL3gSdnmnY");
  assert.equal(sessionUrl({}), null);
  const body = pushoverBody(
    { ...EMERGENCY, title: "t", message: "m" },
    { PUSHOVER_APP_TOKEN: "a", PUSHOVER_USER_KEY: "u", CLAUDE_CODE_REMOTE_SESSION_ID: "cse_X1" },
  );
  assert.equal(body.get("url"), "https://claude.ai/code/session_X1");
  assert.equal(body.get("priority"), "2");
  assert.equal(body.get("expire"), String(EMERGENCY.expire));
});

test("markdown is flattened to one line for a lock screen", () => {
  assert.equal(plain("**a** `b`\n[c](http://x)"), "a b c");
  assert.equal(plain("x".repeat(300)).length, 240);
});

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

test("as a hook: owed but unsendable prints a systemMessage and still exits 0", () => {
  const r = spawnSync("node", [SCRIPT], {
    input: JSON.stringify({ hook_event_name: "Stop", last_assistant_message: "🛑 **NEED YOU** — x" }),
    env: { PATH: process.env.PATH },
    encoding: "utf8",
  });
  assert.equal(r.status, 0);
  assert.match(JSON.parse(r.stdout).systemMessage, /NOT alerted/);
});

test("as a hook: nothing owed prints nothing, and bad input never blocks a stop", () => {
  for (const input of [JSON.stringify({ hook_event_name: "Stop", last_assistant_message: "done" }), "not json"]) {
    const r = spawnSync("node", [SCRIPT], { input, env: { PATH: process.env.PATH }, encoding: "utf8" });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "");
  }
});
