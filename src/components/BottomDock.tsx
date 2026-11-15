import { ChevronDown, ChevronUp, Pause, Play, Sun } from 'lucide-react';
import { BasemapMode, CLPSMission } from '../data/clpsMissions';
import { CameraPreset } from './LunarViewport';

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

const BASEMAP_OPTIONS: { id: BasemapMode; label: string }[] = [
  { id: 'wac', label: 'LROC WAC' },
  { id: 'lola', label: 'LOLA DEM' },
  { id: 'hazard', label: 'Slope Hazard' },
  { id: 'quantized', label: 'Quantized Mesh' },
];

const CAMERA_OPTIONS: { id: CameraPreset; label: string }[] = [
  { id: 'global', label: 'Global' },
  { id: 'south-pole', label: 'South Pole' },
  { id: 'far-side', label: 'Far Side' },
  { id: 'lander', label: 'Lander' },
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
  return (
    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-20 w-[min(960px,95vw)] pointer-events-none flex flex-col items-center">
      {/* Collapse / Expand Handle */}
      <button
        type="button"
        onClick={onToggleCollapsed}
        className="pointer-events-auto mb-1.5 px-3 py-1 bg-[#0B0F18] border border-slate-800 rounded-t-md text-[11px] font-medium text-slate-300 hover:text-white flex items-center gap-1.5 transition-colors cursor-pointer whitespace-nowrap"
        title="Toggle Control Dock (H)"
      >
        {collapsed ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
        <span>{collapsed ? 'Show Controls' : 'Hide Controls'}</span>
      </button>

      {/* Main Dock Container */}
      <div
        className={`w-full bg-[#0B0F18]/95 border border-slate-800 rounded-lg p-3 transition-all duration-200 ${
          collapsed ? 'opacity-0 translate-y-6 pointer-events-none h-0 overflow-hidden p-0 border-0' : 'pointer-events-auto opacity-100 translate-y-0'
        }`}
      >
        {/* Row 1: 9 CLPS Mission Selector Bar */}
        <div className="flex items-center gap-1.5 overflow-x-auto pb-2.5 mb-2.5 border-b border-slate-800/80">
          {missions.map((m) => {
            const active = m.id === selectedMissionId;
            return (
              <button
                key={m.id}
                type="button"
                onClick={() => onSelectMission(m.id)}
                className={`px-2.5 py-1.5 rounded text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  active
                    ? 'bg-amber-500 text-slate-950 font-semibold'
                    : 'bg-slate-900/90 text-slate-300 hover:bg-slate-800 hover:text-white border border-slate-800'
                }`}
              >
                {m.name}
              </button>
            );
          })}
        </div>

        {/* Row 2: Basemap · CZML Timeline · Solar Angle · Camera Presets */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          {/* Basemap Layers */}
          <div className="flex items-center gap-1 p-0.5 bg-slate-900 border border-slate-800 rounded-md">
            {BASEMAP_OPTIONS.map((opt) => (
              <button
                key={opt.id}
                type="button"
                onClick={() => onChangeBasemap(opt.id)}
                className={`px-2.5 py-1 text-[11px] font-medium rounded transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  basemapMode === opt.id
                    ? 'bg-cyan-500 text-slate-950 font-semibold'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>

          {/* CZML Orbital / Descent Timeline Scrubber */}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onTogglePlay}
              className="p-1.5 rounded bg-slate-900 border border-slate-800 text-slate-200 hover:text-amber-400 cursor-pointer"
              aria-label={isPlaying ? 'Pause CZML Simulation' : 'Play CZML Simulation'}
            >
              {isPlaying ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
            </button>
            <input
              type="range"
              min={0}
              max={1}
              step={0.005}
              value={epochNorm}
              onChange={(e) => onChangeEpoch(Number(e.target.value))}
              className="w-24 accent-cyan-400 cursor-pointer"
              aria-label="CZML Mission Epoch Scrubber"
            />
            <span className="text-[11px] font-mono text-slate-400 w-10 text-right">
              {Math.round(epochNorm * 100)}%
            </span>
          </div>

          {/* Solar Subsolar Longitude */}
          <div className="flex items-center gap-2">
            <Sun className="w-3.5 h-3.5 text-amber-400 shrink-0" />
            <input
              type="range"
              min={-180}
              max={180}
              step={1}
              value={solarLonDeg}
              onChange={(e) => onChangeSolarLon(Number(e.target.value))}
              className="w-20 accent-amber-400 cursor-pointer"
              aria-label="Solar Illumination Longitude"
            />
            <span className="text-[11px] font-mono text-slate-400 w-11 text-right">
              {solarLonDeg}°
            </span>
          </div>

          {/* Camera Targets */}
          <div className="flex items-center gap-1">
            {CAMERA_OPTIONS.map((cam) => (
              <button
                key={cam.id}
                type="button"
                onClick={() => onCameraPreset(cam.id)}
                className="px-2 py-1 text-[11px] font-medium text-slate-300 bg-slate-900 border border-slate-800 rounded hover:border-slate-600 hover:text-white transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                {cam.label}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
