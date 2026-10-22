import { describe, expect, test } from "bun:test";
import { safeHref } from "./link.ts";

describe("safeHref", () => {
  test("keeps https, http, and file targets", () => {
    expect(safeHref("https://github.com/o/r/pull/12")).toBe("https://github.com/o/r/pull/12");
    expect(safeHref("http://localhost:3000/x")).toBe("http://localhost:3000/x");
    expect(safeHref("file:///home/me/notes.md")).toBe("file:///home/me/notes.md");
  });

  test("refuses any other scheme", () => {
    for (const raw of [
      "javascript:alert(1)",
      "data:text/html,x",
      "ssh://host",
      "vscode://file/x",
      "mailto:a@b",
    ]) {
      expect(safeHref(raw)).toBeNull();
    }
  });

  test("refuses a target carrying ESC, BEL, or any other control character", () => {
    expect(safeHref("https://a.example/\x1b]8;;https://evil.example\x1b\\")).toBeNull();
    expect(safeHref("https://a.example/\x07")).toBeNull();
    expect(safeHref("https://a.example/\u009c")).toBeNull();
    expect(safeHref("https://a.example/\n")).toBeNull();
    expect(safeHref("https://a.example/\x7f")).toBeNull();
  });

  test("refuses what does not parse, and a target too long to send", () => {
    expect(safeHref("not a url")).toBeNull();
    expect(safeHref("")).toBeNull();
    expect(safeHref(`https://a.example/${"x".repeat(3000)}`)).toBeNull();
  });

  test("percent-encodes what the parser lets through, so the target is plain ASCII", () => {
    expect(safeHref("https://a.example/a b")).toBe("https://a.example/a%20b");
    expect(safeHref("https://a.example/ü")).toBe("https://a.example/%C3%BC");
  });
});
