/**
 * Browser-level stubs for the read endpoints a public screen needs, for the
 * described-screen checks in `publicScreens.spec.ts` (#631, increment 8).
 *
 * Why stubs and not rows: the dev stack CI boots has an empty database and no
 * AI doubles, and an active fact can only be created through the moderation
 * pipeline, which needs them. These checks are about what a SCREEN shows for a
 * given API answer; whether the API gives that answer is asserted separately,
 * in the API suite each UAT step's other clauses cite. Every other request
 * (session, config, route stats) still reaches the real dev server.
 *
 * The bodies are typed against the generated API client, so a renamed or
 * retyped field is a type error when these files are type-checked. Nothing in
 * CI type-checks e2e/ today (the package's tsconfig includes only src/), so
 * that is a check a contributor runs, not a gate.
 */
import type { Page, Route } from "@playwright/test";
import type { FactDetail, FactSummary } from "@workspace/api-client-react";

/** The AI meme background sets a fact carries, as GET /api/facts/:id returns them. */
export interface AiMemeImages {
  male: string[];
  female: string[];
  neutral: string[];
}

/** GET /api/facts/:id as the server sends it: the typed detail plus the image fields it adds. */
export type FactDetailBody = FactDetail & {
  rank?: number;
  useCase?: string | null;
  pexelsImages?: unknown;
  aiMemeImages?: AiMemeImages | null;
};

/** One row of GET /api/facts/:id/memes, field for field as `routes/memes.ts` serializes it. */
export interface MemeListItem {
  id: number;
  factId: number;
  templateId: string;
  imageUrl: string;
  permalinkSlug: string;
  isPublic: boolean;
  createdById: string | null;
  createdAt: string;
  aspectRatio: string;
  originalWidth: number | null;
  originalHeight: number | null;
  uploadFileSizeBytes: number | null;
  heartCount: number;
  viewerHasHearted: boolean;
}

/** GET /api/memes/:slug, field for field as `routes/memes.ts` serializes it. */
export interface MemeDetailBody extends Omit<MemeListItem, "aspectRatio"> {
  permalinkUrl: string;
  factText: string;
  createdByName: string | null;
  isNsfw: boolean;
  imageTransform: string | null;
  imageSource: { type?: string } | null;
}

const CREATED = "2026-10-01T12:00:00.000Z";

export function factSummary(overrides: Partial<FactSummary> & Pick<FactSummary, "id" | "text">): FactSummary {
  return {
    upvotes: 12,
    downvotes: 1,
    score: 11,
    commentCount: 0,
    shareCount: 0,
    hashtags: ["legend"],
    submittedBy: null,
    submittedByImage: null,
    createdAt: CREATED,
    ...overrides,
  };
}

export function factDetail(overrides: Partial<FactDetailBody> & Pick<FactDetailBody, "id" | "text">): FactDetailBody {
  return {
    ...factSummary(overrides),
    rank: 1,
    links: [],
    variants: [],
    parentId: null,
    useCase: null,
    pexelsImages: null,
    aiMemeImages: null,
    ...overrides,
  };
}

export function memeItem(overrides: Partial<MemeListItem> & Pick<MemeListItem, "id" | "factId" | "permalinkSlug">): MemeListItem {
  return {
    templateId: "classic",
    imageUrl: `/api/memes/${overrides.permalinkSlug}/image`,
    isPublic: true,
    createdById: null,
    createdAt: CREATED,
    aspectRatio: "landscape",
    originalWidth: 1200,
    originalHeight: 630,
    uploadFileSizeBytes: null,
    heartCount: 0,
    viewerHasHearted: false,
    ...overrides,
  };
}

export function memeDetail(overrides: Partial<MemeDetailBody> & Pick<MemeDetailBody, "id" | "factId" | "permalinkSlug" | "factText">): MemeDetailBody {
  const { aspectRatio: _aspectRatio, ...base } = memeItem(overrides);
  return {
    ...base,
    permalinkUrl: `/m/${overrides.permalinkSlug}`,
    createdByName: null,
    isNsfw: false,
    imageTransform: null,
    imageSource: null,
    ...overrides,
  };
}

/** A 1×1 PNG, served for any stubbed image URL so no <img> fails to load. */
const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=",
  "base64",
);

function json(route: Route, body: unknown, status = 200): Promise<void> {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

export interface PublicFactStubs {
  facts: FactDetailBody[];
  /** Memes per fact id; split by the visibility query the fact page sends. */
  memes?: Record<number, MemeListItem[]>;
  memeDetails?: MemeDetailBody[];
  /** GET /api/facts/:id/related per fact id; empty when absent. */
  related?: Record<number, FactDetailBody[]>;
  /** Image URLs the page may load; each answers with a 1×1 PNG. */
  images?: string[];
}

/**
 * Answer the public fact, meme and list endpoints from `stubs`. Every URL the
 * stub answers is recorded in the returned array, so a test can also assert
 * what the page asked for.
 */
export async function stubPublicFacts(page: Page, stubs: PublicFactStubs): Promise<string[]> {
  const requested: string[] = [];
  const byId = new Map(stubs.facts.map((f) => [f.id, f]));
  const roots = stubs.facts.filter((f) => !f.parentId);

  await page.route(/\/api\/facts(\?.*)?$/, (route) => {
    requested.push(route.request().url());
    const summaries = roots.map((f) => factSummary(f));
    return json(route, { facts: summaries, total: summaries.length });
  });
  await page.route(/\/api\/facts\/hero(\?.*)?$/, (route) => {
    requested.push(route.request().url());
    return roots[0] ? json(route, { fact: factSummary(roots[0]), poolSize: roots.length }) : json(route, { error: "none" }, 404);
  });
  await page.route(/\/api\/facts\/(\d+)(\/[^?]*)?(\?.*)?$/, (route) => {
    const url = new URL(route.request().url());
    requested.push(url.toString());
    const m = /\/api\/facts\/(\d+)(\/[^?]*)?$/.exec(url.pathname)!;
    const id = Number(m[1]);
    const sub = m[2] ?? "";
    const fact = byId.get(id);
    if (!fact) return json(route, { error: "Fact not found" }, 404);
    if (sub === "") return json(route, fact);
    if (sub === "/memes") {
      const visibility = url.searchParams.get("visibility");
      const all = stubs.memes?.[id] ?? [];
      // Logged out, the server returns only public memes for "community" and nothing for the viewer's own lists.
      return json(route, { memes: visibility === "community" ? all.filter((mm) => mm.isPublic) : [] });
    }
    if (sub === "/related") return json(route, { facts: (stubs.related?.[id] ?? []).map((f) => factSummary(f)) });
    if (sub === "/comments") return json(route, { comments: [], total: 0 });
    if (sub === "/links") return json(route, { links: [] });
    return route.continue();
  });
  await page.route(/\/api\/memes\/([^/?]+)(\?.*)?$/, (route) => {
    const url = new URL(route.request().url());
    requested.push(url.toString());
    const slug = decodeURIComponent(url.pathname.split("/").pop()!);
    const meme = stubs.memeDetails?.find((mm) => mm.permalinkSlug === slug);
    return meme ? json(route, meme) : json(route, { error: "Meme not found" }, 404);
  });
  for (const image of stubs.images ?? []) {
    await page.route((url) => url.pathname === image, (route) => {
      requested.push(route.request().url());
      return route.fulfill({ status: 200, contentType: "image/png", body: PIXEL });
    });
  }
  return requested;
}
