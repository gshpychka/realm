#!/usr/bin/env bun
/**
 * Every fire primitive on one screen, for looking at.
 *
 * EMBER_VIEW picks the screen (tiles, row1, row2, columns); EMBER_STILL holds each
 * fire on its first warmed frame, so a capture is reproducible.
 */
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import type { ReactNode } from "react";
import {
  arch,
  even,
  Fire,
  FireColumn,
  type FireProps,
  FireRow,
  FireTile,
  flame,
  MAPPINGS,
  type Mapping,
  TILE_SIZES,
} from "../src/index.ts";

const still = process.env.EMBER_STILL === "1";
const view = process.env.EMBER_VIEW ?? "tiles";

const INK = "#ebdbb2";
const FAINT = "#7c6f64";
const GROUND = "#1d2021";

const TILE_MAPPINGS: readonly Mapping[] = MAPPINGS.filter((mapping) => mapping !== "taper");
const ROW_MAPPINGS: readonly Mapping[] = MAPPINGS.filter((mapping) => mapping !== "taper");

function Tiles() {
  return (
    <box flexDirection="column" gap={1}>
      <box flexDirection="row">
        <text fg={FAINT} width={6}>
          {" "}
        </text>
        {TILE_MAPPINGS.map((mapping) => (
          <text key={mapping} fg={FAINT} width={10}>
            {mapping}
          </text>
        ))}
      </box>
      {TILE_SIZES.map((size) => (
        <box key={size} flexDirection="row" alignItems="flex-end">
          <text fg={FAINT} width={6}>
            {size}
          </text>
          {TILE_MAPPINGS.map((mapping) => (
            <box key={mapping} width={10}>
              <FireTile size={size} mapping={mapping} still={still} />
            </box>
          ))}
        </box>
      ))}
    </box>
  );
}

function Rows({ rows }: { rows: 1 | 2 }) {
  return (
    <box flexDirection="column">
      {ROW_MAPPINGS.map((mapping) => (
        <box key={mapping} flexDirection="column">
          <text fg={FAINT}>{mapping}</text>
          <FireRow rows={rows} mapping={mapping} still={still} />
        </box>
      ))}
    </box>
  );
}

const TRANSCRIPT = [
  ["you", "cap the retention window at 168h and reject anything higher"],
  ["pi", "limits.ts clamps the lower bound already. Mirroring it on the top."],
  ["", "read   packages/api/limits.ts"],
  ["", "edit   packages/api/limits.ts   +6 -2"],
  ["pi", "Both bounds reject out of range now, and check is green."],
] as const;

function Columns() {
  const strips: { cols: 1 | 2; mapping: Mapping }[] = [
    { cols: 1, mapping: "half" },
    { cols: 1, mapping: "solid" },
    { cols: 1, mapping: "taper" },
    { cols: 2, mapping: "half" },
    { cols: 2, mapping: "quadrant" },
    { cols: 2, mapping: "taper" },
  ];
  return (
    <box flexDirection="row" flexGrow={1} gap={2}>
      {strips.map(({ cols, mapping }) => (
        <box key={`${cols}-${mapping}`} flexDirection="column" width={10}>
          <text fg={FAINT}>
            {cols} {mapping}
          </text>
          <box flexDirection="row" flexGrow={1}>
            <FireColumn cols={cols} mapping={mapping} still={still} />
          </box>
        </box>
      ))}
      <box flexDirection="column" flexGrow={1} gap={1}>
        {TRANSCRIPT.map(([who, line]) => (
          <text key={line} fg={who ? INK : FAINT}>
            {who.padEnd(5)}
            {line}
          </text>
        ))}
      </box>
    </box>
  );
}

