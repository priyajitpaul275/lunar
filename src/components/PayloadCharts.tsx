import { useMemo, useState } from 'react';
import { Download, Eye, EyeOff, Sparkles, TrendingUp } from 'lucide-react';
import { PayloadChartSpec } from '../data/clpsMissions';
import { audioFx } from '../engine/audioFx';

interface PayloadChartProps {
  spec: PayloadChartSpec;
}

export function PayloadChart({ spec }: PayloadChartProps) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [showSecondary, setShowSecondary] = useState<boolean>(true);

  const width = 390;
  const height = 180;
  const padL = 46;
  const padR = 18;
  const padT = 20;
  const padB = 32;
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

  // Statistics
  const stats = useMemo(() => {
    const sum = ys.reduce((a, b) => a + b, 0);
    const avg = sum / (ys.length || 1);
    return {
      min: minY,
      max: maxY,
      avg: avg,
      current: ys[ys.length - 1],
    };
  }, [ys, minY, maxY]);

  const toSvgX = (x: number) => padL + ((x - minX) / spanX) * plotW;
  const toSvgY = (y: number) => padT + plotH - ((y - minY) / spanY) * plotH;

  const primaryPath = spec.series
    .map((p, idx) => `${idx === 0 ? 'M' : 'L'} ${toSvgX(p.x).toFixed(1)} ${toSvgY(p.y).toFixed(1)}`)
    .join(' ');

  const hasSecondary = spec.series.some((p) => p.ySecondary !== undefined);
  let secondaryPath = '';
  if (hasSecondary && showSecondary) {
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

  const handleExportCsv = () => {
    audioFx.playClick();
    const rows = [
      [`${spec.xLabel}`, `${spec.yLabel} (${spec.yUnit})`, ...(hasSecondary ? [`${spec.secondaryLabel || 'Secondary'}`] : [])],
      ...spec.series.map((p) => [p.x, p.y, ...(p.ySecondary !== undefined ? [p.ySecondary] : [])]),
    ];
    const csvContent = 'data:text/csv;charset=utf-8,' + rows.map((e) => e.join(',')).join('\n');
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute('download', `${spec.title.toLowerCase().replace(/\s+/g, '-')}-telemetry.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <div className="border border-cyan-950/70 bg-[#060a12] rounded-lg p-3 text-slate-200 font-mono shadow-inner">
      {/* Chart Header */}
      <div className="flex items-center justify-between gap-2 mb-2">
        <div>
          <h4 className="text-xs font-semibold text-slate-100 flex items-center gap-1.5 font-display tracking-wide">
            <TrendingUp className="w-3.5 h-3.5 text-cyan-400" />
            <span className="truncate">{spec.title}</span>
          </h4>
          <div className="text-[10px] text-slate-400 mt-0.5">
            {spec.xLabel} vs {spec.yLabel}
          </div>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          {hasSecondary && (
            <button
              type="button"
              onClick={() => {
                audioFx.playClick();
                setShowSecondary((prev) => !prev);
              }}
              className={`px-1.5 py-0.5 text-[9px] rounded border transition-colors cursor-pointer ${
                showSecondary
                  ? 'bg-amber-500/20 text-amber-300 border-amber-500/40'
                  : 'bg-slate-900 text-slate-400 border-slate-800'
              }`}
              title="Toggle Secondary Telemetry Trace"
            >
              {showSecondary ? 'Trace 2 ON' : 'Trace 2 OFF'}
            </button>
          )}

          <button
            type="button"
            onClick={handleExportCsv}
            className="p-1 rounded bg-slate-900 hover:bg-slate-800 text-slate-400 hover:text-cyan-300 border border-slate-800 cursor-pointer"
            title="Export CSV Telemetry"
          >
            <Download className="w-3 h-3" />
          </button>
        </div>
      </div>

      {/* Active Inspector Readout Badge */}
      <div className="flex items-center justify-between text-[11px] bg-slate-950/80 px-2 py-1 rounded border border-cyan-950/50 mb-2">
        <div className="text-slate-400">
          {spec.xLabel}: <span className="text-slate-200 font-semibold">{activePoint.x}</span>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-cyan-400 font-semibold">
            {activePoint.y} {spec.yUnit}
          </div>
          {hasSecondary && activePoint.ySecondary !== undefined && showSecondary && (
            <div className="text-amber-400 font-semibold">
              {activePoint.ySecondary} {spec.secondaryLabel?.includes('(') ? spec.secondaryLabel.split('(')[1].replace(')', '') : ''}
            </div>
          )}
        </div>
      </div>

      {/* SVG Canvas Plot */}
      <div className="relative">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="w-full h-auto overflow-visible select-none"
          onMouseLeave={() => setHoverIdx(null)}
        >
          {/* Subtle Gridlines */}
          {[0, 0.25, 0.5, 0.75, 1].map((t) => {
            const gy = padT + plotH * (1 - t);
            const val = minY + spanY * t;
            return (
              <g key={t}>
                <line x1={padL} x2={width - padR} y1={gy} y2={gy} stroke="#0f172a" strokeWidth="1" />
                <text
                  x={padL - 6}
                  y={gy + 3}
                  textAnchor="end"
                  className="fill-slate-500 text-[8.5px] font-mono"
                >
                  {val >= 1000 ? `${(val / 1000).toFixed(1)}k` : val.toFixed(1)}
                </text>
              </g>
            );
          })}

          {/* Area Fill Gradient under primary curve */}
          <defs>
            <linearGradient id={`grad-${spec.title.replace(/\s+/g, '')}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#06b6d4" stopOpacity="0.25" />
              <stop offset="100%" stopColor="#06b6d4" stopOpacity="0.0" />
            </linearGradient>
          </defs>
          <path
            d={`${primaryPath} L ${toSvgX(maxX)} ${padT + plotH} L ${toSvgX(minX)} ${padT + plotH} Z`}
            fill={`url(#grad-${spec.title.replace(/\s+/g, '')})`}
          />

          {/* Primary Telemetry Curve */}
          <path d={primaryPath} fill="none" stroke="#06b6d4" strokeWidth="2" strokeLinejoin="round" />

          {/* Secondary Telemetry Curve */}
          {hasSecondary && showSecondary && (
            <path
              d={secondaryPath}
              fill="none"
              stroke="#f59e0b"
              strokeWidth="1.5"
              strokeDasharray="4 3"
              strokeLinejoin="round"
            />
          )}

          {/* Vertical Inspector Cursor Bar */}
          {hoverIdx !== null && (
            <line
              x1={toSvgX(activePoint.x)}
              x2={toSvgX(activePoint.x)}
              y1={padT}
              y2={padT + plotH}
              stroke="#e2e8f0"
              strokeDasharray="2 2"
              strokeWidth="1"
            />
          )}

          {/* Active Data Nodes & Hit Targets */}
          {spec.series.map((p, idx) => {
            const cx = toSvgX(p.x);
            const cy = toSvgY(p.y);
            const isHovered = hoverIdx === idx;
            return (
              <g key={idx}>
                {/* Hit Target for easy scrubbing */}
                <circle
                  cx={cx}
                  cy={cy}
                  r={12}
                  fill="transparent"
                  className="cursor-crosshair"
                  onMouseEnter={() => {
                    audioFx.playClick();
                    setHoverIdx(idx);
                  }}
                />
                {/* Visual node */}
                <circle
                  cx={cx}
                  cy={cy}
                  r={isHovered ? 4.5 : 2.5}
                  fill={isHovered ? '#38bdf8' : '#0891b2'}
                  stroke="#ffffff"
                  strokeWidth={isHovered ? 1.5 : 1}
                  className="pointer-events-none transition-all"
                />
              </g>
            );
          })}

          {/* X-axis tick labels */}
          <text x={padL} y={height - 8} textAnchor="start" className="fill-slate-500 text-[8.5px] font-mono">
            {minX}
          </text>
          <text
            x={width - padR}
            y={height - 8}
            textAnchor="end"
            className="fill-slate-500 text-[8.5px] font-mono"
          >
            {maxX}
          </text>
        </svg>
      </div>

      {/* Statistics Footer Strip */}
      <div className="grid grid-cols-4 gap-1 text-[9px] text-slate-400 border-t border-cyan-950/60 pt-1.5 mt-1 text-center">
        <div>
          <span>MIN:</span> <span className="text-slate-200 font-semibold">{stats.min.toFixed(1)}</span>
        </div>
        <div>
          <span>MAX:</span> <span className="text-slate-200 font-semibold">{stats.max.toFixed(1)}</span>
        </div>
        <div>
          <span>AVG:</span> <span className="text-slate-200 font-semibold">{stats.avg.toFixed(1)}</span>
        </div>
        <div>
          <span>CURR:</span> <span className="text-cyan-300 font-semibold">{stats.current.toFixed(1)}</span>
        </div>
      </div>
    </div>
  );
}
