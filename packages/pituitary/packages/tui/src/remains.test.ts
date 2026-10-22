import { describe, expect, test } from "bun:test";
import { leave, remains } from "./remains.ts";

describe("remains", () => {
  test("default to coals cooling to ash over a minute, some smoke and sparks, and a fading warmth", () => {
    expect(remains({})).toEqual({
      coals: "ash",
      cooling: 60_000,
      smoke: 0.4,
      sparks: 0.6,
      warmth: "fading",
      pilot: false,
      ash: false,
    });
  });

  test("reads each setting", () => {
    expect(
      remains({
        PITUITARY_FIRE_COALS: "wink",
        PITUITARY_FIRE_COOLING: "8",
        PITUITARY_FIRE_SMOKE: "1",
        PITUITARY_FIRE_SPARKS: "1.6",
        PITUITARY_FIRE_WARMTH: "lasting",
        PITUITARY_FIRE_PILOT: "on",
        PITUITARY_FIRE_ASH: "on",
      }),
    ).toEqual({
      coals: "wink",
      cooling: 8000,
      smoke: 1,
      sparks: 1.6,
      warmth: "lasting",
      pilot: true,
      ash: true,
    });
  });

  test("an unknown value falls back to its default, and an amount out of range is held to it", () => {
    expect(
      remains({
        PITUITARY_FIRE_COALS: "embers",
        PITUITARY_FIRE_COOLING: "soon",
        PITUITARY_FIRE_SMOKE: "",
        PITUITARY_FIRE_WARMTH: "hot",
        PITUITARY_FIRE_PILOT: "yes",
      }),
    ).toEqual(remains({}));
    expect(remains({ PITUITARY_FIRE_SMOKE: "3", PITUITARY_FIRE_SPARKS: "-1" })).toMatchObject({
      smoke: 1,
      sparks: 0,
    });
  });

  test("leave nothing where every setting is off", () => {
    const bare = leave(
      remains({
        PITUITARY_FIRE_COALS: "none",
        PITUITARY_FIRE_SMOKE: "0",
        PITUITARY_FIRE_SPARKS: "0",
        PITUITARY_FIRE_WARMTH: "none",
      }),
      4,
      0,
      false,
    );
    expect(bare).toMatchObject({ coals: [], smoke: null, thrown: [], pilot: null });
  });

  test("throw sparks by the corner's width", () => {
    expect(leave(remains({ PITUITARY_FIRE_SPARKS: "1" }), 4, 0, false).thrown).toHaveLength(4);
    expect(leave(remains({ PITUITARY_FIRE_SPARKS: "0.1" }), 4, 0, false).thrown).toHaveLength(1);
  });
});
