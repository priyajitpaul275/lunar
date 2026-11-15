import { useState } from 'react';
import { PayloadChartSpec } from '../data/clpsMissions';

interface PayloadChartProps {
  spec: PayloadChartSpec;
}

export function PayloadChart({ spec }: PayloadChartProps) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const width = 380;
  const height = 164;
  const padL = 42;
  const padR = 16;
  const padT = 16;
  const padB = 28;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;

  const xs = spec.series.map((p) => p.x);
  const ys = spec.series.map((p) => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const spanX = maxX - minX || 1;
  const spanY = maxY - minY || 1;

  const toSvgX = (x: number) => padL + ((x - minX) / spanX) * plotW;
  const toSvgY = (y: number) => padT + plotH - ((y - minY) / spanY) * plotH;

  const primaryPath = spec.series
    .map((p, idx) => `${idx === 0 ? 'M' : 'L'} ${toSvgX(p.x).toFixed(1)} ${toSvgY(p.y).toFixed(1)}`)
    .join(' ');

  const hasSecondary = spec.series.some((p) => p.ySecondary !== undefined);
  let secondaryPath = '';
  if (hasSecondary) {
    const sVals = spec.series.map((p) => p.ySecondary ?? 0);
    const sMin = Math.min(...sVals);
    const sMax = Math.max(...sVals);
    const sSpan = sMax - sMin || 1;
    secondaryPath = spec.series
      .map((p, idx) => {
        const sy = padT + plotH - (((p.ySecondary ?? 0) - sMin) / sSpan) * plotH;
        return `${idx === 0 ? 'M' : 'L'} ${toSvgX(p.x).toFixed(1)} ${sy.toFixed(1)}`;
      })
      .join(' ');
  }

  const activePoint = hoverIdx !== null ? spec.series[hoverIdx] : spec.series[spec.series.length - 1];

  return (
    <div className="border border-slate-800 bg-[#070A10] rounded-lg p-3">
      <div className="flex items-baseline justify-between gap-2 mb-2">
        <h4 className="text-xs font-semibold text-slate-200 truncate">{spec.title}</h4>
        <span className="text-[11px] font-mono text-cyan-400 shrink-0">
          {activePoint.y} {spec.yUnit}
        </span>
      </div>

      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full h-auto overflow-visible select-none"
        onMouseLeave={() => setHoverIdx(null)}
      >
        {/* Horizontal Gridlines */}
        {[0, 0.5, 1].map((t) => {
          const gy = padT + plotH * (1 - t);
          const val = minY + spanY * t;
          return (
            <g key={t}>
              <line x1={padL} x2={width - padR} y1={gy} y2={gy} stroke="#1e293b" strokeWidth="1" />
              <text
                x={padL - 6}
                y={gy + 3}
                textAnchor="end"
                className="fill-slate-500 text-[9px] font-mono"
              >
                {val >= 1000 ? `${(val / 1000).toFixed(1)}k` : val.toFixed(1)}
              </text>
            </g>
          );
        })}

        {/* Primary Curve */}
        <path d={primaryPath} fill="none" stroke="#06b6d4" strokeWidth="2" strokeLinejoin="round" />

        {/* Secondary Theoretical / Correlated Curve (Dashed) */}
        {hasSecondary && (
          <path
            d={secondaryPath}
            fill="none"
            stroke="#f59e0b"
            strokeWidth="1.5"
            strokeDasharray="4 3"
            strokeLinejoin="round"
          />
        )}

        {/* Interactive Snap Targets */}
        {spec.series.map((p, idx) => {
          const cx = toSvgX(p.x);
          const cy = toSvgY(p.y);
          const isActive = hoverIdx === idx;
          return (
            <g key={idx}>
              {isActive && (
                <line
                  x1={cx}
                  x2={cx}
                  y1={padT}
                  y2={padT + plotH}
                  stroke="#475569"
                  strokeWidth="1"
                  strokeDasharray="2 2"
                />
              )}
              <circle
                cx={cx}
                cy={cy}
                r={isActive ? 4 : 2.5}
                className={isActive ? 'fill-amber-400 stroke-[#070A10]' : 'fill-cyan-400'}
                strokeWidth="1.5"
              />
              <rect
                x={cx - 12}
                y={padT}
                width={24}
                height={plotH}
                fill="transparent"
                className="cursor-crosshair"
                onMouseEnter={() => setHoverIdx(idx)}
              />
            </g>
          );
        })}

        {/* X Axis Labels */}
        <text x={padL} y={height - 6} className="fill-slate-500 text-[9px] font-mono">
          {minX}
        </text>
        <text
          x={padL + plotW / 2}
          y={height - 6}
          textAnchor="middle"
          className="fill-slate-400 text-[9px]"
        >
          {spec.xLabel}
        </text>
        <text x={width - padR} y={height - 6} textAnchor="end" className="fill-slate-500 text-[9px] font-mono">
          {maxX}
        </text>
      </svg>

      {/* Compact Crosshair Readout Bar */}
      <div className="mt-2 pt-2 border-t border-slate-800/80 flex items-center justify-between text-[11px] font-mono text-slate-400">
        <span>
          {spec.yLabel}: <strong className="text-cyan-300">{activePoint.y} {spec.yUnit}</strong>
        </span>
        {spec.secondaryLabel && activePoint.ySecondary !== undefined && (
          <span>
            {spec.secondaryLabel}: <strong className="text-amber-300">{activePoint.ySecondary}</strong>
          </span>
        )}
      </div>
    </div>
  );
}
