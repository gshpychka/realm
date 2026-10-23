import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Writable } from "node:stream";
import { palette, theme } from "../theme.ts";
import { type Draft, DraftEngine, offsetOf, textOf } from "./engine.ts";
import type { Frame } from "./screen.ts";

// Each test has an nvim of its own, so one failure leaves no state behind for the next.
let engine: DraftEngine;
beforeEach(() => {
  engine = new DraftEngine();
});
afterEach(() => engine.close());

/** Resolves with the first of the current value and those `subscribe` hands over that satisfies `done`. */
function when<T>(
  current: () => T | null,
  subscribe: (listener: (value: T) => void) => () => void,
  done: (value: T) => boolean,
): Promise<T> {
  const now = current();
  if (now !== null && done(now)) return Promise.resolve(now);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      stop();
      reject(new Error(`nothing matched; last ${JSON.stringify(current())}`));
    }, 2000);
    const stop = subscribe((value) => {
      if (!done(value)) return;
      clearTimeout(timer);
      stop();
      resolve(value);
    });
  });
}

/** Resolves with the first draft nvim reports that satisfies `done`. */
const until = (done: (draft: Draft) => boolean) =>
  when(
    () => engine.draft,
    (listener) => engine.onChange(listener),
    done,
  );

/** Resolves with the first frame nvim draws that satisfies `done`. */
const drawn = (done: (frame: Frame) => boolean) =>
  when(
    () => engine.frame,
    (listener) => engine.onFrame(listener),
    done,
  );

/** Each row of a frame as text, without the blanks that pad it to the screen's width. */
const rowsOf = (frame: Frame) =>
  frame.rows.map((row) =>
    row
      .map((run) => run.text)
      .join("")
      .trimEnd(),
  );

const text = (want: string) => (draft: Draft) => textOf(draft) === want;
const normal = (want: string) => (draft: Draft) => textOf(draft) === want && draft.mode === "n";

/** Types `draft` in insert mode and leaves it in normal mode. */
async function inNormal(draft: string): Promise<void> {
  engine.input(draft);
  engine.input("<Esc>");
  await until(normal(draft));
}

