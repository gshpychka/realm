import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCatalog, parseCatalog } from "./catalog.ts";
import { agentManifestDigest } from "./protocol.ts";

const reader = {
  schemaVersion: 1,
  name: "reader",
  description: "Read a change",
  instructions: "Read the exact change and report concrete issues.",
  model: null,
  tools: ["read", "grep"],
  delegatesTo: [],
  credentials: ["model-provider"],
  program: "pituitary-reader",
  machine: "pituitary-reader",
  machineRevision: "machine-revision-1",
};

function catalog() {
  return { schemaVersion: 1, baySocket: "/run/bay/bay.sock", agents: { reader } };
}

test("a declarative catalog separates the reusable machine from its immutable role", () => {
  const parsed = parseCatalog(catalog());
  expect(parsed.agents.reader).toEqual({
    manifest: {
      schemaVersion: 1,
      name: "reader",
      description: reader.description,
      instructions: reader.instructions,
      model: null,
      tools: ["read", "grep"],
      delegatesTo: [],
      credentials: ["model-provider"],
    },
    program: reader.program,
    machine: reader.machine,
    machineRevision: reader.machineRevision,
  });
  const changed = parseCatalog({
    ...catalog(),
    agents: { reader: { ...reader, machineRevision: "machine-revision-2" } },
  });
  const original = parsed.agents.reader;
  const replacement = changed.agents.reader;
  if (!original || !replacement) throw new Error("Expected reader declaration");
  expect(agentManifestDigest(original.manifest)).toBe(agentManifestDigest(replacement.manifest));
});

test("catalog names, machine identities and delegation targets must resolve", () => {
  expect(() => parseCatalog({ ...catalog(), baySocket: "bay.sock" })).toThrow("absolute path");
  expect(() => parseCatalog({ ...catalog(), agents: { different: reader } })).toThrow("manifest name");
  for (const key of ["program", "machine", "machineRevision"])
    expect(() => parseCatalog({ ...catalog(), agents: { reader: { ...reader, [key]: "" } } })).toThrow(key);
  expect(() =>
    parseCatalog({ ...catalog(), agents: { reader: { ...reader, delegatesTo: ["missing"] } } }),
  ).toThrow("undeclared agent missing");
  const coordinator = { ...reader, name: "coordinator", delegatesTo: ["reader"] };
  expect(parseCatalog({ ...catalog(), agents: { reader, coordinator } }).agents.coordinator).toBeDefined();
});

test("loading a catalog reads JSON and never imports executable project configuration", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-catalog-"));
  try {
    const path = join(root, "agents.json");
    writeFileSync(path, JSON.stringify(catalog()));
    expect(loadCatalog(path).agents.reader?.manifest.name).toBe("reader");
    writeFileSync(path, "export default await arbitraryProjectCode()");
    expect(() => loadCatalog(path)).toThrow(`Could not load agent catalog ${path}`);
    writeFileSync(
      path,
      JSON.stringify({ ...catalog(), agents: { reader: { ...reader, apiKey: "secret" } } }),
    );
    expect(() => loadCatalog(path)).toThrow("unknown field");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
