import type { Beat, Scenario } from "../../packages/fake-pi/src/types.ts";
import {
  agentRun,
  assistantTurn,
  type PiEvent,
  stored,
  type ToolArgs,
  toolRun,
  userTurn,
} from "../../packages/rpc/src/index.ts";

/** Scripted sessions for the showcase recordings: realistic work, played by the scripted agent. */

const RETRY_SOURCE = [
  'import { clamp } from "./math";',
  "",
  "/** How long a failed payout keeps retrying before it is parked. */",
  "export interface RetryPolicy {",
  "  windowHours: number;",
  "  backoffSeconds: number;",
  "}",
  "",
  "export const DEFAULT_POLICY: RetryPolicy = {",
  "  windowHours: 24,",
  "  backoffSeconds: 30,",
  "};",
  "",
  "export function windowFor(requested: number): number {",
  "  return clamp(requested, 1, Number.POSITIVE_INFINITY);",
  "}",
  "",
  "export function nextAttempt(attempt: number, policy = DEFAULT_POLICY): number {",
  "  return policy.backoffSeconds * 2 ** attempt;",
  "}",
].join("\n");

const DIFF = [
  "  13 ",
  "  14 export function windowFor(requested: number): number {",
  "- 15   return clamp(requested, 1, Number.POSITIVE_INFINITY);",
  "+ 15   return clamp(requested, 1, MAX_WINDOW_HOURS);",
  "  16 }",
].join("\n");

const TEST_LINES = [
  "bun test v1.4.2",
  "",
  "src/retry.test.ts:",
  "✓ windowFor > keeps a request inside the window [0.08ms]",
  "✓ windowFor > caps a request at one week [0.03ms]",
  "✓ windowFor > raises a zero request to one hour [0.02ms]",
  "✓ nextAttempt > doubles the backoff each attempt [0.04ms]",
  "✓ nextAttempt > starts from the policy's backoff [0.02ms]",
  "✓ DEFAULT_POLICY > retries for a day [0.01ms]",
  "",
  " 6 pass",
  " 0 fail",
  "Ran 6 tests across 1 file. [41.00ms]",
];

/** Each partial output of a command whose lines arrive one by one. */
const unfolding = (lines: string[]) => lines.map((_, index) => lines.slice(0, index + 1).join("\n"));

function call(
  id: string,
  name: string,
  args: ToolArgs,
  output: string[],
  text?: string,
  details?: unknown,
): PiEvent[][] {
  return [
    assistantTurn({ ...(text ? { text } : {}), toolCall: { id, name, args }, parts: 6 }),
    toolRun({ id, name, args, output, ...(details === undefined ? {} : { details }) }),
  ];
}

const SUMMARY = [
  "## Done",
  "",
  "The retry window now stops at **one week**, so a payout that keeps failing is parked",
  "instead of retrying forever.",
  "",
  "```ts",
  "export const MAX_WINDOW_HOURS = 168;",
  "",
  "export function windowFor(requested: number): number {",
  "  return clamp(requested, 1, MAX_WINDOW_HOURS);",
  "}",
  "```",
  "",
  "| request | before | after |",
  "| --- | --- | --- |",
  "| 0 hours | 1 | 1 |",
  "| 500 hours | 500 | 168 |",
  "",
  "All 6 tests pass. The default policy still retries for a day.",
].join("\n");

const SESSION = { sessionName: "retry window" };

/** A task done end to end: think, read, edit, test, summarise. */
const work: Scenario = {
  name: "demo-work",
  state: SESSION,
  bash: (command) => {
    if (command.startsWith("bun test")) return TEST_LINES;
    if (command.startsWith("git")) return [" M src/retry.ts", " M src/retry.test.ts"];
    return [`ran: ${command}`];
  },
  run: (prompt) =>
    agentRun([
      userTurn(prompt),
      assistantTurn({
        thinking:
          "The window has no upper bound, so a failing payout retries forever. Read the policy, cap it, then prove it with a test.",
        text: "Reading the retry policy first.",
        toolCall: { id: "r1", name: "read", args: { path: "src/retry.ts" } },
        parts: 14,
      }),
      toolRun({ id: "r1", name: "read", args: { path: "src/retry.ts" }, output: [RETRY_SOURCE] }),
      ...call(
        "e1",
        "edit",
        { path: "src/retry.ts" },
        ["Successfully replaced 1 block(s) in src/retry.ts."],
        "Capping the window at a week.",
        { diff: DIFF },
      ),
      ...call(
        "b1",
        "bash",
        { command: "bun test src/retry.test.ts" },
        unfolding(TEST_LINES),
        "Running the tests.",
      ),
      assistantTurn({ text: SUMMARY, parts: 90 }),
    ]),
};

const U = "anthropic-ratelimit-unified-";
const hence = (hours: number) => String(Math.floor(Date.now() / 1000 + hours * 3600));

/** A reply carrying usage-limit headers with the weekly limit close. */
const limits: Scenario = {
  name: "demo-limits",
  state: SESSION,
  run: (prompt): Beat[] => {
    const run = agentRun([
      userTurn(prompt),
      assistantTurn({ text: "Checked. The weekly limit is close; the five-hour one has room.", parts: 12 }),
    ]);
    return [
      ...run.slice(0, -2),
      {
        limits: {
          [`${U}status`]: "allowed_warning",
          [`${U}5h-utilization`]: "0.41",
          [`${U}5h-reset`]: hence(3),
          [`${U}7d-utilization`]: "0.92",
          [`${U}7d-reset`]: hence(38),
          [`${U}representative-claim`]: "seven_day",
          [`${U}overage-status`]: "allowed",
        },
      },
      ...run.slice(-2),
    ];
  },
};

const PLAN = [
  "## Where the retry window is set",
  "",
  "- `src/retry.ts` holds the default policy: one day, 30 seconds of backoff",
  "- `src/worker.ts` reads it once per payout and never caps it",
  "- `src/config.ts` lets an operator raise it without a limit",
  "",
  "## What changes",
  "",
  "1. Add `MAX_WINDOW_HOURS = 168` beside the default",
  "2. Clamp every requested window to it in `windowFor`",
  "3. Reject a larger value in `config.ts` with a clear message",
  "4. Cover the cap and the rejection with tests",
  "",
  "## What stays",
  "",
  "- the default window of one day",
  "- the doubling backoff between attempts",
  "- the parked state a payout reaches when its window ends",
  "",
  "Ready to make the change when you are.",
].join("\n");

const MASCOT_PROMPT = "where is the retry window set?";

/**
 * The same plan on every prompt, after a history of the same exchange long enough that the
 * scrollbar sits at its smallest, so each round ends on the screen it began on.
 */
const mascot: Scenario = {
  name: "demo-mascot",
  state: SESSION,
  context: 12,
  history: Array.from({ length: 12 }, () => [
    stored.user(MASCOT_PROMPT),
    stored.assistant({ text: PLAN }),
  ]).flat(),
  run: (prompt) => agentRun([userTurn(prompt), assistantTurn({ text: PLAN, parts: 60 })]),
};

export const demoScenarios = {
  "demo-work": work,
  "demo-limits": limits,
  "demo-mascot": mascot,
} satisfies Record<string, Scenario>;
