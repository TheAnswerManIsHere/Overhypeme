/**
 * The caption font a builder's text options name, as a catalogue id
 * (names-and-fonts plan). A save or download always sends the id explicitly,
 * so a new meme never depends on the server's default for an omitted font,
 * which stored recipes still rely on.
 *
 * @purpose Resolves the builders' text options to a caption font id and stamps that id on every save and download request.
 * @subsystem meme-studio
 */
import { captionFontIdFromStored, type CaptionFontId } from "@workspace/api-zod";
import type { MemeTextOptions } from "./types";

export function captionFontOf(options: MemeTextOptions | undefined): CaptionFontId {
  return captionFontIdFromStored(options?.fontFamily);
}

export function withCaptionFont(options: MemeTextOptions | undefined): MemeTextOptions {
  return { ...options, fontFamily: captionFontOf(options) };
}
