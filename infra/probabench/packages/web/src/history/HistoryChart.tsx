import { calibrationErrorText, type Run } from "@probabench/domain";
import { useId, useMemo } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  type TooltipContentProps,
  XAxis,
  YAxis,
} from "recharts";
import { CHART, PlotEmpty } from "../common/chart-frame";
import { modelName, percent, samplingText, shortId, timestamp } from "../common/format";
import { type ModelStyle, styleOf } from "../common/palette";
import { buildHistoryChartModel, type HistoryPoint } from "./history-chart-data";

function HistoryTooltip({
  active,
  label,
  points,
  styles,
}: {
  active: boolean;
  label: TooltipContentProps["label"] | undefined;
  points: readonly HistoryPoint[];
  styles: ReadonlyMap<string, ModelStyle>;
}) {
  const atTime = points.filter((point) => point.timestamp === Number(label));
  const first = atTime[0];
  if (!active || !first) return null;
  return (
    <div className="chart-tooltip">
      <p className="tooltip-target">
        <time dateTime={first.run.startedAt}>{timestamp(first.run.startedAt)}</time>
      </p>
      {atTime.map(({ run, summary }) => (
        <div key={run.id} className="tooltip-series">
          <p className="tooltip-model">
            <span className="color-dot" style={{ background: styleOf(styles, run.model).color }} />
            <strong>{modelName(run.model)}</strong>
          </p>
          <div className="tooltip-value">
            {calibrationErrorText(summary.meanCalibrationError, "No valid replies")}
            <span>mean calibration error</span>
          </div>
          <p className="muted">
            {percent(summary.validity)} valid · {summary.coveredPoints}/{summary.totalPoints}{" "}
            targets covered
          </p>
          <p className="muted">{samplingText(run)}</p>
          <p className="muted">
            reasoning {run.reasoning} · run {shortId(run.id)}
          </p>
        </div>
      ))}
    </div>
  );
}

const emptyPlot = (points: readonly HistoryPoint[]) => {
  if (points.length === 0)
    return { title: "No runs shown.", detail: "Show a model or clear the history search." };
  if (points.every((point) => point.calibrationError === null))
    return {
      title: "No calibration errors to plot.",
      detail: "These runs contain no valid replies. Their outcomes remain in the history list.",
    };
  return null;
};

/** Per-model timelines keep a break for each run without valid replies, and every run on a tied timestamp. */
export function HistoryChart({
  runs,
  styles,
}: {
  runs: readonly Run[];
  styles: ReadonlyMap<string, ModelStyle>;
}) {
  const descriptionId = useId();
  const { points, series, domain, yMax, tickFormat } = useMemo(
    () => buildHistoryChartModel(runs, styles),
    [runs, styles],
  );
  const empty = emptyPlot(points);
  return (
    <figure
      className="plot"
      aria-label="Calibration error over time"
      aria-describedby={descriptionId}
    >
      <ResponsiveContainer width="100%" height={300} minWidth={0}>
        <LineChart margin={{ top: 22, right: 26, bottom: 30, left: 8 }} accessibilityLayer>
          <CartesianGrid {...CHART.grid} />
          <XAxis
            dataKey="timestamp"
            type="number"
            scale="time"
            domain={domain}
            tickFormatter={(value: number) => tickFormat.format(value)}
            minTickGap={35}
            stroke={CHART.axis}
            tickLine={false}
            tick={CHART.tick}
            tickMargin={12}
            label={{
              ...CHART.label,
              value: "Run start (UTC)",
              position: "insideBottom",
              offset: -20,
            }}
          />
          <YAxis
            domain={[0, yMax]}
            tickFormatter={(value: number) => `${Math.round(value * 100)}`}
            width={56}
            axisLine={false}
            tickLine={false}
            tick={CHART.tick}
            tickMargin={10}
            label={{
              ...CHART.label,
              value: "Calibration error (pp)",
              angle: -90,
              position: "insideLeft",
              offset: -4,
            }}
          />
          <Tooltip
            filterNull={false}
            cursor={CHART.cursor}
            content={({ active, label }) => (
              <HistoryTooltip active={active} label={label} points={points} styles={styles} />
            )}
          />
          {series.map(({ model, style, points: line }) => (
            <Line
              key={model}
              data={line}
              dataKey="calibrationError"
              name={model}
              stroke={style.color}
              strokeDasharray={style.dash}
              strokeWidth={2}
              dot={{ r: 4, strokeWidth: 2, fill: CHART.surface }}
              activeDot={false}
              connectNulls={false}
              isAnimationActive={false}
              type="linear"
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
      {empty ? <PlotEmpty {...empty} /> : null}
      <figcaption id={descriptionId} className="chart-description">
        Mean absolute calibration error across recorded targets with valid replies, in percentage
        points. Lower is better. Each point is a saved run. Runs with no valid replies leave gaps
        and remain available in the history list. Different target grids and sample budgets affect
        this error.
      </figcaption>
    </figure>
  );
}
