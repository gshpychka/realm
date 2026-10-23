import type { Run } from "@probabench/domain";
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
import {
  buildChartModel,
  type ChartModel,
  modelDash,
  REFERENCE_COLOR,
  REFERENCE_KEY,
} from "./chart-data";
import { number, percent } from "./format";

function ChartTooltip({ active, label }: TooltipContentProps, model: ChartModel) {
  if (!active) return null;
  const metadata = model.meta.get(Number(label));
  if (!metadata?.size) return null;
  return (
    <div className="chart-tooltip">
      <p className="tooltip-target">
        Target <strong>{percent(Number(label))}</strong>
      </p>
      {model.series.map((series) => {
        const point = metadata.get(series.key);
        if (!point) return null;
        return (
          <div key={series.id} className="tooltip-series">
            <p>
              <span className="color-dot" style={{ background: series.color }} />
              <strong>{series.label}</strong>
            </p>
            <div className="tooltip-value">
              {point.observed === null ? "No valid replies" : percent(point.observed)}
              <span>
                Ones: {number(point.ones)} / {number(point.valid)} valid replies
              </span>
            </div>
            {point.interval ? (
              <p className="muted">
                95% interval {percent(point.interval[0])}–{percent(point.interval[1])}
              </p>
            ) : null}
            <p className="muted">
              {number(point.invalid)} of {number(point.total)} replies invalid
            </p>
          </div>
        );
      })}
    </div>
  );
}

export function CalibrationChart({
  runs,
  colors,
  intervals,
}: {
  runs: ReadonlyArray<Run>;
  colors: ReadonlyMap<string, string>;
  intervals: boolean;
}) {
  const model = useMemo(() => buildChartModel(runs, colors), [runs, colors]);
  return (
    <figure
      className="plot calibration-plot"
      aria-label="Observed fraction of ones versus target probability"
      aria-describedby="chart-description"
    >
      <ResponsiveContainer width="100%" height="100%" minWidth={0}>
        <LineChart
          data={model.rows}
          margin={{ top: 24, right: 24, bottom: 30, left: 8 }}
          accessibilityLayer
        >
          <CartesianGrid stroke="#3c3836" strokeDasharray="2 5" vertical={false} />
          <XAxis
            dataKey="x"
            type="number"
            domain={[0, 1]}
            ticks={[0, 0.25, 0.5, 0.75, 1]}
            tickFormatter={(value: number) => percent(value, 0)}
            stroke="#665c54"
            tickLine={false}
            tick={{ fill: "#bdae93", fontSize: 12, fontFamily: "monospace" }}
            tickMargin={12}
            label={{
              value: "Target probability",
              position: "insideBottom",
              offset: -22,
              fill: "#a89984",
              fontSize: 11,
            }}
          />
          <YAxis
            domain={[0, 1]}
            ticks={[0, 0.25, 0.5, 0.75, 1]}
            tickFormatter={(value: number) => percent(value, 0)}
            width={52}
            axisLine={false}
            tickLine={false}
            tick={{ fill: "#bdae93", fontSize: 12, fontFamily: "monospace" }}
            tickMargin={10}
          />
          <Tooltip
            filterNull={false}
            cursor={{ stroke: "#665c54", strokeDasharray: "3 4" }}
            content={(props) => ChartTooltip(props, model)}
          />
          <Line
            dataKey={REFERENCE_KEY}
            name="Calibrated sampling"
            stroke={REFERENCE_COLOR}
            strokeWidth={1}
            strokeDasharray="5 6"
            dot={false}
            isAnimationActive={false}
            type="linear"
          />
          {model.series.map((series) => (
            <Line
              key={series.id}
              data={model.seriesRows.get(series.key) ?? []}
              dataKey={series.key}
              name={series.label}
              stroke={series.color}
              strokeDasharray={modelDash(series.label, colors) ?? "none"}
              strokeWidth={2.5}
              dot={{ r: 3, strokeWidth: 2, fill: "#282828" }}
              activeDot={{ r: 5, fill: series.color, stroke: "#282828", strokeWidth: 3 }}
              connectNulls={false}
              isAnimationActive={false}
              type="linear"
            >
              {intervals ? (
                <ErrorBar
                  dataKey={`${series.key}_interval`}
                  direction="y"
                  isAnimationActive={false}
                  stroke={series.color}
                  strokeOpacity={0.55}
                  strokeWidth={1.2}
                  width={3}
                />
              ) : null}
            </Line>
          ))}
        </LineChart>
      </ResponsiveContainer>
      {runs.length === 0 ? (
        <div className="plot-empty">
          <p>Select a model to draw its observations.</p>
          <span>The dashed line is the calibration reference.</span>
        </div>
      ) : null}
      {runs.length > 0 && !model.series.some((series) => series.valid > 0) ? (
        <div className="plot-empty" role="status">
          <p>No valid samples in the selected runs.</p>
          <span>Invalid replies remain recorded in the measurement tables.</span>
        </div>
      ) : null}
    </figure>
  );
}
