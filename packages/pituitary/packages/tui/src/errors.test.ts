import { describe, expect, test } from "bun:test";
import { explain } from "./errors.ts";

describe("any other error", () => {
  test("a body that carries no message is left as it is", () => {
    expect(explain('error {"retry": true}').text).toBe('error {"retry": true}');
  });

  test("diagnostics after a sentence are dropped", () => {
    expect(
      explain("Token exchange request failed. url=https://example.com/token; details=Error: boom").text,
    ).toBe("Token exchange request failed.");
  });
});
