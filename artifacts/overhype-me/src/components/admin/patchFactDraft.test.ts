/**
 * patchFactDraft maps the endpoint's success body and its typed refusal into a
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
  it("maps a 200 with a fact to saved", async () => {
    stubFetch(200, { success: true, fact: { id: 1, text: "x" } });
    const r = await patchFactDraft<{ id: number; text: string }>(1, { useCase: null });
    expect(r.kind).toBe("saved");
    if (r.kind === "saved") expect(r.fact.id).toBe(1);
  });

  it("maps WORDING_LOCKED to wording_locked with the server's message", async () => {
    stubFetch(409, { code: FACT_TEXT_EDIT_CODES.WORDING_LOCKED, error: "locked" });
    const r = await patchFactDraft(1, { text: "x" });
    expect(r).toEqual({ kind: "wording_locked", message: "locked" });
  });

  it("maps an unknown/untyped error to error", async () => {
    stubFetch(500, { error: "boom" });
    const r = await patchFactDraft(1, { text: "x" });
    expect(r).toEqual({ kind: "error", message: "boom" });
  });
});
