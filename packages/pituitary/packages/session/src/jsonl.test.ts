import { describe, expect, test } from "bun:test";
import { JsonLineDecoder } from "./jsonl.ts";

describe("JsonLineDecoder", () => {
  test("splits on LF and holds the partial record", () => {
    const decoder = new JsonLineDecoder();
    expect(decoder.push('{"a":1}\n{"b":')).toEqual(['{"a":1}']);
    expect(decoder.push("2}\n")).toEqual(['{"b":2}']);
  });

  test("keeps U+2028 and U+2029 inside string values", () => {
    const decoder = new JsonLineDecoder();
    const record = JSON.stringify({ text: "a b c" });
    expect(decoder.push(`${record}\n`)).toEqual([record]);
  });

  test("strips a trailing CR", () => {
    const decoder = new JsonLineDecoder();
    expect(decoder.push('{"a":1}\r\n')).toEqual(['{"a":1}']);
  });

  test("decodes multi-byte characters split across chunks", () => {
    const decoder = new JsonLineDecoder();
    const bytes = new TextEncoder().encode('{"t":"é"}\n');
    expect(decoder.push(bytes.slice(0, 7))).toEqual([]);
    expect(decoder.push(bytes.slice(7))).toEqual(['{"t":"é"}']);
  });

  test("flush yields a record left without a newline", () => {
    const decoder = new JsonLineDecoder();
    decoder.push('{"a":1}');
    expect(decoder.flush()).toEqual(['{"a":1}']);
    expect(decoder.flush()).toEqual([]);
  });
});

describe("JsonLineDecoder at scale", () => {
  test("a record arriving in many chunks decodes in time linear in its size", () => {
    const time = (bytes: number) => {
      const decoder = new JsonLineDecoder();
      const piece = "x".repeat(64 * 1024);
      const started = performance.now();
      for (let sent = 0; sent < bytes; sent += piece.length) decoder.push(piece);
      decoder.push("\n");
      return performance.now() - started;
    };
    const small = time(4 * 1024 * 1024);
    const large = time(32 * 1024 * 1024);
    expect(large / Math.max(small, 1)).toBeLessThan(20);
  });
});
