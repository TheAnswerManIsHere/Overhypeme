// Phase 7 amendment (plan docs/plans/PLAN_PHASE7_AI_PICTURE_FLOW.md): making an
// AI picture as its own flow. The subject comes from the photo check, never a
// question; the picture is drawn in the shape chosen and with the subject's
// own name, while the caption may name anyone; a failed load of the choices
// retries and keeps every choice (#1315); a finished picture is handed to the
// builder with its own shape and caption.
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { cleanup, render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AiPictureFlow, type AiPictureFlowProps } from "../AiPictureFlow";
import { captureReturnSnapshot, readPictureHandoff } from "@/components/meme-builder/wizard/state/wizardStorage";

type Reply = unknown | [number, unknown] | Error;
type Handler = (url: string, body: Record<string, unknown> | undefined) => Reply | undefined;

const S = { timeout: 4000 };
let calls: Array<{ url: string; body?: Record<string, unknown> }> = [];

function stub(handler: Handler) {
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    calls.push({ url, body });
    const out = handler(url, body) ?? base(url, body);
    if (out instanceof Error) throw out;
    const [status, json] = Array.isArray(out) && typeof out[0] === "number" ? out as [number, unknown] : [200, out];
    return new Response(JSON.stringify(json), { status });
  }));
}

const upload = (objectPath: string) => ({ objectPath, width: 800, height: 800, isLowRes: false, fileSizeBytes: 1, createdAt: "2026-01-01T00:00:00Z", transform: null, sourceObjectPath: null, factId: null, transformParamsHash: null, isProfile: false });
const gag = (i: number, description: string | null = null) => ({ gagId: 10 + i, slot: i + 1, description, examples: { male: `/ex/${i}/m`, female: null, pet: null } });
const options = (n: number, extra: Record<string, unknown> = {}) => ({ gags: Array.from({ length: n }, (_, i) => gag(i, i === 0 ? "{NAME} lifts {POSS} own car." : null)), choice: n > 1, credits: 2, nextIsFree: false, ...extra });
const picture = (status: string, extra: Record<string, unknown> = {}) => ({ attemptId: 5, factId: 3, status, reason: null, creditReturned: false, aiImageId: null, imageUrl: null, aspectRatio: "landscape", caption: null, createdAt: "2026-11-27T00:00:00Z", ...extra });

let photoSubject: Record<string, Reply> = {};
function base(url: string, body: Record<string, unknown> | undefined): Reply {
  if (url.startsWith("/api/users/me/uploads")) return { uploads: [upload("/objects/uploads/me.jpg"), upload("/objects/uploads/pet.jpg")], nextCursor: null };
  if (url === "/api/member-pictures/photo-check") return photoSubject[String(body?.uploadKey)] ?? { uploadKey: body?.uploadKey, subject: "person" };
  if (url === "/api/member-pictures") return { pictures: [], credits: 2 };
  if (url === "/api/look-styles") return [{ id: "comic", label: "Comic", description: "Bold lines", previewImagePath: "/samples/comic.png" }];
  if (url === "/api/facts/3/picture-options") return options(1);
  return [404, {}];
}

function renderFlow(props: Partial<AiPictureFlowProps> = {}) {
  const onOpenBuilder = vi.fn();
  const onBack = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retryDelay: 1 } } });
  render(
    <QueryClientProvider client={client}>
      <AiPictureFlow factId="3" factText="{NAME} lifts cars." memberName="Alex" memberPronouns="she/her" signedIn verified
        fromBuilder={false} initialGagId={null} onBack={onBack} onOpenBuilder={onOpenBuilder} {...props} />
    </QueryClientProvider>,
  );
  return { onOpenBuilder, onBack, client };
}

const confirm = () => screen.getByTestId("ai-picture-confirm");
const sent = () => calls.filter((c) => c.url === "/api/facts/3/member-pictures").map((c) => c.body!);
function tile(name: string) {
  const img = document.querySelector(`img[src*="${name}"]`);
  if (!img?.closest("button")) throw new Error(`no tile ${name}`);
  return img.closest("button")!;
}

beforeEach(() => { window.sessionStorage.clear(); photoSubject = {}; });
afterEach(() => vi.unstubAllGlobals());

