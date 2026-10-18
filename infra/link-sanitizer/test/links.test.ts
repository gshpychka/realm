import { describe, expect, it } from "bun:test";
import { extractUrls, stripTracking } from "../src/links.ts";

describe("extractUrls", () => {
  it("slices by Telegram's UTF-16 offsets", () => {
    const text = "👋 http://example.com";
    expect(extractUrls(text, [{ type: "url", offset: 3, length: 18 }])).toEqual([
      "http://example.com",
    ]);
  });
});

describe("stripTracking", () => {
  it("leaves a link without tracking unanswered, with or without a scheme", () => {
    expect(stripTracking("http://example.com/?foo=1")).toBeUndefined();
    expect(stripTracking("example.com/page")).toBeUndefined();
  });

  it("cleans a link without a scheme", () => {
    expect(stripTracking("example.com/page?fbclid=abc")).toBe("https://example.com/page");
  });

  it("unwraps a redirect and cleans its target", () => {
    expect(
      stripTracking("https://www.google.com/url?q=https://example.com/page%3Futm_source%3Dx&sa=D"),
    ).toBe("https://example.com/page");
  });
});
