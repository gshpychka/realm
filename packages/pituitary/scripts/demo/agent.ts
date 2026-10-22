// The scripted agent with the showcase's sessions added to its scenarios.
import { scenarios } from "../../packages/fake-pi/scenarios/index.ts";
import { demoScenarios } from "./scenarios.ts";

for (const [name, scenario] of Object.entries(demoScenarios)) scenarios.set(name, scenario);

// The mascot scene loops from one round's end to the next, so the footer's figures hold
// still across rounds: every session stats reply reports the first round's.
if (process.env.FAKE_PI_SCENARIO === "demo-mascot") {
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    const text = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    const record = recordOf(text);
    if (record?.command === "get_session_stats" && record.data) {
      record.data.cost = 0.0123;
      record.data.tokens = { input: 1200, output: 340, cacheRead: 4000, cacheWrite: 500, total: 6040 };
      return (write as (text: string, ...more: unknown[]) => boolean)(`${JSON.stringify(record)}\n`, ...rest);
    }
    return (write as (chunk: string | Uint8Array, ...more: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stdout.write;
}

/** `text` as one stats reply or other record, or null when a write holds something else. */
function recordOf(text: string): { command?: string; data?: Record<string, unknown> } | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

await import("../../packages/fake-pi/src/main.ts");