describe("AiPictureFlow", () => {
  it("decides me-or-my-pet from the photo: a pet photo asks only the pet's name, draws with it, and the caption follows it", async () => {
    photoSubject = { "/objects/uploads/pet.jpg": { uploadKey: "/objects/uploads/pet.jpg", subject: "pet" } };
    stub((url) => (url === "/api/facts/3/member-pictures" ? [202, { picture: picture("queued"), credits: 1 }] : undefined));
    renderFlow();
    await screen.findByText("A picture of you.", {}, S);
    expect(screen.queryByText(/who's in the picture/i)).toBeNull();
    fireEvent.click(tile("pet.jpg"));
    await screen.findByText("A picture of your pet.", {}, S);
    expect(screen.getByTestId("ai-picture-blocker").textContent).toContain("pet's name");
    fireEvent.change(screen.getByTestId("ai-picture-pet-name"), { target: { value: "Rex" } });
    expect((screen.getByTestId("ai-picture-caption-name") as HTMLInputElement).value).toBe("Rex");
    fireEvent.click(screen.getByTestId("aspect-landscape"));
    fireEvent.click(confirm());
    await waitFor(() => expect(sent()).toHaveLength(1), S);
    expect(sent()[0]).toMatchObject({
      uploadKey: "/objects/uploads/pet.jpg",
      subject: { kind: "pet", name: "Rex", pronouns: "they/them" },
      aspectRatio: "landscape",
      caption: { name: "Rex", pronouns: "they/them" },
    });
    // Left to follow the pet, the caption carries no mark.
    expect((sent()[0]!.caption as Record<string, unknown>).chosen).toBeUndefined();
  });

  it("draws in each shape chosen", async () => {
    for (const shape of ["landscape", "square", "portrait"] as const) {
      stub((url) => (url === "/api/facts/3/member-pictures" ? [400, { message: "no" }] : undefined));
      renderFlow();
      await waitFor(() => expect(confirm().hasAttribute("disabled")).toBe(false), S);
      fireEvent.click(screen.getByTestId(`aspect-${shape}`));
      fireEvent.click(confirm());
      await waitFor(() => expect(sent()).toHaveLength(1), S);
      expect(sent()[0]!.aspectRatio).toBe(shape);
      cleanup();
    }
  });

  it("a caption the member chose is never replaced, even one that matches their own name, and the draw still uses the subject", async () => {
    photoSubject = { "/objects/uploads/pet.jpg": { uploadKey: "/objects/uploads/pet.jpg", subject: "pet" } };
    stub((url) => (url === "/api/facts/3/member-pictures" ? [202, { picture: picture("queued"), credits: 1 }] : undefined));
    renderFlow();
    await screen.findByText("A picture of you.", {}, S);
    // Another Alex, with other pronouns: the name equals the member's own, but it was chosen.
    fireEvent.change(screen.getByTestId("ai-picture-caption-pronouns"), { target: { value: "he/him" } });
    fireEvent.click(tile("pet.jpg"));
    await screen.findByText("A picture of your pet.", {}, S);
    fireEvent.change(screen.getByTestId("ai-picture-pet-name"), { target: { value: "Rex" } });
    expect((screen.getByTestId("ai-picture-caption-name") as HTMLInputElement).value).toBe("Alex");
    fireEvent.click(confirm());
    await waitFor(() => expect(sent()).toHaveLength(1), S);
    expect(sent()[0]).toMatchObject({ subject: { kind: "pet", name: "Rex" }, caption: { name: "Alex", pronouns: "he/him", chosen: true } });
  });

  it("a photo check that could not run says so and offers no subject; a result for a photo no longer chosen sets nothing", async () => {
    let releaseMe: (() => void) | null = null;
    photoSubject = { "/objects/uploads/pet.jpg": [503, { error: "photo_check_failed", message: "We couldn't check this photo right now. Try again." }] };
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
      calls.push({ url, body });
      if (url === "/api/member-pictures/photo-check" && body?.uploadKey === "/objects/uploads/me.jpg") {
        await new Promise<void>((r) => { releaseMe = r; });
        return new Response(JSON.stringify({ uploadKey: "/objects/uploads/me.jpg", subject: "person" }), { status: 200 });
      }
      const out = base(url, body);
      const [status, json] = Array.isArray(out) && typeof out[0] === "number" ? out as [number, unknown] : [200, out];
      return new Response(JSON.stringify(json), { status });
    }));
    renderFlow();
    await waitFor(() => expect(releaseMe).not.toBeNull(), S);
    fireEvent.click(tile("pet.jpg"));
    await screen.findByText(/We couldn't check this photo — try again/, {}, S);
    releaseMe!();
    // The late "person" answer belongs to the photo no longer chosen.
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText("A picture of you.")).toBeNull();
    expect(confirm().hasAttribute("disabled")).toBe(true);
    expect(screen.getByTestId("ai-picture-blocker").textContent).toMatch(/couldn't check/i);
  });

  it("with one gag nothing is offered to select; with several, the dialog's select names the gag sent", async () => {
    stub((url) => (url === "/api/facts/3/picture-options" ? options(2) : url === "/api/facts/3/member-pictures" ? [202, { picture: picture("queued"), credits: 1 }] : undefined));
    renderFlow();
    await waitFor(() => expect(screen.getAllByTestId("ai-picture-gag")).toHaveLength(2), S);
    expect(screen.getByText("Fact Visualization Options")).toBeTruthy();
    fireEvent.click(screen.getAllByTestId("ai-picture-gag")[1]!);
    const dialog = await screen.findByTestId("ai-picture-gag-dialog");
    fireEvent.click(within(dialog).getByText("Select this visualization option"));
    await waitFor(() => expect(confirm().hasAttribute("disabled")).toBe(false), S);
    fireEvent.click(confirm());
    await waitFor(() => expect(sent()).toHaveLength(1), S);
    expect(sent()[0]!.gagId).toBe(11);
  });

  it("one gag: the card reads as this fact's visualization, its dialog has Close only and the description in the subject's name", async () => {
    stub(() => undefined);
    renderFlow();
    await waitFor(() => expect(screen.getAllByTestId("ai-picture-gag")).toHaveLength(1), S);
    expect(screen.getAllByText("This fact's visualization").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByTestId("ai-picture-gag"));
    const dialog = await screen.findByTestId("ai-picture-gag-dialog");
    expect(within(dialog).queryByText("Select this visualization option")).toBeNull();
    expect(within(dialog).getByTestId("ai-picture-gag-description").textContent).toBe("Alex lifts her own car.");
  });

  it("#1315: a failed load retries once, then Try again keeps the choices and reaches a working Make it without submitting a picture", async () => {
    let fails = 2;
    stub((url) => (url === "/api/facts/3/picture-options" && fails-- > 0 ? [500, {}] : undefined));
    renderFlow();
    fireEvent.click(await screen.findByTestId("aspect-square", {}, S));
    await screen.findByTestId("ai-picture-load-error", {}, S);
    expect(calls.filter((c) => c.url === "/api/facts/3/picture-options")).toHaveLength(2);
    expect(confirm().hasAttribute("disabled")).toBe(true);
    expect(screen.getByTestId("ai-picture-blocker").textContent).toMatch(/didn't load/);
    fireEvent.click(screen.getByTestId("ai-picture-retry"));
    await waitFor(() => expect(confirm().hasAttribute("disabled")).toBe(false), S);
    expect(screen.getByTestId("aspect-square").getAttribute("aria-checked")).toBe("true");
    expect(sent()).toHaveLength(0);
  });

  it("#1315: after Make another, a failed re-read of the cost still reaches a working Make it", async () => {
    let failNext = 0;
    const state = picture("failed", { reason: "The drawing failed.", creditReturned: true });
    stub((url) => {
      if (url === "/api/facts/3/picture-options" && failNext > 0) { failNext -= 1; return [500, {}]; }
      if (url === "/api/member-pictures/5") return { picture: state, credits: 2 };
      if (url === "/api/facts/3/member-pictures") return [202, { picture: state, credits: 1 }];
      return undefined;
    });
    renderFlow();
    await waitFor(() => expect(confirm().hasAttribute("disabled")).toBe(false), S);
    fireEvent.click(confirm());
    await screen.findByText(/Your credit was returned/, {}, S);
    failNext = 2;
    fireEvent.click(screen.getByTestId("ai-picture-make-another"));
    await screen.findByTestId("ai-picture-load-error", {}, S);
    expect(screen.getByTestId("ai-picture-blocker").textContent).not.toBe("");
    fireEvent.click(screen.getByTestId("ai-picture-retry"));
    await waitFor(() => expect(confirm().hasAttribute("disabled")).toBe(false), S);
    expect(sent()).toHaveLength(1);
  });

  it("#1315: returning while a picture draws, a load that failed behind it still reaches a working Make it after Make another", async () => {
    let state = picture("drawing");
    let fails = 2;
    stub((url) => {
      if (url === "/api/facts/3/picture-options" && fails > 0) { fails -= 1; return [500, {}]; }
      if (url === "/api/member-pictures") return { pictures: [state], credits: 2 };
      if (url === "/api/member-pictures/5") return { picture: state, credits: 2 };
      return undefined;
    });
    renderFlow();
    await screen.findByText(/Drawing your picture/, {}, S);
    state = picture("failed", { reason: "The drawing failed.", creditReturned: true });
    fireEvent.click(await screen.findByTestId("ai-picture-make-another", {}, { timeout: 6000 }));
    await waitFor(() => {
      const ready = !confirm().hasAttribute("disabled");
      const explained = screen.queryByTestId("ai-picture-load-error") !== null;
      expect(ready || explained).toBe(true);
    }, S);
    if (screen.queryByTestId("ai-picture-load-error")) fireEvent.click(screen.getByTestId("ai-picture-retry"));
    await waitFor(() => expect(confirm().hasAttribute("disabled")).toBe(false), S);
    expect(sent()).toHaveLength(0);
  }, 10000);

  it("opened from the builder: its shape and chosen caption are the defaults", async () => {
    captureReturnSnapshot({ schemaVersion: 3, capturedAt: Date.now(), factId: "3", entryFlow: "fact-detail", aspectRatio: "square", name: "Sam", pronouns: "he/him", captionChosen: true });
    stub(() => undefined);
    renderFlow({ fromBuilder: true });
    await waitFor(() => expect(confirm().hasAttribute("disabled")).toBe(false), S);
    expect(screen.getByTestId("aspect-square").getAttribute("aria-checked")).toBe("true");
    expect((screen.getByTestId("ai-picture-caption-name") as HTMLInputElement).value).toBe("Sam");
  });

  it("a lost response is retried with the same request id, so it cannot spend twice", async () => {
    let first = true;
    stub((url) => {
      if (url !== "/api/facts/3/member-pictures") return undefined;
      if (first) { first = false; return new Error("network"); }
      return [200, { picture: picture("queued"), credits: 1 }];
    });
    renderFlow();
    await waitFor(() => expect(confirm().hasAttribute("disabled")).toBe(false), S);
    fireEvent.click(confirm());
    await screen.findByText(/won't be charged twice/, {}, S);
    fireEvent.click(confirm());
    await waitFor(() => expect(sent()).toHaveLength(2), S);
    expect(sent()[0]!.requestId).toBe(sent()[1]!.requestId);
  });

  it("a request whose answer was lost is resent as it was even after the balance re-reads at zero, and its finished picture shows", async () => {
    let first = true;
    let credits = 1;
    stub((url) => {
      if (url === "/api/facts/3/picture-options") return options(1, { credits });
      if (url === "/api/member-pictures/5") return { picture: picture("done", { aiImageId: 70, imageUrl: "/img/70" }), credits: 0 };
      if (url !== "/api/facts/3/member-pictures") return undefined;
      if (first) { first = false; credits = 0; return new Error("network"); }
      return [200, { picture: picture("done", { aiImageId: 70, imageUrl: "/img/70" }), credits: 0 }];
    });
    const { client } = renderFlow();
    await waitFor(() => expect(confirm().hasAttribute("disabled")).toBe(false), S);
    fireEvent.click(confirm());
    await screen.findByText(/won't be charged twice/, {}, S);
    // The connection comes back and the choices are re-read (as the query layer does on reconnect): the balance is now zero.
    void client.invalidateQueries({ queryKey: ["member-pictures", "options", "3"] });
    await waitFor(() => expect(calls.filter((c) => c.url === "/api/facts/3/picture-options").length).toBeGreaterThan(1), S);
    await waitFor(() => expect(screen.getByTestId("ai-picture-cost").textContent).toContain("Costs"), S);
    expect(confirm().hasAttribute("disabled")).toBe(false);
    expect(confirm().textContent).toBe("Try again");
    expect(screen.queryByText(/no credits left/)).toBeNull();
    fireEvent.click(confirm());
    await screen.findByTestId("ai-picture-make-meme", {}, S);
    expect(sent()).toHaveLength(2);
    expect(sent()[1]!.requestId).toBe(sent()[0]!.requestId);
  });

  it("a new picture the balance cannot pay for is still refused before sending", async () => {
    stub((url) => (url === "/api/facts/3/picture-options" ? options(1, { credits: 0 }) : undefined));
    renderFlow();
    await screen.findByText(/no credits left/, {}, S);
    expect(confirm().hasAttribute("disabled")).toBe(true);
    expect(sent()).toHaveLength(0);
  });

  it("with another picture of this fact drawing, its row shows its outcome without a tap", async () => {
    let other = picture("drawing", { attemptId: 6 });
    stub((url) => {
      if (url === "/api/member-pictures") return { pictures: [picture("drawing"), other], credits: 1 };
      if (url === "/api/member-pictures/5") return { picture: picture("drawing"), credits: 1 };
      return undefined;
    });
    renderFlow();
    await waitFor(() => expect(screen.getByTestId("ai-picture-other-drawing").textContent).toContain("Drawing your picture"), S);
    other = picture("done", { attemptId: 6, aiImageId: 60, imageUrl: "/img/60" });
    await waitFor(() => expect(screen.getByTestId("ai-picture-other-drawing").textContent).toContain("Your picture is ready."), { timeout: 8000 });
  }, 12000);

  it("on return, a picture still drawing for this fact is shown; when done, the hand-off carries its own shape and caption", async () => {
    let state = picture("drawing", { caption: { name: "Rex", pronouns: "he/him" } });
    stub((url) => {
      if (url === "/api/member-pictures") return { pictures: [state], credits: 1 };
      if (url === "/api/member-pictures/5") return { picture: state, credits: 1 };
      return undefined;
    });
    const { onOpenBuilder } = renderFlow();
    await screen.findByText(/Drawing your picture/, {}, S);
    state = picture("done", { aiImageId: 77, imageUrl: "/api/memes/ai-user/image?storagePath=x", caption: { name: "Rex", pronouns: "he/him" } });
    fireEvent.click(await screen.findByTestId("ai-picture-make-meme", {}, { timeout: 6000 }));
    expect(onOpenBuilder).toHaveBeenCalled();
    expect(readPictureHandoff("3")).toMatchObject({ aiImageId: 77, aspectRatio: "landscape", caption: { name: "Rex", pronouns: "he/him", chosen: false } });
  }, 10000);

  it("a picture whose caption was chosen hands it off as chosen, even to a form that never saw the choice", async () => {
    const state = picture("done", { aiImageId: 79, imageUrl: "/img/79", caption: { name: "Sam", pronouns: "he/him", chosen: true } });
    stub((url) => {
      if (url === "/api/member-pictures") return { pictures: [], credits: 1 };
      if (url === "/api/member-pictures/5") return { picture: state, credits: 1 };
      if (url === "/api/facts/3/member-pictures") return [200, { picture: state, credits: 1 }];
      return undefined;
    });
    renderFlow();
    await waitFor(() => expect(confirm().hasAttribute("disabled")).toBe(false), S);
    // This form's own caption was never touched.
    fireEvent.click(confirm());
    fireEvent.click(await screen.findByTestId("ai-picture-make-meme", {}, S));
    expect(readPictureHandoff("3")).toMatchObject({ caption: { name: "Sam", pronouns: "he/him", chosen: true } });
  });

  it("an older picture with no recorded caption hands off none, so the builder's caption stays", async () => {
    const state = picture("done", { aiImageId: 78, imageUrl: "/img", caption: null, aspectRatio: "portrait" });
    stub((url) => {
      if (url === "/api/member-pictures/5") return { picture: state, credits: 1 };
      if (url === "/api/facts/3/member-pictures") return [200, { picture: state, credits: 1 }];
      return undefined;
    });
    renderFlow();
    await waitFor(() => expect(confirm().hasAttribute("disabled")).toBe(false), S);
    fireEvent.click(confirm());
    fireEvent.click(await screen.findByTestId("ai-picture-make-meme", {}, S));
    expect(readPictureHandoff("3")).toMatchObject({ aiImageId: 78, aspectRatio: "portrait", caption: null });
  });

  it("Make another keeps the choices and reads the cost again", async () => {
    const state = picture("failed", { reason: "The drawing failed.", creditReturned: true });
    stub((url) => {
      if (url === "/api/member-pictures/5") return { picture: state, credits: 2 };
      if (url === "/api/facts/3/member-pictures") return [202, { picture: state, credits: 1 }];
      return undefined;
    });
    renderFlow();
    await waitFor(() => expect(confirm().hasAttribute("disabled")).toBe(false), S);
    fireEvent.click(screen.getByTestId("aspect-square"));
    fireEvent.click(confirm());
    await screen.findByText(/Your credit was returned/, {}, S);
    const before = calls.filter((c) => c.url === "/api/facts/3/picture-options").length;
    fireEvent.click(screen.getByTestId("ai-picture-make-another"));
    await waitFor(() => expect(calls.filter((c) => c.url === "/api/facts/3/picture-options").length).toBeGreaterThan(before), S);
    expect(screen.getByTestId("aspect-square").getAttribute("aria-checked")).toBe("true");
  });

  it("signed out: the explanation and the sign-in route, never the form", () => {
    stub(() => undefined);
    renderFlow({ signedIn: false });
    expect(screen.getByText(/Sign up or sign in/, { selector: "button" })).toBeTruthy();
    expect(screen.queryByTestId("ai-picture-confirm")).toBeNull();
  });
});
