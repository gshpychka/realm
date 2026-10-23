// What both charts share: their chrome and their empty state.
import "./chart-frame.css";

// SVG presentation attributes accept var(), so base.css stays the only palette.
export const CHART = {
  grid: { stroke: "var(--line)", strokeDasharray: "2 5", vertical: false },
  axis: "var(--border-strong)",
  tick: { fill: "var(--text-3)", fontSize: 12, fontFamily: "var(--mono)" },
  label: { fill: "var(--muted)", fontSize: 11 },
  cursor: { stroke: "var(--border-strong)", strokeDasharray: "3 4" },
  /** The card behind the plot; filling a point with it draws the point hollow. */
  surface: "var(--panel)",
  /** The y = x line a calibrated sampler follows. */
  reference: "var(--dim)",
} as const;

export function PlotEmpty({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="plot-empty" role="status">
      <p>{title}</p>
      <span>{detail}</span>
    </div>
  );
}
