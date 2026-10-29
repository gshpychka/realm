import { calibrationErrorText, type EvidenceCheckpoint } from "@probabench/domain";
import { useMemo } from "react";
import {
  CartesianGrid,
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
import { date, modelName, NO_VALID_REPLIES } from "../common/format";
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
      <p className="tooltip-heading">
        Through <time dateTime={first.day}>{date(first.day)}</time>
      </p>
      {atTime.map(({ model, summary }) => (
        <div key={model} className="tooltip-series">
          <p className="tooltip-model">
            <span className="color-dot" style={{ background: styleOf(styles, model).color }} />
            <strong>{modelName(model)}</strong>
          </p>
          <div className="tooltip-value">
            {calibrationErrorText(summary.meanCalibrationError, NO_VALID_REPLIES)}
            <span>mean absolute error</span>
          </div>
        </div>
      ))}
    </div>
  );
}

const meanError = (point: HistoryPoint) => point.summary.meanCalibrationError;

export function HistoryChart({
  history,
  styles,
  through,
  onInspect,
}: {
  history: readonly EvidenceCheckpoint[];
  styles: ReadonlyMap<string, ModelStyle>;
  through: string | null;
  onInspect: (point: EvidenceCheckpoint) => void;
}) {
  const { points, series, domain, yMax, tickFormat } = useMemo(
    () => buildHistoryChartModel(history, styles),
    [history, styles],
  );
  const empty =
    points.length === 0
      ? { title: "No models shown.", detail: "Show a model from the legend." }
      : points.every((point) => meanError(point) === null)
        ? {
            title: "No valid answers yet.",
            detail: "See the measurement tables for the replies received.",
          }
        : null;
  return (
    <figure aria-label="Mean absolute error over time">
      <div className="plot">
        <ResponsiveContainer>
          <LineChart margin={CHART.margin}>
            <CartesianGrid {...CHART.grid} />
            <XAxis
              {...CHART.xAxis}
              dataKey="timestamp"
              type="number"
              scale="time"
              domain={domain}
              ticks={[...new Set(points.map((point) => point.timestamp))]}
              interval="preserveStartEnd"
              tickFormatter={(value: number) => tickFormat.format(value)}
              minTickGap={40}
              label={{ ...CHART.xLabel, value: "Date" }}
            />
            <YAxis
              {...CHART.yAxis}
              domain={[0, yMax]}
              ticks={Array.from({ length: 6 }, (_, index) => (index * yMax) / 5)}
              tickFormatter={(value: number) => `${Math.round(value * 100)}`}
              width={56}
              label={{
                ...CHART.label,
                value: "Mean absolute error (pp)",
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
            {through ? (
              <ReferenceLine
                x={Date.parse(`${through}T00:00:00.000Z`)}
                stroke={CHART.reference}
                strokeDasharray="4 5"
              />
            ) : null}
            {series.map(({ model, style, points: line }) => (
              <Line
                key={model}
                data={line}
                dataKey={meanError}
                name={model}
                stroke={style.color}
                strokeDasharray={style.dash}
                strokeWidth={2}
                dot={(props) => {
                  const { cx, cy, payload } = props;
                  const point = payload as HistoryPoint;
                  if (
                    cx === undefined ||
                    cy === undefined ||
                    point.summary.meanCalibrationError === null
                  )
                    return <g key={point.day} />;
                  const label = `${modelName(model)}, through ${date(point.day)}, mean error ${calibrationErrorText(point.summary.meanCalibrationError)}`;
                  return (
                    // biome-ignore lint/a11y/useSemanticElements: SVG chart markers need SVG geometry and cannot contain an HTML button.
                    <g
                      key={point.day}
                      role="button"
                      tabIndex={0}
                      aria-label={label}
                      className="history-point"
                      onClick={() => onInspect(point)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          onInspect(point);
                        }
                      }}
                    >
                      <circle cx={cx} cy={cy} r={12} fill="transparent" />
                      <circle
                        className="history-point-marker"
                        cx={cx}
                        cy={cy}
                        r={4}
                        stroke={style.color}
                        strokeWidth={2}
                        fill={CHART.surface}
                      />
                    </g>
                  );
                }}
                activeDot={false}
                isAnimationActive={false}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
        {empty ? <PlotEmpty {...empty} /> : null}
      </div>
    </figure>
  );
}
