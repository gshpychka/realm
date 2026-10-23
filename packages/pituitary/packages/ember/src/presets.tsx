import { Fire, type FireProps } from "./fire.tsx";
import { flame } from "./fuel.ts";

type Tuning = Omit<FireProps, "width" | "height">;

/** A tile's size as columns × rows. */
export type TileSize = "2x2" | "2x3" | "3x2" | "3x3";

export const TILE_SIZES: readonly TileSize[] = ["2x2", "2x3", "3x2", "3x3"];

/** A small fire of fixed size, burning to a point: an icon or a status mark. */
export function FireTile({ size, ...tuning }: { size: TileSize } & Tuning) {
  const [cols, rows] = size.split("x").map(Number) as [number, number];
  return (
    <Fire
      mapping="quadrant"
      fuel={flame}
      reach={1.25}
      point={1.6}
      turbulence={0.45}
      {...tuning}
      width={cols}
      height={rows}
    />
  );
}

/** A band of fire `rows` tall along the width of its parent, rising from its floor. */
export function FireRow({ rows, ...tuning }: { rows: 1 | 2 } & Tuning) {
  return <Fire mapping={rows === 1 ? "eighths" : "half"} {...tuning} width="100%" height={rows} />;
}

/** A strip of fire `cols` wide down the height of its parent, hot at the foot and out towards the top. */
export function FireColumn({ cols, ...tuning }: { cols: 1 | 2 } & Tuning) {
  return <Fire mapping="half" reach={1.2} turbulence={0.35} {...tuning} width={cols} height="100%" />;
}
