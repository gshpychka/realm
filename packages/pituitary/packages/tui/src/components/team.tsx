import type { ScrollBoxRenderable } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { plain } from "@pituitary/session";
import type { RunDetail } from "@realm/dura/types";
import { useEffect, useRef, useState } from "react";
import { CURRENT, type Hint, hintLine } from "../hints.ts";
import { keyHint, useKeymap } from "../keymap-context.tsx";
import { counted } from "../plural.ts";
import { ellipsize, wrapCells } from "../text-width.ts";
import { palette, theme } from "../theme.ts";
import { GRACE_MS } from "./dialog.tsx";
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

/** Task states that stopped short of a result and need the operator to act. */
const FAILED = new Set<TeamTask["status"]>(["failed", "conflicted", "superseded"]);

const tone = (task: TeamTask) =>
  task.status === "accepted"
    ? theme.ok
    : FAILED.has(task.status)
      ? theme.error
      : ["waiting", "submitting", "verifying"].includes(task.status)
        ? theme.tool
        : theme.dim;

/** Whether `task` waits on the operator's answer. */
const asks = (detail: RunDetail, task: TeamTask) =>
  detail.questions.some((question) => question.taskId === task.id && question.status === "open");

/** Whether `task`, or the attempt running it, failed. */
const failed = (detail: RunDetail, task: TeamTask) =>
  FAILED.has(task.status) ||
  Boolean(detail.attempts.find((attempt) => attempt.id === task.currentAttemptId)?.error);

/** Child tasks a narrow screen shows under the conversation, each in two rows. */
const NARROW_TASKS = 2;

/**
 * The children of `taskId` a narrow screen shows, those waiting on the operator first, then
 * failures, and what it leaves out: how many, and how many of those failed.
 */
function narrowTasks(detail: RunDetail, taskId: string) {
  const urgency = (task: TeamTask) => (asks(detail, task) ? 0 : failed(detail, task) ? 1 : 2);
  const children = detail.tasks
    .filter((task) => task.parentTaskId === taskId)
    .toSorted((a, b) => urgency(a) - urgency(b));
  const hidden = children.slice(NARROW_TASKS);
  return {
    tasks: children.slice(0, NARROW_TASKS),
    hidden: hidden.length,
    hiddenFailed: hidden.filter((task) => failed(detail, task)).length,
  };
}

/** Columns from which the team's tasks take a panel beside the conversation. */
const WIDE_COLUMNS = 120;

/** Whether a screen `columns` wide puts the team's tasks in a panel beside the conversation. */
export const wideTeam = (columns: number) => columns >= WIDE_COLUMNS;

/** The side panel's share of the screen, kept wide enough to tell objectives apart. */
function teamPanelWidth(columns: number): number {
  return Math.max(35, Math.min(60, Math.round(columns * 0.3)));
}

/** Rows the team takes above the editor: its header, a narrow screen's tasks, and a busy or error line. */
export function teamRows(team: TeamContext, columns: number): number {
  const narrow = narrowTasks(team.detail, team.taskId);
  const cards = wideTeam(columns) ? 0 : narrow.tasks.length * 2 + (narrow.hidden > 0 ? 1 : 0);
  return 1 + cards + (team.busy || team.error ? 1 : 0);
}

