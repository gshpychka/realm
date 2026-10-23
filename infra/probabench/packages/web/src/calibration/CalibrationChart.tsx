import type { Run } from "@probabench/domain";
import { useId, useMemo } from "react";
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
  const hits = series.flatMap(({ run, style, points }) => {
    const point = points.find((item) => item.x === x);
    return point ? [{ run, style, point }] : [];
  });
  if (!active || hits.length === 0) return null;
  return (
    <div className="chart-tooltip">
      <p className="tooltip-target">
        Target <strong>{percent(x)}</strong>
      </p>
      {hits.map(({ run, style, point }) => (
        <div key={run.id} className="tooltip-series">
          <p className="tooltip-model">
            <span className="color-dot" style={{ background: style.color }} />
            <strong>{modelName(run.model)}</strong>
          </p>
          <div className="tooltip-value">
            {observedText(point.observed)}
            <span>
              Ones: {count(point.ones)} / {count(point.valid)} valid replies
            </span>
          </div>
          {point.interval ? (
            <p className="muted">
              95% interval {percent(point.interval[0])}–{percent(point.interval[1])}
            </p>
          ) : null}
          <p className="muted">
            {count(point.invalid)} of {count(point.total)} replies invalid
          </p>
        </div>
      ))}
    </div>
  );
}

const emptyPlot = (series: readonly CalibrationSeries[]) => {
  if (series.length === 0)
    return {
      title: "Select a model to draw its run.",
      detail: "Choose one from the Models list.",
    };
  if (series.every(({ points }) => points.every((point) => point.observed === null)))
    return {
      title: "No valid samples in the selected runs.",
      detail: "Invalid replies remain recorded in the measurement tables.",
    };
  return null;
};

export function CalibrationChart({
  runs,
  styles,
  intervals,
}: {
  runs: readonly Run[];
  styles: ReadonlyMap<string, ModelStyle>;
  intervals: boolean;
}) {
  const descriptionId = useId();
  const series = useMemo(() => buildCalibrationSeries(runs, styles), [runs, styles]);
  const empty = emptyPlot(series);
  return (
    <figure
      aria-label="Observed fraction of ones versus target probability"
      aria-describedby={descriptionId}
    >
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
              label={{ ...CHART.xLabel, value: "Target probability" }}
            />
            <YAxis
              {...CHART.yAxis}
              domain={[0, 1]}
              ticks={TICKS}
              tickFormatter={(value: number) => percent(value, 0)}
              width={52}
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
            {series.map(({ run, style, points }) => (
              <Line
                key={run.id}
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
      <div className="chart-caption">
        <span className="reference-key">
          <span aria-hidden="true" />
          Calibrated sampling (y = x)
        </span>
        <span className="mono">
          {series.length} / {styles.size} models
        </span>
      </div>
      <figcaption id={descriptionId} className="chart-description">
        Points mark measured targets; lines join them. Gaps mark targets with no valid replies.
        Intervals assume independent valid responses.
      </figcaption>
    </figure>
  );
}
