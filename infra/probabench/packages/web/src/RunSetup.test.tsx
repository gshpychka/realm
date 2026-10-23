import { describe, expect, it } from "@effect/vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { BenchmarkDraft, Job } from "./benchmark";
import { RunSetup } from "./RunSetup";
import type { Bridge } from "./use-benchmark";

const bridge = (mode: Bridge["mode"], job: Job | null = null, configured = true): Bridge => ({
  mode,
  status: mode === "local" ? { local: true, configured, job } : null,
  pending: false,
  error: null,
  refresh: () => {},
  start: () => Promise.resolve(true),
  cancel: () => Promise.resolve(true),
});
const render = (connection: Bridge, draft?: BenchmarkDraft) =>
  renderToStaticMarkup(
    <RunSetup
      open
      onClose={() => {}}
      onViewResults={() => {}}
      bridge={connection}
      modelSuggestions={[]}
      {...(draft ? { draft } : {})}
    />,
  );
const job = (status: Job["status"]): Job => ({
  id: "job",
  status,
  startedAt: "2026-10-22T10:00:00.000Z",
  log: "[vendor/model] point 2/11 x=10%",
});

describe("benchmark setup workflow", () => {
  it("starts with clear presets, hides custom sample inputs, and validates the API's model length", () => {
    const html = render(bridge("local"));
    expect(html).toContain("550");
    expect(html).toContain("Start benchmark");
    expect(html).toContain("Choose a custom budget");
    expect(html).not.toContain('id="benchmark-trials"');
    expect(html).not.toContain('id="benchmark-step"');
    expect(html).toContain('maxLength="200"');
    expect(html).toContain('<details class="advanced">');
  });

  it("offers a usable primary command action on the published site", () => {
    const html = render(bridge("published"));
    expect(html).toContain('type="submit" class="button primary">Copy command');
    expect(html).toContain('aria-label="Benchmark terminal command"');
    expect(html).not.toContain("Start benchmark");
    expect(html).not.toContain("Connect your OpenRouter key");
  });

  it("makes key setup actionable instead of showing a disabled Start button", () => {
    const html = render(bridge("local", null, false));
    expect(html).toContain("Connect your OpenRouter key");
    expect(html).toContain('type="button" class="button primary">Check connection');
    expect(html).not.toContain("Start benchmark");
  });

  it("puts an active job ahead of setup, with meaningful progress and optional raw output", () => {
    const html = render(bridge("local", job("running")));
    expect(html).toContain("2 of 11 probability targets sampled.");
    expect(html).toContain("Keep running in background");
    expect(html).toContain("Cancel run");
    expect(html).toContain('<details class="job-output">');
    expect(html).not.toContain('id="benchmark-model"');
  });

  it("leads completed runs with View results rather than another setup form", () => {
    const html = render(bridge("local", job("completed")));
    expect(html).toContain('class="button primary">View results');
    expect(html).toContain("Set up another");
    expect(html).not.toContain('id="benchmark-model"');
  });

  it("prefills a rerun draft and deliberately exposes a non-preset sampling budget", () => {
    const html = render(bridge("local", job("completed")), {
      key: "rerun-one",
      model: "vendor/model",
      trialsPerStep: 17,
      stepPercent: 30,
      concurrency: 3,
      reasoning: "low",
    });
    expect(html).toContain('value="vendor/model"');
    expect(html).toContain('id="benchmark-trials"');
    expect(html).toContain('value="17"');
    expect(html).toContain('value="30"');
    expect(html).toContain("Start benchmark");
    expect(html).not.toContain("View results");
  });
});
