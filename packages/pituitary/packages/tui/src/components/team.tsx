import type { ScrollBoxRenderable } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { plain } from "@pituitary/session";
import type { RunDetail } from "@realm/dura/types";
import { useEffect, useRef, useState } from "react";
import { palette, theme } from "../theme.ts";
import { Markdown } from "./markdown.tsx";

export type TeamTask = RunDetail["tasks"][number];
export type TeamQuestion = RunDetail["questions"][number];

export interface ConversationState {
  draft: string;
  cursor: number;
  scrollTop: number | null;
  window: number;
  expanded: boolean;
  thinking: boolean;
}

export interface TeamContext {
  detail: RunDetail;
  taskId: string;
  busy: string | null;
  error: string | null;
  canBack: boolean;
  select(taskId: string, view: ConversationState): void;
  back(view: ConversationState): void;
  join(view: ConversationState): void;
  answer(questionId: string, text: string): Promise<void>;
  retry(task: TeamTask): Promise<void>;
  revise(task: TeamTask, objective: string): Promise<void>;
  integrate(task: TeamTask): Promise<void>;
  apply(task: TeamTask): Promise<void>;
}

export function resolveReport(detail: RunDetail, task: TeamTask) {
  return detail.reports.find((report) => report.id === task.reportId) ?? null;
}

export function taskState(detail: RunDetail, task: TeamTask): string {
  const question = detail.questions.find(
    (question) => question.taskId === task.id && question.status === "open",
  );
  if (question) return "needs your answer";
  const attempt = detail.attempts.find((attempt) => attempt.id === task.currentAttemptId);
  if (attempt?.error) return plain(attempt.error).split("\n")[0] ?? "failed";
  if (task.status === "waiting") {
    const names = task.waitFor.map((id) => detail.tasks.find((task) => task.id === id)?.role ?? "task");
    return names.length ? `waiting for ${names.join(", ")}` : "waiting for a message";
  }
  if (task.status === "submitting") return "retaining code result";
  if (task.status === "accepted")
    return detail.verifications.some((item) => item.id === task.verificationId && item.status === "passed")
      ? "verified"
      : "accepted";
  if (task.status === "conflicted") return "integration conflict";
  if (task.status === "submitted") {
    if (!task.artifactId) return "report submitted";
    const integration = detail.integrations.find((item) => item.id === task.integrationId);
    const verification = detail.verifications.find((item) => item.id === task.verificationId);
    if (integration?.status === "pending") return "integrating retained code";
    if (integration?.status === "conflicted") return "integration conflict";
    if (integration?.status === "failed") return "integration failed";
    if (integration?.status === "stale") return "integration changed";
    if (verification) return `independent checks ${verification.status}`;
    if (integration?.status === "integrated")
      return verificationPolicy(detail, task)
        ? "awaiting independent checks"
        : "code integrated · no verification policy";
    return "code retained · awaiting integration";
  }
  if (task.status === "superseded") return "inputs changed · needs a new attempt";
  if (attempt?.status === "starting") return "starting environment";
  if (attempt?.status === "unreachable") return "connection interrupted";
  return task.status;
}

const tone = (task: TeamTask) =>
  task.status === "accepted"
    ? theme.ok
    : ["failed", "conflicted", "superseded"].includes(task.status)
      ? theme.error
      : ["waiting", "submitting", "verifying"].includes(task.status)
        ? theme.tool
        : theme.dim;

