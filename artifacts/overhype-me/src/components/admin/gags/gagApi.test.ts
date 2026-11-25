/**
 * `tokenizeGag`: which fields a gag save sends to the tokenizer. Regression for
 * the moderator report "There's a bug in the tokenizer that is not
 * re-tokenizing some items like 'his'": a scene stored with plain subject
 * pronouns was never sent again, because only changed fields were.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { EMPTY_VISUAL_STRATEGY_OVERRIDE, type VisualPromptStrategyOverride } from "@workspace/api-zod";
import { tokenizeGag } from "./gagApi";
import { DEFAULT_SUBJECT_EXAMPLE_NAMES } from "@/components/admin/subjectExampleNames";

const NAMES = ["David Franklin", "Raena Franklin", "Alex Franklin"];
const scene = (text: string, bubbleText?: string): VisualPromptStrategyOverride => ({
  ...EMPTY_VISUAL_STRATEGY_OVERRIDE,
  coreSceneOverride: text,
  bubbles: bubbleText == null ? [] : [{ type: "speech", entity: "subject", text: bubbleText }],
});

/** Stub the tokenize route: records the paths sent, answers each with `tokenized(value)`. */
function stubTokenizer(tokenized: (v: string) => string = (v) => v) {
  const sent: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { entries: Array<{ path: string; value: string }> };
    sent.push(...body.entries.map((e) => e.path));
    return new Response(JSON.stringify({ results: body.entries.map((e) => ({ path: e.path, value: tokenized(e.value) })) }), { status: 200 });
  }));
  return sent;
}

afterEach(() => vi.unstubAllGlobals());

describe("tokenizeGag", () => {
  const STORED = "{NAME} turns his head to look away from the person he’s talking to. {Subj} cups his ear.";

  it("re-sends an unchanged scene that still holds a plain subject pronoun, and saves what comes back", async () => {
    const sent = stubTokenizer((v) => v.replace(/\bhis\b/g, "{POSS}").replace("he’s", "{SUBJ} {is|are}"));
    const stored = scene(STORED, "Old line.");
    const edited = scene(STORED, "New line.");
    const r = await tokenizeGag(edited, stored, NAMES);
    expect(sent).toContain("coreSceneOverride");
    expect(r.ok).toBe(true);
    expect(r.content.coreSceneOverride).toBe("{NAME} turns {POSS} head to look away from the person {SUBJ} {is|are} talking to. {Subj} cups {POSS} ear.");
  });

  it("re-sends an unchanged scene that still names the subject in plain words", async () => {
    const sent = stubTokenizer();
    const text = "David Franklin waves at a crowd.";
    await tokenizeGag(scene(text, "New line."), scene(text, "Old line."), NAMES);
    expect(sent).toContain("coreSceneOverride");
  });

  it("does not send an unchanged scene that is fully tokenized", async () => {
    const sent = stubTokenizer();
    const text = "{NAME} turns {POSS} head and cups {POSS} ear.";
    await tokenizeGag(scene(text, "New line."), scene(text, "Old line."), NAMES);
    expect(sent).toEqual(["bubbles[0].text"]);
  });

  it("does not re-send an unchanged bubble line with a pronoun: it may be a speaker's own words", async () => {
    const sent = stubTokenizer();
    const text = "{NAME} turns {POSS} head.";
    const stored = scene(text, "Is that his dog?");
    const r = await tokenizeGag({ ...stored }, stored, NAMES);
    expect(sent).toEqual([]);
    expect(r.ok).toBe(true);
  });
});

describe("the example people a moderation or Facts-page save sends (Issue #983)", () => {
  it("are David, Raena, Alex and Mango, and nobody else", () => {
    expect([...DEFAULT_SUBJECT_EXAMPLE_NAMES]).toEqual(["David Franklin", "Raena Franklin", "Alex Franklin", "Mango"]);
  });

  it("reach the tokenizer request as its subject names, and a scene naming Mango in plain words is re-sent", async () => {
    const bodies: Array<{ subjectContext: { names: string[] } }> = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { entries: Array<{ path: string; value: string }>; subjectContext: { names: string[] } };
      bodies.push(body);
      return new Response(JSON.stringify({ results: body.entries.map((e) => ({ path: e.path, value: e.value })) }), { status: 200 });
    }));
    const text = "Mango naps on the keyboard.";
    await tokenizeGag(scene(text, "New line."), scene(text, "Old line."), [...DEFAULT_SUBJECT_EXAMPLE_NAMES]);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]!.subjectContext.names).toEqual(["David Franklin", "Raena Franklin", "Alex Franklin", "Mango"]);
    expect((bodies[0] as unknown as { entries: Array<{ path: string }> }).entries.map((e) => e.path)).toContain("coreSceneOverride");
  });
});
