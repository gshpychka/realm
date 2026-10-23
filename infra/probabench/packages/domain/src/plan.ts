// Run-plan vocabulary shared by the CLI, the dev bridge and the setup form.
import type { ReasoningMode } from "./schema";

export const REASONING_LABELS: Readonly<Record<ReasoningMode, string>> = {
  off: "Off",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
};
