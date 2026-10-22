import type { BoxRenderable, OptimizedBuffer } from "@opentui/core";
import {
  blend,
  evening,
  FIREPLACE,
  flame,
  type Hearth,
  kindle,
  lights,
  type Mapping,
  paint,
  pixels,
  reshape,
  shader,
  stoke,
  type Temper,
  temperAt,
  warm,
} from "@pituitary/ember";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef } from "react";
import { type Firelight, relight } from "../firelight.ts";
import { drawRemnant, leave, type Remains, type Remnant, remnantLights, tend } from "../remains.ts";

/**
 * pituitary's fire, a single mascot: one simulation drawn in one place at a time. Parts of
 * the screen offer it a place with a `MascotSlot`; it burns in the one that matters most
 * and carries the same fire over as it moves and changes shape.
 */

/** Places the fire can burn, in the order it prefers them. */
export type SlotName = "working" | "corner";
const PREFERENCE: readonly SlotName[] = ["working", "corner"];

/** How the fire burns at rest in the corner: through a fireplace's evening, or held at one smoulder. */
export type Burn = "living" | "steady";

/** Beside the working line: lively, climbing to a point. */
const WORKING: Temper = {
  pace: 70,
  options: {
    fuel: flame,
    intensity: 1.05,
    reach: 1.3,
    point: 1.4,
    turbulence: 0.8,
    flicker: 0.4,
    flickerRate: 0.35,
    sparks: 1.5,
  },
};

/** Smouldering in the corner: low heat, so the tips cool into the dark, and slow enough never to pulse. */
const SMOULDER: Temper = {
  pace: 200,
  options: {
    fuel: flame,
    intensity: 0.75,
    reach: 0.9,
    point: 0,
    turbulence: 0.3,
    flicker: 0.3,
    flickerRate: 0.2,
    sparks: 0,
  },
};

/** How each place spends a cell: the corner is a hearth one row tall, its flames rising from the cell floor. */
const MAPPING: Record<SlotName, Mapping> = { working: "quadrant", corner: "eighths" };

/** How long the fire takes to flare up or die down to a new place's temper. */
const EASE_MS = 400;

/** How long the fire takes to travel between places. */
export const GLIDE_MS = 320;

/** Milliseconds between frames while the fire travels or eases. */
const FRAME_MS = 8;

/** Where parts of the screen offer the fire a place, among the `places` it may burn in. */
export class MascotStage {
  private readonly slots = new Map<SlotName, BoxRenderable>();
  private readonly listeners = new Set<() => void>();

  constructor(private readonly places: readonly SlotName[] = PREFERENCE) {}

  /** Whether the fire may burn in `name`, so a part of the screen makes room for it there. */
  takes(name: SlotName): boolean {
    return this.places.includes(name);
  }

  offer(name: SlotName, box: BoxRenderable | null): void {
    if (box) this.slots.set(name, box);
    else this.slots.delete(name);
    for (const listener of this.listeners) listener();
  }

  /** The place the fire burns now, if any is offered. */
  target(): { name: SlotName; box: BoxRenderable } | null {
    for (const name of PREFERENCE) {
      const box = this.offered(name);
      if (box && this.takes(name)) return { name, box };
    }
    return null;
  }