/** Cells a card's rows are set in by, which nests the cards under the header's task. */
const INDENT = 2;

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
  current,
  open,
  width,
  compact = false,
}: {
  detail: RunDetail;
  task: TeamTask;
  /** The conversation is attached to this task. */
  current: boolean;
  open(): void;
  /** Columns the card takes, its padding included. */
  width: number;
  compact?: boolean;
}) {
  const state = taskState(detail, task);
  const badges = compact ? "" : resultBadges(detail, task);
  // The panel's cards wrap the objective to a second row and the narrow list keeps one; both
  // cut at the end, so objectives that start alike still read apart.
  const room = Math.max(1, width - 2 - INDENT);
  const role = plain(task.role ?? "solo");
  const mark = current ? CURRENT : "";
  const [title = "", ...more] = wrapCells(
    `${role}${mark} · ${plain(task.objective).split("\n")[0] || "Conversation"}`,
    room,
    compact ? 1 : 2,
  );
  const indent = " ".repeat(INDENT);
  return (
    <box
      flexDirection="column"
      flexShrink={0}
      paddingLeft={1}
      paddingRight={1}
      paddingTop={compact ? 0 : 1}
      backgroundColor={current ? palette.bar : theme.bg}
      onMouseDown={(event) => {
        if (event.button === 0) open();
      }}
    >
      <text selectable={false} wrapMode="none" fg={current ? theme.assistant : palette.muted}>
        {indent}
        {title.slice(0, role.length)}
        <span fg={palette.yellow}>{title.slice(role.length, role.length + mark.length)}</span>
        <span fg={theme.dim}>{title.slice(role.length + mark.length)}</span>
      </text>
      {more.map((row) => (
        <text key={row} selectable={false} wrapMode="none" fg={theme.dim}>
          {indent}
          {row}
        </text>
      ))}
      <text selectable={false} wrapMode="none" fg={tone(task)}>
        {indent}
        {ellipsize(state, room)}
      </text>
      {badges ? (
        <text selectable={false} fg={theme.dim} wrapMode="none">
          {indent}
          {ellipsize(badges, room)}
        </text>
      ) : null}
    </box>
  );
}

/**
 * The run and the task this conversation is attached to, then what needs the operator and the
 * ways to the tasks and the result. The run's side is cut at its end to leave the other a gap.
 */
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
  const { width } = useTerminalDimensions();
  const task = team.detail.tasks.find((task) => task.id === team.taskId);
  const questions = team.detail.questions.filter((question) => question.status === "open");
  const returns = team.canBack ? "‹ back · " : "";
  const asking = questions.length
    ? `${questions.length} ${questions.length === 1 ? "needs" : "need"} you · `
    : "";
  const reported = task?.reportId ? " · result" : "";
  const where = `${plain(team.detail.run.name)} · ${plain(task?.role ?? "solo")}`;
  const title = ellipsize(
    `${where} · ${task ? taskState(team.detail, task) : "connecting"}`,
    // The padding, the way back, and a cell of gap before the right side.
    width - 2 - Bun.stringWidth(returns) - Bun.stringWidth(`${asking}tasks${reported}`) - 1,
  );
  return (
    <box
      flexDirection="row"
      flexShrink={0}
      height={1}
      paddingLeft={1}
      paddingRight={1}
      backgroundColor={palette.bar}
    >
      {returns ? (
        <text selectable={false} fg={theme.dim} flexShrink={0} wrapMode="none" onMouseDown={back}>
          {returns}
        </text>
      ) : null}
      <text selectable={false} flexGrow={1} fg={theme.assistant} wrapMode="none" onMouseDown={tasks}>
        {title.slice(0, where.length)}
        <span fg={theme.dim}>{title.slice(where.length)}</span>
      </text>
      <box flexDirection="row" flexShrink={0}>
        {asking ? (
          <text selectable={false} fg={theme.tool} wrapMode="none" onMouseDown={attention}>
            {asking}
          </text>
        ) : null}
        <text selectable={false} fg={theme.dim} wrapMode="none" onMouseDown={tasks}>
          tasks
        </text>
        {reported ? (
          <text
            selectable={false}
            fg={task?.status === "accepted" ? theme.ok : theme.tool}
            wrapMode="none"
            onMouseDown={result}
          >
            {reported}
          </text>
        ) : null}
      </box>
    </box>
  );
}

const SECOND = 1000;

/**
 * What remains of the run's time, and for how many milliseconds that reading holds. It counts
 * whole minutes, and hours past an hour, rounded down so it never promises more time than
 * there is, and seconds only in the last minute.
 */
function timeLeft(deadline: number, now: number): { text: string; holds: number | null } {
  const left = deadline - now;
  if (left <= 0) return { text: "overdue", holds: null };
  const seconds = Math.ceil(left / SECOND);
  // Each reading holds until the seconds left drop below the least it reads as.
  if (seconds < 60) return { text: `${seconds}s left`, holds: left - (seconds - 1) * SECOND };
  const minutes = Math.floor(seconds / 60);
  const text = minutes < 60 ? `${minutes}m left` : `${Math.floor(minutes / 60)}h ${minutes % 60}m left`;
  return { text, holds: left - (minutes * 60 - 1) * SECOND };
}

