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
  MyImageSource,
} from "../types";

export interface BuilderInternalState {
  name: string;
  pronouns: string;
  /** Selected self-upload source. */
  myImage: MyImageSource | null;
  textOptions: MemeTextOptions;
  aspectRatio: AspectRatio;
}

export type BuilderAction =
  | { type: "set-name"; name: string }
  | { type: "set-pronouns"; pronouns: string }
  | { type: "set-my-image"; myImage: MyImageSource | null }
  | { type: "set-text-options"; textOptions: MemeTextOptions }
  | { type: "set-aspect-ratio"; aspectRatio: AspectRatio };

export interface BuilderInitArgs {
  initialName?: string;
  initialPronouns?: string;
}

export function buildInitialState(args: BuilderInitArgs): BuilderInternalState {
  const base: BuilderInternalState = {
    name: args.initialName ?? "",
    pronouns: args.initialPronouns ?? "they/them",
    myImage: null,
    textOptions: {},
    aspectRatio: "landscape",
  };

  return base;
}

export function reducer(state: BuilderInternalState, action: BuilderAction): BuilderInternalState {
  switch (action.type) {
    case "set-name":
      return { ...state, name: action.name };
    case "set-pronouns":
      return { ...state, pronouns: action.pronouns };
    case "set-my-image":
      return { ...state, myImage: action.myImage };
    case "set-text-options":
      return { ...state, textOptions: action.textOptions };
    case "set-aspect-ratio":
      return { ...state, aspectRatio: action.aspectRatio };
  }
}

export function useBuilderState(args: BuilderInitArgs): {
  state: BuilderInternalState;
  dispatch: React.Dispatch<BuilderAction>;
} {
  const [state, dispatch] = useReducer(reducer, args, buildInitialState);
  return { state, dispatch };
}
