// What both charts share: their chrome, their empty state, and the boundary that
// loads them. Only the charts are split from the page, because recharts is heavy.
import { Component, type ReactNode, Suspense } from "react";
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

/** Shows a lazily loaded chart, or a reload prompt when its chunk or its render fails. */
export class ChartBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    if (this.state.failed)
      return (
        <div role="alert" className="chart-failure">
          <span className="state-symbol">!</span>
          <h3>Could not load the chart.</h3>
          <p>Reload the page to try again.</p>
          <button
            type="button"
            className="button secondary"
            onClick={() => window.location.reload()}
          >
            Reload page <span aria-hidden="true">↻</span>
          </button>
        </div>
      );
    return (
      <Suspense
        fallback={
          <div className="chart-loading" role="status">
            <span className="loading-line" />
            Loading the chart…
          </div>
        }
      >
        {this.props.children}
      </Suspense>
    );
  }
}
