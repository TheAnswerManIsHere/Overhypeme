// SYNCED FROM KITT — do not edit in a consumer repo. Local edits are overwritten by the next sync and their reasoning is lost; change KITT instead.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { decide, alertFor, send, pushoverBody, sessionUrl, plain, WAITING, withoutFences } from "../needs-you-alert.mjs";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "needs-you-alert.mjs");
const env = { CLAUDE_PROJECT_DIR: "/home/user/Overhype.me" };
// What a single Stop owes on a fresh session: the deduplicated alert, never the internal `clear` marker.
const stop = (last_assistant_message) =>
  alertFor({ hook_event_name: "Stop", session_id: "t", last_assistant_message }, { ...env, NEEDS_YOU_ALERT_STATE_DIR: mkdtempSync(join(tmpdir(), "nya-")) });

const SUMMARY = "Wrote the hook and opened the PR; its CI is running and wakes me when it finishes.";
const PLAN_DONE = "Merged the last increment and synced the Repl.\n\n✅ **PLAN DONE** — the caption editor is built and live";

test("every alert rings once: high priority, no retry, no expire (David, 2026-11-02)", () => {
  assert.deepEqual(WAITING, { priority: 1, sound: "siren" });
  const body = pushoverBody({ ...WAITING, title: "t", message: "m" }, { PUSHOVER_APP_TOKEN: "a", PUSHOVER_USER_KEY: "u" });
  assert.equal(body.get("priority"), "1");
  assert.equal(body.has("retry"), false);
  assert.equal(body.has("expire"), false);
  for (const alert of [
    stop("🛑 **NEED YOU** — x"),
    stop(PLAN_DONE),
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

test("an open-ask line rings nothing: it marks an ask already rung and unchanged", () => {
  assert.equal(stop("Still waiting on you: the Astra code, above."), null);
  assert.equal(stop(`${SUMMARY}\n\nStill waiting on you: the code, above.`), null);
});

test("a summary before a new ask does not hide it", () => {
  assert.equal(stop(`${SUMMARY}\n\n🛑 **NEED YOU** — the code`).title, "🛑 Overhype.me: Claude needs you");
});

test("a finished plan alerts, carrying its line (David, 2026-11-04)", () => {
  const alert = stop(PLAN_DONE);
  assert.equal(alert.title, "✅ Overhype.me: plan done — over to you");
  assert.equal(alert.message, "the caption editor is built and live");
  assert.ok(stop("## ✅ **PLAN DONE** — x"), "dressed in a heading");
  assert.equal(stop("It rings on a `✅ **PLAN DONE** —` line."), null, "quoted mid-line, it is not one");
  assert.equal(stop("```\n✅ **PLAN DONE** — example\n```"), null, "nor inside a fence");
});

test("one ask, one ring: an unchanged ask rings once, a changed one rings, and any other hand-back resets it (David, 2026-11-03)", () => {
  const e = { ...env, NEEDS_YOU_ALERT_STATE_DIR: mkdtempSync(join(tmpdir(), "nya-")) };
  const at = (text, session_id = "s1") => alertFor({ hook_event_name: "Stop", session_id, last_assistant_message: text }, e);
  assert.ok(at("🛑 **NEED YOU** — sign in"));
  assert.equal(at("🛑 **NEED YOU** — sign in"), null, "an identical banner does not ring twice");
  assert.equal(at(`${SUMMARY}\n\nStill waiting on you: sign in, above.`), null, "nor its open-ask line");
  assert.ok(at("🛑 **NEED YOU** — sign in", "s2"), "another session keeps its own memory");
  assert.ok(at("🛑 **NEED YOU** — pick the fonts"), "a different ask rings");
  assert.equal(at(SUMMARY), null, "a hand-back waiting on nothing rings nothing");
  assert.ok(at("🛑 **NEED YOU** — pick the fonts"), "and after it, the old ask rings again as a new one");
  assert.ok(at(PLAN_DONE));
  assert.equal(at(PLAN_DONE), null, "an identical plan-done line does not ring twice");
  assert.ok(at("Merged.\n\n✅ **PLAN DONE** — the logging viewer is built"), "a different finished plan rings");
  assert.ok(alertFor({ hook_event_name: "Notification", session_id: "s1", notification_type: "permission_prompt" }, e));
  assert.ok(alertFor({ hook_event_name: "Notification", session_id: "s1", notification_type: "permission_prompt" }, e), "prompts are not deduplicated");
});

test("a changed decision under the same banner heading rings; /status reproducing an unchanged ask does not; long lines differing only at the end stay distinct (Codex, PR #279)", () => {
  const e = { ...env, NEEDS_YOU_ALERT_STATE_DIR: mkdtempSync(join(tmpdir(), "nya-")) };
  const at = (text) => alertFor({ hook_event_name: "Stop", session_id: "s", last_assistant_message: text }, e);
  assert.ok(at("🛑 **NEED YOU** — approve the production deployment\n\nRelease 1.4.0.\n\n1. Ship\n2. Hold"));
  assert.ok(at("🛑 **NEED YOU** — approve the production deployment\n\nRelease 1.5.0.\n\n1. Ship\n2. Hold"), "a changed decision under the same banner heading rings");
  const ask = "🛑 **NEED YOU** — pick the caption fonts\n\n1. Ten fonts\n2. Strict six\n\nRecommendation: 2.\n\n---";
  assert.ok(at(`Context.\n\n---\n${ask}\n\nMore.`));
  assert.equal(at(`📍 Overhype.me — briefing\n\n🛑 Waiting on you:\n\n---\n${ask}\n\nNext: Phase 5.\nYour next stop: UAT.`), null, "/status reproducing the unchanged ask, with other sections after it, rings nothing (Codex, DojoOS PR #74)");
  const long = "review the release notes carefully, ".repeat(10);
  assert.ok(at(`✅ **PLAN DONE** — ${long}for release A`));
  assert.ok(at(`✅ **PLAN DONE** — ${long}for release B`), "a change past 240 characters rings");
});

test("a state file that cannot be written still rings: a duplicate is cheaper than a missed ask", () => {
  // A directory path running through a regular file: every read and write fails at once (ENOTDIR).
  const file = join(mkdtempSync(join(tmpdir(), "nya-")), "not-a-dir");
  writeFileSync(file, "");
  const e = { ...env, NEEDS_YOU_ALERT_STATE_DIR: join(file, "state") };
  const at = () => alertFor({ hook_event_name: "Stop", session_id: "x", last_assistant_message: PLAN_DONE }, e);
  assert.ok(at());
  assert.ok(at());
});

test("nothing that is not waiting on David alerts: a summary of work that continues, a finished increment with more to come, a build report, an FYI, a retired footer, plain text, silence", () => {
  for (const text of [
    SUMMARY,
    "Increment 2 of 4 is merged and synced; increment 3 is starting.",
    "**Build report — PR #263 — Sync · merged**\n\n*About the unit.*\n\n**Needs you:** walk the UAT\n\n**What was built**\n\nA thing.",
    "---\n👀 **FYI** — **Pushover chosen** as the channel\nspecifics\n---",
    "**Done:** all of it · **Next:** nothing — the plan is done · **Needs you:** the code · **Spend:** $3",
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
  ]) {
    assert.match(stop(text)?.message ?? "", /pick a channel/, text);
  }
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
  assert.equal(decide({ hook_event_name: "Stop", agent_id: "sub-1", last_assistant_message: "🛑 **NEED YOU** — b" }, env), null);
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
    env: { PATH: process.env.PATH, NEEDS_YOU_ALERT_STATE_DIR: mkdtempSync(join(tmpdir(), "nya-")) },
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
    JSON.stringify({ hook_event_name: "Stop", last_assistant_message: SUMMARY }),
    JSON.stringify({ hook_event_name: "PostToolUse", tool_name: "Bash" }),
    JSON.stringify({ hook_event_name: "Notification", notification_type: "idle_prompt" }),
    "not json",
  ]) {
    const r = spawnSync("node", [SCRIPT], { input, env: { PATH: process.env.PATH, NEEDS_YOU_ALERT_STATE_DIR: mkdtempSync(join(tmpdir(), "nya-")) }, encoding: "utf8" });
    assert.equal(r.status, 0, input);
    assert.equal(r.stdout, "", input);
  }
});