/** The run's time left, redrawn when its reading changes while `active`. */
function useTimeLeft(deadline: number, active: boolean): string {
  const [now, setNow] = useState(Date.now);
  const { text, holds } = timeLeft(deadline, now);
  // biome-ignore lint/correctness/useExhaustiveDependencies: each new `now` waits for the reading after it, though `holds` may repeat
  useEffect(() => {
    if (!active || holds === null) return;
    const timer = setTimeout(() => setNow(Date.now()), holds);
    return () => clearTimeout(timer);
  }, [active, holds, now]);
  return text;
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
  const { width: columns } = useTerminalDimensions();
  const bindings = useKeymap();
  const left = useTimeLeft(team.detail.run.deadline, wide);
  const narrow = narrowTasks(team.detail, team.taskId);
  const items = wide ? team.detail.tasks : narrow.tasks;
  const width = wide ? teamPanelWidth(columns) : columns;
  const live =
    team.detail.attempts.filter(
      (attempt) => attempt.desired === "running" && !["queued", "stopped", "failed"].includes(attempt.status),
    ).length + team.detail.verifications.filter((item) => item.status === "running").length;
  const tasksKey = keyHint(bindings, "app.team.tasks");
  const attentionKey = keyHint(bindings, "app.team.attention");
  if (!wide && !items.length) return null;
  return (
    <box
      flexDirection="column"
      flexShrink={0}
      minHeight={0}
      width={width}
      border={wide ? ["left"] : []}
      borderColor={theme.border}
      paddingBottom={wide ? 1 : 0}
    >
      {wide ? (
        <box paddingLeft={1} paddingTop={1} flexShrink={0}>
          <text selectable={false} fg={theme.dim}>
            work · {live}/{team.detail.run.limits.maxLiveAttempts} active · {left}
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
              current={task.id === team.taskId}
              open={() => open(task.id)}
              // The panel's left border takes a column of its width.
              width={width - 1}
            />
          ))}
        </scrollbox>
      ) : (
        items.map((task) => (
          <TaskCard
            key={task.id}
            detail={team.detail}
            task={task}
            current={false}
            open={() => open(task.id)}
            width={width}
            compact
          />
        ))
      )}
      {!wide && narrow.hidden > 0 ? (
        <box paddingLeft={1 + INDENT} flexShrink={0} height={1}>
          <text selectable={false} fg={narrow.hiddenFailed ? theme.error : theme.dim} wrapMode="none">
            {ellipsize(
              [
                `+${narrow.hidden} more`,
                narrow.hiddenFailed ? `${narrow.hiddenFailed} failed` : null,
                tasksKey ? `${tasksKey} tasks` : "/tasks",
              ]
                .filter(Boolean)
                .join(" · "),
              width - 2 - INDENT,
            )}
          </text>
        </box>
      ) : null}
      {wide && (tasksKey || attentionKey) ? (
        <box paddingLeft={1} paddingTop={1} flexShrink={0}>
          <text selectable={false} fg={theme.dim} wrapMode="none">
            {hintLine(
              [tasksKey ? [tasksKey, "tasks"] : null, attentionKey ? [attentionKey, "attention"] : null],
              null,
              width - 2,
            )}
          </text>
        </box>
      ) : null}
    </box>
  );
}

/** Units a size is counted in past a thousand and twenty-four bytes. */
const BYTE_UNITS = ["KiB", "MiB", "GiB", "TiB"] as const;

