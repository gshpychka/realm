import { type RenderContext, type TextOptions, TextRenderable } from "@opentui/core";

/**
 * `<text>` that a mouse selection takes only when it sets `selectable`. Prompts, replies,
 * thinking, and tool calls set it; the screen around them is not there to be copied.
 */
export class OptInText extends TextRenderable {
  constructor(ctx: RenderContext, options: TextOptions) {
    super(ctx, { ...options, selectable: options.selectable ?? false });
  }
}
