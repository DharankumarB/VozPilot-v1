import { EmptyState } from '../ui/Feedback';
import { cn } from '../../lib/utils';

/**
 * Small hand-rolled SVG charts — no chart library, tuned for the VozPilot
 * visual language (violet area fills, gold accents, hairline grid).
 */

/* ------------------------------ Area trend ------------------------------ */

export function AreaTrendChart({
  data,
  height = 190,
  className,
  labelFormat,
}: {
  data: { date: string; count: number }[];
  height?: number;
  className?: string;
  labelFormat?: (date: string) => string;
}) {
  const width = 640;
  const padding = { top: 16, right: 12, bottom: 26, left: 30 };
  const innerW = width - padding.left - padding.right;
  const innerH = height - padding.top - padding.bottom;

  const max = Math.max(...data.map((point) => point.count), 1);
  const stepX = data.length > 1 ? innerW / (data.length - 1) : innerW;

  const points = data.map((point, index) => ({
    x: padding.left + index * stepX,
    y: padding.top + innerH - (point.count / max) * innerH,
    ...point,
  }));

  const line = points.map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ');
  const area =
    points.length > 0
      ? `${line} L${points[points.length - 1].x.toFixed(1)},${(padding.top + innerH).toFixed(1)} L${points[0].x.toFixed(1)},${(padding.top + innerH).toFixed(1)} Z`
      : '';

  const gridLines = [0, 0.5, 1].map((ratio) => ({
    y: padding.top + innerH * ratio,
    value: Math.round(max * (1 - ratio)),
  }));

  const format = labelFormat ?? ((date: string) => date.slice(5));
  const labelIndices = new Set<number>();
  if (points.length > 0) {
    labelIndices.add(0);
    labelIndices.add(Math.floor((points.length - 1) / 2));
    labelIndices.add(points.length - 1);
  }

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className={cn('h-auto w-full', className)}
      role="img"
      aria-label="Completion trend chart"
    >
      <defs>
        <linearGradient id="vp-area-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.34" />
          <stop offset="100%" stopColor="var(--accent)" stopOpacity="0.02" />
        </linearGradient>
        <linearGradient id="vp-area-line" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="var(--accent)" />
          <stop offset="100%" stopColor="#b7a4ff" />
        </linearGradient>
      </defs>

      {gridLines.map((lineMeta) => (
        <g key={lineMeta.y}>
          <line
            x1={padding.left}
            x2={width - padding.right}
            y1={lineMeta.y}
            y2={lineMeta.y}
            stroke="rgba(255,255,255,0.06)"
            strokeDasharray="3 5"
          />
          <text x={4} y={lineMeta.y + 3.5} fontSize="9.5" fill="#6a6a82">
            {lineMeta.value}
          </text>
        </g>
      ))}

      {area ? <path d={area} fill="url(#vp-area-fill)" /> : null}
      {line ? <path d={line} fill="none" stroke="url(#vp-area-line)" strokeWidth="2" strokeLinejoin="round" vectorEffect="non-scaling-stroke" /> : null}

      {points.map((point, index) => (
        <circle key={point.date} cx={point.x} cy={point.y} r={point.count > 0 ? 3 : 2} fill={point.count > 0 ? '#b7a4ff' : '#2b2b3d'} stroke="#0a0a0f" strokeWidth="1.5" vectorEffect="non-scaling-stroke">
          <title>{`${point.date}: ${point.count} completed`}</title>
        </circle>
      )).filter((_, index) => data[index] && (data[index].count > 0 || points.length <= 14))}

      {points.map((point, index) =>
        labelIndices.has(index) ? (
          <text
            key={`label-${point.date}`}
            x={point.x}
            y={height - 8}
            fontSize="9.5"
            fill="#6a6a82"
            textAnchor={index === 0 ? 'start' : index === points.length - 1 ? 'end' : 'middle'}
          >
            {format(point.date)}
          </text>
        ) : null,
      )}
    </svg>
  );
}

