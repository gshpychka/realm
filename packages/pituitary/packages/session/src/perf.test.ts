import { expect, test } from "bun:test";
import { encodeJsonLine, JsonLineDecoder } from "./jsonl.ts";
import { agentRun, assistantTurn, stored, toolRun, userTurn } from "./session.fixture.ts";
import { emptySession, reduceAll, restore } from "./session.ts";

// Budgets sit well above what a quiet machine measures, so they catch a regression in
// complexity without failing on a busy one.

function timed(run: () => void): number {
  const start = performance.now();
  run();
  return performance.now() - start;
}

test("folding a reply of 20000 deltas stays linear", () => {
  const text = "The window holds at 168h and the limits table follows it. ".repeat(2000);
  const events = agentRun([userTurn("go"), assistantTurn({ text, parts: 20_000 })]);
  const ms = timed(() => reduceAll(emptySession, events));
  console.log(`fold 20000 deltas: ${ms.toFixed(1)}ms`);
  expect(ms).toBeLessThan(100);
});

test("decoding 50000 records split across small chunks stays linear", () => {
  const wire = Array.from({ length: 50_000 }, (_, index) => encodeJsonLine({ type: "tick", index })).join("");
  const decoder = new JsonLineDecoder();
  let records = 0;
  const ms = timed(() => {
    for (let at = 0; at < wire.length; at += 61) records += decoder.push(wire.slice(at, at + 61)).length;
  });
  console.log(`decode 50000 records: ${ms.toFixed(1)}ms`);
  expect(records).toBe(50_000);
  expect(ms).toBeLessThan(100);
});

test("restoring a session of 3000 messages is quick", () => {
  const messages = Array.from({ length: 1000 }, (_, index) => [
    stored.user(`step ${index}`),
    stored.assistant({
      text: `Reading module ${index}.`,
      toolCall: { id: `c${index}`, name: "edit", args: { path: `m${index}.ts` } },
    }),
    stored.toolResult({ id: `c${index}`, name: "edit", output: "applied" }),
  ]).flat();
  const ms = timed(() => restore(messages));
  console.log(`restore 3000 messages: ${ms.toFixed(1)}ms`);
  expect(ms).toBeLessThan(200);
});

test("a run of 200 tool calls folds quickly", () => {
  const events = agentRun([
    userTurn("go"),
    ...Array.from({ length: 200 }, (_, index) => {
      const call = { id: `t${index}`, name: "bash", args: { command: `echo ${index}` } };
      return [
        assistantTurn({ text: "Running it.", toolCall: call }),
        toolRun({ ...call, output: ["partial\n", `${index}\n`] }),
      ];
    }).flat(),
  ]);
  let view = emptySession;
  const ms = timed(() => {
    view = reduceAll(emptySession, events);
  });
  expect(view.entries.flatMap((entry) => (entry.kind === "assistant" ? entry.tools : [])).length).toBe(200);
  console.log(`fold 200 tool calls: ${ms.toFixed(1)}ms`);
  expect(ms).toBeLessThan(100);
});
