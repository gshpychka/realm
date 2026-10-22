import type { ReactNode } from "react";
import { safeHref } from "../link.ts";

export interface LinkProps {
  /** Where a click opens; a target `safeHref` refuses leaves the text drawn plainly. */
  href: string;
  children: ReactNode;
  fg?: string;
  bg?: string;
}

/**
 * Text that opens `href` when clicked, as an OSC 8 hyperlink, for use inside a `<text>`.
 * For targets pituitary itself decides to draw; text from pi and extensions stays scrubbed.
 */
export function Link({ href, children, fg, bg }: LinkProps) {
  const target = safeHref(href);
  return target ? (
    <a href={target} fg={fg} bg={bg}>
      {children}
    </a>
  ) : (
    <span fg={fg} bg={bg}>
      {children}
    </span>
  );
}
