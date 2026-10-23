import { expect, test } from "bun:test";
import { scrub } from "./protocol.ts";

test("scrubbing keeps an own __proto__ key without changing the record's prototype", () => {
  const input = JSON.parse(
    '{"__proto__":{"polluted":true,"text":"safe\\u001b[2J"},"nested":{"__proto__":"value"}}',
  );
  const result = scrub(input);
  expect(Object.hasOwn(result, "__proto__")).toBe(true);
  expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
  expect(result.polluted).toBeUndefined();
  expect(Object.getOwnPropertyDescriptor(result, "__proto__")?.value.text).toBe("safe");
  expect(Object.hasOwn(result.nested, "__proto__")).toBe(true);
});
