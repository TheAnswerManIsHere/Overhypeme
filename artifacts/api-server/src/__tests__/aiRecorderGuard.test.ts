/**
 * The AI recorder launcher's refusals (src/testing/aiRecorderGuard.ts): the
 * recording run boots the real app with real AI keys, so everything else it
 * could reach is refused before the app is imported.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { recorderLaunchRefusals } from "../testing/aiRecorderGuard.js";

const OK = {
  NODE_ENV: "development",
  AI_BACKEND: "recorder",
  FAL_AI_API_KEY: "fal-test",
  OPENAI_API_KEY: "sk-test",
  STORAGE_BACKEND: "local-double",
  STORAGE_DOUBLE_DIR: "/tmp/ai-recorder-storage",
  AI_RECORDINGS_DIR: "/tmp/ai-recordings",
  AI_RECORDER_ALLOWANCE_USD: "5",
};

describe("AI recorder launch refusals", () => {
  it("accepts the isolated recording environment", () => {
    assert.deepEqual(recorderLaunchRefusals(OK), []);
  });

  it("refuses a production boot or a deployment", () => {
    assert.match(recorderLaunchRefusals({ ...OK, NODE_ENV: "production" }).join(), /production/);
    assert.match(recorderLaunchRefusals({ ...OK, REPLIT_DEPLOYMENT: "1" }).join(), /production/);
  });

  it("refuses unless it is recording, into local storage, under an allowance", () => {
    assert.match(recorderLaunchRefusals({ ...OK, AI_BACKEND: "recorded-double" }).join(), /AI_BACKEND must be 'recorder'/);
    assert.match(recorderLaunchRefusals({ ...OK, STORAGE_BACKEND: "" }).join(), /real bucket/);
    assert.match(recorderLaunchRefusals({ ...OK, AI_RECORDINGS_DIR: "rel" }).join(), /AI_RECORDINGS_DIR/);
    for (const v of [undefined, "0", "-1", "lots"]) {
      assert.match(recorderLaunchRefusals({ ...OK, AI_RECORDER_ALLOWANCE_USD: v }).join(), /ALLOWANCE/);
    }
  });

  it("refuses the vendor keys it needs being absent", () => {
    assert.match(recorderLaunchRefusals({ ...OK, OPENAI_API_KEY: "" }).join(), /OPENAI_API_KEY/);
  });

  it("refuses any credential outside the AI baseline", () => {
    for (const name of ["STRIPE_SECRET_KEY_TEST", "STRIPE_ACCOUNT_ID_TEST", "RESEND_API_KEY", "PEXELS_API_KEY", "ARACHNID_SHIELD_PASSWORD"]) {
      assert.match(recorderLaunchRefusals({ ...OK, [name]: "x" }).join(), new RegExp(name), name);
    }
  });
});
