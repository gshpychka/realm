import type { AgentCatalog, AgentDefinition, VerificationPolicy } from "./catalog.ts";

export interface StartRunInput {
  name?: string;
  cwd: string;
  prompt?: string;
  agent?: string;
  model?: string;
  repos?: readonly string[];
  workspace?: { includeUntracked?: readonly string[] };
}
export interface ReviseTaskInput {
  objective?: string;
  acceptance?: readonly string[];
  inputArtifactId?: string;
  dependsOn?: readonly string[];
}

export interface RunLimits {
  maxTasks: number;
  maxLiveAttempts: number;
  maxDepth: number;
  deadlineMs: number;
  reportBytes: number;
  artifactBytes: number;
}
export const DEFAULT_RUN_LIMITS: Readonly<RunLimits> = {
  maxTasks: 16,
  maxLiveAttempts: 4,
  maxDepth: 2,
  deadlineMs: 60 * 60 * 1000,
  reportBytes: 64 * 1024,
  artifactBytes: 64 * 1024 * 1024,
};
/** One authorized objective. Execution identity belongs to its attempts. */
export interface Run {
  id: string;
  name: string;
  cwd: string;
  objective: string;
  model: string | null;
  created: string;
  desired: "running" | "stopped";
  rootTaskId: string;
  catalog: AgentCatalog | null;
  limits: RunLimits;
  deadline: number;
  repos: readonly string[];
  workspace: { includeUntracked: readonly string[] } | null;
  inputArtifactId: string | null;
  integrationArtifactId: string | null;
  acceptedArtifactId: string | null;
}
export type TaskStatus =
  | "queued"
  | "running"
  | "waiting"
  | "submitting"
  | "submitted"
  | "verifying"
  | "accepted"
  | "conflicted"
  | "superseded"
  | "failed"
  | "cancelled";
export interface Report {
  id: string;
  runId: string;
  taskId: string;
  attemptId: string;
  revision: number;
  digest: string;
  text: string;
  at: string;
}
/** Immutable retained bytes and Git identity, validated by the host artifact adapter. */
export interface Artifact {
  id: string;
  runId: string;
  taskId: string | null;
  attemptId: string | null;
  kind: "input" | "result" | "integration";
  repository: string;
  base: string | null;
  head: string;
  tree: string;
  content: string;
  bytes: number;
  created: string;
  source?: { head: string | null; indexHash: string };
}
export interface TaskDependency {
  taskId: string;
  revision: number;
  artifactId: string | null;
  reportId: string | null;
}
export interface Integration {
  id: string;
  runId: string;
  taskId: string;
  revision: number;
  resultArtifactId: string;
  baseArtifactId: string;
  artifactId: string | null;
  status: "pending" | "integrated" | "conflicted" | "stale" | "failed";
  conflicts: readonly string[];
  error: string | null;
  created: string;
}
export interface VerificationCheckResult {
  name: string;
  exitCode: number | null;
  status: "passed" | "failed" | "timed_out";
  output: string;
  truncated?: boolean;
}
export interface Verification {
  id: string;
  runId: string;
  taskId: string;
  revision: number;
  integrationId: string;
  artifactId: string;
  tree: string;
  agent: AgentDefinition;
  policy: VerificationPolicy;
  policyDigest: string;
  status: "pending" | "running" | "passed" | "failed" | "stale" | "cancelled";
  checks: readonly VerificationCheckResult[];
  execution: { sessionName: string; recordId: string; generation: number } | null;
  error: string | null;
  created: string;
  completed: string | null;
}
export interface Question {
  id: string;
  runId: string;
  taskId: string;
  attemptId: string;
  revision: number;
  question: string;
  choices: readonly string[];
  status: "open" | "answered" | "superseded";
  answer: string | null;
  created: string;
  answeredAt: string | null;
}
export interface Task {
  id: string;
  runId: string;
  parentTaskId: string | null;
  role: string | null;
  revision: number;
  inputArtifactId: string | null;
  dependencies: readonly TaskDependency[];
  objective: string;
  acceptance: readonly string[];
  status: TaskStatus;
  currentAttemptId: string;
  waitFor: readonly string[];
  reportId: string | null;
  artifactId: string | null;
  integrationId: string | null;
  verificationId: string | null;
}
export interface TaskDetail extends Task {
  report: Report | null;
}
export type AttemptStatus =
  | "queued"
  | "starting"
  | "ready"
  | "busy"
  | "waiting"
  | "stopping"
  | "stopped"
  | "unreachable"
  | "interrupted"
  | "failed";
export interface BayExecution {
  kind: "bay";
  socket: string;
  sessionName: string;
  recordId: string;
  generation: number;
  agent: AgentDefinition;
  repos: readonly string[];
}
export interface Attempt {
  id: string;
  taskId: string;
  number: number;
  revision: number;
  inputArtifactId: string | null;
  dependencies: readonly TaskDependency[];
  depth: number;
  conversationId: string | null;
  cwd: string;
  status: AttemptStatus;
  desired: "running" | "stopped";
  error: string | null;
  execution: BayExecution | null;
  grant: { maxChildren: number; maxDepth: number };
}
export interface RunEvent {
  sequence: number;
  runId: string;
  taskId: string | null;
  attemptId: string | null;
  type: string;
  at: string;
  data: Record<string, unknown>;
}
export interface RunDetail {
  run: Run;
  tasks: TaskDetail[];
  attempts: Attempt[];
  events: RunEvent[];
  reports: Report[];
  artifacts: Artifact[];
  integrations: Integration[];
  verifications: Verification[];
  questions: Question[];
}

/** Exact attempt scope provided to artifact adapters. */
export interface ExecutionContext {
  run: Run;
  task: Task;
  attempt: Attempt;
}
