import type { ModelEvidence } from "@probabench/domain";
import { useMemo } from "react";
import {
  CartesianGrid,
  ErrorBar,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  type TooltipContentProps,
  XAxis,
  YAxis,
} from "recharts";
import { CHART, PlotEmpty } from "../common/chart-frame";
import { count, modelName, observedText, percent } from "../common/format";
import type { ModelStyle } from "../common/palette";
import { buildCalibrationSeries, type CalibrationSeries } from "./calibration-chart-data";

const TICKS = [0, 0.25, 0.5, 0.75, 1];
/** The y = x line, drawn as data: an empty selection still needs the axes it brings. */
const REFERENCE = [
  { x: 0, y: 0 },
  { x: 1, y: 1 },
];

function CalibrationTooltip({
  active,
  label,
  series,
}: {
  active: boolean;
  label: TooltipContentProps["label"] | undefined;
  series: readonly CalibrationSeries[];
}) {
  const x = Number(label);
  const hits = series.flatMap(({ model, style, points }) => {
    const point = points.find((item) => item.x === x);
    return point ? [{ model, style, point }] : [];
  });
  if (!active || hits.length === 0) return null;
  return (
    <div className="chart-tooltip">
      <p className="tooltip-heading">
        Requested <strong>{percent(x)}</strong>
      </p>
      {hits.map(({ model, style, point }) => (
        <div key={model} className="tooltip-series">
          <p className="tooltip-model">
            <span className="color-dot" style={{ background: style.color }} />
            <strong>{modelName(model)}</strong>
            <span className="tooltip-observed">{observedText(point.observed)}</span>
          </p>
          <p className="muted">
            {point.interval
              ? `95% interval ${percent(point.interval[0])}–${percent(point.interval[1])} · `
              : null}
            {count(point.valid)} valid samples · {count(point.invalid)} invalid
          </p>
        </div>
      ))}
    </div>
  );
}

const emptyPlot = (series: readonly CalibrationSeries[]) => {
  if (series.length === 0)
    return {
      title: "Select a model to see its measurements.",
      detail: "Choose one from the Models list.",
    };
  if (series.every(({ points }) => points.every((point) => point.observed === null)))
    return {
      title: "No valid answers.",
      detail: "See the measurements for the replies received.",
    };
  return null;
};

export function CalibrationChart({
  evidence,
  styles,
  intervals,
}: {
  evidence: readonly ModelEvidence[];
  styles: ReadonlyMap<string, ModelStyle>;
  intervals: boolean;
}) {
  const series = useMemo(() => buildCalibrationSeries(evidence, styles), [evidence, styles]);
  const empty = emptyPlot(series);
  return (
    <figure aria-label="Observed frequency of 1 versus requested probability">
      <div className="plot calibration-plot">
        <ResponsiveContainer>
          <LineChart margin={CHART.margin}>
            <CartesianGrid {...CHART.grid} />
            <XAxis
              {...CHART.xAxis}
              dataKey="x"
              type="number"
              domain={[0, 1]}
              ticks={TICKS}
              tickFormatter={(value: number) => percent(value, 0)}
              label={{ ...CHART.xLabel, value: "Requested probability of 1" }}
            />
            <YAxis
              {...CHART.yAxis}
              domain={[0, 1]}
              ticks={TICKS}
              tickFormatter={(value: number) => percent(value, 0)}
              width={52}
              label={{
                ...CHART.label,
                value: "Observed frequency of 1",
                angle: -90,
                position: "insideLeft",
                offset: -4,
              }}
            />
            <Tooltip
              // Keep null entries: a target with no valid replies must still open its tooltip.
              filterNull={false}
              cursor={CHART.cursor}
              content={({ active, label }) => (
                <CalibrationTooltip active={active} label={label} series={series} />
              )}
            />
            <Line
              data={REFERENCE}
              dataKey="y"
              stroke={CHART.reference}
              strokeWidth={1}
              strokeDasharray="5 6"
              dot={false}
              activeDot={false}
              isAnimationActive={false}
            />
            {series.map(({ model, style, points }) => (
              <Line
                key={model}
                data={points}
                dataKey="observed"
                stroke={style.color}
                strokeDasharray={style.dash}
                strokeWidth={2.5}
                dot={{ r: 3, strokeWidth: 2, fill: CHART.surface }}
                activeDot={{ r: 5, fill: style.color, stroke: CHART.surface, strokeWidth: 3 }}
                isAnimationActive={false}
              >
                {intervals ? (
                  <ErrorBar
                    dataKey="errorBar"
                    direction="y"
                    isAnimationActive={false}
                    stroke={style.color}
                    strokeOpacity={0.55}
                    strokeWidth={1.2}
                    width={3}
                  />
                ) : null}
              </Line>
            ))}
          </LineChart>
        </ResponsiveContainer>
        {empty ? <PlotEmpty {...empty} /> : null}
      </div>
      <figcaption className="calibration-caption">
        <span className="reference-key">
          <span aria-hidden="true" />
          Ideal (y = x)
        </span>
      </figcaption>
    </figure>
  );
}
