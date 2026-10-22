import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TuiTest } from "@microsoft/tui-test";
import { REPO } from "./harness.ts";

const PERF = join(REPO, "artifacts", "perf");

export interface Summary {
  n: number;
  p50: number;
  p95: number;
  max: number;
}

export function summarise(samples: number[]): Summary {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? Number.NaN;
  const round = (ms: number) => Math.round(ms * 10) / 10;
  return {
    n: sorted.length,
    p50: round(at(0.5)),
    p95: round(at(0.95)),
    max: round(sorted.at(-1) ?? Number.NaN),
  };
}

/**
 * Milliseconds from `act` until the screen satisfies `done`.
 *
 * The screen is read as fast as the harness serves it, so the figure includes the
 * app's frame pacing and the PTY round trip: what an operator waits for.
 */
export async function timeTo(
  terminal: TuiTest,
  act: () => Promise<void> | void,
  done: (screen: string) => boolean,
  timeoutMs = 5000,
): Promise<number> {
  const start = performance.now();
  await act();
  for (;;) {
    if (done(await terminal.text())) return performance.now() - start;
    if (performance.now() - start > timeoutMs) throw new Error(`screen never matched within ${timeoutMs}ms`);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** Records a measurement in artifacts/perf, where the loop report collects it. */
export function record(name: string, figures: Record<string, Summary | number>, budget: string): void {
  mkdirSync(PERF, { recursive: true });
  writeFileSync(join(PERF, `${name}.json`), `${JSON.stringify({ name, budget, ...figures }, null, 2)}\n`);
}

/**
 * Times each typed character until the draft shows it, `count` characters about `gapMs` apart.
 * The renderer holds frames at least 1/120 s apart, so keys closer than that each wait out
 * the rest of a frame; a gap of a typist's pace measures what the operator feels. Each gap
 * adds a different fraction of a frame, so the keys land at every point between frames
 * rather than at one fixed phase of a steady redraw.
 */
/** Milliseconds in one frame at the renderer's highest rate. */
const FRAME_MS = 17;

export async function echoes(terminal: TuiTest, count: number, gapMs = 80): Promise<number[]> {
  // A marker the transcript never contains, so the draft is the only place it can appear.
  const marker = "qqz";
  await terminal.write(marker);
  let typed = marker;
  await timeTo(
    terminal,
    () => {},
    (screen) => screen.includes(typed),
  );
  const letters = "abcdefghijklmnoprstuvwy";
  const samples: number[] = [];
  for (let index = 0; index < count; index++) {
    const letter = letters[index % letters.length] ?? "a";
    typed += letter;
    const want = typed;
    if (gapMs > 0) await new Promise((resolve) => setTimeout(resolve, gapMs + ((index * 7) % FRAME_MS)));
    samples.push(
      await timeTo(
        terminal,
        () => terminal.write(letter),
        (screen) => screen.includes(want),
      ),
    );
  }
  return samples;
}
