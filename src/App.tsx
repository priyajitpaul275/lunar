import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BasemapMode,
  CLPS_MISSIONS,
  InspectorTab,
} from './data/clpsMissions';
import { computeSolarZenithDeg } from './engine/selenodesy';
import type { SampledEntityState } from './workers/czmlWorker';
import { CameraPreset, LunarViewport } from './components/LunarViewport';
import { TopBar } from './components/TopBar';
import { BottomDock } from './components/BottomDock';
import { InspectorDrawer } from './components/InspectorDrawer';
import { audioFx } from './engine/audioFx';

export default function App() {
  const [selectedMissionId, setSelectedMissionId] = useState<string>('to19d'); // Blue Ghost 1 default
  const [activeTab, setActiveTab] = useState<InspectorTab | null>(null);
  const [basemapMode, setBasemapMode] = useState<BasemapMode>('wac');
  const [solarLonDeg, setSolarLonDeg] = useState<number>(38);
  const [dockCollapsed, setDockCollapsed] = useState<boolean>(false);

  const [isPlaying, setIsPlaying] = useState<boolean>(true);
  const [epochNorm, setEpochNorm] = useState<number>(0.35);

  const [scanlinesEnabled, setScanlinesEnabled] = useState<boolean>(false);
  const [audioEnabled, setAudioEnabled] = useState<boolean>(audioFx.isEnabled());

  const [cameraPreset, setCameraPreset] = useState<{ preset: CameraPreset; seq: number }>({
    preset: 'global',
    seq: 0,
  });

  const [cursorCoords, setCursorCoords] = useState<{ latDeg: number; lonDeg: number } | null>(null);
  const [wmtsInfo, setWmtsInfo] = useState<{
    layer: string;
    loaded: number;
    total: number;
    cacheHits: number;
    liveTiles: number;
  } | null>(null);

  const [qmStats, setQmStats] = useState<{
    missionId: string;
    vertexCount: number;
    triangleCount: number;
    byteLength: number;
    minHeightM: number;
    maxHeightM: number;
    hasOctNormals: boolean;
    sampleOctPair: [number, number];
    sampleDecodedNormal: [number, number, number];
  } | null>(null);

  // Off-thread Web Worker CZML pipeline
  const workerRef = useRef<Worker | null>(null);
  const [rawCzmlPackets, setRawCzmlPackets] = useState<unknown[]>([]);
  const [czmlSummary, setCzmlSummary] = useState<{ parseMs: number; entityCount: number }>({
    parseMs: 0,
    entityCount: 0,
  });
  const [czmlStates, setCzmlStates] = useState<SampledEntityState[]>([]);

  useEffect(() => {
    const worker = new Worker(new URL('./workers/czmlWorker.ts', import.meta.url), {
      type: 'module',
    });
    workerRef.current = worker;

    worker.onmessage = (event: MessageEvent) => {
      const msg = event.data;
      if (msg.type === 'CZML_PARSED') {
        setCzmlSummary({ parseMs: msg.parseMs, entityCount: msg.summary.length });
        worker.postMessage({ type: 'SAMPLE_EPOCH', progressNorm: 0.35 });
      } else if (msg.type === 'EPOCH_SAMPLED') {
        setCzmlStates(msg.states);
      }
    };

    fetch('/api/czml/missions')
      .then((res) => res.json())
      .then((packets) => {
        setRawCzmlPackets(packets);
        worker.postMessage({ type: 'PARSE_CZML', packets });
      })
      .catch(() => {
        // Worker remains idle if server unavailable
      });

    return () => {
      worker.terminate();
      workerRef.current = null;
    };
  }, []);

  // Playback loop advancing epochNorm -> Web Worker SAMPLE_EPOCH
  useEffect(() => {
    if (!isPlaying) return;
    let last = performance.now();
    let rafId = 0;

    const step = (now: number) => {
      const dt = (now - last) / 1000;
      if (dt >= 0.08) {
        last = now;
        setEpochNorm((prev) => {
          const next = (prev + dt * 0.025) % 1;
          workerRef.current?.postMessage({ type: 'SAMPLE_EPOCH', progressNorm: next });
          return next;
        });
      }
      rafId = requestAnimationFrame(step);
    };

    rafId = requestAnimationFrame(step);
    return () => cancelAnimationFrame(rafId);
  }, [isPlaying]);

  // Keyboard shortcut handler
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

      if (e.key === 'h' || e.key === 'H') {
        audioFx.playClick();
        setDockCollapsed((prev) => !prev);
      } else if (e.key === 't' || e.key === 'T') {
        audioFx.playClick();
        setActiveTab((prev) => (prev === 'telemetry' ? null : 'telemetry'));
      } else if (e.key === 'm' || e.key === 'M') {
        audioFx.playClick();
        setActiveTab((prev) => (prev === 'matrix' ? null : 'matrix'));
      } else if (e.key === 'e' || e.key === 'E') {
        audioFx.playClick();
        setActiveTab((prev) => (prev === 'ephemeris' ? null : 'ephemeris'));
      } else if (e.key === 'g' || e.key === 'G') {
        audioFx.playClick();
        setActiveTab(null);
        setCameraPreset((prev) => ({ preset: 'global', seq: prev.seq + 1 }));
      } else if (e.code === 'Space') {
        e.preventDefault();
        audioFx.playClick();
        setIsPlaying((p) => !p);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const selectedMission = useMemo(
    () => CLPS_MISSIONS.find((m) => m.id === selectedMissionId) || CLPS_MISSIONS[0],
    [selectedMissionId]
  );

  const handleSelectMission = useCallback((id: string) => {
    setSelectedMissionId(id);
    setActiveTab('telemetry');
    setCameraPreset((prev) => ({ preset: 'lander', seq: prev.seq + 1 }));
  }, []);

  const handleSelectTopTab = useCallback((tab: InspectorTab) => {
    setActiveTab((prev) => (prev === tab ? null : tab));
  }, []);

  const handleResetGlobe = useCallback(() => {
    setActiveTab(null);
    setCameraPreset((prev) => ({ preset: 'global', seq: prev.seq + 1 }));
  }, []);

  const handleChangeEpoch = useCallback((val: number) => {
    setIsPlaying(false);
    setEpochNorm(val);
    workerRef.current?.postMessage({ type: 'SAMPLE_EPOCH', progressNorm: val });
  }, []);

  const handleCameraPreset = useCallback((preset: CameraPreset) => {
    setCameraPreset((prev) => ({ preset, seq: prev.seq + 1 }));
  }, []);

  const handleToggleAudio = useCallback(() => {
    const next = audioFx.toggle();
    setAudioEnabled(next);
  }, []);

  const handleSync3DGlobe = useCallback((newSolarLonDeg: number, missionId: string) => {
    setSolarLonDeg(newSolarLonDeg);
    setSelectedMissionId(missionId);
    setCameraPreset((prev) => ({ preset: 'lander', seq: prev.seq + 1 }));
  }, []);

  return (
    <div className="relative w-screen h-screen bg-[#04060a] text-slate-100 overflow-hidden flex flex-col font-sans select-none">
      <TopBar
        activeTab={activeTab}
        onSelectTab={handleSelectTopTab}
        onResetGlobe={handleResetGlobe}
        selectedMissionName={selectedMission.name}
        selectedMissionTask={selectedMission.taskOrder}
        scanlinesEnabled={scanlinesEnabled}
        onToggleScanlines={() => setScanlinesEnabled((prev) => !prev)}
        audioEnabled={audioEnabled}
        onToggleAudio={handleToggleAudio}
      />

      {/* Main Unobstructed 3D Viewport Stage */}
      <main className="relative flex-1 w-full overflow-hidden">
        <LunarViewport
          missions={CLPS_MISSIONS}
          selectedMissionId={selectedMissionId}
          basemapMode={basemapMode}
          solarLonDeg={solarLonDeg}
          cameraPreset={cameraPreset}
          czmlStates={czmlStates}
          onSelectMission={handleSelectMission}
          onCursorCoords={setCursorCoords}
          onWmtsProgress={setWmtsInfo}
          onQmLoaded={setQmStats}
        />

        {/* Selected Mission Quick Open Handle when Drawer is Closed */}
        {!activeTab && (
          <button
            type="button"
            onClick={() => {
              audioFx.playClick();
              setActiveTab('telemetry');
            }}
            className="fixed top-16 right-5 z-20 px-3 py-1.5 panel-glass-amber border border-amber-500/40 rounded-md text-xs font-mono text-amber-300 hover:text-white hover:border-amber-400 transition-all cursor-pointer flex items-center gap-2 shadow-[0_0_15px_rgba(245,158,11,0.2)] animate-in fade-in"
          >
            <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
            <span className="font-semibold">{selectedMission.taskOrder}</span>
            <span>Inspect {selectedMission.name}</span>
            <span className="text-[10px] text-slate-400 border border-slate-700 rounded px-1">[T]</span>
          </button>
        )}

        <BottomDock
          missions={CLPS_MISSIONS}
          selectedMissionId={selectedMissionId}
          onSelectMission={handleSelectMission}
          basemapMode={basemapMode}
          onChangeBasemap={setBasemapMode}
          solarLonDeg={solarLonDeg}
          onChangeSolarLon={setSolarLonDeg}
          isPlaying={isPlaying}
          onTogglePlay={() => setIsPlaying((p) => !p)}
          epochNorm={epochNorm}
          onChangeEpoch={handleChangeEpoch}
          onCameraPreset={handleCameraPreset}
          collapsed={dockCollapsed}
          onToggleCollapsed={() => setDockCollapsed((c) => !c)}
        />

        <InspectorDrawer
          activeTab={activeTab}
          onChangeTab={setActiveTab}
          onClose={() => setActiveTab(null)}
          missions={CLPS_MISSIONS}
          selectedMission={selectedMission}
          onSelectMission={handleSelectMission}
          solarLonDeg={solarLonDeg}
          basemapMode={basemapMode}
          onChangeBasemap={setBasemapMode}
          qmStats={qmStats}
          czmlSummary={czmlSummary}
          czmlStates={czmlStates}
          rawCzmlPackets={rawCzmlPackets}
          onSync3DGlobe={handleSync3DGlobe}
        />

        {/* Optional Tactical CRT Scanline Overlay */}
        {scanlinesEnabled && (
          <div className="absolute inset-0 scanlines pointer-events-none z-10 opacity-40" />
        )}
      </main>
    </div>
  );
}
