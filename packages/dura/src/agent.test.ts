import { expect, test } from "bun:test";
import { type AgentManifest, agentManifestDigest, canonical, validateAgentManifest } from "./agent.ts";

const role: AgentManifest = {
  schemaVersion: 1,
  name: "reviewer",
  description: "Review the change",
  instructions: "Find concrete correctness issues.",
  model: null,
  tools: ["read", "grep"],
  delegatesTo: [],
  credentials: ["anthropic"],
  limits: { maxChildren: 0, maxDepth: 0 },
};

test("declarations contain role authority without credential paths or unrecognized tools", () => {
  expect(validateAgentManifest(role)).toEqual(role);
  expect(() => validateAgentManifest({ ...role, apiKey: "secret" })).toThrow("unknown field");
  expect(() => validateAgentManifest({ ...role, tools: ["shell"] })).toThrow("tools");
  expect(() => validateAgentManifest({ ...role, tools: ["read", "read"] })).toThrow("duplicate");
  expect(() => validateAgentManifest({ ...role, credentials: ["/operator/auth.json"] })).toThrow(
    "credentials",
  );
  expect(() => validateAgentManifest({ ...role, model: "no-provider" })).toThrow("provider/model");
  expect(() => validateAgentManifest({ ...role, limits: undefined })).toThrow("limits");
  expect(() => validateAgentManifest({ ...role, limits: { maxChildren: -1, maxDepth: 1 } })).toThrow(
    "non-negative",
  );
});
test("role identity includes content and authority, independently of property order", () => {
  const parsed = validateAgentManifest(role);
  expect(agentManifestDigest(parsed)).toBe(
    agentManifestDigest(validateAgentManifest(Object.fromEntries(Object.entries(role).reverse()))),
  );
  expect(agentManifestDigest({ ...parsed, instructions: "Another objective" })).not.toBe(
    agentManifestDigest(parsed),
  );
  expect(agentManifestDigest({ ...parsed, limits: { maxChildren: 1, maxDepth: 1 } })).not.toBe(
    agentManifestDigest(parsed),
  );
  parsed.tools.push("ls");
  expect(role.tools).toEqual(["read", "grep"]);
  expect(canonical({ b: 1, a: 2, empty: undefined })).toBe(canonical({ a: 2, b: 1 }));
});
