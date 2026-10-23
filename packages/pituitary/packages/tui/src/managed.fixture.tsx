import { mkdtempSync, rmSync } from "node:fs";
import { createCliRenderer } from "@opentui/core";
import { createRoot, extend } from "@opentui/react";
import { type ConversationClient, connectConversation } from "@realm/dura/client";
import type { RunDetail } from "@realm/dura/types";
import { serveConversationFixture } from "../../../../dura/src/conversation.fixture.ts";
import { OptInText } from "./components/text.ts";
import { ManagedWorkspace } from "./managed.tsx";
import { type ManagedView, RELOAD_UI, readManagedView, writeManagedView } from "./ui-state.ts";

const directory = mkdtempSync("/tmp/pituitary-team-fixture-");
const at = "2026-10-23T10:00:00.000Z";
const hash = "a".repeat(64);
const declaration = {
  manifest: {
    schemaVersion: 1 as const,
    name: "reviewer",
    description: "Independent reviewer",
    instructions: "Review retained code.",
    model: null,
    tools: [],
    delegatesTo: [],
    credentials: [],
    limits: { maxChildren: 0, maxDepth: 0 },
  },
  machine: "reviewer",
  machineRevision: "reviewer-v1",
  program: "/bin/reviewer",
};
const task = (
  id: string,
  role: string,
  parentTaskId: string | null,
  status: RunDetail["tasks"][number]["status"],
  objective: string,
): RunDetail["tasks"][number] => ({
  id,
  runId: "run-team",
  parentTaskId,
  role,
  revision: 1,
  inputArtifactId: hash,
  dependencies: [],
  objective,
  acceptance: [],
  status,
  currentAttemptId: `attempt-${id}`,
  waitFor: [],
  reportId: null,
  artifactId: null,
  integrationId: null,
  verificationId: null,
  report: null,
});
const tasks = [
  task("coordinator", "coordinator", null, "waiting", "Ship an accessible, polished command menu"),
  task("builder", "builder", "coordinator", "waiting", "Build keyboard navigation and focus handling"),
  task("reviewer", "reviewer", "coordinator", "accepted", "Review the menu and run independent checks"),
  task(
    "failed-builder",
    "builder",
    "coordinator",
    "failed",
    "Fix the environment and continue the menu polish",
  ),
];
const [coordinator, , reviewer] = tasks;
if (!coordinator || !reviewer) throw new Error("Team fixture roles are missing");
coordinator.waitFor = ["builder"];
reviewer.reportId = "report-reviewer";
reviewer.artifactId = hash;
reviewer.integrationId = "integration-reviewer";
reviewer.verificationId = "verification-reviewer";
const detail: RunDetail = {
  run: {
    id: "run-team",
    name: "command-menu",
    cwd: "/work/workspace",
    objective: coordinator.objective,
    model: null,
    created: at,
    desired: "running",
    rootTaskId: "coordinator",
    catalog: null,
    limits: {
      maxTasks: 16,
      maxLiveAttempts: 4,
      maxDepth: 2,
      deadlineMs: 3600000,
      reportBytes: 65536,
      artifactBytes: 67108864,
    },
    deadline: Date.now() + 45 * 60000,
    repos: [],
    workspace: { includeUntracked: [] },
    inputArtifactId: hash,
    integrationArtifactId: hash,
    acceptedArtifactId: hash,
  },
  tasks,
  attempts: tasks.map((item): RunDetail["attempts"][number] => ({
    id: item.currentAttemptId,
    taskId: item.id,
    number: 1,
    revision: 1,
    inputArtifactId: hash,
    dependencies: [],
    depth: item.parentTaskId ? 1 : 0,
    conversationId: item.id === "failed-builder" ? null : `conversation-${item.id}`,
    cwd: "/work/workspace",
    status: item.id === "reviewer" ? "stopped" : item.id === "failed-builder" ? "failed" : "ready",
    desired: item.id === "reviewer" || item.id === "failed-builder" ? "stopped" : "running",
    error: item.id === "failed-builder" ? "Environment image unavailable" : null,
    grant: { maxChildren: 2, maxDepth: 2 },
    execution: {
      kind: "bay",
      socket: "/private/bay.sock",
      sessionName: item.id,
      recordId: item.id,
      generation: 1,
      agent: declaration,
      repos: [],
    },
  })),
  events: [],
  reports: [
    {
      id: "report-reviewer",
      runId: "run-team",
      taskId: "reviewer",
      attemptId: "attempt-reviewer",
      revision: 1,
      digest: hash,
      at,
      text: "## Ready to ship\n\nKeyboard navigation follows the focused item. Escape returns focus to the trigger.\n\n- Arrow keys wrap predictably.\n- Reduced motion keeps transitions immediate.\n- Both checks passed against the retained tree.",
    },
  ],
  artifacts: [
    {
      id: hash,
      runId: "run-team",
      taskId: "reviewer",
      attemptId: "attempt-reviewer",
      kind: "result",
      repository: "primary",
      base: "0".repeat(40),
      head: "1".repeat(40),
      tree: "2".repeat(40),
      content: hash,
      bytes: 8192,
      created: at,
    },
  ],
  integrations: [
    {
      id: "integration-reviewer",
      runId: "run-team",
      taskId: "reviewer",
      revision: 1,
      resultArtifactId: hash,
      baseArtifactId: hash,
      artifactId: hash,
      status: "integrated",
      conflicts: [],
      error: null,
      created: at,
    },
  ],
  verifications: [
    {
      id: "verification-reviewer",
      runId: "run-team",
      taskId: "reviewer",
      revision: 1,
      integrationId: "integration-reviewer",
      artifactId: hash,
      tree: "2".repeat(40),
      agent: declaration,
      policy: {
        agent: "reviewer",
        checks: {
          types: { command: ["bun", "typecheck"], timeoutMs: 60000 },
          keyboard: { command: ["bun", "test", "keyboard"], timeoutMs: 60000 },
        },
      },
      policyDigest: hash,
      status: "passed",
      checks: [
        { name: "types", exitCode: 0, status: "passed", output: "" },
        { name: "keyboard", exitCode: 0, status: "passed", output: "" },
      ],
      execution: null,
      error: null,
      created: at,
      completed: at,
    },
  ],
  questions: [
    {
      id: "question-focus",
      runId: "run-team",
      taskId: "builder",
      attemptId: "attempt-builder",
      revision: 1,
      question: "When the menu closes, where should focus return?",
      choices: ["Return focus to the trigger", "Keep focus on the next item"],
      status: "open",
      answer: null,
      created: at,
      answeredAt: null,
    },
  ],
};
if (process.env.PITUITARY_FIXTURE_FAILED_CHECK === "1") {
  reviewer.status = "submitted";
  detail.run.acceptedArtifactId = null;
  const verification = detail.verifications[0];
  if (!verification) throw new Error("Missing fixture verification");
  verification.status = "failed";
  verification.checks = [
    {
      name: "types",
      exitCode: 1,
      status: "failed",
      output: "Missing exported member: keyboardShortcut",
      truncated: true,
    },
  ];
}
const server = await serveConversationFixture(
  directory,
  tasks.filter((task) => task.id !== "failed-builder"),
  { archiveTasks: ["reviewer"] },
);
const socketPath = server.socketPath;
const saved = readManagedView(process.env.PITUITARY_UI_STATE);
let selected = process.env.PITUITARY_UI_RESUME === "1" ? (saved?.taskId ?? "coordinator") : "coordinator";
if (!tasks.some((task) => task.id === selected)) selected = "coordinator";
let coordinatorConnections = 0;
const runtime = {
  inspect: async () => structuredClone(detail),
  connect: async (_run: unknown, control: boolean, id?: string) => {
    if (
      id === "coordinator" &&
      ++coordinatorConnections === 2 &&
      process.env.PITUITARY_FIXTURE_FAIL_BACK === "1"
    )
      throw new Error("The previous input lease is unavailable");
    return connectConversation({ socketPath, runId: "run-team", taskId: id ?? "coordinator", control });
  },
  answer: async (id: string, answer: string) => {
    const question = detail.questions.find((question) => question.id === id);
    if (!question) throw new Error("Unknown fixture question");
    question.status = "answered";
    question.answer = answer;
    question.answeredAt = at;
    const task = detail.tasks.find((task) => task.id === question.taskId);
    if (!task) throw new Error("Unknown question task");
    task.status = "running";
  },
  retry: async () => {},
  revise: async () => {},
  integrate: async () => {},
  apply: async () => {},
};
let current: ConversationClient = await runtime.connect("run-team", saved?.control ?? true, selected);
const renderer = await createCliRenderer({ exitOnCtrlC: false, targetFps: 120, maxFps: 120 });
extend({ text: OptInText });
const root = createRoot(renderer);
let capture: (() => ManagedView) | undefined;
let closing = false;
const quit = (code = 0) => {
  if (closing) return;
  closing = true;
  if (capture) writeManagedView(process.env.PITUITARY_UI_STATE, capture());
  root.unmount();
  renderer.destroy();
  void current
    .close()
    .then(() => server.close())
    .finally(() => {
      rmSync(directory, { recursive: true, force: true });
      process.exit(code);
    });
};
process.once("SIGTERM", () => quit());
root.render(
  <ManagedWorkspace
    runtime={runtime}
    initial={detail}
    taskId={selected}
    client={current}
    saved={saved}
    onClient={(next) => {
      current = next;
    }}
    onCapture={(next) => {
      capture = next;
    }}
    onQuit={() => quit()}
    onReload={() => quit(RELOAD_UI)}
  />,
);