/** A size as the operator reads it: `512 bytes`, `1.5 KiB`, `8 KiB`, `217 KiB`. */
function byteSize(bytes: number): string {
  if (bytes < 1024) return counted(bytes, "byte");
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? Math.round(value * 10) / 10 : Math.round(value)} ${BYTE_UNITS[unit]}`;
}

/** A result panel action that reaches beyond the panel, and so waits for a second press. */
type Weighty = "retry" | "apply";

/** The key of each weighty action. */
const WEIGHTY_KEYS: Record<Weighty, string> = { retry: "r", apply: "a" };

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
  const { width } = useTerminalDimensions();
  const task = detail.tasks.find((task) => task.id === taskId);
  const scroll = useRef<ScrollBoxRenderable | null>(null);
  const [ready, setReady] = useState(false);
  // A first press of a weighty action's key asks for a second; any other key lets it go. Keys
  // can arrive faster than React draws, so the press waiting is read from a ref.
  const [armed, setArmed] = useState<Weighty | null>(null);
  const waiting = useRef<Weighty | null>(null);
  useEffect(() => {
    const timer = setTimeout(() => setReady(true), GRACE_MS);
    return () => clearTimeout(timer);
  }, []);
  const report = task ? resolveReport(detail, task) : null;
  const artifact = detail.artifacts.find((item) => item.id === task?.artifactId);
  const integration = detail.integrations.find((item) => item.id === task?.integrationId);
  const verification = detail.verifications.find((item) => item.id === task?.verificationId);
  const canApply = task ? readyToApply(detail, task) : false;
  const canRetry = task?.status !== "accepted";
  const canIntegrate = Boolean(
    detail.run.desired === "running" &&
      artifact &&
      task?.status !== "accepted" &&
      !["pending", "integrated"].includes(integration?.status ?? ""),
  );
  const workspace = () => plain(detail.run.cwd);
  /** Whether each weighty action is open to the task, what it does, and what its second press does. */
  const weighty: Record<Weighty, { can: boolean; run(task: TeamTask): void; again(): string }> = {
    retry: { can: canRetry, run: retry, again: () => "start a fresh attempt" },
    apply: { can: canApply, run: apply, again: () => `apply to ${workspace()}` },
  };
  useKeyboard((key) => {
    if (!ready || key.ctrl || key.meta || key.shift) return;
    const pressed = (Object.keys(WEIGHTY_KEYS) as Weighty[]).find(
      (action) => WEIGHTY_KEYS[action] === key.name && weighty[action].can,
    );
    const confirmed = pressed !== undefined && waiting.current === pressed;
    const wasArmed = waiting.current !== null;
    waiting.current = pressed && !confirmed ? pressed : null;
    setArmed(waiting.current);
    if (key.name === "escape") {
      key.preventDefault();
      // Esc steps out of a waiting confirmation first, and closes the panel from there.
      if (!wasArmed) close();
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
    if (pressed) {
      key.preventDefault();
      if (confirmed) weighty[pressed].run(task);
    } else if (key.name === "i" && canIntegrate) {
      key.preventDefault();
      integrate(task);
    } else if (key.name === "e") {
      key.preventDefault();
      revise(task);
    } else if (key.name === "c" && report) {
      key.preventDefault();
      copy(report.text);
    }
  });
  if (!task) return null;
  const keys: (Hint | null)[] = [
    canIntegrate ? ["i", "integrate"] : null,
    canApply ? [WEIGHTY_KEYS.apply, "apply"] : null,
    canRetry ? [WEIGHTY_KEYS.retry, "retry"] : null,
    ["e", "revise"],
    report ? ["c", "copy"] : null,
    ["esc", "back"],
  ];
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
        result · {task.role ?? "solo"} · revision {task.revision}
        <span fg={tone(task)}> · {taskState(detail, task)}</span>
      </text>
      <scrollbox ref={scroll} maxHeight={Math.max(3, rows - 4)} scrollX={false} focusable={false}>
        <Markdown content={plain(report?.text ?? "No report has been submitted for this revision.")} />
        {artifact ? (
          <text fg={theme.dim}>
            Code retained · tree {artifact.tree.slice(0, 12)} · {byteSize(artifact.bytes)}
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
                <box flexDirection="row" flexShrink={0}>
                  <text
                    selectable={false}
                    flexShrink={0}
                    fg={check.status === "passed" ? theme.ok : theme.error}
                  >
                    {check.status === "passed" ? "✓" : "!"}{" "}
                  </text>
                  <text fg={check.status === "passed" ? theme.ok : theme.error}>
                    {plain(check.name)}
                    {check.status === "passed" ? "" : ` · ${check.status}`}
                  </text>
                </box>
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
          <text fg={theme.dim} wrapMode="none">
            {ellipsize(`Ready to apply to ${workspace()}`, width - 4)}
          </text>
        ) : null}
      </scrollbox>
      <text selectable={false} fg={armed ? theme.user : theme.dim} wrapMode="none">
        {armed
          ? ellipsize(`${WEIGHTY_KEYS[armed]} again to ${weighty[armed].again()}`, width - 4)
          : hintLine(keys, null, width - 4)}
      </text>
    </box>
  );
}
