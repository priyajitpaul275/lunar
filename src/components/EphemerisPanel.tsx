import { useEffect, useState } from 'react';
import { Download, RefreshCw } from 'lucide-react';
import { CLPSMission } from '../data/clpsMissions';
import {
  LibrationTelemetryPayload,
  interpolateHorizonMask,
} from '../engine/librationEngine';

interface EphemerisPanelProps {
  mission: CLPSMission;
}

export function EphemerisPanel({ mission }: EphemerisPanelProps) {
  const [mode, setMode] = useState<'live' | 'synthetic'>('live');
  const [maskRes, setMaskRes] = useState<36 | 360>(360);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<LibrationTelemetryPayload | null>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const fetchLibration = async (m: CLPSMission, reqMode: 'live' | 'synthetic', resPts: 36 | 360) => {
    setLoading(true);
    setError(null);
    try {
      const url = `/api/ephemeris/libration?lat=${m.latDeg}&lon=${m.lonDeg}&elevM=${m.elevationM}&hours=720&maskRes=${resPts}&mode=${reqMode}`;
      const res = await fetch(url);
      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.error || `HTTP ${res.status}`);
      }
      setData(json as LibrationTelemetryPayload);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch Horizons ephemeris');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchLibration(mission, mode, maskRes);
  }, [mission, mode, maskRes]);

  const handleExportRfc = () => {
    if (!data) return;
    const exportObj = {
      schema: data.schema,
      mock: data.mock,
      source: data.source,
      reference_frame: data.reference_frame,
      moon_radius_m: data.moon_radius_m,
      site: data.site,
      solar_illumination: data.solar_illumination,
      dte_comms: data.dte_comms,
      frame_alignment_note: data.frame_alignment_note,
    };
    const blob = new Blob([JSON.stringify(exportObj, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `rfc-2026-clps-v1.0-${mission.id}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Sample every 6h (120 pts) for crisp SVG time-series plotting
  const sampledSeries = data ? data.series.filter((_, idx) => idx % 6 === 0) : [];
  const activeSample =
    hoverIdx !== null && sampledSeries[hoverIdx]
      ? sampledSeries[hoverIdx]
      : sampledSeries[sampledSeries.length - 1] ?? null;

  // SVG Time-Series geometry (Sun El, Earth El, Local Sun Horizon Mask El)
  const w = 380;
  const h = 158;
  const padL = 38;
  const padR = 14;
  const padT = 14;
  const padB = 24;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;

  let minEl = -20;
  let maxEl = 40;
  if (sampledSeries.length > 0) {
    const allEls = sampledSeries.flatMap((s) => [s.sunElDeg, s.earthElDeg, s.sunMaskElDeg]);
    minEl = Math.min(-10, Math.floor(Math.min(...allEls) / 5) * 5);
    maxEl = Math.max(15, Math.ceil(Math.max(...allEls) / 5) * 5);
  }
  const spanEl = maxEl - minEl || 1;
  const toX = (i: number) =>
    padL + (sampledSeries.length > 1 ? (i / (sampledSeries.length - 1)) * plotW : 0);
  const toY = (el: number) => padT + plotH - ((el - minEl) / spanEl) * plotH;

  const sunPath = sampledSeries
    .map((s, i) => `${i === 0 ? 'M' : 'L'} ${toX(i).toFixed(1)} ${toY(s.sunElDeg).toFixed(1)}`)
    .join(' ');
  const earthPath = sampledSeries
    .map((s, i) => `${i === 0 ? 'M' : 'L'} ${toX(i).toFixed(1)} ${toY(s.earthElDeg).toFixed(1)}`)
    .join(' ');
  const maskPath = sampledSeries
    .map((s, i) => `${i === 0 ? 'M' : 'L'} ${toX(i).toFixed(1)} ${toY(s.sunMaskElDeg).toFixed(1)}`)
    .join(' ');

  // 360-deg Horizon Mask Azimuth Preview sparkline
  const azPts: string[] = [];
  if (data) {
    for (let deg = 0; deg <= 360; deg += 5) {
      const el = interpolateHorizonMask(deg, data.horizon_mask_deg);
      const ax = 12 + (deg / 360) * 356;
      const ay = 44 - Math.max(-2, Math.min(12, el)) * 2.8;
      azPts.push(`${deg === 0 ? 'M' : 'L'} ${ax.toFixed(1)} ${ay.toFixed(1)}`);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-slate-100">
            Libration & Solar Duty Cycle (30-Day)
          </h3>
          <p className="text-[11px] font-mono text-slate-400 mt-0.5">
            rfc-2026-clps-v1.0 · IAU_MOON_2015_ME
          </p>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            onClick={() => fetchLibration(mission, mode, maskRes)}
            disabled={loading}
            className="p-1.5 bg-slate-800 text-slate-200 rounded hover:bg-slate-700 cursor-pointer disabled:opacity-50"
            aria-label="Recompute Horizons Ephemeris"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
          <button
            type="button"
            onClick={handleExportRfc}
            disabled={!data}
            className="px-2.5 py-1.5 text-[11px] font-medium bg-slate-800 text-slate-100 rounded hover:bg-slate-700 flex items-center gap-1 cursor-pointer disabled:opacity-40"
          >
            <Download className="w-3 h-3" />
            <span>JSON</span>
          </button>
        </div>
      </div>

      {/* Mode & Horizon Mask Resolution Controls */}
      <div className="grid grid-cols-2 gap-2">
        <div className="flex items-center gap-1 p-1 bg-slate-900 border border-slate-800 rounded-md">
          <button
            type="button"
            onClick={() => setMode('live')}
            className={`flex-1 px-2 py-1 text-[11px] font-medium rounded cursor-pointer ${
              mode === 'live'
                ? 'bg-cyan-500 text-slate-950 font-semibold'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            JPL Horizons
          </button>
          <button
            type="button"
            onClick={() => setMode('synthetic')}
            className={`flex-1 px-2 py-1 text-[11px] font-medium rounded cursor-pointer ${
              mode === 'synthetic'
                ? 'bg-amber-500 text-slate-950 font-semibold'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Synthetic
          </button>
        </div>

        <div className="flex items-center gap-1 p-1 bg-slate-900 border border-slate-800 rounded-md">
          <button
            type="button"
            onClick={() => setMaskRes(360)}
            className={`flex-1 px-2 py-1 text-[11px] font-medium rounded cursor-pointer ${
              maskRes === 360
                ? 'bg-slate-700 text-slate-100 font-semibold'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            360-pt (1°)
          </button>
          <button
            type="button"
            onClick={() => setMaskRes(36)}
            className={`flex-1 px-2 py-1 text-[11px] font-medium rounded cursor-pointer ${
              maskRes === 36
                ? 'bg-slate-700 text-slate-100 font-semibold'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            36-pt (10°)
          </button>
        </div>
      </div>

      {loading && (
        <div className="p-3 border border-slate-800 rounded bg-[#070A10] text-xs text-slate-400">
          Querying NASA/JPL Horizons API (CENTER=&apos;coord@301&apos;, DE441) for 720h Sun & Earth vectors...
        </div>
      )}

      {error && !loading && (
        <div className="p-3 border border-rose-900/60 bg-rose-950/30 rounded text-xs text-rose-300 space-y-2">
          <div>Horizons query note: {error}</div>
          <button
            type="button"
            onClick={() => setMode('synthetic')}
            className="text-amber-300 underline cursor-pointer"
          >
            Switch to Analytic Libration Fallback
          </button>
        </div>
      )}

      {data && !loading && (
        <>
          {/* Source & Mock Flag Provenance */}
          <div className="bg-[#070A10] border border-slate-800 rounded p-2.5 text-[11px] font-mono space-y-1">
            <div className="flex justify-between">
              <span className="text-slate-400">Ephemeris Source:</span>
              <span className="text-cyan-300 truncate max-w-[230px]">{data.source}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-400">Payload Flags:</span>
              <span className="text-slate-200">
                mock: {String(data.mock)} · {data.latencyMs ?? 0} ms · {data.cache ?? 'MISS'}
              </span>
            </div>
          </div>

          {/* Hardware Protection Gates */}
          <div className="grid grid-cols-2 gap-2.5">
            <div className="bg-[#070A10] border border-slate-800 rounded p-3">
              <div className="flex items-center justify-between text-[11px]">
                <span className="text-slate-400">Solar Duty Gate</span>
                <span
                  className={`font-mono font-semibold ${
                    data.solar_illumination.pass ? 'text-emerald-400' : 'text-rose-400'
                  }`}
                >
                  {data.solar_illumination.pass ? '● PASS' : '✖ FAIL'}
                </span>
              </div>
              <div className="text-xl font-mono font-semibold text-slate-100 mt-1">
                {data.solar_illumination.duty_cycle_pct.toFixed(1)}%
              </div>
              <div className="text-[11px] font-mono text-slate-400 mt-1">
                Gate ≥ 70.0% · Max Shadow {data.solar_illumination.max_continuous_shadow_hrs}h
              </div>
            </div>

            <div className="bg-[#070A10] border border-slate-800 rounded p-3">
              <div className="flex items-center justify-between text-[11px]">
                <span className="text-slate-400">DTE Comms Gate</span>
                <span
                  className={`font-mono font-semibold ${
                    data.dte_comms.pass ? 'text-emerald-400' : 'text-rose-400'
                  }`}
                >
                  {data.dte_comms.pass ? '● PASS' : '✖ FAIL'}
                </span>
              </div>
              <div className="text-xl font-mono font-semibold text-slate-100 mt-1">
                {data.dte_comms.visibility_pct.toFixed(1)}%
              </div>
              <div className="text-[11px] font-mono text-slate-400 mt-1">
                Gate ≥ 55.0% · Blackout {data.dte_comms.max_blackout_hrs}h
              </div>
            </div>
          </div>

          {/* 30-Day Sun & Earth Elevation vs Local Horizon Mask SVG */}
          <div className="border border-slate-800 bg-[#070A10] rounded-lg p-3">
            <div className="flex items-center justify-between mb-2">
              <h4 className="text-xs font-semibold text-slate-200">
                Topocentric Elevation vs MOON_ME Mask (720h)
              </h4>
              <span className="text-[11px] font-mono text-slate-400">
                Libration {data.dte_comms.libration_range_deg}°
              </span>
            </div>

            <svg
              viewBox={`0 0 ${w} ${h}`}
              className="w-full h-auto overflow-visible select-none"
              onMouseLeave={() => setHoverIdx(null)}
            >
              {[minEl, 0, maxEl].map((val) => {
                const gy = toY(val);
                return (
                  <g key={val}>
                    <line
                      x1={padL}
                      x2={w - padR}
                      y1={gy}
                      y2={gy}
                      stroke={val === 0 ? '#334155' : '#1e293b'}
                      strokeDasharray={val === 0 ? '3 3' : undefined}
                      strokeWidth="1"
                    />
                    <text
                      x={padL - 5}
                      y={gy + 3}
                      textAnchor="end"
                      className="fill-slate-500 text-[9px] font-mono"
                    >
                      {val}°
                    </text>
                  </g>
                );
              })}

              {/* Terrain Horizon Mask Trace */}
              <path d={maskPath} fill="none" stroke="#64748b" strokeWidth="1.2" strokeDasharray="3 2" />
              {/* Sun Elevation */}
              <path d={sunPath} fill="none" stroke="#f59e0b" strokeWidth="1.8" />
              {/* Earth DTE Elevation */}
              <path d={earthPath} fill="none" stroke="#06b6d4" strokeWidth="1.8" />

              {sampledSeries.map((_, i) => {
                const cx = toX(i);
                return (
                  <rect
                    key={i}
                    x={cx - 2}
                    y={padT}
                    width={4}
                    height={plotH}
                    fill="transparent"
                    className="cursor-crosshair"
                    onMouseEnter={() => setHoverIdx(i)}
                  />
                );
              })}

              {hoverIdx !== null && sampledSeries[hoverIdx] && (
                <line
                  x1={toX(hoverIdx)}
                  x2={toX(hoverIdx)}
                  y1={padT}
                  y2={padT + plotH}
                  stroke="#94a3b8"
                  strokeWidth="1"
                />
              )}

              <text x={padL} y={h - 5} className="fill-slate-500 text-[9px] font-mono">
                T+0h
              </text>
              <text x={padL + plotW / 2} y={h - 5} textAnchor="middle" className="fill-slate-400 text-[9px]">
                Sun (Amber) · Earth DTE (Cyan) · Horizon Mask (Dashed)
              </text>
              <text x={w - padR} y={h - 5} textAnchor="end" className="fill-slate-500 text-[9px] font-mono">
                T+720h
              </text>
            </svg>

            {activeSample && (
              <div className="mt-2 pt-2 border-t border-slate-800/80 grid grid-cols-2 gap-2 text-[11px] font-mono text-slate-400">
                <div>
                  Sun: <span className="text-amber-300">{activeSample.sunElDeg}°</span> / Mask{' '}
                  {activeSample.sunMaskElDeg}° ({activeSample.sunLit ? 'LIT' : 'SHADOW'})
                </div>
                <div className="text-right">
                  Earth: <span className="text-cyan-300">{activeSample.earthElDeg}°</span> (
                  {activeSample.earthVisible ? 'DTE' : 'LOS'})
                </div>
              </div>
            )}
          </div>

          {/* 360° Terrain Horizon Profile Strip */}
          <div className="border border-slate-800 bg-[#070A10] rounded-lg p-3">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-xs font-semibold text-slate-200">
                MOON_ME 360° Horizon Mask ({data.site.horizon_mask_points} pts)
              </span>
              <span className="text-[11px] font-mono text-slate-400">0° → 360° Az</span>
            </div>
            <svg viewBox="0 0 380 54" className="w-full h-auto">
              <line x1="12" x2="368" y1="44" y2="44" stroke="#1e293b" strokeWidth="1" />
              <path d={azPts.join(' ')} fill="none" stroke="#94a3b8" strokeWidth="1.5" />
            </svg>
            <p className="text-[11px] text-slate-400 leading-relaxed mt-1">
              {data.frame_alignment_note}
            </p>
          </div>
        </>
      )}
    </div>
  );
}
