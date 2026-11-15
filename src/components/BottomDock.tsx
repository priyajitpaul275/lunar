import { useState } from 'react';
import {
  ChevronDown,
  ChevronUp,
  Compass,
  FastForward,
  Filter,
  Layers,
  MapPin,
  Moon,
  Navigation,
  Pause,
  Play,
  RotateCcw,
  SkipBack,
  SkipForward,
  Sparkles,
  Sun,
  Video,
} from 'lucide-react';
import { BasemapMode, CLPSMission } from '../data/clpsMissions';
import { CameraPreset } from './LunarViewport';
import { audioFx } from '../engine/audioFx';

interface BottomDockProps {
  missions: CLPSMission[];
  selectedMissionId: string;
  onSelectMission: (id: string) => void;
  basemapMode: BasemapMode;
  onChangeBasemap: (mode: BasemapMode) => void;
  solarLonDeg: number;
  onChangeSolarLon: (deg: number) => void;
  isPlaying: boolean;
  onTogglePlay: () => void;
  epochNorm: number;
  onChangeEpoch: (val: number) => void;
  onCameraPreset: (preset: CameraPreset) => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
}

const BASEMAP_OPTIONS: { id: BasemapMode; label: string; desc: string }[] = [
  { id: 'wac', label: 'LROC WAC', desc: '303 PPD' },
  { id: 'lola', label: 'LOLA DEM', desc: '128 PPD' },
  { id: 'hazard', label: 'Slope Hazard', desc: 'Artemis' },
  { id: 'quantized', label: 'Quantized Mesh', desc: '1.0 TIN' },
];

const CAMERA_OPTIONS: { id: CameraPreset; label: string; icon: string }[] = [
  { id: 'global', label: 'Global', icon: '🌐' },
  { id: 'south-pole', label: 'South Pole', icon: '❄️' },
  { id: 'far-side', label: 'Far Side', icon: '📡' },
  { id: 'lander', label: 'Lander Focus', icon: '🎯' },
];

const SOLAR_PRESETS = [
  { label: 'Dawn', deg: -90 },
  { label: 'Noon', deg: 0 },
  { label: 'Dusk', deg: 90 },
  { label: 'Night', deg: 180 },
];

