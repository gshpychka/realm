import { describe, expect, test } from "bun:test";
import { explain } from "./errors.ts";

describe("any other error", () => {
  test("short words pass through untouched", () => {
    expect(explain("400 invalid_request_error: prompt is too long")).toEqual({
      text: "400 invalid_request_error: prompt is too long",
    });
    expect(explain("529 overloaded_error")).toEqual({ text: "529 overloaded_error" });
  });

  test("a stack trace is dropped, and the error's class with it", () => {
    const thrown =
      "TypeError: Cannot read properties of undefined (reading 'x')\n    at run (/ext/index.ts:4:9)";
    expect(explain(thrown)).toEqual({
      text: "Cannot read properties of undefined (reading 'x')",
      original: thrown,
    });
  });

  test("a response body reads as its message", () => {
    expect(
      explain(
        '400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 210000 tokens > 200000 maximum"}}',
      ).text,
    ).toBe("400 prompt is too long: 210000 tokens > 200000 maximum");
  });

  test("a body that carries no message is left as it is", () => {
    expect(explain('error {"retry": true}').text).toBe('error {"retry": true}');
  });

  test("diagnostics after a sentence are dropped", () => {
    expect(
      explain("Token exchange request failed. url=https://example.com/token; details=Error: boom").text,
    ).toBe("Token exchange request failed.");
  });

  test("a long line is cut at a word, and only the first line shows", () => {
    const long = `${"word ".repeat(60)}\nsecond line`;
    const { text, original } = explain(long);
    expect(text.length).toBeLessThanOrEqual(160);
    expect(text.endsWith("word…")).toBe(true);
    expect(original).toBe(long);
  });
});
