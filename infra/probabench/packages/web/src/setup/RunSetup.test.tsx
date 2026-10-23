import { describe, expect, it } from "@effect/vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Job } from "../bridge/protocol";
import type { Bridge, Connection } from "../bridge/use-bridge";
import { RunSetup } from "./RunSetup";

const bridge = (connection: Connection): Bridge => ({
  connection,
  pending: false,
  start: () => Promise.resolve(null),
  cancel: () => Promise.resolve(null),
});
const local = (job: Job | null = null, configured = true) =>
  bridge({ kind: "local", status: { configured, job }, reconnecting: false });
const render = (connection: Bridge) =>
  renderToStaticMarkup(
    <RunSetup
      open
      onClose={() => {}}
      onViewResults={() => {}}
      bridge={connection}
      modelSuggestions={[]}
    />,
  );
const job = (status: Job["status"]): Job => ({
  id: "job",
  status,
  startedAt: "2026-10-22T10:00:00.000Z",
  log: "",
  progress: { completed: 2, total: 11 },
});

describe("benchmark setup workflow", () => {
  it("starts with clear presets, hides custom sample inputs, and validates the API's model length", () => {
    const html = render(local());
    expect(html).toContain("550");
    expect(html).toContain("Start benchmark");
    expect(html).toContain("Custom budget");
    expect(html).not.toContain('id="benchmark-trials"');
    expect(html).not.toContain('id="benchmark-step"');
    expect(html).toContain('maxLength="200"');
    expect(html).toContain("Advanced settings");
  });

  it("explains how to give the dev server its key before a run can start", () => {
    const html = render(local(null, false));
    expect(html).toContain("Connect your OpenRouter key");
    expect(html).toContain("secrets/infra/probabench.env");
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*disabled=""[^>]*>Start benchmark/);
  });

  it("puts an active job ahead of setup, with meaningful progress and optional raw output", () => {
    const html = render(local(job("running")));
    expect(html).toContain("2 of 11 probability targets sampled.");
    expect(html).toContain("Keep running in background");
    expect(html).toContain("Cancel run");
    expect(html).toContain("Runner output");
    expect(html).not.toContain('id="benchmark-model"');
  });

  it("leads completed runs with View results rather than another setup form", () => {
    const html = render(local(job("completed")));
    expect(html).toMatch(/<button[^>]*class="button primary"[^>]*>View results/);
    expect(html).toContain("Set up another");
    expect(html).not.toContain('id="benchmark-model"');
  });
});
