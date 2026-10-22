import { expect, test } from "bun:test";
import { canonical, WorkerRecordDecoder } from "./protocol.ts";

test("record limits include trailing fragments after complete records", () => {
  const decoder = new WorkerRecordDecoder(8);
  expect(decoder.push(Buffer.from("ok\n123456"))).toEqual(["ok"]);
  expect(() => decoder.push(Buffer.from("789"))).toThrow("exceeds");
});

test("record limits apply independently to coalesced records and fragmented UTF-8", () => {
  const decoder = new WorkerRecordDecoder(8);
  expect(decoder.push(Buffer.from("12345678\n12345678\n"))).toEqual(["12345678", "12345678"]);
  const bytes = Buffer.from("🧠\n");
  expect(decoder.push(bytes.subarray(0, 2))).toEqual([]);
  expect(decoder.push(bytes.subarray(2))).toEqual(["🧠"]);
});

test("canonical command identity ignores property order but preserves values", () => {
  expect(canonical({ type: "prompt", message: "hello", extra: undefined })).toBe(
    canonical({ message: "hello", type: "prompt" }),
  );
  expect(canonical({ message: "hello" })).not.toBe(canonical({ message: "world" }));
});
