import { useEffect, useState } from "react";

export type CopyStatus = "copied" | "failed";

/** How long a successful copy is acknowledged. */
const COPIED_MS = 4_000;

/**
 * Copies text and remembers the outcome for that text only: once the text changes,
 * its old outcome no longer applies, with no effect to reset it.
 */
export function useClipboard() {
  const [last, setLast] = useState<{ text: string; status: CopyStatus } | null>(null);
  useEffect(() => {
    if (last?.status !== "copied") return;
    const timer = setTimeout(() => setLast(null), COPIED_MS);
    return () => clearTimeout(timer);
  }, [last]);
  const copy = async (text: string): Promise<CopyStatus> => {
    const status = await navigator.clipboard.writeText(text).then(
      () => "copied" as const,
      () => "failed" as const,
    );
    setLast({ text, status });
    return status;
  };
  const statusOf = (text: string): CopyStatus | null => (last?.text === text ? last.status : null);
  return { copy, statusOf };
}
