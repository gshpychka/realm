import { expect, test } from "bun:test";
import {
  type AgentManifest,
  agentManifestDigest,
  canonical,
  validateAgentManifest,
  WorkerRecordDecoder,
} from "./protocol.ts";

test("record limits include trailing fragments after complete records", () => {
  const decoder = new WorkerRecordDecoder(8);
  expect(decoder.push(Buffer.from("ok\n123456"))).toEqual(["ok"]);
  expect(() => decoder.push(Buffer.from("789"))).toThrow("exceeds");
});

test("record limits apply independently to coalesced records and fragmented UTF-8", () => {
  const decoder = new WorkerRecordDecoder(8);
  expect(decoder.push(Buffer.from("12345678\n12345678\n"))).toEqual(["12345678", "12345678"]);
  const bytes = Buffer.from("🧠\n");
  expect(decoder.push(bytes.subarray(0, 2))).toEqual([]);
  expect(decoder.push(bytes.subarray(2))).toEqual(["🧠"]);
});

test("canonical command identity ignores property order but preserves values", () => {
  expect(canonical({ type: "prompt", message: "hello", extra: undefined })).toBe(
    canonical({ message: "hello", type: "prompt" }),
  );
  expect(canonical({ message: "hello" })).not.toBe(canonical({ message: "world" }));
});

const role: AgentManifest = {
  schemaVersion: 1,
  name: "reviewer",
  description: "Review the change",
  instructions: "Find concrete correctness issues.",
  model: null,
  tools: ["read", "grep"],
  delegatesTo: [],
  credentials: ["anthropic"],
};

test("agent manifests reject unrecognized fields, tools and credential paths", () => {
  expect(validateAgentManifest(role)).toEqual(role);
  expect(() => validateAgentManifest({ ...role, apiKey: "never-role-data" })).toThrow("unknown field");
  expect(() => validateAgentManifest({ ...role, tools: ["shell"] })).toThrow("tools");
  expect(() => validateAgentManifest({ ...role, tools: ["read", "read"] })).toThrow("duplicate");
  expect(() => validateAgentManifest({ ...role, credentials: ["/home/operator/auth.json"] })).toThrow(
    "credentials",
  );
  expect(() => validateAgentManifest({ ...role, model: "missing-provider" })).toThrow("provider/model");
});

test("agent identity covers role content and is independent of object property order", () => {
  const manifest = validateAgentManifest(role);
  const reversed = validateAgentManifest(Object.fromEntries(Object.entries(role).reverse()));
  expect(agentManifestDigest(manifest)).toBe(agentManifestDigest(reversed));
  expect(agentManifestDigest({ ...manifest, instructions: "Different task" })).not.toBe(
    agentManifestDigest(manifest),
  );
  manifest.tools.push("ls");
  expect(role.tools).toEqual(["read", "grep"]);
});
