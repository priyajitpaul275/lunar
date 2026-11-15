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

export default function App() {
  const [selectedMissionId, setSelectedMissionId] = useState<string>('to19d'); // Blue Ghost 1 default
  const [activeTab, setActiveTab] = useState<InspectorTab | null>(null);
  const [basemapMode, setBasemapMode] = useState<BasemapMode>('wac');
  const [solarLonDeg, setSolarLonDeg] = useState<number>(38);
  const [dockCollapsed, setDockCollapsed] = useState<boolean>(false);

  const [isPlaying, setIsPlaying] = useState<boolean>(true);
  const [epochNorm, setEpochNorm] = useState<number>(0.35);

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

  // Keyboard shortcut 'H' to toggle bottom control dock
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'h' || e.key === 'H') {
        const tag = document.activeElement?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
        setDockCollapsed((prev) => !prev);
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

  const displayLat = cursorCoords ? cursorCoords.latDeg : selectedMission.latDeg;
  const displayLon = cursorCoords ? cursorCoords.lonDeg : selectedMission.lonDeg;
  const solarZenith = computeSolarZenithDeg(displayLon, displayLat, solarLonDeg);

  return (
    <div className="relative w-screen h-screen bg-[#07090E] text-slate-100 overflow-hidden flex flex-col">
      <TopBar
        activeTab={activeTab}
        onSelectTab={handleSelectTopTab}
        onResetGlobe={handleResetGlobe}
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

        {/* Quiet Top-Left Selenodetic Telemetry Readout (Unboxed Text) */}
        <div className="pointer-events-none fixed top-16 left-5 z-10 space-y-1">
          <div className="text-[11px] font-mono text-slate-400">
            IAU2015_Moon · R_M 1,737.400 km
          </div>
          <div className="text-xs font-mono text-slate-200">
            {cursorCoords ? 'Cursor' : selectedMission.taskOrder}:{' '}
            <span className="text-cyan-300">
              {displayLat >= 0 ? `${displayLat.toFixed(2)}°N` : `${Math.abs(displayLat).toFixed(2)}°S`}
            </span>
            {' · '}
            <span className="text-cyan-300">
              {displayLon >= 0 ? `${displayLon.toFixed(2)}°E` : `${Math.abs(displayLon).toFixed(2)}°W`}
            </span>
            {' · '}
            <span className="text-amber-300">Zenith {solarZenith.toFixed(1)}°</span>
          </div>
          {wmtsInfo && (
            <div className="text-[11px] font-mono text-slate-400">
              NASA Moon Trek {wmtsInfo.layer.toUpperCase()}: {wmtsInfo.liveTiles}/{wmtsInfo.total} tiles
              {wmtsInfo.cacheHits > 0 ? ` (${wmtsInfo.cacheHits} cached)` : ''}
            </div>
          )}
        </div>

        {/* Selected Mission Quick Open Handle when Drawer is Closed */}
        {!activeTab && (
          <button
            type="button"
            onClick={() => setActiveTab('telemetry')}
            className="fixed top-16 right-5 z-10 px-3.5 py-2 bg-[#0B0F18] border border-slate-800 rounded-md text-xs font-medium text-slate-200 hover:border-amber-500/60 hover:text-white transition-colors cursor-pointer"
          >
            Inspect {selectedMission.name}
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
        />
      </main>
    </div>
  );
}
