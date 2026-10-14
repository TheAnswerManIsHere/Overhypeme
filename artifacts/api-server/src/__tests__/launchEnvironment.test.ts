/**
 * Every journey launcher boots from a constructed environment (Phase 2,
 * increment 6, #631; plan D3). The shape lives in one module; each launch's
 * guard refuses any variable outside its list, so a vendor credential the list
 * does not name never reaches that server.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { acceptanceLaunchRefusals } from "../testing/acceptanceGuard.js";
import { recorderLaunchRefusals } from "../testing/aiRecorderGuard.js";
import {
  ACCEPTANCE_ENV_ALLOWLIST,
  allowlistRefusals,
  constructEnvironment,
  LIVE_ENV_ALLOWLIST,
  outsideAllowlist,
  PRODUCTION_MODE_ENV_ALLOWLIST,
  RECORDER_ENV_ALLOWLIST,
} from "../testing/launchEnvironment.js";
import { productionModeRefusals } from "../testing/productionModeGuard.js";

const VENDOR_KEYS = [
  "STRIPE_SECRET_KEY_TEST",
  "STRIPE_ACCOUNT_ID_TEST",
  "RESEND_API_KEY",
  "PEXELS_API_KEY",
  "ARACHNID_SHIELD_PASSWORD",
  "OPENAI_API_KEY",
  "FAL_AI_API_KEY",
  "SENTRY_DSN_BACKEND",
  "SOME_NEW_VENDOR_KEY",
];

describe("the launch-environment allowlists", () => {
  it("name no credential where a launch holds none", () => {
    for (const list of [ACCEPTANCE_ENV_ALLOWLIST, PRODUCTION_MODE_ENV_ALLOWLIST]) {
      for (const key of VENDOR_KEYS) assert.equal(list.includes(key), false, key);
    }
  });

  it("give the recorder only the AI baseline's vendors, and the live check those plus the vendors its journeys reach", () => {
    assert.deepEqual(VENDOR_KEYS.filter((k) => RECORDER_ENV_ALLOWLIST.includes(k)), ["OPENAI_API_KEY", "FAL_AI_API_KEY"]);
    assert.deepEqual(
      VENDOR_KEYS.filter((k) => LIVE_ENV_ALLOWLIST.includes(k)),
      ["PEXELS_API_KEY", "ARACHNID_SHIELD_PASSWORD", "OPENAI_API_KEY", "FAL_AI_API_KEY"],
    );
    assert.equal(LIVE_ENV_ALLOWLIST.includes("STRIPE_SECRET_KEY_TEST"), false);
  });

  it("names every stray variable in one refusal", () => {
    const env = { PATH: "/bin", ZED: "1", ALPHA: "2" };
    assert.deepEqual(outsideAllowlist(env, ["PATH"]), ["ALPHA", "ZED"]);
    assert.match(allowlistRefusals(env, ["PATH"], "test launch").join(), /test launch's allowlist are set \(ALPHA, ZED\)/);
    assert.deepEqual(allowlistRefusals({ PATH: "/bin" }, ["PATH"], "test launch"), []);
  });

  it("constructs only allowlisted keys, dropping undefined values and throwing on any other key", () => {
    assert.deepEqual(constructEnvironment(["PATH", "HOME"], { PATH: "/bin", HOME: undefined }), { PATH: "/bin" });
    assert.throws(() => constructEnvironment(["PATH"], { PATH: "/bin", OPENAI_API_KEY: "sk" }), /OPENAI_API_KEY is not on this launch's allowlist/);
  });
});

describe("each launch's guard refuses a vendor credential outside its list", () => {
  const acceptance = { NODE_ENV: "development", AI_BACKEND: "recorded-double", STORAGE_BACKEND: "local-double", STORAGE_DOUBLE_DIR: "/tmp/acc" };
  const production = { NODE_ENV: "production", E2E_MAIL_SINK_DIR: "/tmp/mail", SITE_BASE_URL: "http://localhost:5174" };
  const recorder = {
    NODE_ENV: "development",
    AI_BACKEND: "recorder",
    FAL_AI_API_KEY: "fal",
    OPENAI_API_KEY: "sk",
    STORAGE_BACKEND: "local-double",
    STORAGE_DOUBLE_DIR: "/tmp/rec",
    AI_RECORDINGS_DIR: "/tmp/rec-out",
    AI_RECORDER_ALLOWANCE_USD: "5",
  };

  it("accepts each launch's own environment", () => {
    assert.deepEqual(acceptanceLaunchRefusals(acceptance), []);
    assert.deepEqual(productionModeRefusals(production), []);
    assert.deepEqual(recorderLaunchRefusals(recorder), []);
    assert.deepEqual(recorderLaunchRefusals({ ...recorder, AI_RECORDER_LIVE: "1", PEXELS_API_KEY: "px" }), []);
  });

  it("refuses the acceptance launch any credential at all", () => {
    for (const key of VENDOR_KEYS) {
      assert.match(acceptanceLaunchRefusals({ ...acceptance, [key]: "x" }).join(), new RegExp(`acceptance launcher's allowlist are set \\(${key}\\)`), key);
    }
  });

  it("refuses journey 1's production-mode launch any vendor key, beside the guard's own Resend refusal", () => {
    // The launcher applies both: productionModeRefusals (unchanged) and this list.
    for (const key of VENDOR_KEYS) {
      assert.match(allowlistRefusals({ ...production, [key]: "x" }, PRODUCTION_MODE_ENV_ALLOWLIST, "production-mode launcher").join(), new RegExp(`production-mode launcher's allowlist are set \\(${key}\\)`), key);
    }
    assert.deepEqual(allowlistRefusals(production, PRODUCTION_MODE_ENV_ALLOWLIST, "production-mode launcher"), []);
    assert.match(productionModeRefusals({ ...production, RESEND_API_KEY: "re" }).join(), /a Resend API key is set/);
  });

  it("refuses the recorder Pexels and Arachnid unless it is the live check", () => {
    assert.match(recorderLaunchRefusals({ ...recorder, PEXELS_API_KEY: "px" }).join(), /recorder's allowlist are set \(PEXELS_API_KEY\)/);
    assert.match(recorderLaunchRefusals({ ...recorder, AI_RECORDER_LIVE: "1", STRIPE_SECRET_KEY_TEST: "sk" }).join(), /live check's allowlist are set \(STRIPE_SECRET_KEY_TEST\)/);
  });

  it("refuses an acceptance launch on a real AI backend, real storage, or in production", () => {
    assert.match(acceptanceLaunchRefusals({ ...acceptance, AI_BACKEND: "recorder" }).join(), /recorded-double/);
    assert.match(acceptanceLaunchRefusals({ ...acceptance, STORAGE_BACKEND: "" }).join(), /real bucket/);
    assert.match(acceptanceLaunchRefusals({ ...acceptance, REPLIT_DEPLOYMENT: "1" }).join(), /production/);
  });
});
