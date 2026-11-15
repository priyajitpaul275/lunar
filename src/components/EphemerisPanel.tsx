import { useEffect, useState } from 'react';
import { Activity, AlertTriangle, CheckCircle2, Download, RefreshCw, ShieldAlert, ShieldCheck, Sun, Wifi } from 'lucide-react';
import { CLPSMission } from '../data/clpsMissions';
import {
  LibrationTelemetryPayload,
  interpolateHorizonMask,
} from '../engine/librationEngine';
import { audioFx } from '../engine/audioFx';

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
    audioFx.playClick();
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

  // SVG Time-Series geometry
  const w = 390;
  const h = 168;
  const padL = 40;
  const padR = 16;
  const padT = 16;
  const padB = 26;
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

  // 360-deg Horizon Mask Azimuth preview
  const azPts: string[] = [];
  if (data) {
    for (let deg = 0; deg <= 360; deg += 4) {
      const el = interpolateHorizonMask(deg, data.horizon_mask_deg);
      const ax = 12 + (deg / 360) * 366;
      const ay = 46 - Math.max(-2, Math.min(14, el)) * 2.6;
      azPts.push(`${deg === 0 ? 'M' : 'L'} ${ax.toFixed(1)} ${ay.toFixed(1)}`);
    }
  }

  return (
    <div className="space-y-4 font-mono text-xs">
      {/* Title & Actions */}
      <div className="flex items-start justify-between gap-2 border-b border-cyan-950/70 pb-2">
        <div>
          <h3 className="text-sm font-semibold text-slate-100 font-display flex items-center gap-1.5">
            <Activity className="w-4 h-4 text-cyan-400" />
            <span>Libration & Solar Duty Cycle</span>
          </h3>
          <p className="text-[10px] text-slate-400 mt-0.5">
            30-Day Horizons Ephemeris (DE441) · IAU2015_Moon Frame
          </p>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            onClick={() => {
              audioFx.playClick();
              fetchLibration(mission, mode, maskRes);
            }}
            disabled={loading}
            className="p-1.5 bg-slate-800 text-slate-200 rounded hover:bg-slate-700 hover:text-cyan-300 cursor-pointer disabled:opacity-50 border border-slate-700"
            title="Recompute JPL Horizons Ephemeris"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin text-cyan-400' : ''}`} />
          </button>
          <button
            type="button"
            onClick={handleExportRfc}
            disabled={!data}
            className="px-2.5 py-1.5 text-[11px] font-medium bg-cyan-500/15 text-cyan-300 border border-cyan-500/40 rounded hover:bg-cyan-500/25 flex items-center gap-1 cursor-pointer disabled:opacity-40"
            title="Export RFC Schema JSON"
          >
            <Download className="w-3 h-3" />
            <span>RFC JSON</span>
          </button>
        </div>
      </div>

      {/* Mode & Horizon Mask Resolution Controls */}
      <div className="grid grid-cols-2 gap-2">
        <div className="flex items-center gap-1 p-1 bg-slate-950/70 border border-cyan-950/60 rounded-md">
          <button
            type="button"
            onClick={() => {
              audioFx.playClick();
              setMode('live');
            }}
            className={`flex-1 px-2 py-1 text-[11px] font-semibold rounded cursor-pointer transition-colors ${
              mode === 'live'
                ? 'bg-cyan-500 text-slate-950 shadow-[0_0_8px_rgba(6,182,212,0.4)]'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            JPL Horizons
          </button>
          <button
            type="button"
            onClick={() => {
              audioFx.playClick();
              setMode('synthetic');
            }}
            className={`flex-1 px-2 py-1 text-[11px] font-semibold rounded cursor-pointer transition-colors ${
              mode === 'synthetic'
                ? 'bg-amber-500 text-slate-950 shadow-[0_0_8px_rgba(245,158,11,0.4)]'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Synthetic
          </button>
        </div>

        <div className="flex items-center gap-1 p-1 bg-slate-950/70 border border-cyan-950/60 rounded-md">
          <button
            type="button"
            onClick={() => {
              audioFx.playClick();
              setMaskRes(360);
            }}
            className={`flex-1 px-2 py-1 text-[11px] font-medium rounded cursor-pointer transition-colors ${
              maskRes === 360
                ? 'bg-slate-800 text-cyan-300 font-bold border border-cyan-800/60'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            360-pt (1°)
          </button>
          <button
            type="button"
            onClick={() => {
              audioFx.playClick();
              setMaskRes(36);
            }}
            className={`flex-1 px-2 py-1 text-[11px] font-medium rounded cursor-pointer transition-colors ${
              maskRes === 36
                ? 'bg-slate-800 text-cyan-300 font-bold border border-cyan-800/60'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            36-pt (10°)
          </button>
        </div>
      </div>

      {loading && (
        <div className="p-4 border border-cyan-950/60 rounded-md bg-slate-950/80 text-xs text-cyan-400 flex items-center gap-2">
          <RefreshCw className="w-4 h-4 animate-spin text-cyan-400" />
          <span>Querying NASA/JPL Horizons Ephemeris API (DE441, 720h vectors)...</span>
        </div>
      )}

      {error && !loading && (
        <div className="p-3 border border-rose-900/60 bg-rose-950/30 rounded-md text-xs text-rose-300 space-y-2">
          <div className="flex items-center gap-1.5 font-semibold">
            <AlertTriangle className="w-4 h-4 text-rose-400" />
            <span>Horizons upstream query note: {error}</span>
          </div>
          <button
            type="button"
            onClick={() => {
              audioFx.playClick();
              setMode('synthetic');
            }}
            className="text-amber-300 hover:text-amber-200 underline cursor-pointer text-[11px]"
          >
            Engage Analytic Libration Fallback (Synthetic Mode)
          </button>
        </div>
      )}

      {data && !loading && (
        <>
          {/* Provenance Card */}
          <div className="bg-slate-950/70 border border-cyan-950/60 rounded-md p-2.5 text-[11px] space-y-1">
            <div className="flex justify-between">
              <span className="text-slate-400">Ephemeris Source:</span>
              <span className="text-cyan-300 font-semibold truncate max-w-[220px]">{data.source}</span>
            </div>
            <div className="flex justify-between text-slate-400">
              <span>Telemetry Flags:</span>
              <span className="text-slate-300">
                mock: {String(data.mock)} · {data.latencyMs ?? 0} ms · {data.cache ?? 'MISS'}
              </span>
            </div>
          </div>

          {/* Hardware Protection Gates */}
          <div className="grid grid-cols-2 gap-2.5">
            {/* Solar Duty Gate */}
            <div className={`p-3 rounded-lg border bg-slate-950/80 ${
              data.solar_illumination.pass
                ? 'border-emerald-500/40 shadow-[0_0_12px_rgba(16,185,129,0.15)]'
                : 'border-rose-500/40 shadow-[0_0_12px_rgba(244,63,94,0.15)]'
            }`}>
              <div className="flex items-center justify-between text-[11px]">
                <span className="text-slate-400 flex items-center gap-1">
                  <Sun className="w-3 h-3 text-amber-400" />
                  Solar Duty Gate
                </span>
                <span className={`font-bold flex items-center gap-1 ${
                  data.solar_illumination.pass ? 'text-emerald-400' : 'text-rose-400'
                }`}>
                  {data.solar_illumination.pass ? <ShieldCheck className="w-3.5 h-3.5" /> : <ShieldAlert className="w-3.5 h-3.5" />}
                  {data.solar_illumination.pass ? 'PASS' : 'FAIL'}
                </span>
              </div>
              <div className="text-xl font-bold text-slate-100 mt-1">
                {data.solar_illumination.duty_cycle_pct.toFixed(1)}%
              </div>
              <div className="text-[10px] text-slate-400 mt-0.5">
                Gate ≥ 70.0% · Max Shadow {data.solar_illumination.max_continuous_shadow_hrs}h
              </div>
            </div>

            {/* DTE Comms Gate */}
            <div className={`p-3 rounded-lg border bg-slate-950/80 ${
              data.dte_comms.pass
                ? 'border-emerald-500/40 shadow-[0_0_12px_rgba(16,185,129,0.15)]'
                : 'border-rose-500/40 shadow-[0_0_12px_rgba(244,63,94,0.15)]'
            }`}>
              <div className="flex items-center justify-between text-[11px]">
                <span className="text-slate-400 flex items-center gap-1">
                  <Wifi className="w-3 h-3 text-cyan-400" />
                  DTE Comms Gate
                </span>
                <span className={`font-bold flex items-center gap-1 ${
                  data.dte_comms.pass ? 'text-emerald-400' : 'text-rose-400'
                }`}>
                  {data.dte_comms.pass ? <ShieldCheck className="w-3.5 h-3.5" /> : <ShieldAlert className="w-3.5 h-3.5" />}
                  {data.dte_comms.pass ? 'PASS' : 'FAIL'}
                </span>
              </div>
              <div className="text-xl font-bold text-slate-100 mt-1">
                {data.dte_comms.visibility_pct.toFixed(1)}%
              </div>
              <div className="text-[10px] text-slate-400 mt-0.5">
                Gate ≥ 55.0% · Blackout {data.dte_comms.max_blackout_hrs}h
              </div>
            </div>
          </div>

          {/* 30-Day Topocentric Elevation vs Local Horizon Mask */}
          <div className="border border-cyan-950/70 bg-[#060a12] rounded-lg p-3">
            <div className="flex items-center justify-between mb-2">
              <h4 className="text-xs font-semibold text-slate-200 font-display">
                Topocentric Elevation vs MOON_ME Mask (720h)
              </h4>
              <span className="text-[10px] text-cyan-400 font-bold">
                Libration ±{data.dte_comms.libration_range_deg}°
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
                      stroke={val === 0 ? '#334155' : '#111827'}
                      strokeDasharray={val === 0 ? '3 3' : undefined}
                      strokeWidth="1"
                    />
                    <text
                      x={padL - 6}
                      y={gy + 3}
                      textAnchor="end"
                      className="fill-slate-500 text-[8.5px] font-mono"
                    >
                      {val}°
                    </text>
                  </g>
                );
              })}

              {/* Mask path */}
              <path d={maskPath} fill="none" stroke="#64748b" strokeWidth="1.2" strokeDasharray="3 2" />
              {/* Sun Path */}
              <path d={sunPath} fill="none" stroke="#f59e0b" strokeWidth="2" strokeLinejoin="round" />
              {/* Earth Path */}
              <path d={earthPath} fill="none" stroke="#06b6d4" strokeWidth="2" strokeLinejoin="round" />

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
                    onMouseEnter={() => {
                      audioFx.playClick();
                      setHoverIdx(i);
                    }}
                  />
                );
              })}

              {hoverIdx !== null && sampledSeries[hoverIdx] && (
                <line
                  x1={toX(hoverIdx)}
                  x2={toX(hoverIdx)}
                  y1={padT}
                  y2={padT + plotH}
                  stroke="#38bdf8"
                  strokeWidth="1.5"
                />
              )}

              <text x={padL} y={h - 6} className="fill-slate-500 text-[8.5px] font-mono">
                T+0h
              </text>
              <text x={padL + plotW / 2} y={h - 6} textAnchor="middle" className="fill-slate-400 text-[8.5px]">
                Sun (Amber) · Earth (Cyan) · Horizon Mask (Dashed)
              </text>
              <text x={w - padR} y={h - 6} textAnchor="end" className="fill-slate-500 text-[8.5px] font-mono">
                T+720h
              </text>
            </svg>

            {activeSample && (
              <div className="mt-2 pt-2 border-t border-slate-800/80 grid grid-cols-2 gap-2 text-[11px] text-slate-300">
                <div>
                  Sun: <span className="text-amber-300 font-semibold">{activeSample.sunElDeg}°</span> / Mask{' '}
                  {activeSample.sunMaskElDeg}° ({activeSample.sunLit ? '☀️ LIT' : '🌑 SHADOW'})
                </div>
                <div className="text-right">
                  Earth: <span className="text-cyan-300 font-semibold">{activeSample.earthElDeg}°</span> (
                  {activeSample.earthVisible ? 'DIRECT COMM' : 'OCCULTED'})
                </div>
              </div>
            )}
          </div>

          {/* 360° Terrain Horizon Profile */}
          <div className="border border-cyan-950/70 bg-[#060a12] rounded-lg p-3">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-xs font-semibold text-slate-200 font-display">
                MOON_ME 360° Site Horizon Mask ({data.site.horizon_mask_points} pts)
              </span>
              <span className="text-[10px] text-slate-400">Azimuth: 0° (North) → 360°</span>
            </div>
            <svg viewBox="0 0 390 54" className="w-full h-auto">
              <line x1="12" x2="378" y1="44" y2="44" stroke="#1e293b" strokeWidth="1" />
              <path d={azPts.join(' ')} fill="none" stroke="#38bdf8" strokeWidth="1.5" />
            </svg>
            <p className="text-[10px] text-slate-400 leading-relaxed mt-1">
              {data.frame_alignment_note}
            </p>
          </div>
        </>
      )}
    </div>
  );
}
