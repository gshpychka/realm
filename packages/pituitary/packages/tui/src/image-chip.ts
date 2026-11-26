import { glyphs } from "./glyphs.ts";

/**
 * How an image shows among a message's words: a pill with rounded ends around a label, which the
 * image's number follows. Its colours are `theme.image` on `theme.imageTint`.
 */
export const IMAGE_CHIP = { start: glyphs.chipStart, stop: glyphs.chipEnd, label: `${glyphs.image} image ` };
