import { describe, expect, test } from "bun:test";
import type { Light } from "@pituitary/ember";
import { type Cells, type Firelight, firelight, relight } from "./firelight.ts";

const WIDTH = 60;
const HEIGHT = 12;

/** Colour metadata as the renderer packs it into the high bytes: intent in green's, a slot in red's. */
const RGB = 0x0000;
const INDEXED = 0x0100;

/** A screen of `char` in text `fg` over fill `bg`, each colour's high bytes set to `meta`. */
function screen(char = "a", meta: [number, number, number, number] = [0, RGB, 0, 0]): Cells {
  const cells: Cells = {
    char: new Uint32Array(WIDTH * HEIGHT).fill(char.codePointAt(0) ?? 0x20),
    fg: new Uint16Array(WIDTH * HEIGHT * 4),
    bg: new Uint16Array(WIDTH * HEIGHT * 4),
  };
  for (let cell = 0; cell < WIDTH * HEIGHT; cell++) {
    [0xeb, 0xdb, 0xb2, 0xff].forEach((value, index) => {
      cells.fg[cell * 4 + index] = value | (meta[index] ?? 0);
    });
    [0x28, 0x28, 0x28, 0xff].forEach((value, index) => {
      cells.bg[cell * 4 + index] = value | (meta[index] ?? 0);
    });
  }
  return cells;
}

/** An ember-coloured light in the middle of the bottom row. */
const fire: Light[] = [{ x: 30.5, y: 11.5, colour: [0.7, 0.12, 0.005], power: 0.04 }];

/** Light carried across the room onto everything, so each test sets only what it varies. */
const room = (overrides: Partial<Firelight> = {}): Firelight => ({
  ...firelight({ PITUITARY_FIRELIGHT: "room", PITUITARY_FIRELIGHT_ON: "everything" }),
  ...overrides,
});

const colour = (colours: Uint16Array, x: number, y: number) =>
  Array.from(colours.subarray((y * WIDTH + x) * 4, (y * WIDTH + x) * 4 + 4));

const same = (a: Cells, b: Cells) => ({
  fg: a.fg.every((value, index) => value === b.fg[index]),
  bg: a.bg.every((value, index) => value === b.bg[index]),
  char: a.char.every((value, index) => value === b.char[index]),
});

describe("firelight", () => {
  test("defaults to a close reach, a warm light on text, and a soft haze", () => {
    expect(firelight({})).toEqual({ radius: 1.5, exposure: 28, lit: "text", sheen: 0.05 });
  });

  test("reads each setting, and an unknown value falls back to its default", () => {
    expect(
      firelight({
        PITUITARY_FIRELIGHT: "wide",
        PITUITARY_FIRELIGHT_STRENGTH: "bright",
        PITUITARY_FIRELIGHT_ON: "fills",
        PITUITARY_FIRELIGHT_HAZE: "smoky",
      }),
    ).toEqual({ radius: 6, exposure: 62, lit: "fills", sheen: 0.14 });
    expect(firelight({ PITUITARY_FIRELIGHT: "off" }).radius).toBeNull();
    expect(firelight({ PITUITARY_FIRELIGHT: "toString", PITUITARY_FIRELIGHT_ON: "all" })).toEqual(
      firelight({}),
    );
  });
});

