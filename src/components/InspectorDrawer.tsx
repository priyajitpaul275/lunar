import { useEffect, useState } from 'react';
import { Download, ExternalLink, RefreshCw, X } from 'lucide-react';
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
import { DrivePanel } from './DrivePanel';

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
}

const TAB_LIST: { id: InspectorTab; label: string }[] = [
  { id: 'telemetry', label: 'Telemetry' },
  { id: 'ephemeris', label: 'Ephemeris' },
  { id: 'matrix', label: 'Missions' },
  { id: 'czml', label: 'CZML' },
  { id: 'pds', label: 'PDS ODE' },
  { id: 'drive', label: 'Drive' },
  { id: 'compliance', label: 'Compliance' },
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
}: InspectorDrawerProps) {
  const [hemisphereFilter, setHemisphereFilter] = useState<string>('All');
  const [pdsDataset, setPdsDataset] = useState<'lroc' | 'lola' | 'diviner'>('lroc');
  const [pdsData, setPdsData] = useState<PDSResponse | null>(null);
  const [pdsLoading, setPdsLoading] = useState(false);
  const [health, setHealth] = useState<ServerHealth | null>(null);

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
      // Ignore transient error
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

  const outcomeDisplay = (() => {
    switch (selectedMission.outcome) {
      case 'nominal':
        return { glyph: '●', text: selectedMission.statusLabel, cls: 'text-emerald-400' };
      case 'tipped':
        return { glyph: '▲', text: selectedMission.statusLabel, cls: 'text-amber-400' };
      case 'aborted':
        return { glyph: '✖', text: selectedMission.statusLabel, cls: 'text-rose-400' };
      default:
        return { glyph: '◆', text: selectedMission.statusLabel, cls: 'text-cyan-400' };
    }
  })();

  const filteredMissions =
    hemisphereFilter === 'All'
      ? missions
      : missions.filter((m) => m.hemisphere === hemisphereFilter);

  const missionCzmlStates = czmlStates.filter(
    (st) =>
      st.id === selectedMission.id ||
      (selectedMission.id === 'to20a' && st.id === 'flip-rover') ||
      (Boolean(selectedMission.hasRelayLink) && st.id === 'lunar-pathfinder-relay')
  );

  const handleDownloadCzml = () => {
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
      className="fixed top-12 right-0 bottom-0 z-20 w-[440px] max-w-[94vw] bg-[#0B0F18] border-l border-slate-800 flex flex-col"
      aria-label="Mission Telemetry Inspector"
    >
      {/* Drawer Header & Tab Strip */}
      <div className="px-4 pt-3 pb-2 border-b border-slate-800 flex items-center justify-between gap-2 shrink-0">
        <div className="flex items-center gap-1 overflow-x-auto">
          {TAB_LIST.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => onChangeTab(tab.id)}
              className={`px-2.5 py-1.5 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                activeTab === tab.id
                  ? 'bg-slate-800 text-slate-100'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="p-1.5 text-slate-400 hover:text-white rounded hover:bg-slate-800 transition-colors cursor-pointer shrink-0"
          aria-label="Close Inspector"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Scrollable Body */}
      <div className="flex-1 overflow-y-auto p-4 space-y-5">
        {activeTab === 'telemetry' && (
          <>
            {/* Mission Title & Unboxed Metadata */}
            <div>
              <div className="flex items-center gap-2 text-xs text-slate-400 mb-1">
                <span className="font-mono text-slate-300">{selectedMission.taskOrder}</span>
                <span aria-hidden="true">·</span>
                <span>{selectedMission.contractor}</span>
                <span aria-hidden="true">·</span>
                <span>{selectedMission.landerClass}</span>
              </div>
              <h2 className="text-lg font-semibold text-slate-100 leading-snug">
                {selectedMission.name}
              </h2>
              <p className={`text-xs font-medium mt-1 ${outcomeDisplay.cls}`}>
                {outcomeDisplay.glyph} {outcomeDisplay.text}
              </p>
              <p className="text-xs text-slate-300 leading-relaxed mt-2.5">
                {selectedMission.summary}
              </p>
            </div>

            {/* Selenodetic & MCMF Frame Metrics */}
            <div className="border-t border-slate-800/80 pt-4">
              <div className="flex items-baseline justify-between mb-2.5">
                <h3 className="text-xs font-semibold text-slate-200">
                  IAU2015_Moon Selenodetic Vector
                </h3>
                <span className="text-[11px] font-mono text-slate-400">
                  R_M = {(IAU2015_MOON.MEAN_RADIUS_M / 1000).toFixed(1)} km
                </span>
              </div>

              <div className="grid grid-cols-2 gap-3 text-xs">
                <div className="bg-[#070A10] border border-slate-800/80 rounded p-2.5">
                  <div className="text-[11px] text-slate-400">Landing Coordinates</div>
                  <div className="font-mono text-slate-100 mt-0.5">
                    {selectedMission.latDeg.toFixed(2)}°, {selectedMission.lonDeg.toFixed(2)}°
                  </div>
                  <div className="text-[11px] font-mono text-slate-400 mt-0.5">
                    Elev {selectedMission.elevationM} m
                  </div>
                </div>

                <div className="bg-[#070A10] border border-slate-800/80 rounded p-2.5">
                  <div className="text-[11px] text-slate-400">Solar Zenith Angle</div>
                  <div className="font-mono text-amber-300 mt-0.5">
                    {solarZenith.toFixed(2)}°
                  </div>
                  <div className="text-[11px] font-mono text-slate-400 mt-0.5">
                    {solarZenith < 90 ? 'Sunlit Horizon' : 'Shadowed / Night'}
                  </div>
                </div>

                <div className="col-span-2 bg-[#070A10] border border-slate-800/80 rounded p-2.5">
                  <div className="flex items-center justify-between text-[11px] text-slate-400 mb-1">
                    <span>MCMF Cartesian (m)</span>
                    <span className="font-mono text-emerald-400">
                      WGS84 Error Avoided: +{wgsErrorKm.toFixed(1)} km
                    </span>
                  </div>
                  <div className="font-mono text-xs text-cyan-300 grid grid-cols-3 gap-2">
                    <span>X {(mcmf.x / 1000).toFixed(2)} km</span>
                    <span>Y {(mcmf.y / 1000).toFixed(2)} km</span>
                    <span>Z {(mcmf.z / 1000).toFixed(2)} km</span>
                  </div>
                </div>

                <div className="col-span-2 bg-[#070A10] border border-slate-800/80 rounded p-2.5">
                  <div className="flex items-center justify-between text-[11px] text-slate-400 mb-1">
                    <span>Attitude Unit Quaternion (ENU → MCMF)</span>
                    <span className="font-mono text-slate-300">
                      Tilt {selectedMission.attitudeEulerDeg.roll.toFixed(1)}°
                    </span>
                  </div>
                  <div className="font-mono text-[11px] text-slate-200">
                    [{q.x.toFixed(4)}, {q.y.toFixed(4)}, {q.z.toFixed(4)}, {q.w.toFixed(4)}]
                  </div>
                </div>
              </div>
            </div>

            {/* Scientific Payload Telemetry Chart */}
            <div className="border-t border-slate-800/80 pt-4">
              <PayloadChart spec={selectedMission.chart} />
            </div>

            {/* Quantized Mesh 1.0 Binary Patch Inspector */}
            <div className="border-t border-slate-800/80 pt-4">
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-xs font-semibold text-slate-200">
                  Quantized Mesh 1.0 & Oct-Normals
                </h3>
                {basemapMode !== 'quantized' && (
                  <button
                    type="button"
                    onClick={() => onChangeBasemap('quantized')}
                    className="text-[11px] font-medium text-cyan-400 hover:text-cyan-300 cursor-pointer"
                  >
                    Render 3D Mesh Patch
                  </button>
                )}
              </div>

              {qmStats && qmStats.missionId === selectedMission.id ? (
                <div className="bg-[#070A10] border border-slate-800/80 rounded p-2.5 text-[11px] font-mono space-y-1 text-slate-300">
                  <div className="flex justify-between">
                    <span className="text-slate-400">Binary Tile Size:</span>
                    <span>{qmStats.byteLength.toLocaleString()} bytes</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-400">Vertices / Tris:</span>
                    <span>
                      {qmStats.vertexCount} / {qmStats.triangleCount}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-400">Elevation Bounds:</span>
                    <span>
                      {qmStats.minHeightM} m .. {qmStats.maxHeightM} m
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-400">Ext ID 1 Oct Pair:</span>
                    <span className="text-amber-300">
                      [{qmStats.sampleOctPair[0]}, {qmStats.sampleOctPair[1]}] → (
                      {qmStats.sampleDecodedNormal.join(', ')})
                    </span>
                  </div>
                </div>
              ) : (
                <p className="text-xs text-slate-400">
                  Switch basemap to Quantized Mesh to stream the binary 16-bit elevation patch and decode Extension ID 1 oct-encoded normals in 3D.
                </p>
              )}
            </div>

            {/* Manifested Payloads */}
            <div className="border-t border-slate-800/80 pt-4">
              <h3 className="text-xs font-semibold text-slate-200 mb-2">
                Manifested Payloads ({selectedMission.payloads.length})
              </h3>
              <ul className="space-y-1 text-xs text-slate-300">
                {selectedMission.payloads.map((p) => (
                  <li key={p} className="flex items-center justify-between py-1 border-b border-slate-800/50">
                    <span>{p}</span>
                  </li>
                ))}
              </ul>
            </div>
          </>
        )}

        {activeTab === 'matrix' && (
          <div className="space-y-3">
            <div className="flex items-center gap-1 p-1 bg-slate-900 border border-slate-800 rounded-md overflow-x-auto">
              {['All', 'South Pole', 'Near Side', 'Far Side', 'Cislunar'].map((region) => (
                <button
                  key={region}
                  type="button"
                  onClick={() => setHemisphereFilter(region)}
                  className={`px-2.5 py-1 text-[11px] font-medium rounded whitespace-nowrap shrink-0 cursor-pointer ${
                    hemisphereFilter === region
                      ? 'bg-amber-500 text-slate-950 font-semibold'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {region}
                </button>
              ))}
            </div>

            <div className="divide-y divide-slate-800/80 border border-slate-800 rounded-lg bg-[#070A10]">
              {filteredMissions.map((m) => {
                const isSel = m.id === selectedMission.id;
                return (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => {
                      onSelectMission(m.id);
                      onChangeTab('telemetry');
                    }}
                    className={`w-full text-left p-3 hover:bg-slate-900/70 transition-colors cursor-pointer ${
                      isSel ? 'bg-slate-900/90' : ''
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-semibold text-slate-100">{m.name}</span>
                      <span className="text-[11px] font-mono text-slate-400">{m.taskOrder}</span>
                    </div>
                    <div className="text-[11px] text-slate-400 mt-1 flex items-center gap-1.5">
                      <span>{m.contractor}</span>
                      <span aria-hidden="true">·</span>
                      <span>{m.destination}</span>
                    </div>
                    <div className="text-[11px] font-mono text-cyan-400 mt-1">
                      {m.latDeg.toFixed(2)}°, {m.lonDeg.toFixed(2)}° · {m.statusLabel}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {activeTab === 'ephemeris' && <EphemerisPanel mission={selectedMission} />}

        {activeTab === 'czml' && (
          <div className="space-y-4">
            <div className="space-y-2.5">
              <div>
                <h3 className="text-sm font-semibold text-slate-100">
                  Off-Thread CZML 1.0 Worker Pipeline
                </h3>
                <p className="text-xs text-slate-400 mt-0.5">
                  Hermite polynomial position & quaternion SLERP in MOON_FIXED frame
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={handleDownloadCzml}
                  className="px-2.5 py-1.5 text-xs font-medium bg-slate-800 text-slate-100 rounded hover:bg-slate-700 flex items-center gap-1.5 cursor-pointer shrink-0"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>Export CZML</span>
                </button>
                <button
                  type="button"
                  onClick={handleDownloadCzmlStates}
                  disabled={missionCzmlStates.length === 0}
                  className="px-2.5 py-1.5 text-xs font-medium bg-amber-500/15 text-amber-300 border border-amber-500/40 rounded hover:bg-amber-500/25 flex items-center gap-1.5 cursor-pointer shrink-0 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>Download States JSON</span>
                </button>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2 text-xs font-mono bg-[#070A10] border border-slate-800 rounded p-3">
              <div>
                <div className="text-[11px] text-slate-400">Active CZML Entities</div>
                <div className="text-slate-100 mt-0.5">{czmlSummary.entityCount} tracks</div>
              </div>
              <div>
                <div className="text-[11px] text-slate-400">Worker Parse Time</div>
                <div className="text-cyan-400 mt-0.5">{czmlSummary.parseMs.toFixed(2)} ms</div>
              </div>
            </div>

            <div className="space-y-2">
              {czmlStates.map((st) => (
                <div
                  key={st.id}
                  className={`p-2.5 rounded border text-[11px] font-mono ${
                    st.id === selectedMission.id
                      ? 'border-amber-500/60 bg-slate-900/70'
                      : 'border-slate-800/80 bg-[#070A10]'
                  }`}
                >
                  <div className="flex items-center justify-between text-slate-200 font-semibold mb-1">
                    <span>{st.id}</span>
                    <span className="text-slate-400">
                      r={(Math.hypot(st.x, st.y, st.z) / 1000).toFixed(2)} km
                    </span>
                  </div>
                  <div className="text-cyan-300">
                    XYZ: ({(st.x / 1000).toFixed(1)}, {(st.y / 1000).toFixed(1)},{' '}
                    {(st.z / 1000).toFixed(1)}) km
                  </div>
                  <div className="text-slate-400 mt-0.5">
                    Q: [{st.qx.toFixed(3)}, {st.qy.toFixed(3)}, {st.qz.toFixed(3)}, {st.qw.toFixed(3)}]
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {activeTab === 'pds' && (
          <div className="space-y-4">
            <div className="flex items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-semibold text-slate-100">
                  NASA PDS Geosciences ODE Query
                </h3>
                <p className="text-xs text-slate-400 mt-0.5">
                  Site: {selectedMission.destination} ({selectedMission.latDeg.toFixed(2)}°,{' '}
                  {selectedMission.lonDeg.toFixed(2)}°)
                </p>
              </div>
              <button
                type="button"
                onClick={() => fetchPdsForMission(selectedMission, pdsDataset)}
                disabled={pdsLoading}
                className="px-2.5 py-1.5 text-xs font-medium bg-cyan-500 text-slate-950 rounded hover:bg-cyan-400 flex items-center gap-1.5 cursor-pointer shrink-0 disabled:opacity-50"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${pdsLoading ? 'animate-spin' : ''}`} />
                <span>Query PDS</span>
              </button>
            </div>

            <div className="flex items-center gap-1 p-1 bg-slate-900 border border-slate-800 rounded-md">
              {[
                { id: 'lroc' as const, label: 'LROC NAC' },
                { id: 'lola' as const, label: 'LOLA RDR4' },
                { id: 'diviner' as const, label: 'Diviner RDR4' },
              ].map((ds) => (
                <button
                  key={ds.id}
                  type="button"
                  onClick={() => setPdsDataset(ds.id)}
                  className={`flex-1 px-2.5 py-1 text-[11px] font-medium rounded whitespace-nowrap cursor-pointer ${
                    pdsDataset === ds.id
                      ? 'bg-cyan-500 text-slate-950 font-semibold'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {ds.label}
                </button>
              ))}
            </div>

            {pdsLoading && (
              <div className="p-4 border border-slate-800 rounded bg-[#070A10] text-xs text-slate-400">
                Querying NASA PDS Orbital Data Explorer REST API...
              </div>
            )}

            {!pdsLoading && pdsData && (
              <>
                <div className="bg-[#070A10] border border-slate-800 rounded p-2.5 text-[11px] font-mono space-y-1">
                  <div className="flex justify-between">
                    <span className="text-slate-400">Upstream Status:</span>
                    <span
                      className={
                        pdsData.status === 'live' ? 'text-emerald-400' : 'text-amber-400'
                      }
                    >
                      {pdsData.status.toUpperCase()}
                    </span>
                  </div>
                  {pdsData.latencyMs !== undefined && (
                    <div className="flex justify-between">
                      <span className="text-slate-400">Latency / Cache:</span>
                      <span className="text-slate-200">
                        {pdsData.latencyMs} ms · {pdsData.cache || 'MISS'}
                      </span>
                    </div>
                  )}
                  {pdsData.totalCount !== undefined && (
                    <div className="flex justify-between">
                      <span className="text-slate-400">Matched ODE Products:</span>
                      <span className="text-cyan-300">{pdsData.totalCount.toLocaleString()}</span>
                    </div>
                  )}
                </div>

                {pdsData.error && (
                  <div className="p-3 border border-rose-900/60 bg-rose-950/30 rounded text-xs text-rose-300">
                    Upstream PDS REST note: {pdsData.error}
                  </div>
                )}

                {pdsData.products.length === 0 && !pdsData.error && (
                  <div className="p-3 border border-slate-800 rounded text-xs text-slate-400">
                    No PDS products returned for this bounding box. Try expanding the region or querying another site.
                  </div>
                )}

                <div className="space-y-2">
                  {pdsData.products.map((prod, idx) => (
                    <div
                      key={`${prod.productId}-${idx}`}
                      className="p-2.5 border border-slate-800/80 bg-[#070A10] rounded text-xs"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono text-slate-100 truncate">{prod.productId}</span>
                        <span className="text-[11px] font-mono text-cyan-400 shrink-0">
                          {prod.instrumentHost} · {prod.instrument}
                        </span>
                      </div>
                      <div className="text-[11px] text-slate-400 mt-1 flex items-center justify-between gap-2">
                        <span>
                          {prod.productType} · {prod.pdsVersion}
                        </span>
                        {prod.labelUrl && (
                          <a
                            href={prod.labelUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="text-amber-400 hover:text-amber-300 inline-flex items-center gap-1"
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

        {activeTab === 'drive' && (
          <DrivePanel
            selectedMission={selectedMission}
            solarLonDeg={solarLonDeg}
            qmStats={qmStats}
            czmlStates={czmlStates}
            rawCzmlPackets={rawCzmlPackets}
          />
        )}

        {activeTab === 'compliance' && (
          <div className="space-y-4">
            <div>
              <h3 className="text-sm font-semibold text-slate-100">
                NASA Space Apps Engineering Audit
              </h3>
              <p className="text-xs text-slate-400 mt-0.5">
                Verification against the 25-point local rubric and live agency API scaling rules.
              </p>
            </div>

            <div className="space-y-2">
              {NASA_COMPLIANCE_CHECKS.map((item) => (
                <div
                  key={item.id}
                  className="p-3 border border-slate-800 bg-[#070A10] rounded text-xs space-y-1"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-slate-100">
                      {item.pillar} · {item.title}
                    </span>
                    <span className="font-mono text-emerald-400">/{item.maxScore} pts</span>
                  </div>
                  <p className="text-slate-300 leading-relaxed">{item.verification}</p>
                  <div className="text-[11px] font-mono text-cyan-400 pt-0.5">
                    {item.endpointOrModule}
                  </div>
                </div>
              ))}
            </div>

            {health && (
              <div className="border-t border-slate-800 pt-3 space-y-2">
                <h4 className="text-xs font-semibold text-slate-200">
                  Live Server LRU Cache & Pipeline Metrics
                </h4>
                <div className="bg-[#070A10] border border-slate-800 rounded p-2.5 text-[11px] font-mono space-y-1 text-slate-300">
                  <div className="flex justify-between">
                    <span className="text-slate-400">Reference Ellipsoid:</span>
                    <span>
                      {health.referenceFrame} ({health.moonMeanRadiusM.toLocaleString()} m)
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-400">WMTS Tile Cache:</span>
                    <span>
                      {health.caches.wmts.entries} tiles ({health.caches.wmts.hits} hits /{' '}
                      {health.caches.wmts.misses} misses)
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-400">PDS ODE Cache:</span>
                    <span>
                      {health.caches.pds.entries} queries ({health.caches.pds.hits} hits /{' '}
                      {health.caches.pds.misses} misses)
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-400">Quantized Mesh Cache:</span>
                    <span>
                      {health.caches.quantizedMesh.entries} patches (
                      {health.caches.quantizedMesh.hits} hits)
                    </span>
                  </div>
                  {health.caches.horizons && (
                    <div className="flex justify-between">
                      <span className="text-slate-400">Horizons Ephemeris Cache:</span>
                      <span>
                        {health.caches.horizons.entries} sites ({health.caches.horizons.hits} hits /{' '}
                        {health.caches.horizons.misses} misses)
                      </span>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}
