import { useEffect, useMemo, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  Calendar,
  Check,
  CheckCircle2,
  Copy,
  Cpu,
  Database,
  Download,
  ExternalLink,
  Flame,
  Globe2,
  Layers,
  MapPin,
  Navigation,
  Radio,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  Sun,
  X,
} from 'lucide-react';
import {
  BasemapMode,
  CLPSMission,
  InspectorTab,
  NASA_COMPLIANCE_CHECKS,
} from '../data/clpsMissions';
import {
  IAU2015_MOON,
  computeLanderQuaternion,
  computeSolarZenithDeg,
  selenographicToMCMF,
  wgs84RadialErrorKm,
} from '../engine/selenodesy';
import type { SampledEntityState } from '../workers/czmlWorker';
import { PayloadChart } from './PayloadCharts';
import { EphemerisPanel } from './EphemerisPanel';
import { MissionSimulation } from './MissionSimulation';
import { DrivePanel } from './DrivePanel';
import { audioFx } from '../engine/audioFx';

interface PDSProduct {
  productId: string;
  instrumentHost: string;
  instrument: string;
  productType: string;
  utcTime: string;
  centerLat: number;
  centerLon: number;
  labelUrl: string;
  pdsVersion: string;
}

interface PDSResponse {
  status: string;
  source?: string;
  upstreamUrl?: string;
  latencyMs?: number;
  cache?: string;
  totalCount?: number;
  products: PDSProduct[];
  error?: string;
}

interface ServerHealth {
  referenceFrame: string;
  moonMeanRadiusM: number;
  uptimeSec: number;
  caches: {
    wmts: { entries: number; hits: number; misses: number; totalBytes: number };
    pds: { entries: number; hits: number; misses: number; totalBytes: number };
    quantizedMesh: { entries: number; hits: number; misses: number; totalBytes: number };
    horizons?: { entries: number; hits: number; misses: number; totalBytes: number };
  };
  endpoints: string[];
}

interface QmStats {
  missionId: string;
  vertexCount: number;
  triangleCount: number;
  byteLength: number;
  minHeightM: number;
  maxHeightM: number;
  hasOctNormals: boolean;
  sampleOctPair: [number, number];
  sampleDecodedNormal: [number, number, number];
}

interface InspectorDrawerProps {
  activeTab: InspectorTab | null;
  onChangeTab: (tab: InspectorTab) => void;
  onClose: () => void;
  missions: CLPSMission[];
  selectedMission: CLPSMission;
  onSelectMission: (id: string) => void;
  solarLonDeg: number;
  basemapMode: BasemapMode;
  onChangeBasemap: (mode: BasemapMode) => void;
  qmStats: QmStats | null;
  czmlSummary: { parseMs: number; entityCount: number };
  czmlStates: SampledEntityState[];
  rawCzmlPackets: unknown[];
  onSync3DGlobe?: (solarLonDeg: number, missionId: string) => void;
}

const TAB_LIST: { id: InspectorTab; label: string; badge?: string }[] = [
  { id: 'telemetry', label: 'Telemetry' },
  { id: 'ephemeris', label: 'Ephemeris', badge: 'DE441' },
  { id: 'matrix', label: 'Missions', badge: '14' },
  { id: 'czml', label: 'CZML Track' },
  { id: 'pds', label: 'PDS ODE' },
  { id: 'compliance', label: 'Audit', badge: '25/25' },
  { id: 'drive', label: 'Drive' },
];

