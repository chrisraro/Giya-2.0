export interface BarChartProps {
  data: { day: string; value: number }[];
  ariaLabel: string;
}

const CHART_HEIGHT = 120;
const LABEL_GUTTER = 20;
const BAR_WIDTH = 28;
const GAP = 16;
const RADIUS = 6;

/** Path for a bar with rounded top corners only (flat bottom flush with the baseline). */
function barPath(x: number, height: number) {
  const y = CHART_HEIGHT - height;
  const r = Math.min(RADIUS, height / 2, BAR_WIDTH / 2);
  return [
    `M${x},${CHART_HEIGHT}`,
    `L${x},${y + r}`,
    `Q${x},${y} ${x + r},${y}`,
    `L${x + BAR_WIDTH - r},${y}`,
    `Q${x + BAR_WIDTH},${y} ${x + BAR_WIDTH},${y + r}`,
    `L${x + BAR_WIDTH},${CHART_HEIGHT}`,
    "Z",
  ].join(" ");
}

/** Pure SVG bar chart (server component, no client hooks) for the week's visit counts. */
export function BarChart({ data, ariaLabel }: BarChartProps) {
  const max = Math.max(...data.map((d) => d.value), 1);
  const width = data.length * BAR_WIDTH + Math.max(data.length - 1, 0) * GAP;

  return (
    <svg
      role="img"
      aria-label={ariaLabel}
      viewBox={`0 0 ${width} ${CHART_HEIGHT + LABEL_GUTTER}`}
      preserveAspectRatio="xMidYMax meet"
      className="h-40 w-full"
    >
      {data.map((d, index) => {
        const x = index * (BAR_WIDTH + GAP);
        const barHeight = (d.value / max) * (CHART_HEIGHT - 8);
        return (
          <g key={d.day}>
            <path d={barPath(x, barHeight)} fill="var(--md-sys-color-secondary)" />
            <text
              x={x + BAR_WIDTH / 2}
              y={CHART_HEIGHT + LABEL_GUTTER - 4}
              textAnchor="middle"
              className="text-label-s fill-on-surface-variant"
            >
              {d.day}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
