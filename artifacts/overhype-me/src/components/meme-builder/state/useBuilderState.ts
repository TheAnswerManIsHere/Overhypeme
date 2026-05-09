/**
 * Reducer-backed state for the meme builder. Centralized so behavior matrix
 * cells, tests, and the live preview all read from one source.
 *
 * The reducer is intentionally small: most decisions live in behaviorMatrix.ts.
 * This file just owns "what the user has typed/picked so far".
 */

import { useReducer } from "react";
import type {
  AspectRatio,
  MemeTextOptions,
  Mode,
  MyImageSource,
  PendingBuilderState,
} from "../types";

export interface BuilderInternalState {
  name: string;
  pronouns: string;
  /** Selected stock image id when sourceArea === "stock". */
  stockImageId: string | null;
  /** Selected stock image URL — kept alongside the id so the live preview
   *  can render the photo immediately without waiting for a server round-trip. */
  stockImageUrl: string | null;
  /** Selected self-upload source when sourceArea === "my-image". */
  myImage: MyImageSource | null;
  /** When mode === "self-upload" and the user is legendary, did they request stylize. */
  stylizeWithAi: boolean;
  textOptions: MemeTextOptions;
  aspectRatio: AspectRatio;
}

export type BuilderAction =
  | { type: "set-name"; name: string }
  | { type: "set-pronouns"; pronouns: string }
  | { type: "set-stock-image"; stockImageId: string | null; stockImageUrl?: string | null }
  | { type: "set-my-image"; myImage: MyImageSource | null }
  | { type: "set-stylize"; stylizeWithAi: boolean }
  | { type: "set-text-options"; textOptions: MemeTextOptions }
  | { type: "set-aspect-ratio"; aspectRatio: AspectRatio }
  | { type: "hydrate-from-pending"; pending: PendingBuilderState };

export interface BuilderInitArgs {
  initialName?: string;
  initialPronouns?: string;
  initialStockImageId?: string;
  initialPendingState?: PendingBuilderState;
}

export function buildInitialState(args: BuilderInitArgs): BuilderInternalState {
  const base: BuilderInternalState = {
    name: args.initialName ?? "",
    pronouns: args.initialPronouns ?? "they/them",
    stockImageId: args.initialStockImageId ?? null,
    stockImageUrl: null,
    myImage: null,
    stylizeWithAi: false,
    textOptions: {},
    aspectRatio: "landscape",
  };

  const pending = args.initialPendingState;
  if (pending) {
    return reducer(base, { type: "hydrate-from-pending", pending });
  }
  return base;
}

export function reducer(state: BuilderInternalState, action: BuilderAction): BuilderInternalState {
  switch (action.type) {
    case "set-name":
      return { ...state, name: action.name };
    case "set-pronouns":
      return { ...state, pronouns: action.pronouns };
    case "set-stock-image":
      return {
        ...state,
        stockImageId: action.stockImageId,
        stockImageUrl: action.stockImageUrl ?? null,
      };
    case "set-my-image":
      return { ...state, myImage: action.myImage };
    case "set-stylize":
      return { ...state, stylizeWithAi: action.stylizeWithAi };
    case "set-text-options":
      return { ...state, textOptions: action.textOptions };
    case "set-aspect-ratio":
      return { ...state, aspectRatio: action.aspectRatio };
    case "hydrate-from-pending": {
      const p = action.pending;
      const next: BuilderInternalState = { ...state };
      if (p.name !== undefined) next.name = p.name;
      if (p.pronouns !== undefined) next.pronouns = p.pronouns;
      if (p.aspectRatio) next.aspectRatio = p.aspectRatio;
      if (p.textOptions) next.textOptions = p.textOptions;
      if (p.source) {
        if (p.source.kind === "stock") {
          next.stockImageId = p.source.stockImageId;
          next.stockImageUrl = null;
          next.myImage = null;
        } else {
          next.myImage = p.source.image;
          next.stylizeWithAi = p.source.stylizeWithAi;
          next.stockImageId = null;
        }
      }
      return next;
    }
  }
}

export function useBuilderState(args: BuilderInitArgs): {
  state: BuilderInternalState;
  dispatch: React.Dispatch<BuilderAction>;
} {
  const [state, dispatch] = useReducer(reducer, args, buildInitialState);
  return { state, dispatch };
}

/** Snapshot the in-progress state into a sessionStorage-shaped record. */
export function snapshotPendingState(args: {
  factId: string;
  mode: Mode;
  entryFlow: PendingBuilderState["entryFlow"];
  state: BuilderInternalState;
}): PendingBuilderState {
  const { factId, mode, entryFlow, state } = args;
  let source: PendingBuilderState["source"];
  if (mode === "stock" && state.stockImageId) {
    source = { kind: "stock", stockImageId: state.stockImageId };
  } else if (mode === "self-upload" && state.myImage) {
    source = { kind: "self-upload", image: state.myImage, stylizeWithAi: state.stylizeWithAi };
  }
  return {
    schemaVersion: 1,
    capturedAt: Date.now(),
    factId,
    mode,
    entryFlow,
    name: state.name || undefined,
    pronouns: state.pronouns || undefined,
    source,
    textOptions: state.textOptions,
    aspectRatio: state.aspectRatio,
  };
}
