import { Component, type ReactNode } from "react";

export class LoadBoundary extends Component<
  { children: ReactNode; surface?: "chart" | "setup" | "notebook" },
  { failed: boolean }
> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    if (this.state.failed)
      return (
        <div
          role="alert"
          className={`chart-failure ${this.props.surface === "setup" ? "setup-failure" : ""}`}
        >
          <span className="state-symbol">!</span>
          <h3>
            {this.props.surface === "setup"
              ? "Could not open benchmark setup."
              : this.props.surface === "notebook"
                ? "Could not load this notebook view."
                : "Could not load the chart."}
          </h3>
          <p>
            {this.props.surface === "setup"
              ? "The setup form did not arrive. Reload the page to try again; your saved observations stay in the notebook."
              : this.props.surface === "notebook"
                ? "Reload the page to try again. Your saved observations stay in the notebook."
                : "The visualisation did not arrive. Your recorded results are still available in the measurement tables."}
          </p>
          <button
            type="button"
            className="button secondary"
            onClick={() => window.location.reload()}
          >
            Reload page <span aria-hidden="true">↻</span>
          </button>
        </div>
      );
    return this.props.children;
  }
}
