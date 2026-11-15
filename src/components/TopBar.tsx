import { useEffect, useState } from 'react';
import {
  Activity,
  CheckCircle2,
  Database,
  ExternalLink,
  Eye,
  EyeOff,
  Globe2,
  Maximize2,
  Minimize2,
  Radio,
  RotateCcw,
  Sparkles,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { InspectorTab } from '../data/clpsMissions';
import { audioFx } from '../engine/audioFx';

interface TopBarProps {
  activeTab: InspectorTab | null;
  onSelectTab: (tab: InspectorTab) => void;
  onResetGlobe: () => void;
  selectedMissionName?: string;
  selectedMissionTask?: string;
  scanlinesEnabled: boolean;
  onToggleScanlines: () => void;
  audioEnabled: boolean;
  onToggleAudio: () => void;
}

const NAV_ITEMS: { id: InspectorTab; label: string; badge?: string }[] = [
  { id: 'matrix', label: 'Missions', badge: '14' },
  { id: 'ephemeris', label: 'Ephemeris & Sim', badge: 'UTC Sim' },
  { id: 'czml', label: 'Orbital & CZML', badge: 'Hermite' },
  { id: 'pds', label: 'PDS Archive', badge: 'ODE' },
  { id: 'compliance', label: 'Compliance', badge: '25/25' },
  { id: 'drive', label: 'Google Drive' },
];

export function TopBar({
  activeTab,
  onSelectTab,
  onResetGlobe,
  selectedMissionName,
  selectedMissionTask,
  scanlinesEnabled,
  onToggleScanlines,
  audioEnabled,
  onToggleAudio,
}: TopBarProps) {
  // Live UTC Clock
  const [utcTime, setUtcTime] = useState<string>('');
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);

  useEffect(() => {
    const updateTime = () => {
      const now = new Date();
      setUtcTime(
        now.toISOString().slice(0, 19).replace('T', ' ') + ' UTC'
      );
    };
    updateTime();
    const interval = setInterval(updateTime, 1000);
    return () => clearInterval(interval);
  }, []);

  const handleToggleFullscreen = () => {
    audioFx.playClick();
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().then(() => setIsFullscreen(true)).catch(() => {});
    } else {
      document.exitFullscreen().then(() => setIsFullscreen(false)).catch(() => {});
    }
  };

  return (
    <header className="relative z-30 h-13 px-4 bg-[#070b13]/95 border-b border-cyan-950/80 backdrop-blur-md flex items-center justify-between gap-4 select-none">
      {/* Zone 1: NASA CLPS Brand Wordmark & Telemetry Status */}
      <div className="flex items-center gap-3 shrink-0">
        <div className="flex items-center gap-2">
          <div className="relative flex items-center justify-center w-7 h-7 rounded bg-gradient-to-br from-cyan-950 to-slate-900 border border-cyan-500/40">
            <Globe2 className="w-4 h-4 text-cyan-400" />
            <div className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="font-display font-bold text-sm tracking-wider text-slate-100 uppercase">
                NASA CLPS
              </span>
              <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-cyan-950/80 text-cyan-300 border border-cyan-800/60 font-medium">
                OPS v2.0
              </span>
            </div>
            <div className="text-[10px] font-mono text-slate-400 flex items-center gap-1.5">
              <span>IAU2015_MOON</span>
              <span className="text-slate-600">·</span>
              <span className="text-emerald-400 font-medium flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-ping inline-block" />
                DSN SYNC
              </span>
            </div>
          </div>
        </div>

        {/* Vertical divider */}
        <div className="hidden lg:block h-6 w-px bg-slate-800/80 mx-1" />

        {/* Master UTC Telemetry Clock */}
        <div className="hidden xl:flex flex-col font-mono text-left">
          <span className="text-[9px] uppercase tracking-wider text-slate-500">Master Clock</span>
          <span className="text-[12px] font-semibold text-cyan-300 tracking-wide">
            {utcTime || 'LOADING UTC...'}
          </span>
        </div>
      </div>

      {/* Zone 2: Navigation Links */}
      <nav className="hidden md:flex items-center gap-1 text-[13px] font-medium" aria-label="Primary Navigation">
        {NAV_ITEMS.map((item) => {
          const isActive = activeTab === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => {
                audioFx.playClick();
                onSelectTab(item.id);
              }}
              className={`px-3 py-1.5 rounded-md transition-all duration-150 whitespace-nowrap shrink-0 cursor-pointer flex items-center gap-1.5 ${
                isActive
                  ? 'bg-cyan-500/15 text-cyan-200 border border-cyan-500/40 shadow-[0_0_12px_rgba(6,182,212,0.18)] font-semibold'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50 border border-transparent'
              }`}
            >
              <span>{item.label}</span>
              {item.badge && (
                <span
                  className={`text-[10px] font-mono px-1 py-0.2 rounded ${
                    isActive
                      ? 'bg-cyan-400 text-slate-950 font-bold'
                      : 'bg-slate-800 text-slate-400'
                  }`}
                >
                  {item.badge}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      {/* Zone 3: Quick Tactical Toggles & Actions */}
      <div className="flex items-center gap-1.5 shrink-0">
        {/* Audio Ambiance Synthesizer Toggle */}
        <button
          type="button"
          onClick={() => {
            onToggleAudio();
          }}
          className={`p-1.5 rounded border transition-colors cursor-pointer ${
            audioEnabled
              ? 'bg-cyan-500/20 text-cyan-300 border-cyan-500/40 hover:bg-cyan-500/30'
              : 'bg-slate-900/80 text-slate-400 border-slate-800 hover:text-slate-200'
          }`}
          title={audioEnabled ? 'Telemetry Audio Active (Mute)' : 'Enable Telemetry Audio'}
          aria-label="Toggle Telemetry Audio"
        >
          {audioEnabled ? <Volume2 className="w-3.5 h-3.5" /> : <VolumeX className="w-3.5 h-3.5" />}
        </button>

        {/* Scanlines Toggle */}
        <button
          type="button"
          onClick={() => {
            audioFx.playClick();
            onToggleScanlines();
          }}
          className={`p-1.5 rounded border transition-colors cursor-pointer ${
            scanlinesEnabled
              ? 'bg-amber-500/20 text-amber-300 border-amber-500/40 hover:bg-amber-500/30'
              : 'bg-slate-900/80 text-slate-400 border-slate-800 hover:text-slate-200'
          }`}
          title={scanlinesEnabled ? 'CRT Scanlines ON (Toggle)' : 'CRT Scanlines OFF (Toggle)'}
          aria-label="Toggle CRT Scanline HUD Effect"
        >
          {scanlinesEnabled ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
        </button>

        {/* Fullscreen Button */}
        <button
          type="button"
          onClick={handleToggleFullscreen}
          className="p-1.5 rounded bg-slate-900/80 text-slate-400 border border-slate-800 hover:text-slate-200 transition-colors cursor-pointer hidden sm:block"
          title="Toggle Fullscreen"
          aria-label="Toggle Fullscreen"
        >
          {isFullscreen ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
        </button>

        {/* Reset Globe View */}
        <button
          type="button"
          onClick={() => {
            audioFx.playClick();
            onResetGlobe();
          }}
          className="px-2.5 py-1.5 text-xs font-mono font-medium bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-400 hover:to-amber-500 text-slate-950 rounded border border-amber-400/50 shadow-[0_0_12px_rgba(245,158,11,0.25)] flex items-center gap-1.5 transition-all cursor-pointer whitespace-nowrap"
          title="Reset Camera to Global Lunar Alignment"
        >
          <RotateCcw className="w-3 h-3 text-slate-950" />
          <span>Reset Globe</span>
        </button>
      </div>
    </header>
  );
}