  /** The room offered for the fire at `name`, whether or not it burns there. */
  offered(name: SlotName): BoxRenderable | null {
    const box = this.slots.get(name);
    return box && !box.isDestroyed ? box : null;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

const StageContext = createContext<MascotStage | null>(null);
export const MascotProvider = StageContext.Provider;

/** Whether the fire may burn at `name`, for a part of the screen deciding whether to make room for it. */
export function useMascotTakes(name: SlotName): boolean {
  return useContext(StageContext)?.takes(name) ?? false;
}

/** Room for the fire, `width` × `height` cells, which it takes when this is the place it prefers. */
export function MascotSlot({ name, width, height }: { name: SlotName; width: number; height: number }) {
  const stage = useContext(StageContext);
  const ref = useCallback((box: BoxRenderable | null) => stage?.offer(name, box), [stage, name]);
  return <box ref={ref} width={width} height={height} flexShrink={0} />;
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const lerp = (from: number, to: number, t: number) => from + (to - from) * t;

/** How the fire burns at rest at a moment on the clock it is drawn by. */
type Resting = (now: number) => Temper;

/** The corner's temper as `burn` asks, its evening lit at `lit`; a fire held still keeps to the steady phase. */
function resting(burn: Burn, still: boolean, lit: number): Resting {
  if (burn === "steady") return () => SMOULDER;
  if (still) return () => FIREPLACE.steady;
  const night = evening(FIREPLACE, "steady", Math.random);
  return (now) => temperAt(night, (now - lit) / 1000);
}

/** How the fire burns in `place` at `now` once it has settled there. */
const own = (place: SlotName, rest: Resting, now: number): Temper =>
  place === "working" ? WORKING : rest(now);

/** The temper a fire in `place` burns with at `now`, eased there from `easing.from` since `easing.start`. */
function easedAt(
  easing: { from: Temper; start: number },
  place: SlotName,
  rest: Resting,
  now: number,
): Temper {
  return blend(easing.from, own(place, rest, now), ease(Math.min(1, (now - easing.start) / EASE_MS)));
}

/**
 * The fire itself, drawn over the rest of the screen into whichever slot it burns in.
 * `still` holds it on one warmed frame in its place, with no travel; `burn` is how it burns at rest in the
 * corner, `light` how it lights the screen, and `left` what it leaves in the corner while it is away.
 */
export function Mascot({
  stage,
  still,
  burn,
  light,
  left,
}: {
  stage: MascotStage;
  still: boolean;
  burn: Burn;
  light: Firelight;
  left: Remains;
}) {
  const box = useRef<BoxRenderable | null>(null);
  const shade = useMemo(() => shader(), []);
  const rest = useMemo(() => resting(burn, still, performance.now()), [burn, still]);
  const state = useRef<{
    hearth: Hearth | null;
    place: SlotName | null;
    /** Where the fire was last drawn, which a journey starts from. */
    drawn: Rect | null;
    journey: { from: Rect; start: number } | null;
    /** The temper the fire eases from toward its place's own, and since when. */
    easing: { from: Temper; start: number };
    /** What the fire left in the corner, until it is back there. */
    remnant: Remnant | null;
  }>({
    hearth: null,
    place: null,
    drawn: null,
    journey: null,
    remnant: null,
    easing: { from: SMOULDER, start: Number.NEGATIVE_INFINITY },
  });

  /** Runs the next step at once, for a fire that has just set off or changed temper. */
  const kick = useRef<() => void>(() => {});

  useEffect(() => {
    if (still) return stage.onChange(() => box.current?.requestRender());
    let timer: ReturnType<typeof setTimeout> | undefined;
    let nextStep = 0;
    const loop = () => {
      timer = undefined;
      const held = state.current;
      const target = stage.target();
      if (!target) {
        box.current?.requestRender();
        return;
      }
      const now = performance.now();
      const temper = easedAt(held.easing, held.place ?? target.name, rest, now);
      if (held.hearth && now >= nextStep) {
        held.hearth.options = { ...held.hearth.options, ...temper.options };
        stoke(held.hearth);
        nextStep = now + temper.pace;
      }
      box.current?.requestRender();
      const moving = held.journey !== null || now - held.easing.start < EASE_MS;
      const wait = moving ? FRAME_MS : Math.max(1, nextStep - now);
      timer = setTimeout(loop, wait);
    };
    const wake = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(loop, 0);
    };
    kick.current = wake;
    wake();
    const unsubscribe = stage.onChange(wake);
    return () => {
      unsubscribe();
      kick.current = () => {};
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [stage, still, rest]);

  function draw(this: BoxRenderable, buffer: OptimizedBuffer) {
    const held = state.current;
    const target = stage.target();
    if (!target) {
      held.place = null;
      held.drawn = null;
      held.journey = null;
      held.remnant = null;
      return;
    }
    const now = performance.now();
    const rect: Rect = {
      x: target.box.x,
      y: target.box.y,
      width: target.box.width,
      height: target.box.height,
    };
    if (rect.width <= 0 || rect.height <= 0) return;
    if (target.name !== held.place) {
      const corner = stage.offered("corner");
      if (held.place === "corner" && corner) held.remnant = leave(left, corner.width, now, still);
      held.easing = { from: easedAt(held.easing, held.place ?? target.name, rest, now), start: now };
      // A fire that was drawn somewhere travels from there; one that was nowhere appears in place.
      held.journey = held.drawn && !still ? { from: held.drawn, start: now } : null;
      held.place = target.name;
      kick.current();
    }
    const mapping = MAPPING[target.name];
    const [w, h] = pixels(mapping, rect.width, rect.height);
    if (!held.hearth || still) {
      if (!held.hearth || held.hearth.width !== w || held.hearth.height !== h)
        held.hearth = warm(kindle(w, h, own(target.name, rest, now).options));
    } else if (held.hearth.width !== w || held.hearth.height !== h) {
      held.hearth = reshape(held.hearth, w, h, easedAt(held.easing, target.name, rest, now).options);
    }
    let at: Rect = rect;
    if (held.journey) {
      const t = Math.min(1, (now - held.journey.start) / GLIDE_MS);
      const from = held.journey.from;
      const e = ease(t);
      // Bottoms travel together, so a fire of another height rises from where it stood.
      at = {
        ...rect,
        x: Math.round(lerp(from.x, rect.x, e)),
        y: Math.round(lerp(from.y + from.height - rect.height, rect.y, e)),
      };
      if (t >= 1) held.journey = null;
    }
    held.drawn = at;
    // The fire takes its corner back once it has arrived there.
    if (target.name === "corner" && !held.journey) held.remnant = null;
    const corner = stage.offered("corner");
    const place = corner && held.remnant ? { x: corner.x, y: corner.y, width: corner.width } : null;
    if (held.remnant && place) tend(held.remnant, now);
    // Lit before the remains and the flames draw, so they keep their own colours.
    if (light.radius !== null) {
      const around = lights(held.hearth, mapping, at.width, at.height).map((source) => ({
        ...source,
        x: source.x + at.x,
        y: source.y + at.y,
      }));
      if (held.remnant && place) around.push(...remnantLights(held.remnant, place, now));
      relight(buffer.buffers, buffer.width, buffer.height, around, light);
    }
    if (held.remnant && place) drawRemnant(buffer, held.remnant, place, now);
    const cells = paint(held.hearth, mapping, at.width, at.height);
    for (let row = 0; row < at.height; row++) {
      for (let col = 0; col < at.width; col++) {
        const cell = cells[row * at.width + col];
        if (!cell) continue;
        buffer.setCellWithAlphaBlending(
          at.x + col,
          at.y + row,
          cell.char,
          shade(cell.fg),
          shade(cell.bg, true),
        );
      }
    }
  }

  // Drawn after everything else, over the screen, and too small to take a click.
  return (
    <box
      ref={box}
      position="absolute"
      left={0}
      top={0}
      width={0}
      height={0}
      zIndex={100}
      renderAfter={draw}
    />
  );
}
