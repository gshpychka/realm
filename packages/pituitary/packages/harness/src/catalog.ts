import { readFileSync } from "node:fs";
import { type AgentManifest, validateAgentManifest } from "./protocol.ts";

export interface AgentDefinition {
  manifest: AgentManifest;
  program: string;
  machine: string;
  machineRevision: string;
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
    const { program, machine, machineRevision, ...role } = value as Record<string, unknown>;
    const manifest = validateAgentManifest(role);
    if (manifest.name !== name) throw new Error(`Agent ${name} has a different manifest name`);
    for (const [key, entry] of Object.entries({ program, machine, machineRevision }))
      if (typeof entry !== "string" || !entry.length) throw new Error(`Agent ${name} needs a ${key}`);
    agents[name] = {
      manifest,
      program: program as string,
      machine: machine as string,
      machineRevision: machineRevision as string,
    };
  }
  for (const [name, agent] of Object.entries(agents))
    for (const target of agent.manifest.delegatesTo)
      if (!Object.hasOwn(agents, target))
        throw new Error(`Agent ${name} delegates to undeclared agent ${target}`);
  return { schemaVersion: 1, baySocket: catalog.baySocket, agents };
}

export function loadCatalog(path = process.env.PITUITARY_CATALOG): AgentCatalog {
  if (!path)
    throw new Error(
      "No agent catalog configured; declare services.pituitary.agents or set PITUITARY_CATALOG",
    );
  try {
    return parseCatalog(JSON.parse(readFileSync(path, "utf8")));
  } catch (error) {
    throw new Error(
      `Could not load agent catalog ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
