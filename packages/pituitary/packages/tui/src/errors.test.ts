import { describe, expect, test } from "bun:test";
import { explain } from "./errors.ts";

const PI_COMMANDS = new Set(["compact", "login"]);

describe("what deals with an error", () => {
  test("a full context offers /compact, where the operator can run it", () => {
    expect(explain("400 invalid_request_error: prompt is too long", PI_COMMANDS)).toEqual({
      text: "400 invalid_request_error: prompt is too long",
      remedy: "/compact frees context",
    });
    expect(explain("400 invalid_request_error: prompt is too long")).toEqual({
      text: "400 invalid_request_error: prompt is too long",
    });
  });

  test("a refused credential offers /login only where /login exists", () => {
    expect(explain('401 {"error":{"message":"invalid x-api-key"}}', PI_COMMANDS).remedy).toBe(
      "/login signs in again",
    );
    expect(explain("OAuth token has expired", new Set(["compact"])).remedy).toBeUndefined();
  });

  test("an overloaded or rate-limited provider asks for patience", () => {
    expect(explain("529 overloaded_error")).toEqual({
      text: "529 overloaded_error",
      remedy: "wait a moment, then send again",
    });
    expect(explain("429 Too Many Requests").remedy).toBe("wait a moment, then send again");
  });

  test("an error's own `Use /…` sentence stays in the brief, and the detail adds only what it leaves out", () => {
    const thrown = [
      "No API key found for the selected model.",
      "",
      "Use /login to log into a provider via OAuth or API key. See:",
      "  /docs/providers.md",
      "  /docs/models.md",
    ].join("\n");
    expect(explain(thrown, PI_COMMANDS)).toEqual({
      text: "No API key found for the selected model. Use /login to log into a provider via OAuth or API key.",
      detail: "See:\n  /docs/providers.md\n  /docs/models.md",
    });
  });
});

describe("any other error", () => {
  test("short words pass through untouched", () => {
    expect(explain("Tool failed: exit 1")).toEqual({ text: "Tool failed: exit 1" });
  });

  test("a stack trace is dropped from the brief, and the detail shows only the stack", () => {
    const thrown =
      "TypeError: Cannot read properties of undefined (reading 'x')\n    at run (/ext/index.ts:4:9)";
    expect(explain(thrown)).toEqual({
      text: "Cannot read properties of undefined (reading 'x')",
      detail: "at run (/ext/index.ts:4:9)",
    });
  });

  test("a response body reads as its message, and the body is kept as the detail", () => {
    const body =
      '400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 210000 tokens > 200000 maximum"}}';
    expect(explain(body)).toEqual({
      text: "400 prompt is too long: 210000 tokens > 200000 maximum",
      detail: body,
    });
  });

  test("a body that carries no message is left as it is", () => {
    expect(explain('error {"retry": true}').text).toBe('error {"retry": true}');
  });

  test("diagnostics after a sentence are dropped", () => {
    expect(
      explain("Token exchange request failed. url=https://example.com/token; details=Error: boom").text,
    ).toBe("Token exchange request failed.");
  });

  test("a long line is cut at a word, and the detail keeps it whole", () => {
    const long = `${"word ".repeat(60)}\nsecond line`;
    const { text, detail } = explain(long);
    expect(text.length).toBeLessThanOrEqual(160);
    expect(text.endsWith("word…")).toBe(true);
    expect(detail).toBe(`${"word ".repeat(60).trimEnd()}\nsecond line`);
  });
});