describe("the draft engine", () => {
  test("keys typed before nvim is up land in insert mode, in order", async () => {
    engine.input('say "hi there" now');
    await engine.ready;
    const draft = await until(text('say "hi there" now'));
    expect(draft.mode).toBe("i");
    expect(offsetOf(draft)).toBe(18);
  });

  test("nvim's motions, text objects, and undo edit the draft", async () => {
    await inNormal('say "hi there" now');
    engine.input('0wci"yo<Esc>');
    await until(normal('say "yo" now'));
    engine.input("u");
    await until(text('say "hi there" now'));
    engine.input("0dw");
    await until(text('"hi there" now'));
  });

  test("counts, operators, and text objects work when each key arrives on its own", async () => {
    for (const key of "hello big wide world") engine.input(key);
    engine.input("<Esc>");
    for (const key of ["0", "2", "d", "w"]) engine.input(key);
    await until(normal("wide world"));
    for (const key of ["c", "i", "w", "X"]) engine.input(key);
    engine.input("<Esc>");
    await until(normal("X world"));
    engine.input(".");
    engine.input("u");
    await until(text("X world"));
  });

  test("taking the draft abandons a half-typed command and keeps the text", async () => {
    await inNormal("X world");
    engine.input("f");
    expect(await engine.take()).toBe("X world");
    await until((draft) => textOf(draft) === "" && draft.mode === "i");
  });

  test("settling waits until the draft shows every key sent", async () => {
    await inNormal('say "hi there" now');
    engine.input("A");
    for (const key of " and more") engine.input(key);
    expect(engine.busy).toBe(true);
    await engine.settle();
    expect(engine.busy).toBe(false);
    expect(textOf(engine.draft)).toBe('say "hi there" now and more');
  });

  test("a half-typed count shows as pending until a key completes or cancels it", async () => {
    await inNormal("abc");
    expect(engine.pending).toBe(false);
    engine.input("3");
    await engine.settle();
    expect(engine.pending).toBe(true);
    engine.input("<Esc>");
    await engine.settle();
    await until(() => !engine.pending);
    expect(engine.draft.mode).toBe("n");
  });

  test("an nvim slow to answer is not taken for a half-typed command", async () => {
    await engine.ready;
    const nvim = (engine as unknown as { rpc: { child: { pid: number } } }).rpc.child.pid;
    let seen = false;
    const stop = engine.onChange(() => {
      seen ||= engine.pending;
    });
    process.kill(nvim, "SIGSTOP");
    engine.input("hello");
    setTimeout(() => process.kill(nvim, "SIGCONT"), 150);
    await engine.settle();
    stop();
    expect(seen).toBe(false);
    expect(textOf(engine.draft)).toBe("hello");
  });

  test("a replacement lands after the keys before it and before the keys after it", async () => {
    engine.input("A tail");
    engine.set("hello wörld 😀 x", 8);
    engine.input("Z");
    const draft = await until(text("hello wöZrld 😀 x"));
    expect(draft.mode).toBe("i");
    expect(draft.col).toBe(9);
  });

  test("taking the draft includes every key sent before it and leaves it empty", async () => {
    engine.set("hello wöZrld 😀 x", 9);
    engine.input("abc");
    expect(await engine.take()).toBe("hello wöZabcrld 😀 x");
    expect(textOf(engine.draft)).toBe("");
    await until((draft) => textOf(draft) === "" && draft.mode === "i");
  });

  test("a failed handover leaves the last visible draft available to the fallback editor", async () => {
    engine.input("keep this draft");
    await until(text("keep this draft"));
    const taken = engine.take();
    const failed = taken.then(
      () => false,
      () => true,
    );
    let fallback = "";
    engine.onClose(() => {
      fallback = textOf(engine.draft);
    });
    engine.close();
    expect(await failed).toBe(true);
    expect(fallback).toBe("keep this draft");
  });

  test("a request sent with a replacement lands in the insert mode the replacement enters", async () => {
    await inNormal("draft");
    const { rpc } = engine as unknown as {
      rpc: {
        request(method: string, params: unknown[]): Promise<unknown>;
        child: { stdin: Writable };
      };
    };
    // One write, so nvim reads the paste before it next waits for input.
    rpc.child.stdin.cork();
    void rpc.request("nvim_exec_lua", ["pi_draft.set(...)", [["ab"], 0, 2]]);
    const pasted = rpc.request("nvim_paste", ["XY", false, -1]);
    rpc.child.stdin.uncork();
    await pasted;
    const state = (await rpc.request("nvim_exec_lua", ["return pi_draft.state()", []])) as Draft;
    expect([state.lines, state.col, state.mode]).toEqual([["abXY"], 4, "i"]);
  });

  test("a paste keeps its lines", async () => {
    engine.paste("one\ntwo");
    const draft = await until(text("one\ntwo"));
    expect([draft.row, draft.col]).toEqual([1, 3]);
  });

  test("a key reaches nvim and its result comes back within a few milliseconds", async () => {
    await engine.ready;
    const samples: number[] = [];
    let typed = "";
    for (const letter of "abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz") {
      typed += letter;
      const want = typed;
      const start = performance.now();
      engine.input(letter);
      await until(text(want));
      samples.push(performance.now() - start);
    }
    samples.sort((a, b) => a - b);
    const p95 = samples[Math.floor(samples.length * 0.95)] ?? Number.NaN;
    console.log(
      `nvim round trip: p50 ${samples[samples.length >> 1]?.toFixed(2)}ms · p95 ${p95.toFixed(2)}ms`,
    );
    // Budgets sit well above a quiet machine's figure, so they catch a regression without failing on a busy one.
    expect(p95).toBeLessThan(10);
  });
});

/** A colour as `hl_attr_define` gives it. */
const rgb = (hex: string) => Number.parseInt(hex.slice(1), 16);

/** Twelve cells, the narrowest screen nvim draws. */
const NARROW = 12;

