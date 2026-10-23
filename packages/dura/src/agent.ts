import { createHash } from "node:crypto";

export const AGENT_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const;
export type AgentTool = (typeof AGENT_TOOLS)[number];

/** Evaluated role data travels separately from the NixOS image and contains no credentials. */
export interface AgentManifest {
  schemaVersion: 1;
  name: string;
  description: string;
  instructions: string;
  model: string | null;
  tools: AgentTool[];
  delegatesTo: string[];
  credentials: string[];
  /** Declarative delegation authority for this role. */
  limits: { maxChildren: number; maxDepth: number };
}

export function validateAgentManifest(value: unknown): AgentManifest {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("agent manifest must be an object");
  const object = value as Record<string, unknown>;
  if (Buffer.byteLength(JSON.stringify(object)) > 2 * 1024 * 1024)
    throw new Error("agent manifest exceeds its byte limit");
  const keys = [
    "schemaVersion",
    "name",
    "description",
    "instructions",
    "model",
    "tools",
    "delegatesTo",
    "credentials",
    "limits",
  ];
  if (Object.keys(object).some((key) => !keys.includes(key)))
    throw new Error("agent manifest contains an unknown field");
  const name = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
  let limits: AgentManifest["limits"];
  {
    if (!object.limits || typeof object.limits !== "object" || Array.isArray(object.limits))
      throw new Error("agent limits must be an object");
    const declaration = object.limits as Record<string, unknown>;
    if (
      Object.keys(declaration).some((key) => !["maxChildren", "maxDepth"].includes(key)) ||
      !Number.isSafeInteger(declaration.maxChildren) ||
      (declaration.maxChildren as number) < 0 ||
      !Number.isSafeInteger(declaration.maxDepth) ||
      (declaration.maxDepth as number) < 0
    )
      throw new Error("agent limits must be non-negative safe integers");
    limits = { maxChildren: declaration.maxChildren as number, maxDepth: declaration.maxDepth as number };
  }
  if (object.schemaVersion !== 1) throw new Error("unsupported agent manifest version");
  if (typeof object.name !== "string" || !name.test(object.name))
    throw new Error("agent manifest has an invalid name");
  if (typeof object.description !== "string" || typeof object.instructions !== "string")
    throw new Error("agent description and instructions must be strings");
  if (Buffer.byteLength(object.description) + Buffer.byteLength(object.instructions) > 1024 * 1024)
    throw new Error("agent instructions exceed the manifest limit");
  if (object.model !== null && (typeof object.model !== "string" || !/^[^/\s]+\/[^\s]+$/.test(object.model)))
    throw new Error("agent model must be provider/model or null");
  const list = (
    key: "tools" | "delegatesTo" | "credentials",
    accepts: (item: string) => boolean,
  ): string[] => {
    const items = object[key];
    if (!Array.isArray(items) || items.some((item) => typeof item !== "string" || !accepts(item)))
      throw new Error(`agent ${key} contains an invalid value`);
    if (new Set(items).size !== items.length) throw new Error(`agent ${key} contains duplicate values`);
    return [...items];
  };
  return {
    schemaVersion: 1,
    name: object.name,
    description: object.description,
    instructions: object.instructions,
    model: object.model,
    tools: list("tools", (item) => (AGENT_TOOLS as readonly string[]).includes(item)) as AgentTool[],
    delegatesTo: list("delegatesTo", (item) => name.test(item)),
    credentials: list("credentials", (item) => /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(item)),
    limits,
  };
}

export function agentManifestDigest(manifest: AgentManifest): string {
  return createHash("sha256").update(canonical(manifest)).digest("hex");
}

/** Stable IDs identify payloads, independently of JSON property ordering. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
