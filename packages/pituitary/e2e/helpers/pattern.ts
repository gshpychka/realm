type Values = readonly (string | number | RegExp)[];

/** `value` as pattern source: a pattern as it is, anything else matching only itself. */
function sourceOf(value: string | number | RegExp): string {
  return value instanceof RegExp ? value.source : String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A template tag that builds a pattern with `flags`. */
const tag =
  (flags: string) =>
  (strings: TemplateStringsArray, ...values: Values): RegExp => {
    const source = strings.raw.reduce((all, part, index) => {
      const value = values[index - 1];
      return `${all}${value === undefined ? "" : sourceOf(value)}${part}`;
    });
    // Interpolated values arrive escaped by `sourceOf`; the rest is the test's own literal source.
    // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
    return new RegExp(source, flags);
  };

/**
 * A pattern written as a template. The literal text is pattern source, as in a regex literal;
 * an interpolated string or number matches only itself, and an interpolated pattern matches
 * as one. `re.m` and `re.s` add the multiline and dot-all flags.
 *
 * @example re`${glyphs.tool} \d+ tools`
 * @example re.m`^ ${glyphs.steering} draft$`
 */
export const re = Object.assign(tag(""), { m: tag("m"), s: tag("s") });