describe("relight", () => {
  test("cells out of reach stay as they were", () => {
    const cells = screen();
    relight(cells, WIDTH, HEIGHT, fire, room({ radius: 1.5 }));
    const untouched = screen();
    // Reach is six radii, nine columns at radius 1.5.
    for (const x of [0, 20, 40, 59]) {
      expect(colour(cells.bg, x, 11)).toEqual(colour(untouched.bg, x, 11));
      expect(colour(cells.fg, x, 11)).toEqual(colour(untouched.fg, x, 11));
    }
    expect(colour(cells.bg, 30, 0)).toEqual(colour(untouched.bg, 30, 0));
  });

  test("a cell beside a light turns warmer, red rising most", () => {
    const cells = screen();
    relight(cells, WIDTH, HEIGHT, fire, room());
    const [r, g, b] = colour(cells.bg, 29, 11);
    expect(r).toBeGreaterThan(0x28);
    expect((r ?? 0) - 0x28).toBeGreaterThan((g ?? 0) - 0x28);
    expect((g ?? 0) - 0x28).toBeGreaterThanOrEqual((b ?? 0) - 0x28);
    const [fr] = colour(cells.fg, 29, 11);
    expect(fr).toBeGreaterThan(0xeb);
  });

  test("the light fades with distance", () => {
    const cells = screen();
    relight(cells, WIDTH, HEIGHT, fire, room());
    const red = (x: number) => colour(cells.bg, x, 11)[0] ?? 0;
    expect(red(29)).toBeGreaterThan(red(26));
    expect(red(26)).toBeGreaterThan(red(20));
  });

  test("a lit colour keeps its metadata bytes", () => {
    const meta: [number, number, number, number] = [0x0700, RGB, 0x0300, 0x0100];
    const cells = screen("a", meta);
    relight(cells, WIDTH, HEIGHT, fire, room());
    const bg = colour(cells.bg, 29, 11);
    expect(bg.map((value) => value & 0xff00)).toEqual(meta);
    expect((bg[0] ?? 0) & 0xff).toBeGreaterThan(0x28);
  });

  test("an indexed or default colour stays as it was", () => {
    for (const intent of [INDEXED, 0x0200]) {
      const cells = screen("a", [0, intent, 0, 0]);
      relight(cells, WIDTH, HEIGHT, fire, room());
      expect(same(cells, screen("a", [0, intent, 0, 0]))).toEqual({ fg: true, bg: true, char: true });
    }
  });

  test("a fully transparent colour stays as it was", () => {
    const cells = screen();
    const at = (11 * WIDTH + 29) * 4;
    cells.bg[at + 3] = 0;
    relight(cells, WIDTH, HEIGHT, fire, room());
    expect(colour(cells.bg, 29, 11)).toEqual([0x28, 0x28, 0x28, 0]);
    expect(colour(cells.bg, 28, 11)[0]).toBeGreaterThan(0x28);
  });

  test("fills lights the fill alone", () => {
    const cells = screen();
    relight(cells, WIDTH, HEIGHT, fire, room({ lit: "fills" }));
    expect(same(cells, screen())).toEqual({ fg: true, bg: false, char: true });
  });

  test("text lights the text alone, and never a space", () => {
    const cells = screen();
    relight(cells, WIDTH, HEIGHT, fire, room({ lit: "text" }));
    expect(same(cells, screen())).toEqual({ fg: false, bg: true, char: true });
    const blank = screen(" ");
    relight(blank, WIDTH, HEIGHT, fire, room({ lit: "text" }));
    expect(same(blank, screen(" "))).toEqual({ fg: true, bg: true, char: true });
  });

  test("everything lights text and fill, and a space's fill alone", () => {
    const blank = screen(" ");
    relight(blank, WIDTH, HEIGHT, fire, room());
    expect(same(blank, screen(" "))).toEqual({ fg: true, bg: false, char: true });
  });

  test("off lights nothing", () => {
    const cells = screen();
    relight(cells, WIDTH, HEIGHT, fire, firelight({ PITUITARY_FIRELIGHT: "off" }));
    expect(same(cells, screen())).toEqual({ fg: true, bg: true, char: true });
  });

  test("light shows the light arriving as the fill, and nothing of the cell's own colour", () => {
    const cells = screen("a", [0, INDEXED, 0, 0]);
    relight(cells, WIDTH, HEIGHT, fire, room({ lit: "light" }));
    const beside = colour(cells.bg, 29, 11);
    expect(beside[3]).toBe(0xff);
    expect(beside[0]).toBeGreaterThan(beside[1] ?? 0);
    expect(beside[1]).toBeGreaterThanOrEqual(beside[2] ?? 0);
    const on = screen("a", [0, INDEXED, 0, 0]);
    const other = screen("a", [0, RGB, 0, 0]);
    for (const cell of [on, other]) cell.bg.fill(0x10);
    relight(on, WIDTH, HEIGHT, fire, room({ lit: "light" }));
    relight(other, WIDTH, HEIGHT, fire, room({ lit: "light" }));
    expect(colour(on.bg, 29, 11)).toEqual(colour(other.bg, 29, 11));
    expect(colour(on.bg, 29, 11)).toEqual(beside);
    expect(same(cells, screen("a", [0, INDEXED, 0, 0])).fg).toBe(true);
    expect(colour(cells.bg, 0, 0)).toEqual(colour(screen("a", [0, INDEXED, 0, 0]).bg, 0, 0));
  });
});
