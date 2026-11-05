import { createCliRenderer } from "@opentui/core";
import { createRoot, useKeyboard } from "@opentui/react";
import type { SessionStats } from "@pituitary/session";
import { useState } from "react";
import { fakeSessionState } from "../../../session/src/session.fixture.ts";
import { theme } from "../theme.ts";
import type { UsageReport } from "../usage/types.ts";
import { Footer } from "./footer.tsx";

const now = Date.now();
const report: UsageReport = {
  provider: "anthropic",
  auth: "subscription",
  model: "claude-sonnet",
  plan: "Max",
  state: "ready",
  checkedAt: now,
  metrics: [
    { kind: "window", label: "5h", usedPercent: 88, windowSeconds: 18000, resetsAt: now + 7200_000 },
    { kind: "window", label: "Weekly", usedPercent: 63, windowSeconds: 604800, resetsAt: now + 172800_000 },
    { kind: "amount", label: "Extra usage", unit: "USD", used: 12.5, limit: 50, period: "monthly" },
  ],
  notes: ["Provider-reported subscription usage."],
};

function Preview() {
  const [open, setOpen] = useState(true);
  const [failed, setFailed] = useState(false);
  useKeyboard((key) => {
    if (key.name === "e") setFailed(true);
    if (key.name === "r") setFailed(false);
    if (key.name === "u") setOpen((value) => !value);
  });
  return (
    <box width="100%" height="100%" flexDirection="column" backgroundColor={theme.bg}>
      <box flexGrow={1} padding={1}>
        <text fg={theme.assistant}>Provider usage preview</text>
      </box>
      <text fg={theme.dim}>u usage · e fetch failure · r recover</text>
      <Footer
        state={fakeSessionState}
        stats={{ cost: 0.42, contextUsage: { percent: 14 } } as SessionStats}
        cwd="/work/sample"
        branch="main"
        usage={{
          open,
          report: failed
            ? { ...report, state: "error", error: "Usage refresh failed.", retryAt: now + 60_000 }
            : report,
        }}
        onUsageToggle={() => setOpen((value) => !value)}
      />
    </box>
  );
}

createRoot(await createCliRenderer({ exitOnCtrlC: true })).render(<Preview />);
