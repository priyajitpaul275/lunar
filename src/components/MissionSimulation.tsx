import { useEffect, useMemo, useState } from 'react';
import {
  Activity,
  Calendar,
  Clock,
  Compass,
  Download,
  Globe2,
  MapPin,
  Play,
  RotateCcw,
  Sparkles,
  Sun,
  Wifi,
} from 'lucide-react';
import { CLPSMission, CLPS_MISSIONS } from '../data/clpsMissions';
import {
  computeDutyCycleTelemetry,
  computeSubsolarLonDegFromUtc,
  generateSiteHorizonMask,
  generateSyntheticAzElSeries,
  LibrationTelemetryPayload,
} from '../engine/librationEngine';
import { audioFx } from '../engine/audioFx';

interface MissionSimulationProps {
  currentMission?: CLPSMission;
  onSync3DGlobe?: (solarLonDeg: number, missionId: string) => void;
  onClose?: () => void;
}

interface SiteOption {
  id: string;
  name: string;
  latDeg: number;
  lonDeg: number;
  elevationM: number;
  taskOrder: string;
}

const PRESET_SITES: SiteOption[] = [
  {
    id: 'ct-3',
    name: 'Connecting Ridge',
    latDeg: -89.4,
    lonDeg: -137.0,
    elevationM: 4650,
    taskOrder: 'TO CT-3 / Blue Moon MK1',
  },
  {
    id: 'artemis-malapert-massif',
    name: 'Malapert Massif',
    latDeg: -85.98,
    lonDeg: -2.6,
    elevationM: 4920,
    taskOrder: 'A3-CAND-01',
  },
  {
    id: 'im-2',
    name: 'Mons Mouton',
    latDeg: -84.99,
    lonDeg: 29.2,
    elevationM: 5210,
    taskOrder: 'TO PRIME-1 / IM-2',
  },
  {
    id: 'artemis-peak-shackleton',
    name: 'Peak Near Shackleton',
    latDeg: -88.85,
    lonDeg: 123.5,
    elevationM: 4210,
    taskOrder: 'A3-CAND-02',
  },
  {
    id: 'to2-im',
    name: 'Malapert A Crater',
    latDeg: -80.13,
    lonDeg: 3.44,
    elevationM: 1480,
    taskOrder: 'TO2-IM / Odysseus',
  },
  {
    id: 'to20a',
    name: 'Nobile Crater Rim',
    latDeg: -85.2,
    lonDeg: 53.5,
    elevationM: 3890,
    taskOrder: 'TO 20A / Griffin',
  },
  {
    id: 'to19d',
    name: 'Mare Crisium (Mons Latreille)',
    latDeg: 18.56,
    lonDeg: 61.81,
    elevationM: -3460,
    taskOrder: 'TO 19D / Blue Ghost 1',
  },
  {
    id: 'cp-11',
    name: 'Reiner Gamma Swirl',
    latDeg: 7.5,
    lonDeg: -59.0,
    elevationM: -2040,
    taskOrder: 'TO CP-11 / IM-3',
  },
  {
    id: 'cp-12',
    name: 'Schrödinger Basin',
    latDeg: -75.0,
    lonDeg: 132.4,
    elevationM: -4180,
    taskOrder: 'TO CP-12 / APEX 1.0',
  },
  {
    id: 'cs-3',
    name: 'Far Side Basin',
    latDeg: -44.0,
    lonDeg: 175.0,
    elevationM: -2810,
    taskOrder: 'TO CS-3 / Blue Ghost 2',
  },
];

