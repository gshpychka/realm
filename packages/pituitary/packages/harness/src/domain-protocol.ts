import { createHash } from "node:crypto";

/** Authority is assigned by the host, never supplied by a model tool argument. */
export interface WorkerAssignment {
  runId: string;
  taskId: string;
  attemptId: string;
  epoch: number;
}

export type DomainCommand =
  | { type: "delegate"; agent: string; objective: string; acceptance?: string[] }
  | { type: "inspect"; taskId?: string }
  | { type: "message"; to: string; body: string; replyTo?: string }
  | { type: "submit"; summary: string }
  | { type: "yield"; reason?: string };

export interface DomainRequest {
  type: "domain_request";
  id: string;
  assistantEntryId: string;
  toolCallId: string;
  command: DomainCommand;
}

export type DomainResult =
  | { type: "domain_result"; id: string; success: true; data: unknown }
  | { type: "domain_result"; id: string; success: false; error: string };

export interface InboxMessage {
  id: string;
  from: string;
  taskId?: string;
  body: string;
  replyTo?: string;
}

export interface InboxDelivery {
  type: "deliver";
  batchId: string;
  messages: InboxMessage[];
  wake: boolean;
}

const identifier = (value: unknown): value is string =>
  typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,255}$/.test(value);

export function validateAssignment(value: unknown): WorkerAssignment {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid worker assignment");
  const assignment = value as Record<string, unknown>;
  if (
    Object.keys(assignment).some((key) => !["runId", "taskId", "attemptId", "epoch"].includes(key)) ||
    !identifier(assignment.runId) ||
    !identifier(assignment.taskId) ||
    !identifier(assignment.attemptId) ||
    !Number.isSafeInteger(assignment.epoch) ||
    (assignment.epoch as number) < 1
  )
    throw new Error("invalid worker assignment");
  return {
    runId: assignment.runId,
    taskId: assignment.taskId,
    attemptId: assignment.attemptId,
    epoch: assignment.epoch as number,
  };
}

export function validateDomainCommand(value: unknown): DomainCommand {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid domain command");
  const command = value as Record<string, unknown>;
  const text = (key: string, limit: number, optional = false): string | undefined => {
    const item = command[key];
    if (optional && item === undefined) return undefined;
    if (typeof item !== "string" || !item.trim() || Buffer.byteLength(item) > limit)
      throw new Error(`invalid domain ${key}`);
    return item;
  };
  const known = (...keys: string[]) => {
    if (Object.keys(command).some((key) => !["type", ...keys].includes(key)))
      throw new Error("unknown domain command field");
  };
  switch (command.type) {
    case "delegate": {
      known("agent", "objective", "acceptance");
      if (typeof command.agent !== "string" || !/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(command.agent))
        throw new Error("invalid delegate agent");
      if (
        command.acceptance !== undefined &&
        (!Array.isArray(command.acceptance) ||
          command.acceptance.length > 32 ||
          command.acceptance.some(
            (item) => typeof item !== "string" || !item.trim() || Buffer.byteLength(item) > 4096,
          ))
      )
        throw new Error("invalid delegation acceptance conditions");
      return {
        type: "delegate",
        agent: command.agent,
        objective: text("objective", 64 * 1024) as string,
        ...(command.acceptance ? { acceptance: [...(command.acceptance as string[])] } : {}),
      };
    }
    case "inspect":
      known("taskId");
      if (command.taskId !== undefined && !identifier(command.taskId))
        throw new Error("invalid inspected task ID");
      return { type: "inspect", ...(command.taskId ? { taskId: command.taskId as string } : {}) };
    case "message":
      known("to", "body", "replyTo");
      if (!identifier(command.to) || (command.replyTo !== undefined && !identifier(command.replyTo)))
        throw new Error("invalid message recipient or reply ID");
      return {
        type: "message",
        to: command.to,
        body: text("body", 64 * 1024) as string,
        ...(command.replyTo ? { replyTo: command.replyTo as string } : {}),
      };
    case "submit":
      known("summary");
      return { type: "submit", summary: text("summary", 64 * 1024) as string };
    case "yield": {
      known("reason");
      const reason = text("reason", 4096, true);
      return { type: "yield", ...(reason ? { reason } : {}) };
    }
    default:
      throw new Error("unknown domain command");
  }
}

export function validateDelivery(value: InboxDelivery): InboxDelivery {
  if (
    !value ||
    value.type !== "deliver" ||
    Object.keys(value).some((key) => !["type", "batchId", "messages", "wake"].includes(key)) ||
    !identifier(value.batchId) ||
    !Array.isArray(value.messages) ||
    !value.messages.length ||
    value.messages.length > 64 ||
    typeof value.wake !== "boolean"
  )
    throw new Error("invalid inbox delivery");
  if (Buffer.byteLength(JSON.stringify(value)) > 256 * 1024)
    throw new Error("inbox delivery exceeds 256 KiB");
  const messages = value.messages.map((message): InboxMessage => {
    if (
      !message ||
      !identifier(message.id) ||
      !identifier(message.from) ||
      typeof message.body !== "string" ||
      !message.body.trim() ||
      Buffer.byteLength(message.body) > 64 * 1024 ||
      (message.taskId !== undefined && !identifier(message.taskId)) ||
      (message.replyTo !== undefined && !identifier(message.replyTo))
    )
      throw new Error("invalid inbox message");
    if (Object.keys(message).some((key) => !["id", "from", "taskId", "body", "replyTo"].includes(key)))
      throw new Error("unknown inbox message field");
    return {
      id: message.id,
      from: message.from,
      body: message.body,
      ...(message.taskId ? { taskId: message.taskId } : {}),
      ...(message.replyTo ? { replyTo: message.replyTo } : {}),
    };
  });
  if (new Set(messages.map((message) => message.id)).size !== messages.length)
    throw new Error("duplicate inbox message ID");
  return { type: "deliver", batchId: value.batchId, messages, wake: value.wake };
}

export function domainRequestId(
  assignment: WorkerAssignment,
  assistantEntryId: string,
  toolCallId: string,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        assignment.runId,
        assignment.taskId,
        assignment.attemptId,
        assignment.epoch,
        assistantEntryId,
        toolCallId,
      ]),
    )
    .digest("hex");
}