/* -------------------------------- Bar list -------------------------------- */

export function BarListChart({
  data,
  emptyLabel = 'No activity yet',
}: {
  data: { label: string; value: number; sublabel?: string }[];
  emptyLabel?: string;
}) {
  const visible = data.filter((item) => item.value > 0);
  if (visible.length === 0) {
    return <p className="py-8 text-center text-xs text-mist-500">{emptyLabel}</p>;
  }
  const max = Math.max(...visible.map((item) => item.value), 1);

  return (
    <ul className="flex flex-col gap-3.5">
      {data.map((item) => {
        const width = item.value === 0 ? 0 : Math.max((item.value / max) * 100, 3);
        return (
          <li key={item.label} className="group">
            <div className="mb-1.5 flex items-baseline justify-between gap-3">
              <span className="truncate text-xs font-medium text-mist-300">{item.label}</span>
              <span className="shrink-0 font-mono text-xs font-semibold text-mist-100">{item.value}</span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-white/6">
              <div
                className={cn(
                  'h-full rounded-full transition-all duration-500',
                  item.value > 0
                    ? 'bg-gradient-to-r from-[var(--accent-strong)] to-[var(--accent)]'
                    : 'bg-transparent',
                )}
                style={{ width: `${width}%` }}
              />
            </div>
            {item.sublabel ? <p className="mt-1 text-[11px] text-mist-500">{item.sublabel}</p> : null}
          </li>
        );
      })}
    </ul>
  );
}

/* ---------------------------------- Donut --------------------------------- */

const DONUT_COLORS = ['#7c5cff', '#d9a94e', '#34d399', '#60a5fa', '#f87171'];

export function DonutChart({
  data,
  size = 168,
}: {
  data: { label: string; value: number; color?: string }[];
  size?: number;
}) {
  const total = data.reduce((sum, item) => sum + item.value, 0);
  if (total === 0) {
    return <EmptyState compact title="No data yet" description="Charts appear once there is real data to show." />;
  }

  const radius = 54;
  const stroke = 16;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;

  const segments = data
    .filter((item) => item.value > 0)
    .map((item, index) => {
      const fraction = item.value / total;
      const length = fraction * circumference;
      const segment = {
        ...item,
        color: item.color ?? DONUT_COLORS[index % DONUT_COLORS.length],
        length,
        offset,
        fraction,
      };
      offset += length;
      return segment;
    });

  return (
    <div className="flex flex-wrap items-center justify-center gap-7 py-2">
      <div className="relative" style={{ width: size, height: size }}>
        <svg viewBox="0 0 140 140" width={size} height={size} role="img" aria-label="Distribution chart">
          <circle cx="70" cy="70" r={radius} fill="none" stroke="rgba(255,255,255,0.05)" strokeWidth={stroke} />
          {segments.map((segment) => (
            <circle
              key={segment.label}
              cx="70"
              cy="70"
              r={radius}
              fill="none"
              stroke={segment.color}
              strokeWidth={stroke}
              strokeDasharray={`${segment.length} ${circumference - segment.length}`}
              strokeDashoffset={-segment.offset}
              transform="rotate(-90 70 70)"
              strokeLinecap="butt"
            >
              <title>{`${segment.label}: ${segment.value} (${Math.round(segment.fraction * 100)}%)`}</title>
            </circle>
          ))}
        </svg>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-2xl font-semibold text-mist-100">{total}</span>
          <span className="text-[10px] uppercase tracking-[0.16em] text-mist-500">total</span>
        </div>
      </div>
      <ul className="flex min-w-40 flex-col gap-2.5">
        {segments.map((segment) => (
          <li key={segment.label} className="flex items-center justify-between gap-4 text-xs">
            <span className="flex items-center gap-2 text-mist-400">
              <span className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: segment.color }} />
              {segment.label}
            </span>
            <span className="font-medium text-mist-200">
              {segment.value}
              <span className="ml-1 text-mist-500">{Math.round(segment.fraction * 100)}%</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
