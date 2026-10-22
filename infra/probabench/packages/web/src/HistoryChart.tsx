import type { Run } from "@probabench/domain";
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
import { modelDash } from "./chart-data";
import { number, percent } from "./format";
import { buildHistoryChartModel, type HistoryPoint } from "./history-chart-data";

export interface HistoryChartProps {
  readonly runs: readonly Run[];
  readonly colors: ReadonlyMap<string, string>;
  readonly selectedId?: string | undefined;
  readonly onSelect: (run: Run) => void;
}

const gap = (value: number | null): string =>
  value === null
    ? "No valid replies"
    : `${(value * 100).toLocaleString("en-US", { maximumFractionDigits: 1 })} pp`;

function HistoryTooltip(
  { active, label }: TooltipContentProps,
  points: readonly HistoryPoint[],
  colors: ReadonlyMap<string, string>,
) {
  if (!active) return null;
  const atTime = points.filter((point) => point.timestamp === Number(label));
  const first = atTime[0];
  if (!first) return null;
  return (
    <div className="chart-tooltip">
      <p className="tooltip-target">
        <time dateTime={first.run.startedAt}>
          {first.run.startedAt.replace("T", " ").replace("Z", " UTC")}
        </time>
      </p>
      {atTime.map(({ run, summary }) => (
        <div key={run.id} className="tooltip-series">
          <p>
            <span
              className="color-dot"
              style={{ background: colors.get(run.model) ?? "#d8a657" }}
            />
            <strong>{run.model}</strong>
          </p>
          <div className="tooltip-value">
            {gap(summary.calibrationError)}
            <span>mean calibration gap</span>
          </div>
          <p className="muted">
            {percent(summary.validity)} valid · {summary.coveredPoints}/{summary.totalPoints}{" "}
            targets covered
          </p>
          <p className="muted">
            {number(run.trialsPerStep)} samples / target · {run.stepPercent}% step
          </p>
          <p className="muted">
            {run.reasoning ?? "Unrecorded"} reasoning · run {run.id.slice(-8)}
          </p>
        </div>
      ))}
    </div>
  );
}

/** Per-model timelines preserve null-score gaps and every execution, including timestamp ties. */
export function HistoryChart({ runs, colors, selectedId, onSelect }: HistoryChartProps) {
  const descriptionId = useId();
  const [tooltipEnabled, setTooltipEnabled] = useState(true);
  const select = (run: Run) => {
    // Recharts preserves its active hover payload after a touch selection and
    // programmatic scroll. Keep the inspector clear until the next interaction.
    setTooltipEnabled(false);
    onSelect(run);
  };
  const { points, series, minimum, maximum, domain, upperScore } = useMemo(
    () => buildHistoryChartModel(runs, colors),
    [runs, colors],
  );
  const tickDate = (timestamp: number): string =>
    new Intl.DateTimeFormat(
      "en-US",
      maximum - minimum < 86_400_000
        ? { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" }
        : {
            month: "short",
            day: "numeric",
            ...(maximum - minimum >= 31_536_000_000 ? { year: "2-digit" as const } : {}),
            timeZone: "UTC",
          },
    ).format(timestamp);
  const renderDot = ({
    cx,
    cy,
    payload,
  }: {
    cx?: number | undefined;
    cy?: number | undefined;
    payload?: HistoryPoint | undefined;
  }) => {
    if (cx === undefined || cy === undefined || !payload || payload.score === null) return <g />;
    const selected = payload.run.id === selectedId;
    const color = colors.get(payload.run.model) ?? "#d8a657";
    return (
      // biome-ignore lint/a11y/useSemanticElements: Native HTML buttons cannot render as SVG chart points; the history list provides the same action.
      <g
        className="history-dot"
        stroke={color}
        strokeWidth={selected ? 3 : 2}
        role="button"
        tabIndex={0}
        aria-pressed={selected}
        aria-label={`Inspect ${payload.run.model}, ${payload.run.startedAt}, mean gap ${gap(payload.score)}, run ${payload.run.id}`}
        style={{ cursor: "pointer" }}
        onClick={() => select(payload.run)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            select(payload.run);
          }
        }}
      >
        <title>
          {payload.run.model} · {gap(payload.score)}
        </title>
        <circle cx={cx} cy={cy} r={12} fill="transparent" stroke="none" />
        <circle
          cx={cx}
          cy={cy}
          r={selected ? 7 : 4.5}
          fill={selected ? color : "#282828"}
          pointerEvents="none"
        />
      </g>
    );
  };
  return (
    <figure
      className="plot history-plot"
      aria-label="Calibration gap over time"
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
          <CartesianGrid stroke="#3c3836" strokeDasharray="2 5" vertical={false} />
          <XAxis
            dataKey="timestamp"
            type="number"
            scale="time"
            domain={domain}
            tickFormatter={tickDate}
            minTickGap={35}
            stroke="#665c54"
            tickLine={false}
            tick={{ fill: "#bdae93", fontSize: 12, fontFamily: "monospace" }}
            tickMargin={12}
            label={{
              value: "Observation time (UTC)",
              position: "insideBottom",
              offset: -20,
              fill: "#928374",
              fontSize: 11,
            }}
          />
          <YAxis
            domain={[0, upperScore]}
            tickFormatter={(value: number) => `${Math.round(value * 100)}`}
            width={56}
            axisLine={false}
            tickLine={false}
            tick={{ fill: "#bdae93", fontSize: 12, fontFamily: "monospace" }}
            tickMargin={10}
            label={{
              value: "Mean gap (pp)",
              angle: -90,
              position: "insideLeft",
              offset: -4,
              fill: "#928374",
              fontSize: 11,
            }}
          />
          <Tooltip
            {...(tooltipEnabled ? {} : { active: false })}
            filterNull={false}
            cursor={{ stroke: "#665c54", strokeDasharray: "3 4" }}
            content={(props) => HistoryTooltip(props, points, colors)}
          />
          {series.map((item) => (
            <Line
              key={item.model}
              data={item.points}
              dataKey="score"
              name={item.model}
              stroke={item.color}
              strokeDasharray={modelDash(item.model, colors) ?? "none"}
              strokeWidth={2}
              dot={renderDot}
              activeDot={false}
              connectNulls={false}
              isAnimationActive={false}
              type="linear"
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
      {points.length === 0 || points.every((point) => point.score === null) ? (
        <div className="plot-empty" role="status">
          <p>{points.length === 0 ? "No runs shown." : "No calibration scores to plot."}</p>
          <span>
            {points.length === 0
              ? "Show a model or clear the history search."
              : "These runs contain no valid replies. Their outcomes remain in the history list."}
          </span>
        </div>
      ) : null}
      <figcaption id={descriptionId} className="chart-description">
        Mean absolute calibration gap across recorded targets with valid replies, in percentage
        points. Lower is better. Each point is a saved run; select a point to inspect its settings.
        Runs with no valid replies leave gaps and remain available in the history list. Different
        target grids and sample budgets affect this score.
      </figcaption>
    </figure>
  );
}
