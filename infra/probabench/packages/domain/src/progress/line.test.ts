import { describe, expect, it } from "@effect/vitest";
import { Probability } from "../plan/sampling";
import { formatPointProgress, parsePointProgress } from "./line";

describe("point progress lines", () => {
  it.each(["vendor/model", "vendor/model [reasoning=low]"])(
    "parses back what the runner prints for %s",
    (model) => {
      const point = { x: Probability.make(0.2), outcomes: [1, 0, { invalidText: "?" }] as const };
      const line = formatPointProgress({ model, point, completed: 3, total: 11 });
      expect(parsePointProgress(line)).toEqual({ completed: 3, total: 11 });
    },
  );

  it.each(["[vendor/model] starting sweep", "[vendor/model] point 99/5 x=25%", "retrying…"])(
    "ignores %s",
    (line) => {
      expect(parsePointProgress(line)).toBeNull();
    },
  );
});