describe("the draft's screen", () => {
  test("nvim draws nothing until the screen has a size, then the draft wrapped between words", async () => {
    engine.input("hello there general kenobi");
    await until(text("hello there general kenobi"));
    expect(engine.frame).toBeNull();
    engine.resize(12, 4);
    const frame = await drawn((each) => each.rows.length === 3);
    expect(rowsOf(frame)).toEqual(["hello there", "general", "kenobi"]);
    expect(frame.cursor).toEqual({ row: 2, col: 6 });
    expect(frame.mode).toEqual({ name: "insert", cursor: "vertical", blinking: false });
  });

  test("the arrows walk the rows a line wraps onto and keep their column, while j and k keep to lines", async () => {
    engine.resize(NARROW, 4);
    engine.input("0123456789abcdefghijklmnopqrs");
    const typed = await drawn((frame) => frame.cursor?.row === 2);
    expect(rowsOf(typed)).toEqual(["0123456789ab", "cdefghijklmn", "opqrs"]);
    expect((await until((draft) => draft.col === 29)).onLastRow).toBe(true);
    engine.input("<Up>");
    const middle = await until((draft) => draft.col === 17);
    expect([middle.onFirstRow, middle.onLastRow]).toEqual([false, false]);
    engine.input("<Up>");
    expect((await until((draft) => draft.col === 5)).onFirstRow).toBe(true);
    engine.input("<Down><Down>");
    expect((await until((draft) => draft.col === 29)).onLastRow).toBe(true);
    engine.input("<Esc><Up>");
    await until((draft) => draft.mode === "n" && draft.col === 16);
    engine.input("k<Up>");
    expect((await until((draft) => draft.col === 4)).onFirstRow).toBe(true);
  });

  test("a line taller than the screen scrolls through it a row at a time", async () => {
    engine.resize(NARROW, 2);
    engine.input(`${"0123456789ab".repeat(4)}vwxyz`);
    // nvim marks a line whose start is scrolled out of view.
    expect(rowsOf(await drawn((frame) => frame.cursor?.row === 1))).toEqual(["<<<3456789ab", "vwxyz"]);
    engine.input("<Up><Up>");
    const scrolled = await drawn((frame) => rowsOf(frame)[1] === "0123456789ab");
    expect(rowsOf(scrolled)[0]).toBe("<<<3456789ab");
    expect(scrolled.cursor).toEqual({ row: 0, col: 5 });
    expect((await until((draft) => draft.col === 29)).onFirstRow).toBe(false);
    engine.input("<Up><Up>");
    expect((await until((draft) => draft.col === 5)).onFirstRow).toBe(true);
    expect(rowsOf(await drawn((frame) => !rowsOf(frame)[0]?.startsWith("<<<")))).toEqual([
      "0123456789ab",
      "0123456789ab",
    ]);
  });

  test("a completion cycles through its matches in place, with no menu over the rows below", async () => {
    engine.resize(20, 4);
    engine.set("al\nalpha alps", 2);
    engine.input("<C-n>");
    const completed = await drawn((frame) => frame.rows.length === 2 && rowsOf(frame)[0] !== "al");
    expect(rowsOf(completed)).toEqual(["alpha", "alpha alps"]);
  });

  test("past a line that fills its last row, the cursor stands on a row of its own", async () => {
    engine.resize(NARROW, 4);
    engine.input("0123456789ab");
    const frame = await drawn((each) => each.cursor?.row === 1);
    expect(rowsOf(frame)).toEqual(["0123456789ab", ""]);
    expect(frame.cursor).toEqual({ row: 1, col: 0 });
    expect((await until((each) => each.col === 12 && !each.onFirstRow)).onLastRow).toBe(true);
  });

  test("a narrower screen wraps the draft onto more rows, and the cursor's row follows", async () => {
    engine.resize(20, 4);
    engine.input("0123456789abcde");
    await drawn((frame) => frame.cursor?.col === 15);
    expect((await until(text("0123456789abcde"))).onFirstRow).toBe(true);
    engine.resize(NARROW, 4);
    expect((await drawn((frame) => frame.rows.length === 2)).cursor).toEqual({ row: 1, col: 3 });
    await until((draft) => !draft.onFirstRow);
  });

  test("an empty draft shows the placeholder while inserting, and loses it to the first key", async () => {
    engine.placeholder("ask pi");
    engine.resize(20, 4);
    const empty = await drawn((frame) => rowsOf(frame)[0] === "ask pi");
    expect(empty.rows[0]?.[0]).toEqual({ text: "ask pi", highlight: { foreground: rgb(theme.dim) } });
    expect(empty.cursor).toEqual({ row: 0, col: 0 });
    engine.input("x");
    await drawn((frame) => rowsOf(frame)[0] === "x");
    engine.input("<BS><Esc>");
    await drawn((frame) => frame.mode.name === "normal" && rowsOf(frame)[0] === "");
  });

  test("text draws in pituitary's colours, a visual selection in its selection colour", async () => {
    engine.resize(20, 4);
    await inNormal("abc def");
    engine.input("0vll");
    const frame = await drawn((each) => each.mode.name === "visual" && each.cursor?.col === 2);
    expect(frame.colors).toEqual({ foreground: rgb(theme.assistant), background: undefined });
    // The cursor marks the character it is on, which the selection's colour leaves to it.
    expect(frame.rows[0]?.[0]).toEqual({ text: "ab", highlight: { background: rgb(palette.selection) } });
    expect(frame.rows[0]?.[1]?.text.trimEnd()).toBe("c def");
  });
});
