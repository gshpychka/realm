import type { Run } from "@probabench/domain";
import { useMemo } from "react";
import {
  CartesianGrid,
  ErrorBar,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  type TooltipContentProps,
  XAxis,
  YAxis,
} from "recharts";
import { CHART, PlotEmpty } from "../common/chart-frame";
import { count, modelName, percent } from "../common/format";
import type { ModelStyle } from "../common/palette";
import { buildCalibrationSeries, type CalibrationSeries } from "./calibration-chart-data";

const TICKS = [0, 0.25, 0.5, 0.75, 1];

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
          <p>
            <span className="color-dot" style={{ background: style.color }} />
            <strong>{modelName(run.model)}</strong>
          </p>
          <div className="tooltip-value">
            {point.observed === null ? "No valid replies" : percent(point.observed)}
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
      title: "Select a model to draw its observations.",
      detail: "The dashed line is the calibration reference.",
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
  descriptionId,
}: {
  runs: readonly Run[];
  styles: ReadonlyMap<string, ModelStyle>;
  intervals: boolean;
  descriptionId: string;
}) {
  const series = useMemo(() => buildCalibrationSeries(runs, styles), [runs, styles]);
  const empty = emptyPlot(series);
  return (
    <figure
      className="plot calibration-plot"
      aria-label="Observed fraction of ones versus target probability"
      aria-describedby={descriptionId}
    >
      <ResponsiveContainer width="100%" height="100%" minWidth={0}>
        <LineChart margin={{ top: 24, right: 24, bottom: 30, left: 8 }} accessibilityLayer>
          <CartesianGrid {...CHART.grid} />
          <XAxis
            dataKey="x"
            type="number"
            domain={[0, 1]}
            ticks={TICKS}
            tickFormatter={(value: number) => percent(value, 0)}
            stroke={CHART.axis}
            tickLine={false}
            tick={CHART.tick}
            tickMargin={12}
            label={{
              ...CHART.label,
              value: "Target probability",
              position: "insideBottom",
              offset: -22,
            }}
          />
          <YAxis
            domain={[0, 1]}
            ticks={TICKS}
            tickFormatter={(value: number) => percent(value, 0)}
            width={52}
            axisLine={false}
            tickLine={false}
            tick={CHART.tick}
            tickMargin={10}
          />
          <Tooltip
            filterNull={false}
            cursor={CHART.cursor}
            content={({ active, label }) => (
              <CalibrationTooltip active={active} label={label} series={series} />
            )}
          />
          <ReferenceLine
            segment={[
              { x: 0, y: 0 },
              { x: 1, y: 1 },
            ]}
            stroke={CHART.reference}
            strokeWidth={1}
            strokeDasharray="5 6"
          />
          {series.map(({ run, style, points }) => (
            <Line
              key={run.id}
              data={points}
              dataKey="observed"
              name={modelName(run.model)}
              stroke={style.color}
              strokeDasharray={style.dash}
              strokeWidth={2.5}
              dot={{ r: 3, strokeWidth: 2, fill: CHART.surface }}
              activeDot={{ r: 5, fill: style.color, stroke: CHART.surface, strokeWidth: 3 }}
              connectNulls={false}
              isAnimationActive={false}
              type="linear"
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
    </figure>
  );
}
