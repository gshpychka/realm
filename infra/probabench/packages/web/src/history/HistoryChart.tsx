import { calibrationErrorText, type Run } from "@probabench/domain";
import { useId, useMemo, useState } from "react";
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

/** A focusable chart point: the history list offers the same action as a native button. */
function HistoryDot({
  cx,
  cy,
  point,
  color,
  selected,
  onSelect,
}: {
  cx: number;
  cy: number;
  point: HistoryPoint;
  color: string;
  selected: boolean;
  onSelect: (run: Run) => void;
}) {
  const { run } = point;
  return (
    // biome-ignore lint/a11y/useSemanticElements: Native HTML buttons cannot render as SVG chart points; the history list provides the same action.
    <g
      className="history-dot"
      stroke={color}
      strokeWidth={selected ? 3 : 2}
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      aria-label={`Inspect ${run.model}, ${timestamp(run.startedAt)}, mean calibration error ${calibrationErrorText(point.calibrationError)}, run ${run.id}`}
      onClick={() => onSelect(run)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect(run);
        }
      }}
    >
      <title>
        {run.model} · {calibrationErrorText(point.calibrationError)}
      </title>
      <circle cx={cx} cy={cy} r={12} fill="transparent" stroke="none" />
      <circle
        cx={cx}
        cy={cy}
        r={selected ? 7 : 4.5}
        fill={selected ? color : CHART.surface}
        pointerEvents="none"
      />
    </g>
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
  selectedId,
  onSelect,
}: {
  runs: readonly Run[];
  styles: ReadonlyMap<string, ModelStyle>;
  selectedId: string | undefined;
  onSelect: (run: Run) => void;
}) {
  const descriptionId = useId();
  const [tooltipEnabled, setTooltipEnabled] = useState(true);
  const select = (run: Run) => {
    // Recharts preserves its active hover payload after a touch selection and
    // programmatic scroll. Keep the inspector clear until the next interaction.
    setTooltipEnabled(false);
    onSelect(run);
  };
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
      onPointerMove={(event) => {
        if (event.pointerType !== "touch") setTooltipEnabled(true);
      }}
      onPointerDown={() => setTooltipEnabled(true)}
      onFocusCapture={() => setTooltipEnabled(true)}
      onKeyDownCapture={(event) => {
        if (event.key.startsWith("Arrow")) setTooltipEnabled(true);
      }}
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
            {...(tooltipEnabled ? {} : { active: false })}
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
              dot={({ cx, cy, payload }: { cx?: number; cy?: number; payload?: HistoryPoint }) =>
                cx === undefined ||
                cy === undefined ||
                !payload ||
                payload.calibrationError === null ? (
                  <g />
                ) : (
                  <HistoryDot
                    cx={cx}
                    cy={cy}
                    point={payload}
                    color={style.color}
                    selected={payload.run.id === selectedId}
                    onSelect={select}
                  />
                )
              }
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
        points. Lower is better. Each point is a saved run; select a point to inspect its settings.
        Runs with no valid replies leave gaps and remain available in the history list. Different
        target grids and sample budgets affect this error.
      </figcaption>
    </figure>
  );
}
