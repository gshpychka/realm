import type { ModelEvidence } from "@probabench/domain";
import { count, observedText, percent } from "./format";
import "./Measurements.css";

const HEADINGS = ["Requested", "Observed", "95% CI", "1s / valid replies", "Invalid"];

/** A model's pooled measurements at every target, as an accessible table. */
export function Measurements({ evidence }: { evidence: ModelEvidence }) {
  return (
    <section
      className="table-scroll"
      // biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users need to scroll wide measurement tables.
      tabIndex={0}
      aria-label={`Measurements for ${evidence.model}`}
    >
      <table className="measurement-table">
        <caption className="sr-only">Combined sampling frequencies for {evidence.model}</caption>
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
          {evidence.points.map((point) => {
            const { observed, interval, ones, valid, invalid, total } = point;
            return (
              <tr key={point.x}>
                <th scope="row">{percent(point.x, 0)}</th>
                <td className="table-observed">{observedText(observed)}</td>
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