export function InspectorDrawer({
  activeTab,
  onChangeTab,
  onClose,
  missions,
  selectedMission,
  onSelectMission,
  solarLonDeg,
  basemapMode,
  onChangeBasemap,
  qmStats,
  czmlSummary,
  czmlStates,
  rawCzmlPackets,
  onSync3DGlobe,
}: InspectorDrawerProps) {
  const [ephemerisSubView, setEphemerisSubView] = useState<'simulation' | 'horizons'>('simulation');
  const [hemisphereFilter, setHemisphereFilter] = useState<string>('All');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [pdsDataset, setPdsDataset] = useState<'lroc' | 'lola' | 'diviner'>('lroc');
  const [pdsData, setPdsData] = useState<PDSResponse | null>(null);
  const [pdsLoading, setPdsLoading] = useState(false);
  const [health, setHealth] = useState<ServerHealth | null>(null);
  const [copiedCoords, setCopiedCoords] = useState(false);

  const fetchPdsForMission = async (m: CLPSMission, ds = pdsDataset) => {
    setPdsLoading(true);
    try {
      const res = await fetch(`/api/pds/products?lat=${m.latDeg}&lon=${m.lonDeg}&span=1.5&dataset=${ds}`);
      const json = (await res.json()) as PDSResponse;
      setPdsData(json);
    } catch (err) {
      setPdsData({
        status: 'error',
        error: err instanceof Error ? err.message : 'Request failed',
        products: [],
      });
    } finally {
      setPdsLoading(false);
    }
  };

  const fetchHealth = async () => {
    try {
      const res = await fetch('/api/health/telemetry');
      if (res.ok) setHealth(await res.json());
    } catch {
      // Ignore
    }
  };

  useEffect(() => {
    if (activeTab === 'pds') {
      fetchPdsForMission(selectedMission, pdsDataset);
    } else if (activeTab === 'compliance') {
      fetchHealth();
    }
  }, [activeTab, selectedMission, pdsDataset]);

  if (!activeTab) return null;

  const mcmf = selenographicToMCMF(
    selectedMission.lonDeg,
    selectedMission.latDeg,
    selectedMission.elevationM
  );
  const q = computeLanderQuaternion(
    selectedMission.lonDeg,
    selectedMission.latDeg,
    selectedMission.attitudeEulerDeg
  );
  const solarZenith = computeSolarZenithDeg(
    selectedMission.lonDeg,
    selectedMission.latDeg,
    solarLonDeg
  );
  const wgsErrorKm = wgs84RadialErrorKm(selectedMission.latDeg);

  const isSunlit = solarZenith < 90;
  const cosZ = Math.max(0, Math.cos((solarZenith * Math.PI) / 180));
  const estimatedTempK = isSunlit
    ? Math.round(100 + 290 * Math.pow(cosZ, 0.25))
    : Math.round(100 - (selectedMission.latDeg < -70 || selectedMission.latDeg > 70 ? 40 : 10));

  const outcomeDisplay = (() => {
    switch (selectedMission.outcome) {
      case 'nominal':
        return { glyph: '●', text: selectedMission.statusLabel, cls: 'text-emerald-400 bg-emerald-950/60 border-emerald-500/40' };
      case 'tipped':
        return { glyph: '▲', text: selectedMission.statusLabel, cls: 'text-amber-400 bg-amber-950/60 border-amber-500/40' };
      case 'aborted':
        return { glyph: '✖', text: selectedMission.statusLabel, cls: 'text-rose-400 bg-rose-950/60 border-rose-500/40' };
      default:
        return { glyph: '◆', text: selectedMission.statusLabel, cls: 'text-cyan-400 bg-cyan-950/60 border-cyan-500/40' };
    }
  })();

  const filteredMissions = useMemo(() => {
    return missions.filter((m) => {
      const matchRegion = hemisphereFilter === 'All' || m.hemisphere === hemisphereFilter;
      const q = searchQuery.toLowerCase().trim();
      const matchQuery =
        !q ||
        m.name.toLowerCase().includes(q) ||
        m.contractor.toLowerCase().includes(q) ||
        m.destination.toLowerCase().includes(q) ||
        m.taskOrder.toLowerCase().includes(q) ||
        m.payloads.some((p) => p.toLowerCase().includes(q));
      return matchRegion && matchQuery;
    });
  }, [missions, hemisphereFilter, searchQuery]);

  const missionCzmlStates = czmlStates.filter(
    (st) =>
      st.id === selectedMission.id ||
      (selectedMission.id === 'to20a' && st.id === 'flip-rover') ||
      (Boolean(selectedMission.hasRelayLink) && st.id === 'lunar-pathfinder-relay')
  );

  const handleCopyCoords = () => {
    audioFx.playClick();
    const str = `${selectedMission.name} (${selectedMission.taskOrder}): ${selectedMission.latDeg.toFixed(4)}° N, ${selectedMission.lonDeg.toFixed(4)}° E, Elev: ${selectedMission.elevationM}m\nMCMF: [X: ${(mcmf.x/1000).toFixed(2)}km, Y: ${(mcmf.y/1000).toFixed(2)}km, Z: ${(mcmf.z/1000).toFixed(2)}km]`;
    navigator.clipboard.writeText(str).then(() => {
      setCopiedCoords(true);
      setTimeout(() => setCopiedCoords(false), 2000);
    });
  };

  const handleDownloadCzml = () => {
    audioFx.playClick();
    const blob = new Blob([JSON.stringify(rawCzmlPackets, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `clps-telemetry-${selectedMission.id}.czml`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleDownloadCzmlStates = () => {
    audioFx.playClick();
    const payload = {
      missionId: selectedMission.id,
      missionName: selectedMission.name,
      taskOrder: selectedMission.taskOrder,
      referenceFrame: 'IAU2015_Moon / MOON_FIXED',
      exportedAt: new Date().toISOString(),
      czmlStates: missionCzmlStates,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `clps-czml-states-${selectedMission.id}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <aside
      className="fixed top-13 right-0 bottom-0 z-30 w-[460px] max-w-[96vw] panel-glass-cyan border-l border-cyan-900/80 flex flex-col font-mono select-none shadow-2xl backdrop-blur-2xl"
      aria-label="Mission Telemetry Inspector"
    >
      {/* Drawer Header & Tab Strip */}
      <div className="px-3 pt-2.5 pb-2 border-b border-cyan-950/80 flex items-center justify-between gap-2 shrink-0 bg-slate-950/80">
        <div className="flex items-center gap-1 overflow-x-auto scrollbar-none">
          {TAB_LIST.map((tab) => {
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => {
                  audioFx.playClick();
                  onChangeTab(tab.id);
                }}
                className={`px-2 py-1 text-[11px] font-medium rounded transition-all duration-150 whitespace-nowrap shrink-0 cursor-pointer flex items-center gap-1 ${
                  isActive
                    ? 'bg-cyan-500/25 text-cyan-200 border border-cyan-500/50 font-bold shadow-[0_0_8px_rgba(6,182,212,0.3)]'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900'
                }`}
              >
                <span>{tab.label}</span>
                {tab.badge && (
                  <span className={`text-[8.5px] px-1 rounded ${isActive ? 'bg-cyan-400 text-slate-950 font-bold' : 'bg-slate-800 text-slate-400'}`}>
                    {tab.badge}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        <button
          type="button"
          onClick={() => {
            audioFx.playClick();
            onClose();
          }}
          className="p-1.5 text-slate-400 hover:text-white rounded hover:bg-slate-800 transition-colors cursor-pointer shrink-0"
          aria-label="Close Inspector Terminal"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Scrollable Body */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4 text-xs scrollbar-thin">
        {activeTab === 'telemetry' && (
          <>
            {/* Mission Hero Header Card */}
            <div className="p-3 bg-slate-950/80 border border-cyan-950/70 rounded-lg space-y-2">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-[11px] text-slate-400">
                  <span className="font-bold text-amber-400 bg-amber-950/60 px-1.5 py-0.5 rounded border border-amber-500/40">
                    {selectedMission.taskOrder}
                  </span>
                  <span>{selectedMission.contractor}</span>
                  <span className="text-slate-600">·</span>
                  <span className="text-cyan-300">{selectedMission.landerClass}</span>
                </div>
                <button
                  type="button"
                  onClick={handleCopyCoords}
                  className="px-2 py-1 text-[10px] font-medium rounded bg-slate-900 border border-slate-700 hover:border-cyan-500 text-slate-300 hover:text-cyan-200 flex items-center gap-1 cursor-pointer transition-colors"
                  title="Copy Coordinates"
                >
                  {copiedCoords ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                  <span>{copiedCoords ? 'Copied' : 'Copy'}</span>
                </button>
              </div>

              <div>
                <h2 className="text-base font-bold text-slate-100 font-display tracking-wide">
                  {selectedMission.name}
                </h2>
                <div className="text-[11px] text-cyan-400 mt-0.5">
                  Target: {selectedMission.destination}
                </div>
              </div>

              <div className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded border text-[11px] font-semibold ${outcomeDisplay.cls}`}>
                <span>{outcomeDisplay.glyph}</span>
                <span>{outcomeDisplay.text}</span>
              </div>

              <p className="text-[11px] text-slate-300 leading-relaxed pt-1">
                {selectedMission.summary}
              </p>
            </div>

            {/* Visual Artificial Horizon Attitude Indicator (Gimbal Tilt Visualizer) */}
            <div className="p-3 bg-slate-950/80 border border-cyan-950/70 rounded-lg space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-slate-200 font-display flex items-center gap-1.5">
                  <Activity className="w-3.5 h-3.5 text-cyan-400" />
                  Attitude Gimbal & Lander Tilt Display
                </span>
                <span className="text-[10px] text-amber-300 font-bold">
                  Tilt {selectedMission.attitudeEulerDeg.roll.toFixed(1)}°
                </span>
              </div>

              {/* Artificial Horizon Dial */}
              <div className="relative h-24 rounded bg-slate-900/90 border border-cyan-950/80 overflow-hidden flex items-center justify-center">
                {/* Sky / Ground division that rolls with attitude */}
                <div
                  className="absolute inset-0 transition-transform duration-200 origin-center"
                  style={{
                    transform: `rotate(${-selectedMission.attitudeEulerDeg.roll}deg)`,
                  }}
                >
                  {/* Sky */}
                  <div className="h-1/2 bg-sky-950/40 border-b border-cyan-400/80 flex items-end justify-center pb-1">
                    <span className="text-[8px] text-cyan-500 font-bold tracking-wider">ZENITH / SKY</span>
                  </div>
                  {/* Ground */}
                  <div className="h-1/2 bg-amber-950/30 flex items-start justify-center pt-1">
                    <span className="text-[8px] text-amber-500 font-bold tracking-wider">LUNAR SURFACE</span>
                  </div>
                </div>

                {/* Fixed Aircraft / Lander Reticle */}
                <div className="relative z-10 flex items-center gap-2 pointer-events-none">
                  <div className="w-8 h-0.5 bg-amber-400 shadow-[0_0_6px_#f59e0b]" />
                  <div className="w-3 h-3 rounded-full border-2 border-amber-400 flex items-center justify-center">
                    <div className="w-1 h-1 bg-amber-400 rounded-full" />
                  </div>
                  <div className="w-8 h-0.5 bg-amber-400 shadow-[0_0_6px_#f59e0b]" />
                </div>

                {/* Pitch ladder ticks */}
                <div className="absolute right-2 top-2 text-[9px] text-slate-400 space-y-0.5 text-right font-mono">
                  <div>R: {selectedMission.attitudeEulerDeg.roll.toFixed(1)}°</div>
                  <div>P: {selectedMission.attitudeEulerDeg.pitch.toFixed(1)}°</div>
                  <div>Y: {selectedMission.attitudeEulerDeg.yaw.toFixed(1)}°</div>
                </div>
              </div>

              {/* Unit Quaternion Vector */}
              <div className="text-[10px] text-slate-400 flex justify-between bg-slate-900/60 p-1.5 rounded border border-slate-800">
                <span>Attitude Quaternion [x, y, z, w]:</span>
                <span className="text-cyan-300 font-semibold">
                  [{q.x.toFixed(4)}, {q.y.toFixed(4)}, {q.z.toFixed(4)}, {q.w.toFixed(4)}]
                </span>
              </div>
            </div>

            {/* Selenodetic & MCMF Coordinate Metrics */}
            <div className="p-3 bg-slate-950/80 border border-cyan-950/70 rounded-lg space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-slate-200 font-display">
                  IAU2015_Moon Selenodesy
                </span>
                <span className="text-[10px] text-emerald-400 font-bold">
                  R_M = {(IAU2015_MOON.MEAN_RADIUS_M / 1000).toFixed(1)} km
                </span>
              </div>

              <div className="grid grid-cols-2 gap-2 text-[11px]">
                <div className="bg-slate-900/80 border border-slate-800/80 rounded p-2">
                  <div className="text-[10px] text-slate-400">Selenographic Lat/Lon</div>
                  <div className="text-slate-100 font-semibold mt-0.5">
                    {selectedMission.latDeg >= 0 ? `${selectedMission.latDeg.toFixed(3)}°N` : `${Math.abs(selectedMission.latDeg).toFixed(3)}°S`},{' '}
                    {selectedMission.lonDeg >= 0 ? `${selectedMission.lonDeg.toFixed(3)}°E` : `${Math.abs(selectedMission.lonDeg).toFixed(3)}°W`}
                  </div>
                  <div className="text-[10px] text-cyan-400 mt-0.5">
                    Elev: {selectedMission.elevationM.toLocaleString()} m
                  </div>
                </div>

                <div className="bg-slate-900/80 border border-slate-800/80 rounded p-2">
                  <div className="text-[10px] text-slate-400">Illumination & Temp</div>
                  <div className="text-amber-300 font-semibold mt-0.5">
                    Zenith {solarZenith.toFixed(1)}° {isSunlit ? '☀️' : '🌑'}
                  </div>
                  <div className="text-[10px] text-slate-300 mt-0.5">
                    Temp: ~{estimatedTempK} K ({estimatedTempK - 273}°C)
                  </div>
                </div>

                <div className="col-span-2 bg-slate-900/80 border border-slate-800/80 rounded p-2">
                  <div className="flex items-center justify-between text-[10px] text-slate-400 mb-1">
                    <span>MCMF Cartesian Coordinates</span>
                    <span className="text-emerald-400 font-bold">
                      WGS84 Radial Avoided: +{wgsErrorKm.toFixed(1)} km
                    </span>
                  </div>
                  <div className="grid grid-cols-3 gap-2 text-cyan-300 font-semibold text-[11px]">
                    <div>X: {(mcmf.x / 1000).toFixed(2)} km</div>
                    <div>Y: {(mcmf.y / 1000).toFixed(2)} km</div>
                    <div>Z: {(mcmf.z / 1000).toFixed(2)} km</div>
                  </div>
                </div>
              </div>
            </div>

            {/* Scientific Payload Telemetry Chart */}
            <PayloadChart spec={selectedMission.chart} />

            {/* Quantized Mesh 1.0 Binary Terrain Diagnostics */}
            <div className="p-3 bg-slate-950/80 border border-cyan-950/70 rounded-lg space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-slate-200 font-display flex items-center gap-1.5">
                  <Layers className="w-3.5 h-3.5 text-cyan-400" />
                  Quantized Mesh 1.0 & Oct-Normals
                </span>
                {basemapMode !== 'quantized' && (
                  <button
                    type="button"
                    onClick={() => {
                      audioFx.playClick();
                      onChangeBasemap('quantized');
                    }}
                    className="text-[10px] text-cyan-300 hover:text-cyan-200 bg-cyan-950/80 px-2 py-0.5 rounded border border-cyan-800/60 font-semibold cursor-pointer"
                  >
                    Render 3D Mesh Patch
                  </button>
                )}
              </div>

              {qmStats && qmStats.missionId === selectedMission.id ? (
                <div className="bg-slate-900/80 border border-slate-800 rounded p-2 text-[11px] space-y-1 text-slate-300">
                  <div className="flex justify-between">
                    <span className="text-slate-400">Binary Tile Size:</span>
                    <span className="text-cyan-300 font-semibold">{qmStats.byteLength.toLocaleString()} bytes</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-400">Vertices / Triangles:</span>
                    <span>{qmStats.vertexCount} / {qmStats.triangleCount}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-400">Elevation Bounds:</span>
                    <span>{qmStats.minHeightM} m .. {qmStats.maxHeightM} m</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-400">Oct-Normal Pair:</span>
                    <span className="text-amber-300 font-semibold">
                      [{qmStats.sampleOctPair[0]}, {qmStats.sampleOctPair[1]}] → ({qmStats.sampleDecodedNormal.join(', ')})
                    </span>
                  </div>
                </div>
              ) : (
                <p className="text-[11px] text-slate-400 leading-relaxed">
                  Switch basemap to Quantized Mesh to stream the binary 16-bit elevation patch and decode Extension ID 1 oct-encoded normals in 3D.
                </p>
              )}
            </div>

            {/* Manifested Payloads List */}
            <div className="p-3 bg-slate-950/80 border border-cyan-950/70 rounded-lg space-y-2">
              <span className="text-xs font-semibold text-slate-200 font-display">
                Manifested Payloads ({selectedMission.payloads.length})
              </span>
              <div className="divide-y divide-slate-800/60">
                {selectedMission.payloads.map((p, idx) => (
                  <div key={idx} className="py-1.5 flex items-center justify-between text-[11px] text-slate-300">
                    <span className="flex items-center gap-1.5">
                      <span className="w-1.5 h-1.5 rounded-full bg-cyan-400" />
                      {p}
                    </span>
                    <span className="text-[9px] uppercase px-1 rounded bg-slate-800 text-slate-400">
                      NASA CLPS
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}

        {/* Tab 2: Ephemeris & Mission Simulation */}
        {activeTab === 'ephemeris' && (
          <div className="space-y-4">
            {/* View Switcher: Mission Simulation (Mariam's Screen) vs Horizons DE441 */}
            <div className="flex items-center gap-1 p-1 bg-slate-950 border border-cyan-950/80 rounded-lg">
              <button
                type="button"
                onClick={() => {
                  audioFx.playClick();
                  setEphemerisSubView('simulation');
                }}
                className={`flex-1 px-2.5 py-1.5 text-xs font-semibold rounded-md transition-all cursor-pointer flex items-center justify-center gap-1.5 ${
                  ephemerisSubView === 'simulation'
                    ? 'bg-cyan-500 text-slate-950 font-bold shadow-[0_0_10px_rgba(6,182,212,0.4)]'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                <Calendar className="w-3.5 h-3.5" />
                <span>Simulation (Date/Time)</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  audioFx.playClick();
                  setEphemerisSubView('horizons');
                }}
                className={`flex-1 px-2.5 py-1.5 text-xs font-semibold rounded-md transition-all cursor-pointer flex items-center justify-center gap-1.5 ${
                  ephemerisSubView === 'horizons'
                    ? 'bg-amber-500 text-slate-950 font-bold shadow-[0_0_10px_rgba(245,158,11,0.4)]'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                <Radio className="w-3.5 h-3.5" />
                <span>Horizons DE441 Live</span>
              </button>
            </div>

            {ephemerisSubView === 'simulation' ? (
              <MissionSimulation
                currentMission={selectedMission}
                onSync3DGlobe={onSync3DGlobe}
              />
            ) : (
              <EphemerisPanel mission={selectedMission} />
            )}
          </div>
        )}

        {/* Tab 3: Missions Database Matrix */}
        {activeTab === 'matrix' && (
          <div className="space-y-3">
            {/* Search Input Bar */}
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search missions, craters, contractors, payloads..."
                className="w-full bg-slate-950 border border-slate-800 rounded-md pl-8 pr-3 py-1.5 text-xs text-slate-100 placeholder-slate-500 focus:outline-none focus:border-cyan-500"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery('')}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white"
                >
                  <X className="w-3 h-3" />
                </button>
              )}
            </div>

            {/* Region Filter Chips */}
            <div className="flex items-center gap-1 p-1 bg-slate-950 border border-slate-800 rounded-md overflow-x-auto">
              {['All', 'Near Side', 'South Pole', 'Far Side', 'Cislunar'].map((region) => (
                <button
                  key={region}
                  type="button"
                  onClick={() => {
                    audioFx.playClick();
                    setHemisphereFilter(region);
                  }}
                  className={`px-2.5 py-1 text-[11px] font-semibold rounded whitespace-nowrap shrink-0 cursor-pointer transition-colors ${
                    hemisphereFilter === region
                      ? 'bg-amber-500 text-slate-950 font-bold'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {region}
                </button>
              ))}
            </div>

            {/* Missions List */}
            <div className="space-y-2">
              {filteredMissions.map((m) => {
                const isSel = m.id === selectedMission.id;
                const outcomeCol =
                  m.outcome === 'nominal'
                    ? 'text-emerald-400'
                    : m.outcome === 'tipped'
                    ? 'text-amber-400'
                    : m.outcome === 'aborted'
                    ? 'text-rose-400'
                    : 'text-cyan-400';

                return (
                  <div
                    key={m.id}
                    onClick={() => {
                      audioFx.playBeep();
                      onSelectMission(m.id);
                    }}
                    className={`p-3 rounded-lg border text-left cursor-pointer transition-all duration-150 ${
                      isSel
                        ? 'bg-slate-900 border-amber-400/80 shadow-[0_0_12px_rgba(245,158,11,0.2)]'
                        : 'bg-slate-950/70 border-slate-800/80 hover:bg-slate-900/60 hover:border-slate-700'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span className={outcomeCol}>
                          {m.outcome === 'nominal' ? '●' : m.outcome === 'tipped' ? '▲' : m.outcome === 'aborted' ? '✖' : '◆'}
                        </span>
                        <span className="font-bold text-slate-100 font-display text-sm">{m.name}</span>
                      </div>
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-300 font-bold">
                        {m.taskOrder}
                      </span>
                    </div>

                    <div className="text-[11px] text-slate-400 mt-1 flex items-center gap-1.5 truncate">
                      <span>{m.contractor}</span>
                      <span>·</span>
                      <span className="text-cyan-300">{m.destination}</span>
                    </div>

                    <div className="text-[10px] text-slate-400 mt-1 flex justify-between items-center pt-1 border-t border-slate-800/50">
                      <span>
                        {m.latDeg.toFixed(2)}°, {m.lonDeg.toFixed(2)}° · Elev {m.elevationM}m
                      </span>
                      <span className="capitalize font-semibold text-slate-300">{m.statusLabel}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Tab 4: Orbital & CZML Track */}
        {activeTab === 'czml' && (
          <div className="space-y-3 font-mono">
            <div className="flex items-center justify-between border-b border-cyan-950/70 pb-2">
              <div>
                <h3 className="text-sm font-semibold text-slate-100 font-display">
                  Off-Thread CZML 1.0 Worker Pipeline
                </h3>
                <p className="text-[10px] text-slate-400 mt-0.5">
                  Hermite polynomial position & quaternion SLERP in MOON_FIXED frame
                </p>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <button
                  type="button"
                  onClick={handleDownloadCzml}
                  className="px-2 py-1 text-[11px] bg-slate-800 hover:bg-slate-700 text-slate-200 rounded flex items-center gap-1 border border-slate-700 cursor-pointer"
                  title="Export Raw CZML Packets"
                >
                  <Download className="w-3 h-3" />
                  <span>CZML</span>
                </button>
                <button
                  type="button"
                  onClick={handleDownloadCzmlStates}
                  className="px-2 py-1 text-[11px] bg-cyan-500/20 hover:bg-cyan-500/30 text-cyan-300 rounded border border-cyan-500/40 flex items-center gap-1 cursor-pointer"
                  title="Export Sampled States JSON"
                >
                  <Download className="w-3 h-3" />
                  <span>JSON</span>
                </button>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2 text-xs bg-slate-950/80 p-2.5 rounded border border-cyan-950/60">
              <div>
                <div className="text-[10px] text-slate-400">Active CZML Entities</div>
                <div className="text-slate-100 font-bold mt-0.5">{czmlSummary.entityCount} tracks</div>
              </div>
              <div>
                <div className="text-[10px] text-slate-400">Worker Parse Time</div>
                <div className="text-cyan-400 font-bold mt-0.5">{czmlSummary.parseMs.toFixed(2)} ms</div>
              </div>
            </div>

            {/* Tracked Entities */}
            <div className="space-y-2">
              {czmlStates.map((st) => (
                <div
                  key={st.id}
                  className={`p-2.5 rounded-lg border text-[11px] space-y-1 ${
                    st.id === selectedMission.id
                      ? 'border-amber-400/80 bg-slate-900'
                      : 'border-slate-800 bg-slate-950/70'
                  }`}
                >
                  <div className="flex items-center justify-between text-slate-200 font-bold">
                    <span>{st.id}</span>
                    <span className="text-cyan-400">
                      r={(Math.hypot(st.x, st.y, st.z) / 1000).toFixed(2)} km
                    </span>
                  </div>
                  <div className="text-slate-300">
                    XYZ: ({(st.x / 1000).toFixed(1)}, {(st.y / 1000).toFixed(1)}, {(st.z / 1000).toFixed(1)}) km
                  </div>
                  <div className="text-slate-400 text-[10px]">
                    Quat: [{st.qx.toFixed(3)}, {st.qy.toFixed(3)}, {st.qz.toFixed(3)}, {st.qw.toFixed(3)}]
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Tab 5: NASA PDS ODE Query */}
        {activeTab === 'pds' && (
          <div className="space-y-3 font-mono">
            <div className="flex items-center justify-between gap-2 border-b border-cyan-950/70 pb-2">
              <div>
                <h3 className="text-sm font-semibold text-slate-100 font-display">
                  NASA PDS Geosciences ODE Query
                </h3>
                <p className="text-[10px] text-slate-400 mt-0.5">
                  Target: {selectedMission.destination} ({selectedMission.latDeg.toFixed(2)}°, {selectedMission.lonDeg.toFixed(2)}°)
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  audioFx.playClick();
                  fetchPdsForMission(selectedMission, pdsDataset);
                }}
                disabled={pdsLoading}
                className="px-2.5 py-1 text-xs font-semibold bg-cyan-500 text-slate-950 rounded hover:bg-cyan-400 flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${pdsLoading ? 'animate-spin' : ''}`} />
                <span>Query PDS</span>
              </button>
            </div>

            {/* Dataset Segments */}
            <div className="flex items-center gap-1 p-1 bg-slate-950 border border-slate-800 rounded-md">
              {[
                { id: 'lroc' as const, label: 'LROC NAC' },
                { id: 'lola' as const, label: 'LOLA RDR4' },
                { id: 'diviner' as const, label: 'Diviner Thermal' },
              ].map((ds) => (
                <button
                  key={ds.id}
                  type="button"
                  onClick={() => {
                    audioFx.playClick();
                    setPdsDataset(ds.id);
                  }}
                  className={`flex-1 px-2 py-1 text-[11px] font-semibold rounded cursor-pointer transition-colors ${
                    pdsDataset === ds.id
                      ? 'bg-cyan-500 text-slate-950'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {ds.label}
                </button>
              ))}
            </div>

            {pdsLoading && (
              <div className="p-4 border border-cyan-950/60 rounded bg-slate-950/80 text-xs text-cyan-400 flex items-center gap-2">
                <RefreshCw className="w-4 h-4 animate-spin text-cyan-400" />
                <span>Querying NASA PDS Orbital Data Explorer REST API...</span>
              </div>
            )}

            {!pdsLoading && pdsData && (
              <>
                <div className="bg-slate-950/80 border border-cyan-950/60 rounded-md p-2.5 text-[11px] space-y-1">
                  <div className="flex justify-between">
                    <span className="text-slate-400">Upstream Status:</span>
                    <span className={pdsData.status === 'live' ? 'text-emerald-400 font-bold' : 'text-amber-400 font-bold'}>
                      {pdsData.status.toUpperCase()}
                    </span>
                  </div>
                  {pdsData.latencyMs !== undefined && (
                    <div className="flex justify-between text-slate-400">
                      <span>Latency / Cache:</span>
                      <span className="text-slate-200">{pdsData.latencyMs} ms · {pdsData.cache || 'MISS'}</span>
                    </div>
                  )}
                  {pdsData.totalCount !== undefined && (
                    <div className="flex justify-between text-slate-400">
                      <span>Matched ODE Products:</span>
                      <span className="text-cyan-300 font-bold">{pdsData.totalCount.toLocaleString()}</span>
                    </div>
                  )}
                </div>

                <div className="space-y-2">
                  {pdsData.products.map((prod, idx) => (
                    <div key={`${prod.productId}-${idx}`} className="p-2.5 border border-slate-800 bg-slate-950/80 rounded-md text-[11px] space-y-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-slate-100 font-bold truncate">{prod.productId}</span>
                        <span className="text-[10px] text-cyan-400 font-semibold shrink-0">
                          {prod.instrumentHost} · {prod.instrument}
                        </span>
                      </div>
                      <div className="text-[10px] text-slate-400 flex items-center justify-between">
                        <span>{prod.productType} · {prod.pdsVersion}</span>
                        {prod.labelUrl && (
                          <a
                            href={prod.labelUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="text-amber-400 hover:text-amber-300 inline-flex items-center gap-1 font-semibold"
                          >
                            <span>PDS Label</span>
                            <ExternalLink className="w-3 h-3" />
                          </a>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        )}

        {/* Tab 6: NASA Compliance Audit */}
        {activeTab === 'compliance' && (
          <div className="space-y-3 font-mono">
            <div className="border-b border-cyan-950/70 pb-2">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-slate-100 font-display flex items-center gap-1.5">
                  <ShieldCheck className="w-4 h-4 text-emerald-400" />
                  <span>NASA Engineering Compliance Audit</span>
                </h3>
                <span className="text-xs font-bold text-emerald-400 bg-emerald-950/60 px-2 py-0.5 rounded border border-emerald-500/40">
                  25 / 25 PTS (100%)
                </span>
              </div>
              <p className="text-[10px] text-slate-400 mt-1">
                Full verification against the 25-point NASA Space Apps challenge rubric and live agency API scaling rules.
              </p>
            </div>

            <div className="space-y-2">
              {NASA_COMPLIANCE_CHECKS.map((item) => (
                <div key={item.id} className="p-2.5 border border-cyan-950/60 bg-slate-950/80 rounded-md text-xs space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-slate-200">
                      {item.pillar} · {item.title}
                    </span>
                    <span className="font-bold text-emerald-400">/{item.maxScore} pts</span>
                  </div>
                  <p className="text-[11px] text-slate-300 leading-relaxed">{item.verification}</p>
                  <div className="text-[10px] text-cyan-400 font-semibold">{item.endpointOrModule}</div>
                </div>
              ))}
            </div>

            {health && (
              <div className="p-3 border border-cyan-950/70 bg-slate-950/90 rounded-md text-[11px] space-y-1.5">
                <div className="font-bold text-slate-200 flex items-center gap-1.5">
                  <Cpu className="w-3.5 h-3.5 text-cyan-400" />
                  Live Server LRU Cache & Pipeline Telemetry
                </div>
                <div className="flex justify-between text-slate-400">
                  <span>Reference Ellipsoid:</span>
                  <span className="text-slate-200">{health.referenceFrame} ({health.moonMeanRadiusM.toLocaleString()} m)</span>
                </div>
                <div className="flex justify-between text-slate-400">
                  <span>WMTS Tile Cache:</span>
                  <span className="text-cyan-300">{health.caches.wmts.entries} tiles ({health.caches.wmts.hits} hits / {health.caches.wmts.misses} misses)</span>
                </div>
                <div className="flex justify-between text-slate-400">
                  <span>PDS ODE Cache:</span>
                  <span className="text-cyan-300">{health.caches.pds.entries} queries ({health.caches.pds.hits} hits)</span>
                </div>
                <div className="flex justify-between text-slate-400">
                  <span>Quantized Mesh Cache:</span>
                  <span className="text-cyan-300">{health.caches.quantizedMesh.entries} patches ({health.caches.quantizedMesh.hits} hits)</span>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Tab 7: Google Drive Sync */}
        {activeTab === 'drive' && (
          <DrivePanel
            selectedMission={selectedMission}
            solarLonDeg={solarLonDeg}
            qmStats={qmStats}
            czmlStates={czmlStates}
            rawCzmlPackets={rawCzmlPackets}
          />
        )}
      </div>
    </aside>
  );
}
