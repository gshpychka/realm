import { SyntaxStyle } from "@opentui/core";
import { palette, theme } from "../theme.ts";

/** Markdown and code highlighting in gruvbox, by the scopes OpenTUI and tree-sitter name. */
export const syntax = SyntaxStyle.fromStyles({
  default: { fg: palette.text },
  // Headings are scoped by level, and a level has no fallback to the bare scope.
  "markup.heading": { fg: palette.yellow, bold: true },
  "markup.heading.1": { fg: palette.yellow, bold: true },
  "markup.heading.2": { fg: palette.yellow, bold: true },
  "markup.heading.3": { fg: palette.yellow, bold: true },
  "markup.heading.4": { fg: palette.yellow },
  "markup.heading.5": { fg: palette.yellow },
  "markup.heading.6": { fg: palette.yellow },
  "markup.list.checked": { fg: palette.green },
  "markup.list.unchecked": { fg: palette.orange },
  "punctuation.special": { fg: palette.faint },
  "markup.strong": { bold: true },
  "markup.italic": { italic: true },
  "markup.strikethrough": { dim: true },
  "markup.raw": { fg: palette.aqua },
  "markup.raw.block": { fg: palette.text },
  "markup.link": { fg: palette.blue, underline: true },
  "markup.link.label": { fg: palette.blue },
  "markup.link.url": { fg: palette.blue, underline: true },
  "markup.quote": { fg: palette.muted, italic: true },
  "markup.list": { fg: palette.orange },
  keyword: { fg: palette.red },
  "keyword.function": { fg: palette.red },
  "keyword.return": { fg: palette.red },
  string: { fg: palette.green },
  comment: { fg: palette.faint, italic: true },
  function: { fg: palette.aqua },
  "function.call": { fg: palette.aqua },
  "function.method": { fg: palette.aqua },
  type: { fg: palette.yellow },
  number: { fg: palette.purple },
  boolean: { fg: palette.purple },
  constant: { fg: palette.purple },
  "constant.builtin": { fg: palette.purple },
  property: { fg: palette.blue },
  operator: { fg: palette.orange },
  punctuation: { fg: palette.muted },
  variable: { fg: palette.text },
});

export interface MarkdownProps {
  content: string;
  /** True while the text is still streaming in, so a half-built block is drawn as it is. */
  streaming?: boolean;
  fg?: string;
}

export function Markdown({ content, streaming = false, fg = theme.assistant }: MarkdownProps) {
  return <markdown content={content} syntaxStyle={syntax} streaming={streaming} conceal fg={fg} />;
}
