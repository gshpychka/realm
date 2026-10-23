import { describe, expect, it } from "@effect/vitest";
import { modelStyles } from "./palette";

// More models than the palette has colours.
const runs = Array.from({ length: 20 }, (_, index) => ({ model: `model-${index}` }));

describe("modelStyles", () => {
  it("gives each model a distinct colour before reusing one with a dash", () => {
    const styles = [...modelStyles(runs).values()];
    const solid = styles.filter((style) => style.dash === "none");
    expect(new Set(solid.map((style) => style.color)).size).toBe(solid.length);
    expect(styles[solid.length]).toEqual({ color: styles[0]?.color, dash: "8 4" });
  });

  it("keeps existing styles when models repeat or new models append", () => {
    const initial = modelStyles(runs.slice(0, 3));
    const appended = modelStyles([...runs.slice(0, 3), { model: "model-1" }, ...runs.slice(3)]);
    for (const [model, style] of initial) expect(appended.get(model)).toEqual(style);
    expect([...appended.keys()]).toEqual(runs.map((run) => run.model));
  });
});
