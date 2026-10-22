import { describe, expect, test } from "bun:test";
import { toNvim } from "./keys.ts";

describe("toNvim", () => {
  test("text keys pass through, with < spelled out", () => {
    expect(toNvim({ name: "a", sequence: "a" })).toBe("a");
    expect(toNvim({ name: "a", sequence: "A", shift: true })).toBe("A");
    expect(toNvim({ name: '"', sequence: '"' })).toBe('"');
    expect(toNvim({ name: "<", sequence: "<" })).toBe("<lt>");
    expect(toNvim({ name: "space", sequence: " " })).toBe(" ");
    expect(toNvim({ name: "ö", sequence: "ö" })).toBe("ö");
  });

  test("named keys and modifiers use nvim's notation", () => {
    expect(toNvim({ name: "escape", sequence: "\x1b" })).toBe("<Esc>");
    expect(toNvim({ name: "backspace", sequence: "\x7f" })).toBe("<BS>");
    expect(toNvim({ name: "return", sequence: "\r", shift: true })).toBe("<S-CR>");
    expect(toNvim({ name: "tab", sequence: "\x1b[Z", shift: true })).toBe("<S-Tab>");
    expect(toNvim({ name: "w", sequence: "\x17", ctrl: true })).toBe("<C-w>");
    expect(toNvim({ name: "r", sequence: "\x12", ctrl: true })).toBe("<C-r>");
    expect(toNvim({ name: "b", sequence: "\x1bb", meta: true })).toBe("<M-b>");
    expect(toNvim({ name: "linefeed", sequence: "\n" })).toBe("<C-j>");
    expect(toNvim({ name: "f5", sequence: "\x1b[15~" })).toBe("<F5>");
  });

  test("a key with no single character and no name nvim knows is dropped", () => {
    expect(toNvim({ name: "", sequence: "\x1b[200~" })).toBeNull();
  });
});
