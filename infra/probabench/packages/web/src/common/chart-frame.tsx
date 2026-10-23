// What both charts share: their chrome and their empty state.
import "./chart-frame.css";

// SVG presentation attributes accept var(), so base.css stays the only palette.
const TICK = { fill: "var(--text-3)", fontSize: 12, fontFamily: "var(--mono)" } as const;
const LABEL = { fill: "var(--muted)", fontSize: 11 } as const;

export const CHART = {
  margin: { top: 24, right: 24, bottom: 30, left: 8 },
  grid: { stroke: "var(--line)", strokeDasharray: "2 5", vertical: false },
  xAxis: { stroke: "var(--border-strong)", tickLine: false, tick: TICK, tickMargin: 12 },
  yAxis: { axisLine: false, tickLine: false, tick: TICK, tickMargin: 10 },
  /** An axis title; xLabel places it under the x-axis ticks. */
  label: LABEL,
  xLabel: { ...LABEL, position: "insideBottom", offset: -22 },
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
