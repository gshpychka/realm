import { compileSanitizer } from "@url-sanitize/core";
import { mergedCatalog } from "@url-sanitize/merged";
import type { MessageEntity } from "./telegram.ts";

// Extend the existing catalog, not its parsing/filtering implementation.
// igsh/ig_rid/igshid are already upstream; evidence is in README.md.
const sanitize = compileSanitizer({
  ...mergedCatalog,
  rules: [
    ...mergedCatalog.rules,
    {
      kind: "strip-param",
      source: "custom",
      provider: "instagram",
      urlPattern: "^https?://(?:[a-z0-9-]+\\.)*instagram\\.com(?::[0-9]+)?(?:/|$)",
      paramPattern: "^(?:psln|stkn|click_source)$",
    },
  ],
});

const schemePattern = /^[a-z][a-z\d+.-]*:\/\//i;

// a redirect's target can carry tracking of its own or wrap another redirect
const maxPasses = 4;

/** The links Telegram marked in a message's text. */
export const extractUrls = (text: string, entities: readonly MessageEntity[]): string[] =>
  entities
    .filter((entity) => entity.type === "url")
    .map((entity) => text.slice(entity.offset, entity.offset + entity.length));

const sanitizeFully = (url: string, passes = maxPasses): string => {
  const result = sanitize(url);
  switch (result.kind) {
    case "cleaned":
    case "redirected":
      return passes > 1 ? sanitizeFully(result.url, passes - 1) : result.url;
    case "unchanged":
    case "blocked":
      return url;
  }
};

/** `link` without tracking parameters and redirect wrappers, or undefined when it has neither. */
export const stripTracking = (link: string): string | undefined => {
  // Telegram also marks links without a scheme (example.com/page)
  const url = schemePattern.test(link) ? link : `https://${link}`;
  const cleaned = sanitizeFully(url);
  return cleaned === url ? undefined : cleaned;
};

/** The message's links that carry tracking, cleaned of it. */
export const cleanLinks = (text: string, entities: readonly MessageEntity[]): string[] =>
  extractUrls(text, entities).flatMap((link) => stripTracking(link) ?? []);

/** The reply that lists the cleaned links. */
export const replyText = (links: readonly string[]): string =>
  `${links.length === 1 ? "Ось лінк" : "Ось лінки"} без трекінгу: ${links.join(", ")}`;
