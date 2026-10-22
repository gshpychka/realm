/** Schemes a drawn link may open. */
const SCHEMES = new Set(["https:", "http:", "file:"]);

/** Longest target drawn as a link; terminals cap OSC 8 URIs at a few thousand bytes. */
const MAX_HREF = 2048;

/** C0, DEL, and C1: any of them inside the target could end the OSC 8 sequence early. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this refuses
const CONTROL = /[\x00-\x1f\x7f-\x9f]/;

/**
 * `raw` as a target safe to put in an OSC 8 hyperlink, or null when it is not one: a
 * scheme outside https, http, and file, a control character, or a target too long to send.
 */
export function safeHref(raw: string): string | null {
  if (CONTROL.test(raw)) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (!SCHEMES.has(url.protocol)) return null;
  // Serialising percent-encodes whatever the parser let through, so the target is plain ASCII.
  const href = url.href;
  return href.length <= MAX_HREF && !CONTROL.test(href) ? href : null;
}