export function BottomDock({
  missions,
  selectedMissionId,
  onSelectMission,
  basemapMode,
  onChangeBasemap,
  solarLonDeg,
  onChangeSolarLon,
  isPlaying,
  onTogglePlay,
  epochNorm,
  onChangeEpoch,
  onCameraPreset,
  collapsed,
  onToggleCollapsed,
}: BottomDockProps) {
  const [filterRegion, setFilterRegion] = useState<string>('All');
  const [speedMultiplier, setSpeedMultiplier] = useState<number>(1);

  const filteredMissions =
    filterRegion === 'All'
      ? missions
      : missions.filter((m) => m.hemisphere === filterRegion);

  const handleStep = (direction: -1 | 1) => {
    audioFx.playClick();
    const stepVal = 0.02 * direction;
    const nextVal = Math.max(0, Math.min(1, epochNorm + stepVal));
    onChangeEpoch(nextVal);
  };

  const handleMissionSelect = (id: string) => {
    audioFx.playBeep();
    onSelectMission(id);
  };

  // Simulated mission phase milestones for CZML timeline
  const getPhaseName = (norm: number) => {
    if (norm < 0.15) return 'TRANSLUNAR INJECTION';
    if (norm < 0.45) return 'CISLUNAR CRUISE';
    if (norm < 0.65) return 'LUNAR ORBIT INSERTION';
    if (norm < 0.82) return 'POWERED DESCENT (PDI)';
    if (norm < 0.88) return 'TERMINAL TOUCHDOWN';
    return 'LUNAR SURFACE OPS';
  };

  return (
    <div className="fixed bottom-3 left-1/2 -translate-x-1/2 z-20 w-[min(1080px,96vw)] pointer-events-none flex flex-col items-center select-none font-mono">
      {/* Collapse / Expand Aerospace Tab Handle */}
      <button
        type="button"
        onClick={() => {
          audioFx.playClick();
          onToggleCollapsed();
        }}
        className="pointer-events-auto mb-1 px-4 py-1 panel-glass text-slate-300 hover:text-white rounded-t-md text-[11px] font-medium flex items-center gap-2 border-t border-x border-cyan-800/40 hover:border-cyan-500/60 shadow-lg cursor-pointer transition-all duration-150"
        title="Toggle Flight Dynamics Dock (Keyboard shortcut: H)"
      >
        <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse" />
        <span className="font-display font-semibold tracking-wider uppercase text-[10px]">
          {collapsed ? 'Engage Flight Controls' : 'Mission Operations Deck'}
        </span>
        <span className="text-[9px] px-1 py-0.2 rounded bg-slate-800 text-slate-400 border border-slate-700">
          [H]
        </span>
        {collapsed ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
      </button>

      {/* Main Deck Container */}
      <div
        className={`w-full panel-glass-cyan rounded-lg p-3 transition-all duration-200 shadow-2xl border border-cyan-900/60 backdrop-blur-xl ${
          collapsed
            ? 'opacity-0 translate-y-8 pointer-events-none h-0 overflow-hidden p-0 border-0'
            : 'pointer-events-auto opacity-100 translate-y-0'
        }`}
      >
        {/* Tier 1: Region Filters & Mission Selector Rail */}
        <div className="mb-2.5 pb-2.5 border-b border-cyan-950/70">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <span className="text-[10px] uppercase tracking-wider text-slate-400 font-semibold flex items-center gap-1">
                <MapPin className="w-3 h-3 text-cyan-400" />
                Target Fleet ({missions.length})
              </span>
              <div className="flex items-center gap-1">
                {['All', 'Near Side', 'South Pole', 'Far Side'].map((reg) => (
                  <button
                    key={reg}
                    type="button"
                    onClick={() => {
                      audioFx.playClick();
                      setFilterRegion(reg);
                    }}
                    className={`px-2 py-0.5 text-[10px] rounded transition-colors cursor-pointer ${
                      filterRegion === reg
                        ? 'bg-cyan-500/25 text-cyan-300 font-bold border border-cyan-500/40'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {reg}
                  </button>
                ))}
              </div>
            </div>

            <div className="text-[10px] text-slate-400 hidden sm:block">
              Click mission card to lock target & inspect telemetry
            </div>
          </div>

          {/* Horizontal Scrolling Mission Chips */}
          <div className="flex items-center gap-1.5 overflow-x-auto pb-1.5 scrollbar-thin">
            {filteredMissions.map((m) => {
              const active = m.id === selectedMissionId;
              const outcomeColor =
                m.outcome === 'nominal'
                  ? 'text-emerald-400'
                  : m.outcome === 'tipped'
                  ? 'text-amber-400'
                  : m.outcome === 'aborted'
                  ? 'text-rose-400'
                  : 'text-cyan-400';

              return (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => handleMissionSelect(m.id)}
                  className={`px-2.5 py-1.5 rounded-md text-left transition-all duration-150 whitespace-nowrap shrink-0 cursor-pointer border ${
                    active
                      ? 'bg-gradient-to-r from-amber-500 to-amber-600 text-slate-950 border-amber-300 font-semibold shadow-[0_0_12px_rgba(245,158,11,0.35)] scale-102'
                      : 'bg-slate-900/80 text-slate-200 hover:bg-slate-800 hover:border-slate-600 border-slate-800/90'
                  }`}
                >
                  <div className="flex items-center gap-1.5">
                    <span className={`text-[10px] ${active ? 'text-slate-950' : outcomeColor}`}>
                      {m.outcome === 'nominal' ? '●' : m.outcome === 'tipped' ? '▲' : m.outcome === 'aborted' ? '✖' : '◆'}
                    </span>
                    <span className="text-xs font-semibold tracking-tight">{m.name}</span>
                    <span className={`text-[9px] uppercase px-1 rounded ${active ? 'bg-slate-950 text-amber-300' : 'bg-slate-800 text-slate-400'}`}>
                      {m.taskOrder}
                    </span>
                  </div>
                  <div className={`text-[10px] truncate mt-0.5 ${active ? 'text-slate-900' : 'text-slate-400'}`}>
                    {m.destination}
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Tier 2: Timeline Scrubber · Basemap Sensors · Solar Dial · Presets */}
        <div className="grid grid-cols-1 md:grid-cols-12 gap-3 items-center">
          {/* Timeline Scrubber & Playback Controls (Cols 5) */}
          <div className="md:col-span-5 bg-slate-950/70 p-2 rounded-md border border-cyan-950/60 flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                audioFx.playClick();
                onTogglePlay();
              }}
              className={`p-1.5 rounded border transition-colors cursor-pointer ${
                isPlaying
                  ? 'bg-cyan-500 text-slate-950 border-cyan-400 font-bold'
                  : 'bg-slate-900 text-slate-200 border-slate-700 hover:text-amber-300'
              }`}
              title={isPlaying ? 'Pause Simulation' : 'Play CZML Simulation'}
            >
              {isPlaying ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
            </button>

            <button
              type="button"
              onClick={() => handleStep(-1)}
              className="p-1 rounded bg-slate-900 text-slate-400 hover:text-slate-200 border border-slate-800"
              title="Step Backward"
            >
              <SkipBack className="w-3 h-3" />
            </button>

            <button
              type="button"
              onClick={() => handleStep(1)}
              className="p-1 rounded bg-slate-900 text-slate-400 hover:text-slate-200 border border-slate-800"
              title="Step Forward"
            >
              <SkipForward className="w-3 h-3" />
            </button>

            {/* Scrubber slider */}
            <div className="flex-1 flex flex-col justify-center">
              <div className="flex justify-between text-[9px] text-slate-400 font-mono mb-0.5">
                <span className="text-cyan-300 uppercase tracking-wide truncate max-w-[130px]">
                  {getPhaseName(epochNorm)}
                </span>
                <span>{Math.round(epochNorm * 100)}%</span>
              </div>
              <input
                type="range"
                min={0}
                max={1}
                step={0.005}
                value={epochNorm}
                onChange={(e) => onChangeEpoch(Number(e.target.value))}
                className="w-full h-1.5 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-cyan-400"
                aria-label="CZML Mission Epoch Scrubber"
              />
            </div>
          </div>

          {/* Basemap Sensor Layers (Cols 4) */}
          <div className="md:col-span-4 flex items-center justify-between gap-1 p-1 bg-slate-950/70 border border-cyan-950/60 rounded-md">
            {BASEMAP_OPTIONS.map((opt) => {
              const active = basemapMode === opt.id;
              return (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => {
                    audioFx.playClick();
                    onChangeBasemap(opt.id);
                  }}
                  className={`flex-1 px-1.5 py-1 text-[10px] rounded transition-all duration-150 cursor-pointer ${
                    active
                      ? 'bg-cyan-500 text-slate-950 font-bold shadow-[0_0_8px_rgba(6,182,212,0.4)]'
                      : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900'
                  }`}
                >
                  <div className="truncate leading-tight font-semibold">{opt.label}</div>
                  <div className={`text-[8px] uppercase ${active ? 'text-slate-950' : 'text-slate-500'}`}>
                    {opt.desc}
                  </div>
                </button>
              );
            })}
          </div>

          {/* Solar Illumination & Camera Presets (Cols 3) */}
          <div className="md:col-span-3 flex items-center justify-between gap-2">
            {/* Solar Dial */}
            <div className="flex items-center gap-1.5 bg-slate-950/70 px-2 py-1.5 rounded-md border border-cyan-950/60">
              <Sun className="w-3.5 h-3.5 text-amber-400 shrink-0 animate-pulse" />
              <input
                type="range"
                min={-180}
                max={180}
                step={1}
                value={solarLonDeg}
                onChange={(e) => onChangeSolarLon(Number(e.target.value))}
                className="w-16 h-1.5 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-amber-400"
                title={`Subsolar Longitude: ${solarLonDeg}°`}
              />
              <span className="text-[10px] font-mono text-amber-300 w-8 text-right font-semibold">
                {solarLonDeg}°
              </span>
            </div>

            {/* Camera Presets Menu */}
            <div className="flex items-center gap-1">
              {CAMERA_OPTIONS.map((cam) => (
                <button
                  key={cam.id}
                  type="button"
                  onClick={() => {
                    audioFx.playClick();
                    onCameraPreset(cam.id);
                  }}
                  className="px-2 py-1.5 text-[10px] font-medium text-slate-300 bg-slate-900 border border-slate-800 rounded hover:border-cyan-500/50 hover:text-cyan-200 transition-colors cursor-pointer shrink-0"
                  title={`Align camera to ${cam.label}`}
                >
                  {cam.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