export function resultBadges(detail: RunDetail, task: TeamTask): string {
  const verification = detail.verifications.find((item) => item.id === task.verificationId);
  return [
    task.reportId ? "report" : null,
    task.artifactId ? "code retained" : null,
    verification
      ? verification.status === "passed"
        ? `verified ${verification.checks.length}/${verification.checks.length}`
        : `checks ${verification.status}`
      : task.artifactId
        ? "unverified"
        : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

function verificationPolicy(detail: RunDetail, task: TeamTask) {
  return (
    detail.attempts.find((item) => item.id === task.currentAttemptId)?.execution?.agent.verification ?? null
  );
}
export function readyToApply(detail: RunDetail, task: TeamTask): boolean {
  const accepted = detail.run.acceptedArtifactId;
  const verification = detail.verifications.find((item) => item.id === task.verificationId);
  return Boolean(
    accepted &&
      accepted === detail.run.integrationArtifactId &&
      verification?.status === "passed" &&
      verification.artifactId === accepted &&
      verification.revision === task.revision &&
      verification.integrationId === task.integrationId,
  );
}

function TaskCard({
  detail,
  task,
  selected,
  open,
  compact = false,
}: {
  detail: RunDetail;
  task: TeamTask;
  selected: boolean;
  open(): void;
  compact?: boolean;
}) {
  const state = taskState(detail, task);
  return (
    <box
      flexDirection="column"
      flexShrink={0}
      paddingLeft={1}
      paddingRight={1}
      paddingTop={compact ? 0 : 1}
      backgroundColor={selected ? palette.bar : theme.bg}
      onMouseDown={(event) => {
        if (event.button === 0) open();
      }}
    >
      <text truncate wrapMode="none" fg={selected ? theme.assistant : palette.muted}>
        {selected ? "› " : "  "}
        {task.role ?? "solo"}
        <span fg={theme.dim}> · {plain(task.objective).split("\n")[0] || "Conversation"}</span>
      </text>
      <text truncate wrapMode="none" fg={tone(task)}>
        {" "}
        {state}
      </text>
      {!compact && resultBadges(detail, task) ? (
        <text fg={theme.dim} truncate wrapMode="none">
          {" "}
          {resultBadges(detail, task)}
        </text>
      ) : null}
    </box>
  );
}

export function TeamHeader({
  team,
  tasks,
  attention,
  back,
  result,
}: {
  team: TeamContext;
  tasks(): void;
  attention(): void;
  back(): void;
  result(): void;
}) {
  const task = team.detail.tasks.find((task) => task.id === team.taskId);
  const questions = team.detail.questions.filter((question) => question.status === "open");
  return (
    <box
      flexDirection="row"
      flexShrink={0}
      height={1}
      paddingLeft={1}
      paddingRight={1}
      backgroundColor={palette.bar}
    >
      <text fg={theme.dim} onMouseDown={back}>
        {team.canBack ? "‹ back · " : ""}
      </text>
      <text flexGrow={1} fg={theme.assistant} truncate wrapMode="none" onMouseDown={tasks}>
        {team.detail.run.name} · {task?.role ?? "solo"}
        <span fg={theme.dim}> · {task ? taskState(team.detail, task) : "connecting"}</span>
      </text>
      <text fg={questions.length ? theme.tool : theme.dim} onMouseDown={attention}>
        {questions.length ? `${questions.length} need you · ` : ""}
      </text>
      <text fg={theme.dim} onMouseDown={tasks}>
        tasks
      </text>
      {task?.reportId ? (
        <text fg={task.status === "accepted" ? theme.ok : theme.tool} onMouseDown={result}>
          {" "}
          · result
        </text>
      ) : null}
    </box>
  );
}

export function TeamCards({
  team,
  wide,
  open,
}: {
  team: TeamContext;
  wide: boolean;
  open(taskId: string): void;
}) {
  const [remaining, setRemaining] = useState(() =>
    Math.max(0, Math.ceil((team.detail.run.deadline - Date.now()) / 60000)),
  );
  useEffect(() => {
    if (!wide) return;
    const timer = setInterval(
      () => setRemaining(Math.max(0, Math.ceil((team.detail.run.deadline - Date.now()) / 60000))),
      1000,
    );
    return () => clearInterval(timer);
  }, [team.detail.run.deadline, wide]);
  const items = wide
    ? team.detail.tasks
    : team.detail.tasks.filter((task) => task.parentTaskId === team.taskId).slice(0, 2);
  const live =
    team.detail.attempts.filter(
      (attempt) => attempt.desired === "running" && !["queued", "stopped", "failed"].includes(attempt.status),
    ).length + team.detail.verifications.filter((item) => item.status === "running").length;
  if (!wide && !items.length) return null;
  return (
    <box
      flexDirection="column"
      flexShrink={0}
      minHeight={0}
      width={wide ? 35 : "100%"}
      border={wide ? ["left"] : []}
      borderColor={theme.border}
      paddingBottom={wide ? 1 : 0}
    >
      {wide ? (
        <box paddingLeft={1} paddingTop={1} flexShrink={0}>
          <text fg={theme.dim}>
            WORK · {live}/{team.detail.run.limits.maxLiveAttempts} active · {remaining}m left
          </text>
        </box>
      ) : null}
      {wide ? (
        <scrollbox flexGrow={1} minHeight={0} scrollX={false} focusable={false}>
          {items.map((task) => (
            <TaskCard
              key={task.id}
              detail={team.detail}
              task={task}
              selected={task.id === team.taskId}
              open={() => open(task.id)}
            />
          ))}
        </scrollbox>
      ) : (
        items.map((task) => (
          <TaskCard
            key={task.id}
            detail={team.detail}
            task={task}
            selected={false}
            open={() => open(task.id)}
            compact
          />
        ))
      )}
      {wide ? (
        <box paddingLeft={1} paddingTop={1} flexShrink={0}>
          <text fg={theme.dim}>ctrl+k tasks · ctrl+q attention</text>
        </box>
      ) : null}
    </box>
  );
}

export function TaskResult({
  detail,
  taskId,
  rows,
  close,
  integrate,
  retry,
  revise,
  apply,
  copy,
}: {
  detail: RunDetail;
  taskId: string;
  rows: number;
  close(): void;
  integrate(task: TeamTask): void;
  retry(task: TeamTask): void;
  revise(task: TeamTask): void;
  apply(task: TeamTask): void;
  copy(text: string): void;
}) {
  const task = detail.tasks.find((task) => task.id === taskId);
  const scroll = useRef<ScrollBoxRenderable | null>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setReady(true), 400);
    return () => clearTimeout(timer);
  }, []);
  const report = task ? resolveReport(detail, task) : null;
  const artifact = detail.artifacts.find((item) => item.id === task?.artifactId);
  const integration = detail.integrations.find((item) => item.id === task?.integrationId);
  const verification = detail.verifications.find((item) => item.id === task?.verificationId);
  const canApply = task ? readyToApply(detail, task) : false;
  const canIntegrate = Boolean(
    detail.run.desired === "running" &&
      artifact &&
      task?.status !== "accepted" &&
      !["pending", "integrated"].includes(integration?.status ?? ""),
  );
  useKeyboard((key) => {
    if (!ready || key.ctrl || key.meta || key.shift) return;
    if (key.name === "escape") {
      key.preventDefault();
      close();
      return;
    }
    if (key.name === "pageup" || key.name === "pagedown") {
      key.preventDefault();
      scroll.current?.scrollBy(
        (key.name === "pageup" ? -1 : 1) * Math.max(1, Math.floor((scroll.current?.height ?? 8) / 2)),
      );
      return;
    }
    if (!task) return;
    if (key.name === "i" && canIntegrate) {
      key.preventDefault();
      integrate(task);
    } else if (key.name === "r") {
      key.preventDefault();
      retry(task);
    } else if (key.name === "e") {
      key.preventDefault();
      revise(task);
    } else if (key.name === "a" && canApply) {
      key.preventDefault();
      apply(task);
    } else if (key.name === "c" && report) {
      key.preventDefault();
      copy(report.text);
    }
  });
  if (!task) return null;
  return (
    <box
      flexDirection="column"
      flexShrink={0}
      border
      borderColor={theme.border}
      paddingLeft={1}
      paddingRight={1}
    >
      <text fg={theme.assistant}>
        RESULT · {task.role ?? "solo"} · revision {task.revision}
        <span fg={tone(task)}> · {taskState(detail, task)}</span>
      </text>
      <scrollbox ref={scroll} maxHeight={Math.max(3, rows - 4)} scrollX={false} focusable={false}>
        <Markdown content={plain(report?.text ?? "No report has been submitted for this revision.")} />
        {artifact ? (
          <text fg={theme.dim}>
            Code retained · tree {artifact.tree.slice(0, 12)} · {artifact.bytes.toLocaleString()} bytes
          </text>
        ) : null}
        {integration ? (
          <text fg={integration.status === "conflicted" ? theme.error : theme.dim}>
            Integration: {integration.status}
            {integration.conflicts.length ? ` · ${integration.conflicts.map(plain).join(", ")}` : ""}
            {integration.error ? ` · ${plain(integration.error)}` : ""}
          </text>
        ) : null}
        {verification ? (
          <box flexDirection="column">
            <text fg={verification.status === "passed" ? theme.ok : theme.tool}>
              Independent checks: {verification.status} · tree {verification.tree.slice(0, 12)}
            </text>
            {verification.checks.map((check) => (
              <box key={check.name} flexDirection="column" flexShrink={0}>
                <text fg={check.status === "passed" ? theme.ok : theme.error}>
                  {check.status === "passed" ? "✓" : "!"} {plain(check.name)} · {check.status}
                </text>
                {check.status !== "passed" && check.output ? (
                  <text fg={theme.dim}>{plain(check.output)}</text>
                ) : null}
                {check.truncated ? <text fg={theme.dim}>… output truncated</text> : null}
              </box>
            ))}
            {verification.error ? <text fg={theme.error}>{plain(verification.error)}</text> : null}
          </box>
        ) : artifact ? (
          <text fg={theme.tool}>
            {verificationPolicy(detail, task)
              ? "Independent verification pending."
              : "No independent verification policy is declared for this role."}
          </text>
        ) : null}
        {canApply ? (
          <text fg={theme.dim} truncate wrapMode="none">
            Ready to apply to {plain(detail.run.cwd)}
          </text>
        ) : null}
      </scrollbox>
      <text fg={theme.dim}>
        {canIntegrate ? "i integrate · " : ""}
        {canApply ? "a apply · " : ""}r retry · e revise · {report ? "c copy · " : ""}esc back
      </text>
    </box>
  );
}
