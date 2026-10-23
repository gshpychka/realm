import { readFileSync } from "node:fs";
import { type AgentManifest, validateAgentManifest } from "./agent.ts";

export interface AgentDefinition {
  manifest: AgentManifest;
  program: string;
  machine: string;
  machineRevision: string;
  verification?: VerificationPolicy | null;
}
export interface VerificationPolicy {
  agent: string;
  checks: Readonly<Record<string, { command: readonly string[]; timeoutMs: number }>>;
}

export function validateVerificationPolicy(value: unknown): VerificationPolicy | null {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid verification policy");
  const policy = value as Record<string, unknown>;
  if (
    Object.keys(policy).some((key) => !["agent", "checks"].includes(key)) ||
    typeof policy.agent !== "string" ||
    !/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(policy.agent) ||
    !policy.checks ||
    typeof policy.checks !== "object" ||
    Array.isArray(policy.checks)
  )
    throw new Error("Invalid verification policy");
  const checks: Record<string, { command: readonly string[]; timeoutMs: number }> = Object.create(null);
  for (const [name, value] of Object.entries(policy.checks)) {
    if (
      !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name) ||
      !value ||
      typeof value !== "object" ||
      Array.isArray(value)
    )
      throw new Error("Invalid verification check");
    const check = value as Record<string, unknown>;
    if (
      Object.keys(check).some((key) => !["command", "timeoutMs"].includes(key)) ||
      !Array.isArray(check.command) ||
      !check.command.length ||
      check.command.length > 128 ||
      check.command.some(
        (part) => typeof part !== "string" || part.includes("\0") || Buffer.byteLength(part) > 16 * 1024,
      ) ||
      typeof check.command[0] !== "string" ||
      !check.command[0].length ||
      !Number.isSafeInteger(check.timeoutMs) ||
      (check.timeoutMs as number) < 1 ||
      (check.timeoutMs as number) > 30 * 60 * 1000
    )
      throw new Error(`Invalid verification check ${name}`);
    checks[name] = { command: [...check.command] as string[], timeoutMs: check.timeoutMs as number };
  }
  if (!Object.keys(checks).length || Object.keys(checks).length > 32)
    throw new Error("Verification requires between one and 32 checks");
  return { agent: policy.agent, checks };
}

/** Nix produces this catalog. Loading it never evaluates project code. */
export interface AgentCatalog {
  schemaVersion: 1;
  baySocket: string;
  agents: Readonly<Record<string, AgentDefinition>>;
}

export function parseCatalog(value: unknown): AgentCatalog {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Agent catalog must be an object");
  const catalog = value as Record<string, unknown>;
  if (catalog.schemaVersion !== 1) throw new Error("Unsupported agent catalog schema");
  if (typeof catalog.baySocket !== "string" || !catalog.baySocket.startsWith("/"))
    throw new Error("Agent catalog baySocket must be an absolute path");
  if (!catalog.agents || typeof catalog.agents !== "object" || Array.isArray(catalog.agents))
    throw new Error("Agent catalog agents must be an object");
  const agents: Record<string, AgentDefinition> = Object.create(null);
  for (const [name, value] of Object.entries(catalog.agents)) {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error(`Invalid declaration for agent ${name}`);
    const { program, machine, machineRevision, verification, ...role } = value as Record<string, unknown>;
    const manifest = validateAgentManifest(role);
    if (manifest.name !== name) throw new Error(`Agent ${name} has a different manifest name`);
    for (const [key, entry] of Object.entries({ program, machine, machineRevision }))
      if (typeof entry !== "string" || !entry.length) throw new Error(`Agent ${name} needs a ${key}`);
    agents[name] = {
      manifest,
      program: program as string,
      machine: machine as string,
      machineRevision: machineRevision as string,
      ...(verification !== undefined ? { verification: validateVerificationPolicy(verification) } : {}),
    };
  }
  for (const [name, agent] of Object.entries(agents))
    for (const target of [
      ...agent.manifest.delegatesTo,
      ...(agent.verification ? [agent.verification.agent] : []),
    ])
      if (!Object.hasOwn(agents, target))
        throw new Error(`Agent ${name} delegates to undeclared agent ${target}`);
  return { schemaVersion: 1, baySocket: catalog.baySocket, agents };
}

export function loadCatalog(path = process.env.DURA_CATALOG): AgentCatalog {
  if (!path)
    throw new Error(
      "No agent catalog configured; declare services.dura.agents or set DURA_CATALOG",
    );
  try {
    return parseCatalog(JSON.parse(readFileSync(path, "utf8")));
  } catch (error) {
    throw new Error(
      `Could not load agent catalog ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
