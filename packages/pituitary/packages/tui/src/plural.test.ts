import { expect, test } from "bun:test";
import { counted } from "./plural.ts";

test("a count of one takes the noun as it is, and any other count its plural", () => {
  expect(counted(1, "tool")).toBe("1 tool");
  expect(counted(3, "more line")).toBe("3 more lines");
  expect(counted(0, "question")).toBe("0 questions");
});
