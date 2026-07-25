/**
 * patchFactDraft maps the endpoint's success body + typed 4xx codes into a
 * discriminated result. Fetch is stubbed per case.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { FACT_TEXT_EDIT_CODES } from "@workspace/api-zod";
import { patchFactDraft } from "./patchFactDraft";

function stubFetch(status: number, body: unknown) {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: status >= 200 && status < 300, status, json: async () => body })) as unknown as typeof fetch);
}

afterEach(() => vi.unstubAllGlobals());

describe("patchFactDraft", () => {
  it("maps a 200 with a fact to saved (carrying extras)", async () => {
    stubFetch(200, { success: true, fact: { id: 1, text: "x" }, auditRowId: 9 });
    const r = await patchFactDraft<{ id: number; text: string }>(1, { text: "x" });
    expect(r.kind).toBe("saved");
    if (r.kind === "saved") {
      expect(r.fact.id).toBe(1);
      expect(r.auditRowId).toBe(9);
    }
  });

  it("maps REQUIRES_CONFIRMATION → confirmation_required with the impact", async () => {
    stubFetch(409, { code: FACT_TEXT_EDIT_CODES.REQUIRES_CONFIRMATION, impact: { protected: true } });
    const r = await patchFactDraft(1, { text: "x" });
    expect(r.kind).toBe("confirmation_required");
  });

  it("maps STALE_BASELINE → stale_baseline", async () => {
    stubFetch(409, { code: FACT_TEXT_EDIT_CODES.STALE_BASELINE, impact: { protected: true } });
    const r = await patchFactDraft(1, { text: "x" });
    expect(r.kind).toBe("stale_baseline");
  });

  it("maps STAGING_PREP_IN_PROGRESS", async () => {
    stubFetch(409, { code: FACT_TEXT_EDIT_CODES.STAGING_PREP_IN_PROGRESS });
    const r = await patchFactDraft(1, { text: "x" });
    expect(r.kind).toBe("staging_prep_in_progress");
  });

  it("maps an unknown/untyped error to error", async () => {
    stubFetch(500, { error: "boom" });
    const r = await patchFactDraft(1, { text: "x" });
    expect(r).toEqual({ kind: "error", message: "boom" });
  });
});