export function MissionSimulation({
  currentMission,
  onSync3DGlobe,
}: MissionSimulationProps) {
  // Input form state matching Mariam's screen
  const [selectedSiteId, setSelectedSiteId] = useState<string>(() => {
    if (currentMission) {
      const match = PRESET_SITES.find((s) => s.id === currentMission.id);
      if (match) return match.id;
    }
    return 'ct-3'; // Connecting Ridge by default
  });

  const [startUtc, setStartUtc] = useState<string>('2026-11-15T00:00');
  const [durationDays, setDurationDays] = useState<number>(30);
  const [stepHours, setStepHours] = useState<number>(6);

  // Simulation output state
  const [data, setData] = useState<LibrationTelemetryPayload | null>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const selectedSite = useMemo(() => {
    return PRESET_SITES.find((s) => s.id === selectedSiteId) || PRESET_SITES[0];
  }, [selectedSiteId]);

  const totalHours = Math.max(1, durationDays * 24);
  const computedSamplesCount = Math.max(1, Math.round(totalHours / Math.max(1, stepHours)));

  // Calculate simulation
  const runSimulation = () => {
    audioFx.playEngage();
    const mask = generateSiteHorizonMask(
      selectedSite.latDeg,
      selectedSite.lonDeg,
      selectedSite.elevationM,
      360
    );

    const { sunRows, earthRows } = generateSyntheticAzElSeries(
      selectedSite.latDeg,
      selectedSite.lonDeg,
      selectedSite.elevationM,
      totalHours,
      stepHours,
      startUtc
    );

    const payload = computeDutyCycleTelemetry({
      latDeg: selectedSite.latDeg,
      lonDeg: selectedSite.lonDeg,
      elevationM: selectedSite.elevationM,
      horizonMaskDeg: mask,
      sunRows,
      earthRows,
      mock: true,
      source: 'Analytic Libration Model (UTC 2020-2040)',
      stepHours,
    });

    setData(payload);
  };

  // Run initial simulation on load
  useEffect(() => {
    runSimulation();
  }, []);

  // Quick Presets
  const applyPreset = (days: number, step: number) => {
    audioFx.playClick();
    setDurationDays(days);
    setStepHours(step);

    const mask = generateSiteHorizonMask(
      selectedSite.latDeg,
      selectedSite.lonDeg,
      selectedSite.elevationM,
      360
    );

    const hrs = days * 24;
    const { sunRows, earthRows } = generateSyntheticAzElSeries(
      selectedSite.latDeg,
      selectedSite.lonDeg,
      selectedSite.elevationM,
      hrs,
      step,
      startUtc
    );

    const payload = computeDutyCycleTelemetry({
      latDeg: selectedSite.latDeg,
      lonDeg: selectedSite.lonDeg,
      elevationM: selectedSite.elevationM,
      horizonMaskDeg: mask,
      sunRows,
      earthRows,
      mock: true,
      source: 'Analytic Libration Model (UTC 2020-2040)',
      stepHours: step,
    });

    setData(payload);
  };

  // Sync with 3D Globe
  const handleSync3DGlobe = () => {
    if (!onSync3DGlobe) return;
    audioFx.playRadarPing();
    const subsolarLon = computeSubsolarLonDegFromUtc(startUtc);
    onSync3DGlobe(subsolarLon, selectedSite.id);
  };

  // SVG Chart Dimensions
  const w = 480;
  const h = 180;
  const padL = 46;
  const padR = 20;
  const padT = 20;
  const padB = 30;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;

  const series = data?.series ?? [];
  const activePoint =
    hoverIdx !== null && series[hoverIdx]
      ? series[hoverIdx]
      : series[series.length - 1] ?? null;

  // Compute elevation domain
  let minEl = -10;
  let maxEl = 10;
  if (series.length > 0) {
    const all = series.flatMap((s) => [s.sunElDeg, s.earthElDeg]);
    minEl = Math.min(-6, Math.floor(Math.min(...all) / 2) * 2);
    maxEl = Math.max(6, Math.ceil(Math.max(...all) / 2) * 2);
  }
  const spanEl = maxEl - minEl || 1;

  const toX = (i: number) =>
    padL + (series.length > 1 ? (i / (series.length - 1)) * plotW : 0);
  const toY = (el: number) => padT + plotH - ((el - minEl) / spanEl) * plotH;

  const sunPath = series
    .map((s, i) => `${i === 0 ? 'M' : 'L'} ${toX(i).toFixed(1)} ${toY(s.sunElDeg).toFixed(1)}`)
    .join(' ');
  const earthPath = series
    .map((s, i) => `${i === 0 ? 'M' : 'L'} ${toX(i).toFixed(1)} ${toY(s.earthElDeg).toFixed(1)}`)
    .join(' ');

  // Compute period end timestamp
  const endUtc = useMemo(() => {
    const st = new Date(startUtc);
    if (Number.isNaN(st.getTime())) return '';
    const et = new Date(st.getTime() + totalHours * 3600 * 1000);
    return et.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
  }, [startUtc, totalHours]);

  return (
    <div className="space-y-4 font-mono text-xs text-slate-200">
      {/* Header Block matching Mariam's screen */}
      <div className="border-b border-cyan-950/80 pb-3">
        <h2 className="text-base font-bold text-white font-display tracking-wide flex items-center gap-2">
          <Activity className="w-4 h-4 text-cyan-400" />
          <span>Mission simulation</span>
        </h2>
        <p className="text-[11px] text-slate-400 mt-1 leading-relaxed">
          Sun and Earth geometry over a chosen UTC period, combined with the site&apos;s terrain horizon.
          Time system: UTC (approximate analytic model). Supported range 2020–2040.
        </p>
      </div>

      {/* Input Controls Card matching Mariam's screen */}
      <div className="p-3.5 bg-slate-950/85 border border-cyan-950/70 rounded-xl space-y-3 shadow-lg">
        <div className="grid grid-cols-1 sm:grid-cols-12 gap-3 items-end">
          {/* Site Selector */}
          <div className="sm:col-span-4">
            <label className="block text-[10px] uppercase tracking-wider text-slate-400 mb-1 font-semibold">
              Site
            </label>
            <select
              value={selectedSiteId}
              onChange={(e) => {
                audioFx.playClick();
                setSelectedSiteId(e.target.value);
              }}
              className="w-full bg-slate-900 border border-slate-700/80 rounded-md px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-cyan-500 cursor-pointer"
            >
              {PRESET_SITES.map((site) => (
                <option key={site.id} value={site.id}>
                  {site.name} ({site.latDeg.toFixed(1)}°, {site.elevationM}m)
                </option>
              ))}
            </select>
          </div>

          {/* Start (UTC) Datetime Picker */}
          <div className="sm:col-span-3">
            <label className="block text-[10px] uppercase tracking-wider text-slate-400 mb-1 font-semibold">
              Start (UTC)
            </label>
            <input
              type="datetime-local"
              value={startUtc}
              onChange={(e) => setStartUtc(e.target.value)}
              className="w-full bg-slate-900 border border-slate-700/80 rounded-md px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-cyan-500"
            />
          </div>

          {/* Duration (days) */}
          <div className="sm:col-span-2">
            <label className="block text-[10px] uppercase tracking-wider text-slate-400 mb-1 font-semibold">
              Duration (days)
            </label>
            <input
              type="number"
              min={1}
              max={365}
              value={durationDays}
              onChange={(e) => setDurationDays(Math.max(1, Number(e.target.value)))}
              className="w-full bg-slate-900 border border-slate-700/80 rounded-md px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-cyan-500"
            />
          </div>

          {/* Step (hours) */}
          <div className="sm:col-span-1">
            <label className="block text-[10px] uppercase tracking-wider text-slate-400 mb-1 font-semibold truncate">
              Step (h)
            </label>
            <select
              value={stepHours}
              onChange={(e) => setStepHours(Number(e.target.value))}
              className="w-full bg-slate-900 border border-slate-700/80 rounded-md px-1.5 py-1.5 text-xs text-white focus:outline-none focus:border-cyan-500 cursor-pointer"
            >
              <option value={1}>1</option>
              <option value={3}>3</option>
              <option value={6}>6</option>
              <option value={12}>12</option>
              <option value={24}>24</option>
            </select>
          </div>

          {/* Run Simulation Button */}
          <div className="sm:col-span-2">
            <button
              type="button"
              onClick={runSimulation}
              className="w-full bg-gradient-to-r from-cyan-500 to-cyan-600 hover:from-cyan-400 hover:to-cyan-500 text-slate-950 font-bold px-3 py-1.5 rounded-md transition-all cursor-pointer shadow-[0_0_12px_rgba(6,182,212,0.3)] flex items-center justify-center gap-1.5"
            >
              <Play className="w-3.5 h-3.5 fill-current" />
              <span>Run simulation</span>
            </button>
          </div>
        </div>

        {/* Quick Preset Buttons & Sample Count row */}
        <div className="flex flex-wrap items-center justify-between gap-2 pt-1 border-t border-slate-800/60">
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => applyPreset(7, 1)}
              className={`px-2.5 py-1 rounded border text-[11px] font-semibold transition-colors cursor-pointer ${
                durationDays === 7 && stepHours === 1
                  ? 'bg-cyan-500/25 text-cyan-300 border-cyan-500/50'
                  : 'bg-slate-900 text-slate-400 border-slate-800 hover:text-white'
              }`}
            >
              7 d · 1 h
            </button>
            <button
              type="button"
              onClick={() => applyPreset(30, 6)}
              className={`px-2.5 py-1 rounded border text-[11px] font-semibold transition-colors cursor-pointer ${
                durationDays === 30 && stepHours === 6
                  ? 'bg-cyan-500/25 text-cyan-300 border-cyan-500/50'
                  : 'bg-slate-900 text-slate-400 border-slate-800 hover:text-white'
              }`}
            >
              30 d · 6 h
            </button>
            <button
              type="button"
              onClick={() => applyPreset(90, 12)}
              className={`px-2.5 py-1 rounded border text-[11px] font-semibold transition-colors cursor-pointer ${
                durationDays === 90 && stepHours === 12
                  ? 'bg-cyan-500/25 text-cyan-300 border-cyan-500/50'
                  : 'bg-slate-900 text-slate-400 border-slate-800 hover:text-white'
              }`}
            >
              90 d · 12 h
            </button>
          </div>

          <div className="text-[11px] text-slate-400 flex items-center gap-2">
            <span>This run will compute {computedSamplesCount} samples.</span>
            {onSync3DGlobe && (
              <button
                type="button"
                onClick={handleSync3DGlobe}
                className="px-2 py-0.5 rounded bg-amber-500/20 text-amber-300 hover:bg-amber-500/30 border border-amber-500/40 text-[10px] font-bold flex items-center gap-1 cursor-pointer transition-colors"
                title="Sync 3D globe lighting with this date and time"
              >
                <Globe2 className="w-3 h-3" />
                <span>Sync 3D Moon</span>
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Output Metric Cards matching Mariam's screen */}
      {data && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {/* Card 1: Period */}
          <div className="p-3.5 bg-slate-950/80 border border-slate-800 rounded-xl space-y-1">
            <div className="text-[10px] text-slate-400 uppercase tracking-wide font-semibold">
              Period
            </div>
            <div className="text-xs font-semibold text-slate-100 leading-tight">
              {startUtc.replace('T', ' ')} UTC →
            </div>
            <div className="text-xs font-semibold text-slate-100 leading-tight">
              {endUtc}
            </div>
            <div className="text-[10px] text-slate-400 pt-1">
              Samples: {series.length} (every {stepHours} h)
            </div>
          </div>

          {/* Card 2: Sun visible above terrain */}
          <div className="p-3.5 bg-slate-950/80 border border-slate-800 rounded-xl space-y-1">
            <div className="text-[10px] text-slate-400 uppercase tracking-wide font-semibold flex items-center gap-1">
              <Sun className="w-3 h-3 text-amber-400" />
              <span>Sun visible above terrain</span>
            </div>
            <div className="text-2xl font-bold text-white font-mono">
              {data.solar_illumination.duty_cycle_pct.toFixed(1)}%
            </div>
            <div className="text-[10px] text-slate-400">
              longest dark gap {data.solar_illumination.max_continuous_shadow_hrs.toFixed(1)} h
            </div>
          </div>

          {/* Card 3: Earth visible above terrain */}
          <div className="p-3.5 bg-slate-950/80 border border-slate-800 rounded-xl space-y-1">
            <div className="text-[10px] text-slate-400 uppercase tracking-wide font-semibold flex items-center gap-1">
              <Wifi className="w-3 h-3 text-cyan-400" />
              <span>Earth visible above terrain</span>
            </div>
            <div className="text-2xl font-bold text-white font-mono">
              {data.dte_comms.visibility_pct.toFixed(1)}%
            </div>
            <div className="text-[10px] text-slate-400">
              longest gap {data.dte_comms.max_blackout_hrs.toFixed(1)} h
            </div>
          </div>
        </div>
      )}

      {/* Interactive Elevation Curve matching Mariam's screen */}
      {data && (
        <div className="p-4 bg-slate-950/80 border border-slate-800 rounded-xl space-y-2 shadow-inner">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-bold text-white font-display tracking-wide">
              Elevation above local horizontal
            </h3>
            <div className="flex items-center gap-3 text-[10px]">
              <span className="flex items-center gap-1 text-amber-400 font-semibold">
                <span className="w-2.5 h-0.5 bg-amber-400 inline-block" />
                Sun Elevation
              </span>
              <span className="flex items-center gap-1 text-blue-400 font-semibold">
                <span className="w-2.5 h-0.5 bg-blue-400 inline-block" />
                Earth Elevation
              </span>
              <span className="text-slate-500">Dashed = 0° Horizon</span>
            </div>
          </div>

          {/* SVG Plot */}
          <div className="relative">
            <svg
              viewBox={`0 0 ${w} ${h}`}
              className="w-full h-auto overflow-visible select-none"
              onMouseLeave={() => setHoverIdx(null)}
            >
              {/* Y Axis Gridlines and Degree Labels */}
              {[maxEl, 0, minEl].map((val) => {
                const gy = toY(val);
                return (
                  <g key={val}>
                    <line
                      x1={padL}
                      x2={w - padR}
                      y1={gy}
                      y2={gy}
                      stroke={val === 0 ? '#475569' : '#1e293b'}
                      strokeDasharray={val === 0 ? '4 3' : undefined}
                      strokeWidth={val === 0 ? '1.2' : '1'}
                    />
                    <text
                      x={padL - 6}
                      y={gy + 3}
                      textAnchor="end"
                      className="fill-slate-400 text-[9px] font-mono font-semibold"
                    >
                      {val}°
                    </text>
                  </g>
                );
              })}

              {/* Sun Elevation Curve (Amber/Yellow) */}
              <path
                d={sunPath}
                fill="none"
                stroke="#f59e0b"
                strokeWidth="2.2"
                strokeLinejoin="round"
              />

              {/* Earth Elevation Curve (Blue) */}
              <path
                d={earthPath}
                fill="none"
                stroke="#3b82f6"
                strokeWidth="2.2"
                strokeLinejoin="round"
              />

              {/* Hover crosshair scrubber */}
              {series.map((_, i) => {
                const cx = toX(i);
                return (
                  <rect
                    key={i}
                    x={cx - 3}
                    y={padT}
                    width={6}
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

              {hoverIdx !== null && activePoint && (
                <line
                  x1={toX(hoverIdx)}
                  x2={toX(hoverIdx)}
                  y1={padT}
                  y2={padT + plotH}
                  stroke="#38bdf8"
                  strokeWidth="1.5"
                />
              )}
            </svg>
          </div>

          {/* Active Hover Inspection Badge */}
          {activePoint && (
            <div className="flex items-center justify-between text-[11px] bg-slate-900/90 px-3 py-1.5 rounded-lg border border-slate-700/80">
              <div className="text-slate-300">
                <span className="text-slate-400">UTC:</span> {activePoint.utc}
              </div>
              <div className="flex items-center gap-4">
                <div className="text-amber-300 font-semibold">
                  Sun: {activePoint.sunElDeg}° ({activePoint.sunLit ? '☀️ LIT' : '🌑 SHADOW'})
                </div>
                <div className="text-blue-400 font-semibold">
                  Earth: {activePoint.earthElDeg}° ({activePoint.earthVisible ? 'DIRECT COMM' : 'OCCULTED'})
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
