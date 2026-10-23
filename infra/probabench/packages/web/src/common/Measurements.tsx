import { measurePoint, type Run } from "@probabench/domain";
import { count, percent, timestamp } from "./format";
import "./Measurements.css";

const HEADINGS = ["Target", "Observed", "95% interval", "Ones / valid", "Invalid"];

/** A run's measurement at every target, as an accessible table. */
export function Measurements({ run }: { run: Run }) {
  return (
    // biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users need to scroll wide measurement tables.
    <section className="table-scroll" tabIndex={0} aria-label={`Measurements for ${run.model}`}>
      <table className="measurement-table">
        <caption className="sr-only">
          Measured sampling frequencies for {run.model}, {timestamp(run.startedAt)}
        </caption>
        <thead>
          <tr>
            {HEADINGS.map((heading) => (
              <th key={heading} scope="col">
                {heading}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {run.points.map((point) => {
            const { observed, interval, ones, valid, invalid, total } = measurePoint(point);
            return (
              <tr key={point.x}>
                <th scope="row">{percent(point.x, 0)}</th>
                <td className="table-observed">
                  {observed === null ? "No valid replies" : percent(observed)}
                </td>
                <td>{interval ? `${percent(interval[0], 0)}–${percent(interval[1], 0)}` : "—"}</td>
                <td>
                  {count(ones)} / {count(valid)}
                </td>
                <td>
                  {count(invalid)} / {count(total)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
