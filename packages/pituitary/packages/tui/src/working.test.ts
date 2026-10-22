import { describe, expect, test } from "bun:test";
import {
  agentRun,
  assistantTurn,
  emptySession,
  type PiEvent,
  reduce,
  type SessionView,
  type TurnEntry,
  toolRun,
  userTurn,
} from "@pituitary/rpc";
import { glyphs } from "./glyphs.ts";
import { clock, count, duration, turnLine, workingLine } from "./working.ts";

function run(events: PiEvent[], at = 1_000): SessionView {
  return events.reduce<SessionView>((view, event) => reduce(view, event, at), emptySession);
}

/** A run's events up to its settling, which the status line only shows until. */
function open(events: PiEvent[]): PiEvent[] {
  return events.slice(
    0,
    events.findIndex((event) => event.type === "agent_end"),
  );
}

const call = { id: "c1", name: "bash", args: { command: "ls" } };
const WIDE = 100;

describe("workingLine", () => {
  test("names what the model does with the time and the interrupt key", () => {
    const line = workingLine(run(open(agentRun([userTurn("q")]))), 13_400, "esc esc", WIDE);
    expect(line).toEqual({
      kind: "reading",
      doing: `${glyphs.reading} reading`,
      figures: " · 12s · esc esc interrupts",
    });
    const reply = assistantTurn({ thinking: "hmm", text: "a" });
    const reasoning = reply.findIndex((event) => event.type === "message_update") + 2;
    const thinking = run([...open(agentRun([userTurn("q")])), ...reply.slice(0, reasoning)]);
    expect(workingLine(thinking, 1_000, "esc esc", WIDE).doing).toBe(`${glyphs.thinking} thinking`);
  });

  test("puts the tokens generated after the key, and drops figures from the end to fit", () => {
    const view = run(open(agentRun([userTurn("q"), assistantTurn({ text: "a", outputTokens: 1_240 })])));
    const figures = (columns: number) => workingLine(view, 3_000, "esc", columns).figures;
    expect(figures(WIDE)).toBe(` · 2s · esc interrupts · ${glyphs.tokens} 1.2k`);
    expect(figures(35)).toBe(" · 2s · esc interrupts");
    expect(figures(16)).toBe(" · 2s");
    expect(figures(8)).toBe("");
  });

  test("names the tool that runs, and counts several", () => {
    const reply = assistantTurn({ text: "listing", toolCall: call });
    const one = run(open(agentRun([userTurn("q"), reply])));
    expect(workingLine(one, 1_000, "esc esc", WIDE).doing).toBe(`${glyphs.tool} bash`);
    const both = {
      role: "assistant",
      content: [
        { type: "toolCall", id: "c1", name: "bash", arguments: {} },
        { type: "toolCall", id: "c2", name: "read", arguments: {} },
      ],
      stopReason: "toolUse",
    } as unknown as Extract<PiEvent, { type: "message_end" }>["message"];
    const two = run([
      ...open(agentRun([userTurn("q")])),
      { type: "message_start", message: both },
      { type: "message_end", message: both },
    ]);
    expect(workingLine(two, 1_000, "esc esc", WIDE).doing).toBe(`${glyphs.tool} 2 tools`);
    const done = run(open(agentRun([userTurn("q"), reply, toolRun({ ...call, output: ["a"] })])));
    expect(workingLine(done, 1_000, "esc esc", WIDE).kind).toBe("reading");
  });

  test("while a dialog is open, says the run waits on the operator, holds the clock, and leaves out the key", () => {
    const started = run(open(agentRun([userTurn("q"), assistantTurn({ text: "a", outputTokens: 30 })])));
    const asked = reduce(started, { type: "waiting", waiting: true }, 6_000);
    const line = workingLine(asked, 60_000, "esc esc", WIDE);
    expect(line).toEqual({
      kind: "operator",
      doing: `${glyphs.waiting} waiting on you`,
      figures: ` · 5s · ${glyphs.tokens} 30`,
    });
  });
});

describe("count", () => {
  test("stays short and never rounds up", () => {
    expect([0, 999, 1_000, 1_299, 9_999, 10_000, 999_999, 1_250_000].map(count)).toEqual([
      "0",
      "999",
      "1.0k",
      "1.2k",
      "9.9k",
      "10k",
      "999k",
      "1.2M",
    ]);
  });
});

describe("turnLine", () => {
  const endedAt = new Date(2026, 8, 28, 14, 32, 50).getTime();
  const turn = (figures: Partial<TurnEntry>): TurnEntry => ({
    kind: "turn",
    id: "e1",
    worked: 12_400,
    output: 1_640,
    tools: 2,
    endedAt,
    ...figures,
  });

  test("gives the time worked, the output tokens, the tool calls, and the local time it ended", () => {
    expect(turnLine(turn({}))).toBe(`${glyphs.turn} 12s · ${glyphs.tokens} 1.6k · 2 tools · 14:32`);
    expect(turnLine(turn({ tools: 1 }))).toBe(`${glyphs.turn} 12s · ${glyphs.tokens} 1.6k · 1 tool · 14:32`);
  });

  test("leaves out tools and tokens the turn had none of", () => {
    expect(turnLine(turn({ tools: 0, output: 0 }))).toBe(`${glyphs.turn} 12s · 14:32`);
  });

  test("ends with how the turn ended when it did not end with a finished reply", () => {
    expect(turnLine(turn({ outcome: "interrupted" }))).toBe(
      `${glyphs.turn} 12s · ${glyphs.tokens} 1.6k · 2 tools · 14:32 · interrupted`,
    );
    expect(turnLine(turn({ tools: 0, outcome: "error" }))).toBe(
      `${glyphs.turn} 12s · ${glyphs.tokens} 1.6k · 14:32 · error`,
    );
  });
});

describe("duration", () => {
  test("counts seconds under a minute, and the largest two units past one", () => {
    expect([0, 400, 59_400, 60_000, 72_000, 3_599_000, 3_600_000, 3_720_000].map(duration)).toEqual([
      "0s",
      "0s",
      "59s",
      "1m 0s",
      "1m 12s",
      "59m 59s",
      "1h 0m",
      "1h 2m",
    ]);
  });
});

describe("clock", () => {
  test("reads the local time on a 24-hour clock", () => {
    expect(clock(new Date(2026, 0, 2, 9, 5).getTime())).toBe("09:05");
    expect(clock(new Date(2026, 0, 2, 23, 59, 59).getTime())).toBe("23:59");
  });
});