/** Small flames that could sit beside a status line, next to a large one to judge the motion by. */
function Flames() {
  const small: { label: string; mapping: Mapping; cols: number; rows: number }[] = [
    { label: "half 4x2", mapping: "half", cols: 4, rows: 2 },
    { label: "quadrant 3x2", mapping: "quadrant", cols: 3, rows: 2 },
    { label: "quadrant 4x2", mapping: "quadrant", cols: 4, rows: 2 },
    { label: "half 6x3", mapping: "half", cols: 6, rows: 3 },
    { label: "quadrant 6x3", mapping: "quadrant", cols: 6, rows: 3 },
  ];
  return (
    <box flexDirection="column" gap={1}>
      <box flexDirection="row" gap={3} alignItems="flex-end">
        {small.map((each) => (
          <box key={each.label} flexDirection="column">
            <Fire
              mapping={each.mapping}
              fuel={flame}
              reach={1.3}
              point={1.5}
              width={each.cols}
              height={each.rows}
              still={still}
            />
            <text fg={FAINT}>{each.label}</text>
          </box>
        ))}
      </box>
      <box flexDirection="row" gap={4} alignItems="flex-end">
        <box flexDirection="column">
          <Fire mapping="quadrant" fuel={arch} reach={0.95} point={1} width={24} height={10} still={still} />
          <text fg={FAINT}>quadrant 24x10</text>
        </box>
        <box flexDirection="column">
          <Fire mapping="half" fuel={arch} reach={0.95} point={1} width={24} height={10} still={still} />
          <text fg={FAINT}>half 24x10</text>
        </box>
      </box>
    </box>
  );
}

/** The same fire under different settings, side by side, for choosing defaults by eye. */
function Tune() {
  const grid: { label: string; props: Partial<FireProps> }[] = [
    { label: "defaults", props: {} },
    { label: "patchy 0.4", props: { patchiness: 0.4 } },
    { label: "patchy 1.2", props: { patchiness: 1.2 } },
    { label: "patchy 1.2 reach 1.2", props: { patchiness: 1.2, reach: 1.2 } },
    { label: "half mapping", props: { mapping: "half" } },
    { label: "even fuel", props: { fuel: even } },
    { label: "lean 0.3", props: { lean: 0.3 } },
    { label: "sparks 6", props: { sparks: 6 } },
  ];
  return (
    <box flexDirection="row" flexWrap="wrap" gap={2}>
      {grid.map((each) => (
        <box key={each.label} flexDirection="column" width={22}>
          <Fire mapping="quadrant" fuel={arch} width={20} height={8} still={still} {...each.props} />
          <text fg={FAINT}>{each.label}</text>
        </box>
      ))}
    </box>
  );
}

/** A 4×1 corner fire under each one-row mapping and heat, smouldering at the same slow pace. */
function Corner() {
  const slow: Partial<FireProps> = { pace: 200, turbulence: 0.3, flicker: 0.3, flickerRate: 0.2, sparks: 0 };
  const rows: { label: string; props: Partial<FireProps> }[] = [
    { label: "quadrant .75", props: { mapping: "quadrant", intensity: 0.75, reach: 0.9 } },
    { label: "quadrant .6", props: { mapping: "quadrant", intensity: 0.6, reach: 0.8 } },
    { label: "half .75", props: { mapping: "half", intensity: 0.75, reach: 0.9 } },
    { label: "half .6", props: { mapping: "half", intensity: 0.6, reach: 0.8 } },
    { label: "solid .6", props: { mapping: "solid", intensity: 0.6, reach: 0.8 } },
    { label: "solid .45", props: { mapping: "solid", intensity: 0.45, reach: 0.8 } },
    { label: "shade .6", props: { mapping: "shade", intensity: 0.6, reach: 0.8 } },
  ];
  return (
    <box flexDirection="column" gap={1}>
      {rows.map(({ label, props }) => (
        <box key={label} flexDirection="row" gap={2}>
          <text fg={FAINT} width={14}>
            {label}
          </text>
          {[1, 7, 3].map((seed) => (
            <Fire
              key={seed}
              fuel={flame}
              width={4}
              height={1}
              still={still}
              {...slow}
              {...props}
              seed={seed}
            />
          ))}
        </box>
      ))}
    </box>
  );
}

const VIEWS: Record<string, () => ReactNode> = {
  corner: Corner,
  tune: Tune,
  flames: Flames,
  tiles: Tiles,
  row1: () => <Rows rows={1} />,
  row2: () => <Rows rows={2} />,
  columns: Columns,
};

const View = VIEWS[view] ?? Tiles;
const renderer = await createCliRenderer({ exitOnCtrlC: true, targetFps: 30 });
createRoot(renderer).render(
  <box flexDirection="column" width="100%" height="100%" backgroundColor={GROUND} padding={1}>
    <text fg={FAINT}>ember · {view}</text>
    <View />
  </box>,
);
