import { useCallback, useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import {
  Compass,
  Crosshair,
  Eye,
  EyeOff,
  Flame,
  Globe,
  Layers,
  MapPin,
  Maximize2,
  Navigation,
  Radio,
  RotateCcw,
  Sparkles,
  Sun,
  Tv,
  Wifi,
} from 'lucide-react';
import { BasemapMode, CLPSMission, MissionOutcome } from '../data/clpsMissions';
import {
  IAU2015_MOON,
  METERS_TO_SCENE,
  computeLanderQuaternion,
  computeSolarZenithDeg,
  mcmfToThreeJS,
  selenographicToMCMF,
  selenographicToThreeJS,
  threeJSToSelenographic,
} from '../engine/selenodesy';
import {
  buildCLPSLanderModel,
  buildFlipRoverModel,
  buildRelaySatelliteModel,
  createSharedLanderMaterials,
} from '../engine/landerModels';
import { createProceduralLunarAtlas, streamMoonTrekAtlas } from '../engine/lunarTextures';
import { parseQuantizedMeshTile } from '../engine/quantizedMesh';
import type { SampledEntityState } from '../workers/czmlWorker';
import { audioFx } from '../engine/audioFx';

export type CameraPreset = 'global' | 'south-pole' | 'far-side' | 'lander';

interface ProjectedPin {
  id: string;
  taskOrder: string;
  name: string;
  outcome: MissionOutcome;
  destination: string;
  contractor: string;
  x: number;
  y: number;
  lat: number;
  lon: number;
  elevationM: number;
  distanceKm: number;
}

interface LunarViewportProps {
  missions: CLPSMission[];
  selectedMissionId: string;
  basemapMode: BasemapMode;
  solarLonDeg: number;
  cameraPreset: { preset: CameraPreset; seq: number };
  czmlStates: SampledEntityState[];
  onSelectMission: (id: string) => void;
  onCursorCoords: (coords: { latDeg: number; lonDeg: number } | null) => void;
  onWmtsProgress: (info: { layer: string; loaded: number; total: number; cacheHits: number; liveTiles: number }) => void;
  onQmLoaded: (stats: {
    missionId: string;
    vertexCount: number;
    triangleCount: number;
    byteLength: number;
    minHeightM: number;
    maxHeightM: number;
    hasOctNormals: boolean;
    sampleOctPair: [number, number];
    sampleDecodedNormal: [number, number, number];
  } | null) => void;
}

// Reusable scratch objects
const _tmpVec = new THREE.Vector3();
const _tmpTarget = new THREE.Vector3();
const _tmpCamGoal = new THREE.Vector3();
const _tmpUp = new THREE.Vector3();
const _rayMouse = new THREE.Vector2();

export function LunarViewport({
  missions,
  selectedMissionId,
  basemapMode,
  solarLonDeg,
  cameraPreset,
  czmlStates,
  onSelectMission,
  onCursorCoords,
  onWmtsProgress,
  onQmLoaded,
}: LunarViewportProps) {
  const mountRef = useRef<HTMLDivElement | null>(null);

  // HUD feature toggles
  const [showBeacons, setShowBeacons] = useState<boolean>(true);
  const [showGraticule, setShowGraticule] = useState<boolean>(true);
  const [showOrbits, setShowOrbits] = useState<boolean>(true);
  const [showRelayBeams, setShowRelayBeams] = useState<boolean>(true);
  const [showReticle, setShowReticle] = useState<boolean>(true);
  const [hoveredPinId, setHoveredPinId] = useState<string | null>(null);

  // Screen projected pins state
  const [projectedPins, setProjectedPins] = useState<ProjectedPin[]>([]);

  // Camera orientation angles for NavBall
  const [camAngles, setCamAngles] = useState<{ lonDeg: number; latDeg: number; headingDeg: number }>({
    lonDeg: 35,
    latDeg: -12,
    headingDeg: 0,
  });

  // Cursor or active coords
  const [cursorCoordsState, setCursorCoordsState] = useState<{ latDeg: number; lonDeg: number } | null>(null);
  const [wmtsState, setWmtsState] = useState<{
    layer: string;
    loaded: number;
    total: number;
    cacheHits: number;
    liveTiles: number;
  } | null>(null);

  // Refs bridging React props to long-lived Three.js scene
  const callbacksRef = useRef({ onSelectMission, onCursorCoords, onWmtsProgress, onQmLoaded });
  callbacksRef.current = { onSelectMission, onCursorCoords, onWmtsProgress, onQmLoaded };

  const stateRef = useRef({
    selectedMissionId,
    basemapMode,
    solarLonDeg,
    czmlStates,
  });
  stateRef.current = { selectedMissionId, basemapMode, solarLonDeg, czmlStates };

  const sceneApiRef = useRef<{
    setBasemap: (mode: BasemapMode) => void;
    setSolarLon: (deg: number) => void;
    flyToPreset: (preset: CameraPreset, mission: CLPSMission) => void;
    updateSelectedRing: (mission: CLPSMission) => void;
    loadQuantizedMeshOverlay: (mission: CLPSMission, visible: boolean) => void;
    applyCzmlStates: (states: SampledEntityState[]) => void;
    toggleGraticule: (visible: boolean) => void;
    toggleOrbits: (visible: boolean) => void;
    toggleRelayBeams: (visible: boolean) => void;
  } | null>(null);

  // Selected mission object
  const selectedMission = missions.find((m) => m.id === selectedMissionId) || missions[0];

  // Primary WebGL Scene lifecycle
  useEffect(() => {
    const container = mountRef.current;
    if (!container) return;

    // Detect software WebGL
    const isSoftwareGl = (() => {
      try {
        const probe = document.createElement('canvas').getContext('webgl2');
        if (!probe) return true;
        const ext = probe.getExtension('WEBGL_debug_renderer_info');
        const param = ext ? ext.UNMASKED_RENDERER_WEBGL : probe.RENDERER;
        const gpu = String(probe.getParameter(param));
        probe.getExtension('WEBGL_lose_context')?.loseContext();
        return /SwiftShader|llvmpipe|softpipe|Software|Basic Render/i.test(gpu);
      } catch {
        return true;
      }
    })();

    const width = container.clientWidth || window.innerWidth;
    const height = container.clientHeight || window.innerHeight;

    const renderer = new THREE.WebGLRenderer({
      antialias: !isSoftwareGl,
      powerPreference: 'high-performance',
      alpha: false,
    });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    renderer.setPixelRatio(isSoftwareGl ? 1 : Math.min(window.devicePixelRatio, 2));
    renderer.setSize(width, height);
    renderer.shadowMap.enabled = !isSoftwareGl;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x04060a);

    // Studio environment reflection for gold MLI & titanium landers
    const pmremGenerator = new THREE.PMREMGenerator(renderer);
    const envTex = pmremGenerator.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environment = envTex;
    pmremGenerator.dispose();

    const camera = new THREE.PerspectiveCamera(42, width / height, 0.01, 60);
    camera.position.set(2.35, -0.7, 1.85);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = !isSoftwareGl;
    controls.dampingFactor = 0.06;
    controls.enablePan = false;
    controls.minDistance = 1.06;
    controls.maxDistance = 6.0;
    controls.target.set(0, 0, 0);

    // Lighting rig: Solar Directional Key Light + Cool Earthshine Fill
    const sunLight = new THREE.DirectionalLight(0xfffaed, 3.2);
    sunLight.castShadow = !isSoftwareGl;
    sunLight.shadow.mapSize.set(1024, 1024);
    sunLight.shadow.bias = -0.0004;
    sunLight.shadow.normalBias = 0.02;
    scene.add(sunLight);

    const hemiFill = new THREE.HemisphereLight(0x2d436e, 0x07090e, 0.28);
    scene.add(hemiFill);

    // Starfield backdrop
    const starCount = 2200;
    const starPos = new Float32Array(starCount * 3);
    for (let i = 0; i < starCount; i++) {
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      const r = 20 + Math.random() * 15;
      starPos[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      starPos[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
      starPos[i * 3 + 2] = r * Math.cos(phi);
    }
    const starGeo = new THREE.BufferGeometry();
    starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
    const starMat = new THREE.PointsMaterial({ color: 0x94a3b8, size: 0.05, sizeAttenuation: true });
    const stars = new THREE.Points(starGeo, starMat);
    scene.add(stars);

    // Lunar Globe (IAU2015_Moon)
    const atlas = createProceduralLunarAtlas(1024, 512);
    const maxAniso = renderer.capabilities.getMaxAnisotropy();
    atlas.albedoTexture.anisotropy = maxAniso;
    atlas.bumpTexture.anisotropy = maxAniso;

    const moonGeo = new THREE.SphereGeometry(1.0, 128, 64);
    const hazardUniform = { value: 0.0 };
    const moonMat = new THREE.MeshStandardMaterial({
      map: atlas.albedoTexture,
      bumpMap: atlas.bumpTexture,
      bumpScale: 0.012,
      roughness: 0.92,
      metalness: 0.02,
    });

    // Custom GLSL slope hazard heatmap shader overlay
    moonMat.onBeforeCompile = (shader) => {
      shader.uniforms.uHazardMix = hazardUniform;
      shader.vertexShader =
        `varying vec3 vObjPos;\nvarying vec3 vObjNormal;\n` +
        shader.vertexShader.replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>\nvObjPos = position;\nvObjNormal = normal;`
        );
      shader.fragmentShader =
        `uniform float uHazardMix;\nvarying vec3 vObjPos;\nvarying vec3 vObjNormal;\n` +
        shader.fragmentShader.replace(
          '#include <color_fragment>',
          `#include <color_fragment>
           if (uHazardMix > 0.01) {
             float polarLat = abs(vObjPos.y);
             float craterSlope = fract(sin(dot(floor(vObjPos * 95.0), vec3(12.9898, 78.233, 37.719))) * 43758.5453);
             float slopeFactor = smoothstep(0.45, 0.92, craterSlope * 0.65 + smoothstep(0.88, 0.99, polarLat) * 0.45);
             vec3 safeCol = vec3(0.04, 0.48, 0.52);
             vec3 warnCol = vec3(0.95, 0.62, 0.05);
             vec3 dangerCol = vec3(0.92, 0.22, 0.22);
             vec3 hazardCol = mix(safeCol, warnCol, smoothstep(0.0, 0.55, slopeFactor));
             hazardCol = mix(hazardCol, dangerCol, smoothstep(0.55, 1.0, slopeFactor));
             diffuseColor.rgb = mix(diffuseColor.rgb, hazardCol * (0.55 + 0.45 * diffuseColor.r), uHazardMix);
           }`
        );
    };

    const moonMesh = new THREE.Mesh(moonGeo, moonMat);
    moonMesh.receiveShadow = true;
    scene.add(moonMesh);

    // Subtle Selenodetic Graticule
    const graticuleGroup = new THREE.Group();
    const gratMat = new THREE.LineBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.35 });
    const addLatRing = (latDeg: number) => {
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i <= 96; i++) {
        const lon = -180 + (i / 96) * 360;
        pts.push(selenographicToThreeJS(lon, latDeg, 1200));
      }
      graticuleGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), gratMat));
    };
    addLatRing(0); // Equator
    addLatRing(-80); // Polar boundary
    addLatRing(80);
    addLatRing(-45);
    addLatRing(45);

    // Prime Meridian & Orthogonal Meridians
    const addLonLine = (lonDeg: number) => {
      const pmPts: THREE.Vector3[] = [];
      for (let i = 0; i <= 96; i++) {
        const lat = -90 + (i / 96) * 180;
        pmPts.push(selenographicToThreeJS(lonDeg, lat, 1200));
      }
      graticuleGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pmPts), gratMat));
    };
    addLonLine(0);
    addLonLine(90);
    addLonLine(180);
    addLonLine(-90);
    scene.add(graticuleGroup);

    // Build Composite 3D CLPS Landers & Pickable Proxy Spheres
    const landerMats = createSharedLanderMaterials();
    const landerGroups = new Map<string, THREE.Group>();
    const pickTargets: THREE.Object3D[] = [];
    const pickProxyGeo = new THREE.SphereGeometry(0.065, 10, 10);
    const pickProxyMat = new THREE.MeshBasicMaterial({ visible: false });

    const LANDER_SCALE = 0.034;
    for (const m of missions) {
      const lander = buildCLPSLanderModel(m, landerMats);
      lander.scale.setScalar(LANDER_SCALE);
      selenographicToThreeJS(m.lonDeg, m.latDeg, 0, lander.position);
      lander.quaternion.copy(computeLanderQuaternion(m.lonDeg, m.latDeg, m.attitudeEulerDeg));
      scene.add(lander);
      landerGroups.set(m.id, lander);

      const proxy = new THREE.Mesh(pickProxyGeo, pickProxyMat);
      proxy.position.copy(lander.position);
      proxy.userData.missionId = m.id;
      proxy.layers.set(1);
      scene.add(proxy);
      pickTargets.push(proxy);
    }

    // Orbiting ESA Lunar Pathfinder / Elytra Relay Satellite
    const relayModel = buildRelaySatelliteModel(landerMats);
    relayModel.scale.setScalar(0.035);
    scene.add(relayModel);

    // FLIP Rover (Griffin Mission 1)
    const flipRover = buildFlipRoverModel(landerMats);
    flipRover.scale.setScalar(0.025);
    scene.add(flipRover);

    // Selected Landing Site Ring Reticle (pulsing tactical indicator)
    const ringGeo = new THREE.RingGeometry(0.036, 0.046, 36);
    ringGeo.rotateX(-Math.PI / 2);
    const ringMat = new THREE.MeshBasicMaterial({ color: 0xf59e0b, side: THREE.DoubleSide });
    const selectedRing = new THREE.Mesh(ringGeo, ringMat);
    scene.add(selectedRing);

    // Trajectory & Orbit lines group
    const trajectoryGroup = new THREE.Group();

    // 1. Peregrine TO2-AB Aborted Trajectory Arc
    const peregrinePts: THREE.Vector3[] = [];
    for (let i = 0; i <= 40; i++) {
      const u = i / 40;
      const lon = -40.9 - u * 48;
      const lat = 35.2 * (1 - u * 0.4) + Math.sin(u * Math.PI) * 16;
      const altM = 120000 + Math.sin(u * Math.PI) * 1450000;
      peregrinePts.push(selenographicToThreeJS(lon, lat, altM));
    }
    const peregrineLine = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(peregrinePts),
      new THREE.LineBasicMaterial({ color: 0xef4444, transparent: true, opacity: 0.85 })
    );
    trajectoryGroup.add(peregrineLine);

    // 2. Griffin TO20A FLIP Rover Traversal Path
    const flipPts: THREE.Vector3[] = [];
    for (let i = 0; i <= 24; i++) {
      const u = i / 24;
      const rLon = 53.5 + u * 2.2;
      const rLat = -85.2 + Math.sin(u * Math.PI) * 0.8;
      flipPts.push(selenographicToThreeJS(rLon, rLat, 6000));
    }
    const flipPathLine = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(flipPts),
      new THREE.LineBasicMaterial({ color: 0x06b6d4, transparent: true, opacity: 0.9 })
    );
    trajectoryGroup.add(flipPathLine);

    // 3. Far-Side Relay Orbit Loop
    const relayOrbitPts: THREE.Vector3[] = [];
    for (let i = 0; i <= 64; i++) {
      const u = i / 64;
      const angle = u * Math.PI * 2;
      const lat = -Math.sin(angle) * 78;
      const lon = 152 + Math.cos(angle) * 28;
      const altM = 580000 + 380000 * (1 - Math.sin(angle)) * 0.5;
      relayOrbitPts.push(selenographicToThreeJS(lon, lat, altM));
    }
    const relayOrbitLine = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints(relayOrbitPts),
      new THREE.LineBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.45 })
    );
    trajectoryGroup.add(relayOrbitLine);
    scene.add(trajectoryGroup);

    // 4. Dynamic Far-Side Relay Beams Group
    const relayBeamGroup = new THREE.Group();
    const apexPos = selenographicToThreeJS(132.4, -75.0, 0);
    const bg2Pos = selenographicToThreeJS(175.0, -44.0, 0);
    const beamApexGeo = new THREE.BufferGeometry().setFromPoints([apexPos, new THREE.Vector3(0, 0, -1.5)]);
    const beamBg2Geo = new THREE.BufferGeometry().setFromPoints([bg2Pos, new THREE.Vector3(0, 0, -1.5)]);
    const beamMat = new THREE.LineBasicMaterial({ color: 0x22d3ee, transparent: true, opacity: 0.88 });
    const beamApex = new THREE.Line(beamApexGeo, beamMat);
    const beamBg2 = new THREE.Line(beamBg2Geo, beamMat);
    relayBeamGroup.add(beamApex, beamBg2);
    scene.add(relayBeamGroup);

    // 5. Blue Ghost 2 Radio-Quiet Shadow Cone
    const coneGeo = new THREE.ConeGeometry(1.0, 2.2, 32, 1, true);
    coneGeo.rotateZ(-Math.PI / 2);
    const coneMat = new THREE.MeshBasicMaterial({
      color: 0x06b6d4,
      transparent: true,
      opacity: 0.08,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const radioQuietCone = new THREE.Mesh(coneGeo, coneMat);
    radioQuietCone.position.set(-1.1, 0, 0);
    scene.add(radioQuietCone);

    // 6. IM-3 Reiner Gamma Magnetic Dipole Field Arcs
    const magGroup = new THREE.Group();
    const magMat = new THREE.LineBasicMaterial({ color: 0xf59e0b, transparent: true, opacity: 0.75 });
    const rgNormal = selenographicToThreeJS(-59.0, 7.5, 0).normalize();
    const rgTangent = new THREE.Vector3(0, 1, 0).cross(rgNormal).normalize();
    for (let k = -1; k <= 1; k += 2) {
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i <= 24; i++) {
        const t = i / 24;
        const angle = t * Math.PI;
        const base = selenographicToThreeJS(-59.0 + (t - 0.5) * 4.5, 7.5 + k * Math.sin(angle) * 1.4, 0);
        base.addScaledVector(rgNormal, Math.sin(angle) * 0.085);
        base.addScaledVector(rgTangent, k * Math.sin(angle) * 0.01);
        pts.push(base);
      }
      magGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), magMat));
    }
    scene.add(magGroup);

    // 7. Quantized Mesh 1.0 Overlay Group
    const qmOverlayGroup = new THREE.Group();
    scene.add(qmOverlayGroup);

    let activeTileAbort: AbortController | null = null;
    let activeQmAbort: AbortController | null = null;

    const loadQuantizedMeshOverlay = async (mission: CLPSMission, visible: boolean) => {
      while (qmOverlayGroup.children.length > 0) {
        const child = qmOverlayGroup.children.pop()!;
        if ((child as THREE.Mesh).geometry) (child as THREE.Mesh).geometry.dispose();
        if ((child as THREE.Mesh).material) ((child as THREE.Mesh).material as THREE.Material).dispose();
      }
      if (activeQmAbort) activeQmAbort.abort();
      if (!visible) return;

      const ac = new AbortController();
      activeQmAbort = ac;
      try {
        const res = await fetch(`/api/terrain/qm/${mission.id}`, { signal: ac.signal });
        if (!res.ok) return;
        const west = Number(res.headers.get('X-Bounds-West'));
        const east = Number(res.headers.get('X-Bounds-East'));
        const south = Number(res.headers.get('X-Bounds-South'));
        const north = Number(res.headers.get('X-Bounds-North'));
        const buf = await res.arrayBuffer();
        const decoded = parseQuantizedMeshTile(buf, { west, south, east, north });

        const vCount = decoded.vertexCount;
        const posArr = new Float32Array(vCount * 3);
        const normLinesArr = new Float32Array(vCount * 6);

        for (let i = 0; i < vCount; i++) {
          const lon = west + (decoded.u[i] / 32767) * (east - west);
          const lat = south + (decoded.v[i] / 32767) * (north - south);
          const h =
            decoded.header.minimumHeight +
            (decoded.height[i] / 32767) * (decoded.header.maximumHeight - decoded.header.minimumHeight);
          const p = selenographicToThreeJS(lon, lat, 3500 + (h - mission.elevationM) * 6.0);
          posArr[i * 3] = p.x;
          posArr[i * 3 + 1] = p.y;
          posArr[i * 3 + 2] = p.z;

          const nx = decoded.normals[i * 3];
          const ny = decoded.normals[i * 3 + 1];
          const nz = decoded.normals[i * 3 + 2];
          const tNorm = mcmfToThreeJS({
            x: nx * IAU2015_MOON.MEAN_RADIUS_M,
            y: ny * IAU2015_MOON.MEAN_RADIUS_M,
            z: nz * IAU2015_MOON.MEAN_RADIUS_M,
          }).normalize();

          normLinesArr[i * 6] = p.x;
          normLinesArr[i * 6 + 1] = p.y;
          normLinesArr[i * 6 + 2] = p.z;
          normLinesArr[i * 6 + 3] = p.x + tNorm.x * 0.018;
          normLinesArr[i * 6 + 4] = p.y + tNorm.y * 0.018;
          normLinesArr[i * 6 + 5] = p.z + tNorm.z * 0.018;
        }

        const qmGeo = new THREE.BufferGeometry();
        qmGeo.setAttribute('position', new THREE.BufferAttribute(posArr, 3));
        qmGeo.setIndex(new THREE.BufferAttribute(decoded.indices, 1));
        qmGeo.computeVertexNormals();

        const wireMat = new THREE.MeshBasicMaterial({
          color: 0x22d3ee,
          wireframe: true,
          transparent: true,
          opacity: 0.72,
        });
        qmOverlayGroup.add(new THREE.Mesh(qmGeo, wireMat));

        const normGeo = new THREE.BufferGeometry();
        normGeo.setAttribute('position', new THREE.BufferAttribute(normLinesArr, 3));
        const normMat = new THREE.LineBasicMaterial({ color: 0xf59e0b, transparent: true, opacity: 0.8 });
        qmOverlayGroup.add(new THREE.LineSegments(normGeo, normMat));

        const sampleEx = decoded.octNormalsRaw[0] ?? 128;
        const sampleEy = decoded.octNormalsRaw[1] ?? 128;
        callbacksRef.current.onQmLoaded({
          missionId: mission.id,
          vertexCount: decoded.vertexCount,
          triangleCount: decoded.triangleCount,
          byteLength: decoded.byteLength,
          minHeightM: Math.round(decoded.header.minimumHeight),
          maxHeightM: Math.round(decoded.header.maximumHeight),
          hasOctNormals: decoded.hasOctNormals,
          sampleOctPair: [sampleEx, sampleEy],
          sampleDecodedNormal: [
            Number((decoded.normals[0] ?? 0).toFixed(4)),
            Number((decoded.normals[1] ?? 0).toFixed(4)),
            Number((decoded.normals[2] ?? 1).toFixed(4)),
          ],
        });
        requestRender();
      } catch {
        // Aborted
      }
    };

    // Camera Flight Transition State
    let transitionActive = false;
    const camGoalPos = new THREE.Vector3().copy(camera.position);
    const camGoalTarget = new THREE.Vector3(0, 0, 0);

    controls.addEventListener('start', () => {
      transitionActive = false;
    });

    let loadedLayer = '';
    const setBasemap = (mode: BasemapMode) => {
      hazardUniform.value = mode === 'hazard' ? 0.85 : 0.0;
      const targetLayer: 'lroc_wac' | 'lola_clr' = mode === 'lola' ? 'lola_clr' : 'lroc_wac';
      if (loadedLayer !== targetLayer) {
        loadedLayer = targetLayer;
        if (activeTileAbort) activeTileAbort.abort();
        activeTileAbort = new AbortController();
        streamMoonTrekAtlas(
          targetLayer,
          atlas.canvas,
          atlas.ctx,
          atlas.albedoTexture,
          (info) => {
            const wmtsPayload = { layer: targetLayer, ...info };
            callbacksRef.current.onWmtsProgress(wmtsPayload);
            setWmtsState(wmtsPayload);
            requestRender();
          },
          activeTileAbort.signal
        );
      }
      requestRender();
    };

    const setSolarLon = (deg: number) => {
      const sunPos = selenographicToThreeJS(deg, 1.54, 0, _tmpVec).multiplyScalar(12);
      sunLight.position.copy(sunPos);
      requestRender();
    };

    const updateSelectedRing = (mission: CLPSMission) => {
      selenographicToThreeJS(mission.lonDeg, mission.latDeg, 2200, selectedRing.position);
      _tmpUp.copy(selectedRing.position).normalize();
      selectedRing.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), _tmpUp);
      requestRender();
    };

    const flyToPreset = (preset: CameraPreset, mission: CLPSMission) => {
      if (preset === 'global') {
        camGoalTarget.set(0, 0, 0);
        camGoalPos.set(2.35, -0.7, 1.85);
      } else if (preset === 'south-pole') {
        camGoalTarget.set(0, -0.35, 0);
        camGoalPos.set(0.65, -2.1, 0.75);
      } else if (preset === 'far-side') {
        camGoalTarget.set(0, 0, 0);
        camGoalPos.set(-2.55, -0.65, -0.7);
      } else if (preset === 'lander') {
        const surf = selenographicToThreeJS(mission.lonDeg, mission.latDeg, 0, _tmpTarget);
        camGoalTarget.set(0, 0, 0);
        camGoalPos.copy(surf).normalize().multiplyScalar(1.42);
      }
      transitionActive = true;
      requestRender();
    };

    const applyCzmlStates = (states: SampledEntityState[]) => {
      for (const st of states) {
        if (st.id === 'lunar-pathfinder-relay') {
          mcmfToThreeJS({ x: st.x, y: st.y, z: st.z }, relayModel.position);
          relayModel.lookAt(0, 0, 0);

          const apexArr = beamApexGeo.attributes.position as THREE.BufferAttribute;
          apexArr.setXYZ(1, relayModel.position.x, relayModel.position.y, relayModel.position.z);
          apexArr.needsUpdate = true;

          const bg2Arr = beamBg2Geo.attributes.position as THREE.BufferAttribute;
          bg2Arr.setXYZ(1, relayModel.position.x, relayModel.position.y, relayModel.position.z);
          bg2Arr.needsUpdate = true;
        } else if (st.id === 'flip-rover') {
          mcmfToThreeJS({ x: st.x, y: st.y, z: st.z }, flipRover.position);
          _tmpUp.copy(flipRover.position).normalize();
          flipRover.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), _tmpUp);
        } else {
          const grp = landerGroups.get(st.id);
          if (grp) {
            mcmfToThreeJS({ x: st.x, y: st.y, z: st.z }, grp.position);
            const r = grp.position.length();
            if (r > 1.0 && st.id !== 'to2-ab') {
              const altBoost = 1 + (r - 1) * 0.28;
              grp.position.normalize().multiplyScalar(altBoost);
            }
          }
        }
      }
      requestRender();
    };

    const toggleGraticule = (visible: boolean) => {
      graticuleGroup.visible = visible;
      requestRender();
    };

    const toggleOrbits = (visible: boolean) => {
      trajectoryGroup.visible = visible;
      requestRender();
    };

    const toggleRelayBeams = (visible: boolean) => {
      relayBeamGroup.visible = visible;
      requestRender();
    };

    sceneApiRef.current = {
      setBasemap,
      setSolarLon,
      flyToPreset,
      updateSelectedRing,
      loadQuantizedMeshOverlay,
      applyCzmlStates,
      toggleGraticule,
      toggleOrbits,
      toggleRelayBeams,
    };

    // Calculate Screen Projected Tactical Beacon Pins
    const updateProjectedPins = () => {
      const w = container.clientWidth || window.innerWidth;
      const h = container.clientHeight || window.innerHeight;
      const pins: ProjectedPin[] = [];

      for (const m of missions) {
        const worldPos = selenographicToThreeJS(m.lonDeg, m.latDeg, 8000, _tmpVec);
        // Horizon occlusion test: surface point must face toward camera
        const normal = worldPos.clone().normalize();
        const toCam = camera.position.clone().sub(worldPos).normalize();
        const isFacing = normal.dot(toCam) > 0.05;

        if (isFacing) {
          const proj = worldPos.clone().project(camera);
          if (proj.z < 1.0 && proj.x >= -1.05 && proj.x <= 1.05 && proj.y >= -1.05 && proj.y <= 1.05) {
            const sx = ((proj.x + 1) / 2) * w;
            const sy = ((-proj.y + 1) / 2) * h;
            pins.push({
              id: m.id,
              taskOrder: m.taskOrder,
              name: m.name,
              outcome: m.outcome,
              destination: m.destination,
              contractor: m.contractor,
              x: sx,
              y: sy,
              lat: m.latDeg,
              lon: m.lonDeg,
              elevationM: m.elevationM,
              distanceKm: Math.round(camera.position.distanceTo(worldPos) * 1737.4),
            });
          }
        }
      }
      setProjectedPins(pins);

      // Camera coordinates for NavBall
      const camCoords = threeJSToSelenographic(camera.position);
      setCamAngles({
        lonDeg: camCoords.lonDeg,
        latDeg: camCoords.latDeg,
        headingDeg: Math.round(Math.atan2(camera.position.x, camera.position.z) * (180 / Math.PI)),
      });
    };

    // Raycasting for clicking landers and hovering over Moon surface
    const raycaster = new THREE.Raycaster();
    let lastMoveCheck = 0;

    const handlePointerDown = (e: PointerEvent) => {
      const rect = renderer.domElement.getBoundingClientRect();
      _rayMouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      _rayMouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

      raycaster.layers.set(1);
      raycaster.setFromCamera(_rayMouse, camera);
      const hits = raycaster.intersectObjects(pickTargets, false);
      if (hits.length > 0) {
        const mId = hits[0].object.userData.missionId as string;
        if (mId) {
          audioFx.playBeep();
          callbacksRef.current.onSelectMission(mId);
        }
      }
    };

    const handlePointerMove = (e: PointerEvent) => {
      const now = performance.now();
      if (now - lastMoveCheck < 40) return;
      lastMoveCheck = now;

      const rect = renderer.domElement.getBoundingClientRect();
      _rayMouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      _rayMouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

      raycaster.layers.set(1);
      raycaster.setFromCamera(_rayMouse, camera);
      const landerHits = raycaster.intersectObjects(pickTargets, false);
      renderer.domElement.style.cursor = landerHits.length > 0 ? 'pointer' : 'crosshair';

      raycaster.layers.set(0);
      raycaster.setFromCamera(_rayMouse, camera);
      const moonHits = raycaster.intersectObject(moonMesh, false);
      if (moonHits.length > 0) {
        const sel = threeJSToSelenographic(moonHits[0].point);
        callbacksRef.current.onCursorCoords(sel);
        setCursorCoordsState(sel);
      } else {
        callbacksRef.current.onCursorCoords(null);
        setCursorCoordsState(null);
      }
    };

    renderer.domElement.addEventListener('pointerdown', handlePointerDown);
    renderer.domElement.addEventListener('pointermove', handlePointerMove);

    const handleContextLost = (e: Event) => {
      e.preventDefault();
    };
    renderer.domElement.addEventListener('webglcontextlost', handleContextLost);

    // Render loop
    let frameId = 0;
    let renderBusy = false;
    let renderDirty = false;
    let lastClockMs = performance.now();

    function requestRender() {
      if (renderBusy) {
        renderDirty = true;
        return;
      }
      renderBusy = true;
      frameId = requestAnimationFrame(() => {
        renderDirty = false;
        const now = performance.now();
        const delta = Math.min(0.1, (now - lastClockMs) / 1000);
        lastClockMs = now;

        if (transitionActive) {
          const lambda = 6.5;
          camera.position.x = THREE.MathUtils.damp(camera.position.x, camGoalPos.x, lambda, delta);
          camera.position.y = THREE.MathUtils.damp(camera.position.y, camGoalPos.y, lambda, delta);
          camera.position.z = THREE.MathUtils.damp(camera.position.z, camGoalPos.z, lambda, delta);
          controls.target.x = THREE.MathUtils.damp(controls.target.x, camGoalTarget.x, lambda, delta);
          controls.target.y = THREE.MathUtils.damp(controls.target.y, camGoalTarget.y, lambda, delta);
          controls.target.z = THREE.MathUtils.damp(controls.target.z, camGoalTarget.z, lambda, delta);

          if (camera.position.distanceTo(camGoalPos) < 0.008) {
            camera.position.copy(camGoalPos);
            controls.target.copy(camGoalTarget);
            transitionActive = false;
          } else {
            renderDirty = true;
          }
        }

        const controlsChanged = controls.update();
        if (controlsChanged || transitionActive) {
          renderDirty = true;
          updateProjectedPins();
        }

        // Pulse selected ring
        const t = now * 0.003;
        selectedRing.scale.setScalar(1 + Math.sin(t) * 0.08);

        renderer.render(scene, camera);
        renderBusy = false;
        if (renderDirty) requestRender();
      });
    }

    controls.addEventListener('change', () => {
      requestRender();
      updateProjectedPins();
    });

    const handleResize = () => {
      if (!container) return;
      const w = container.clientWidth || window.innerWidth;
      const h = container.clientHeight || window.innerHeight;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
      updateProjectedPins();
      requestRender();
    };
    window.addEventListener('resize', handleResize);

    if (!isSoftwareGl) {
      renderer.compile(scene, camera);
    }

    // Initial state sync
    const initMission = missions.find((m) => m.id === stateRef.current.selectedMissionId) || missions[0];
    setSolarLon(stateRef.current.solarLonDeg);
    setBasemap(stateRef.current.basemapMode);
    updateSelectedRing(initMission);
    updateProjectedPins();
    requestRender();

    return () => {
      cancelAnimationFrame(frameId);
      if (activeTileAbort) activeTileAbort.abort();
      if (activeQmAbort) activeQmAbort.abort();
      window.removeEventListener('resize', handleResize);
      renderer.domElement.removeEventListener('pointerdown', handlePointerDown);
      renderer.domElement.removeEventListener('pointermove', handlePointerMove);
      renderer.domElement.removeEventListener('webglcontextlost', handleContextLost);
      controls.dispose();
      moonGeo.dispose();
      moonMat.dispose();
      atlas.albedoTexture.dispose();
      atlas.bumpTexture.dispose();
      envTex.dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode === container) {
        container.removeChild(renderer.domElement);
      }
    };
  }, [missions]);

  // Synchronize React Props with Scene
  useEffect(() => {
    sceneApiRef.current?.setBasemap(basemapMode);
    const m = missions.find((item) => item.id === selectedMissionId) || missions[0];
    sceneApiRef.current?.loadQuantizedMeshOverlay(m, basemapMode === 'quantized');
  }, [basemapMode, selectedMissionId, missions]);

  useEffect(() => {
    sceneApiRef.current?.setSolarLon(solarLonDeg);
  }, [solarLonDeg]);

  useEffect(() => {
    const m = missions.find((item) => item.id === selectedMissionId) || missions[0];
    sceneApiRef.current?.updateSelectedRing(m);
  }, [selectedMissionId, missions]);

  useEffect(() => {
    if (cameraPreset.seq === 0) return;
    const m = missions.find((item) => item.id === selectedMissionId) || missions[0];
    sceneApiRef.current?.flyToPreset(cameraPreset.preset, m);
  }, [cameraPreset, selectedMissionId, missions]);

  useEffect(() => {
    if (czmlStates.length > 0) {
      sceneApiRef.current?.applyCzmlStates(czmlStates);
    }
  }, [czmlStates]);

  useEffect(() => {
    sceneApiRef.current?.toggleGraticule(showGraticule);
  }, [showGraticule]);

  useEffect(() => {
    sceneApiRef.current?.toggleOrbits(showOrbits);
  }, [showOrbits]);

  useEffect(() => {
    sceneApiRef.current?.toggleRelayBeams(showRelayBeams);
  }, [showRelayBeams]);

  // Computed Telemetry Variables
  const displayLat = cursorCoordsState ? cursorCoordsState.latDeg : selectedMission.latDeg;
  const displayLon = cursorCoordsState ? cursorCoordsState.lonDeg : selectedMission.lonDeg;
  const solarZenith = computeSolarZenithDeg(displayLon, displayLat, solarLonDeg);

  // Surface temperature estimate based on solar incidence angle
  // Day max: ~390 K (equator noon). Night / cold trap: ~100 K down to ~40 K in PSR.
  const isSunlit = solarZenith < 90;
  const cosZ = Math.max(0, Math.cos((solarZenith * Math.PI) / 180));
  const estimatedTempK = isSunlit
    ? Math.round(100 + 290 * Math.pow(cosZ, 0.25))
    : Math.round(100 - (displayLat < -70 || displayLat > 70 ? 40 : 10));
  const estimatedTempC = estimatedTempK - 273;
  const solarFluxWm2 = isSunlit ? Math.round(1361 * cosZ) : 0;

  // MCMF Cartesian Vector for readout
  const mcmf = selenographicToMCMF(displayLon, displayLat, cursorCoordsState ? 0 : selectedMission.elevationM);

  return (
    <div className="relative w-full h-full select-none overflow-hidden">
      {/* 3D WebGL Canvas Mount */}
      <div
        ref={mountRef}
        className="absolute inset-0 w-full h-full select-none"
        aria-label="3D IAU2015_Moon CLPS Lunar Viewport"
      />

      {/* Screen-Projected Interactive Tactical Beacon Pins */}
      {showBeacons && (
        <div className="absolute inset-0 pointer-events-none z-10 overflow-hidden">
          {projectedPins.map((pin) => {
            const isSelected = pin.id === selectedMissionId;
            const isHovered = pin.id === hoveredPinId;
            const colorCls =
              pin.outcome === 'nominal'
                ? 'text-emerald-400 border-emerald-500/60 bg-emerald-950/80 shadow-[0_0_12px_rgba(16,185,129,0.3)]'
                : pin.outcome === 'tipped'
                ? 'text-amber-400 border-amber-500/60 bg-amber-950/80 shadow-[0_0_12px_rgba(245,158,11,0.3)]'
                : pin.outcome === 'aborted'
                ? 'text-rose-400 border-rose-500/60 bg-rose-950/80 shadow-[0_0_12px_rgba(244,63,94,0.3)]'
                : 'text-cyan-400 border-cyan-500/60 bg-cyan-950/80 shadow-[0_0_12px_rgba(6,182,212,0.3)]';

            return (
              <div
                key={pin.id}
                style={{
                  transform: `translate3d(${pin.x}px, ${pin.y}px, 0)`,
                  left: 0,
                  top: 0,
                }}
                className="absolute -translate-x-1/2 -translate-y-full pointer-events-auto transition-transform duration-75"
                onMouseEnter={() => setHoveredPinId(pin.id)}
                onMouseLeave={() => setHoveredPinId(null)}
              >
                {/* Tactical Beacon Pin Head */}
                <button
                  type="button"
                  onClick={() => {
                    audioFx.playBeep();
                    onSelectMission(pin.id);
                  }}
                  className={`group relative flex items-center gap-1.5 px-2 py-0.5 rounded border text-[11px] font-mono cursor-pointer transition-all duration-150 ${colorCls} ${
                    isSelected ? 'ring-2 ring-amber-400 ring-offset-1 ring-offset-slate-950 scale-110 z-20' : 'hover:scale-105'
                  }`}
                  aria-label={`Select mission ${pin.name}`}
                >
                  {/* Radar pulse ring on active or hover */}
                  {(isSelected || isHovered) && (
                    <span className="absolute -inset-1 rounded border border-cyan-400/60 animate-radar-beacon pointer-events-none" />
                  )}
                  <span className="w-1.5 h-1.5 rounded-full bg-current animate-pulse" />
                  <span className="font-semibold tracking-wider uppercase text-[10px]">{pin.taskOrder}</span>

                  {/* Vertical beacon anchor needle */}
                  <span className="absolute bottom-0 left-1/2 -translate-x-1/2 translate-y-full w-px h-3 bg-gradient-to-b from-current to-transparent" />
                </button>

                {/* Expanded Tactical Target Card on Hover or Selected */}
                {(isHovered || (isSelected && !hoveredPinId)) && (
                  <div className="absolute left-1/2 -translate-x-1/2 bottom-8 w-48 panel-glass p-2.5 rounded-md text-[11px] font-mono pointer-events-none shadow-xl border border-slate-700/80 z-30 animate-in fade-in zoom-in-95 duration-100">
                    <div className="flex items-center justify-between font-semibold text-slate-100 truncate">
                      <span className="truncate">{pin.name}</span>
                      <span className="text-[10px] text-cyan-400 font-normal shrink-0">
                        {pin.distanceKm} km
                      </span>
                    </div>
                    <div className="text-[10px] text-slate-400 truncate mt-0.5">
                      {pin.destination}
                    </div>
                    <div className="text-[10px] text-cyan-300 mt-1 flex justify-between">
                      <span>
                        {pin.lat >= 0 ? `${pin.lat.toFixed(2)}°N` : `${Math.abs(pin.lat).toFixed(2)}°S`}
                      </span>
                      <span>
                        {pin.lon >= 0 ? `${pin.lon.toFixed(2)}°E` : `${Math.abs(pin.lon).toFixed(2)}°W`}
                      </span>
                    </div>
                    <div className="text-[9px] text-slate-500 mt-1 flex justify-between border-t border-slate-800 pt-1">
                      <span>{pin.contractor}</span>
                      <span className="capitalize text-slate-300">{pin.outcome}</span>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Center Tactical Reticle / Flight Director Crosshair */}
      {showReticle && (
        <div className="absolute inset-0 pointer-events-none flex items-center justify-center z-10 opacity-30">
          <div className="relative w-12 h-12">
            <div className="absolute top-1/2 left-0 right-0 h-px bg-cyan-400 -translate-y-1/2" />
            <div className="absolute left-1/2 top-0 bottom-0 w-px bg-cyan-400 -translate-x-1/2" />
            <div className="absolute inset-2 border border-cyan-400/50 rounded-full" />
          </div>
        </div>
      )}

      {/* Tactical Selenodetic Telemetry Readout (Top-Left HUD Panel) */}
      <div className="pointer-events-auto absolute top-4 left-4 z-20 w-72 panel-glass-cyan p-3 rounded-lg text-xs font-mono hud-corner-tl space-y-2 border border-cyan-900/60">
        <div className="flex items-center justify-between border-b border-cyan-900/60 pb-1.5">
          <div className="flex items-center gap-1.5 text-cyan-400 text-[11px] font-semibold tracking-wider uppercase">
            <Radio className="w-3.5 h-3.5 animate-pulse" />
            <span>Telemetry Stream</span>
          </div>
          <span className="text-[10px] text-slate-400 px-1 py-0.5 rounded bg-cyan-950/70 border border-cyan-800/40">
            {cursorCoordsState ? 'CURSOR HOVER' : 'TARGET LOCKED'}
          </span>
        </div>

        {/* Selected target name */}
        <div>
          <div className="text-[10px] text-slate-400 uppercase tracking-wide">Active Track</div>
          <div className="text-slate-100 font-display font-semibold text-sm truncate">
            {cursorCoordsState ? 'Surface Point' : selectedMission.name}
          </div>
          <div className="text-[10px] text-cyan-300 truncate">
            {cursorCoordsState ? 'Topocentric Coordinates' : `${selectedMission.taskOrder} · ${selectedMission.destination}`}
          </div>
        </div>

        {/* Coordinates grid */}
        <div className="grid grid-cols-2 gap-1.5 text-[11px] bg-slate-950/60 p-2 rounded border border-cyan-950/60">
          <div>
            <div className="text-[9px] text-slate-400 uppercase">Latitude</div>
            <div className="text-cyan-200 font-semibold">
              {displayLat >= 0 ? `${displayLat.toFixed(2)}° N` : `${Math.abs(displayLat).toFixed(2)}° S`}
            </div>
          </div>
          <div>
            <div className="text-[9px] text-slate-400 uppercase">Longitude</div>
            <div className="text-cyan-200 font-semibold">
              {displayLon >= 0 ? `${displayLon.toFixed(2)}° E` : `${Math.abs(displayLon).toFixed(2)}° W`}
            </div>
          </div>
          <div>
            <div className="text-[9px] text-slate-400 uppercase">Solar Zenith</div>
            <div className={`font-semibold ${isSunlit ? 'text-amber-300' : 'text-slate-400'}`}>
              {solarZenith.toFixed(1)}° {isSunlit ? '☀️' : '🌑'}
            </div>
          </div>
          <div>
            <div className="text-[9px] text-slate-400 uppercase">Surface Temp</div>
            <div className="text-slate-200 font-semibold">
              {estimatedTempK} K <span className="text-[10px] text-slate-400 font-normal">({estimatedTempC}°C)</span>
            </div>
          </div>
        </div>

        {/* Secondary Telemetry Details */}
        <div className="text-[10px] text-slate-400 space-y-1 pt-1 border-t border-cyan-950/60">
          <div className="flex justify-between">
            <span>Solar Flux:</span>
            <span className="text-amber-300">{solarFluxWm2} W/m²</span>
          </div>
          <div className="flex justify-between">
            <span>Earth Comms (DTE):</span>
            <span className={displayLon > -85 && displayLon < 85 ? 'text-emerald-400' : 'text-amber-400'}>
              {displayLon > -85 && displayLon < 85 ? 'Line of Sight' : 'Far-Side Relay Reqd'}
            </span>
          </div>
          <div className="flex justify-between">
            <span>MCMF [X, Y, Z]:</span>
            <span className="text-slate-300">
              {(mcmf.x / 1000).toFixed(0)}, {(mcmf.y / 1000).toFixed(0)}, {(mcmf.z / 1000).toFixed(0)} km
            </span>
          </div>
          {wmtsState && (
            <div className="flex justify-between text-cyan-400">
              <span>WMTS {wmtsState.layer.toUpperCase()}:</span>
              <span>
                {wmtsState.liveTiles}/{wmtsState.total} tiles {wmtsState.cacheHits > 0 ? `(${wmtsState.cacheHits}c)` : ''}
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Selenodetic Vector NavBall & Attitude Compass (Bottom-Left HUD Widget) */}
      <div className="pointer-events-auto absolute bottom-24 left-4 z-20 panel-glass p-2.5 rounded-lg border border-slate-800 text-xs font-mono hud-corner-br hidden sm:flex items-center gap-3">
        {/* Visual Dial */}
        <div className="relative w-12 h-12 rounded-full border border-cyan-500/40 bg-slate-950/80 flex items-center justify-center overflow-hidden">
          {/* North needle */}
          <div
            className="absolute top-1 w-0.5 h-4 bg-rose-500 -translate-x-1/2 left-1/2 origin-bottom transition-transform duration-100"
            style={{ transform: `rotate(${-camAngles.headingDeg}deg)` }}
          />
          {/* Subsolar Indicator */}
          <div
            className="absolute w-2 h-2 rounded-full bg-amber-400 shadow-[0_0_6px_#f59e0b] origin-center transition-transform duration-100"
            style={{
              transform: `rotate(${solarLonDeg - camAngles.lonDeg}deg) translateY(-16px)`,
            }}
            title="Subsolar Vector Direction"
          />
          <span className="text-[8px] font-bold text-slate-400">MOON</span>
        </div>

        {/* Textual Angle Readout */}
        <div className="text-[10px] space-y-0.5">
          <div className="text-slate-400 uppercase text-[9px]">Camera Attitude</div>
          <div className="text-slate-200">
            Nadir: <span className="text-cyan-300 font-semibold">{camAngles.latDeg >= 0 ? `${camAngles.latDeg.toFixed(1)}°N` : `${Math.abs(camAngles.latDeg).toFixed(1)}°S`}</span>,{' '}
            <span className="text-cyan-300 font-semibold">{camAngles.lonDeg >= 0 ? `${camAngles.lonDeg.toFixed(1)}°E` : `${Math.abs(camAngles.lonDeg).toFixed(1)}°W`}</span>
          </div>
          <div className="text-slate-400">
            Heading: <span className="text-amber-300 font-semibold">{camAngles.headingDeg}°</span> · Subsolar: <span className="text-amber-300 font-semibold">{solarLonDeg}°</span>
          </div>
        </div>
      </div>

      {/* Floating Tactical Layer Toggles (Top-Right under TopBar) */}
      <div className="pointer-events-auto absolute top-4 right-4 z-20 flex items-center gap-1.5 panel-glass p-1.5 rounded-lg border border-slate-800 text-[11px] font-mono">
        <button
          type="button"
          onClick={() => {
            audioFx.playClick();
            setShowBeacons((prev) => !prev);
          }}
          className={`px-2 py-1 rounded transition-colors cursor-pointer flex items-center gap-1 ${
            showBeacons ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40' : 'text-slate-400 hover:text-slate-200'
          }`}
          title="Toggle 3D Landing Site Beacons"
        >
          <MapPin className="w-3 h-3" />
          <span className="hidden sm:inline">Beacons</span>
        </button>

        <button
          type="button"
          onClick={() => {
            audioFx.playClick();
            setShowGraticule((prev) => !prev);
          }}
          className={`px-2 py-1 rounded transition-colors cursor-pointer flex items-center gap-1 ${
            showGraticule ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40' : 'text-slate-400 hover:text-slate-200'
          }`}
          title="Toggle Selenodetic Lat/Lon Graticule"
        >
          <Globe className="w-3 h-3" />
          <span className="hidden sm:inline">Grid</span>
        </button>

        <button
          type="button"
          onClick={() => {
            audioFx.playClick();
            setShowOrbits((prev) => !prev);
          }}
          className={`px-2 py-1 rounded transition-colors cursor-pointer flex items-center gap-1 ${
            showOrbits ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40' : 'text-slate-400 hover:text-slate-200'
          }`}
          title="Toggle Flight Paths & Orbit Trajectories"
        >
          <Navigation className="w-3 h-3" />
          <span className="hidden sm:inline">Orbits</span>
        </button>

        <button
          type="button"
          onClick={() => {
            audioFx.playClick();
            setShowRelayBeams((prev) => !prev);
          }}
          className={`px-2 py-1 rounded transition-colors cursor-pointer flex items-center gap-1 ${
            showRelayBeams ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40' : 'text-slate-400 hover:text-slate-200'
          }`}
          title="Toggle Far-Side Relay Comms Links"
        >
          <Wifi className="w-3 h-3" />
          <span className="hidden sm:inline">Comms</span>
        </button>

        <button
          type="button"
          onClick={() => {
            audioFx.playClick();
            setShowReticle((prev) => !prev);
          }}
          className={`p-1 rounded transition-colors cursor-pointer ${
            showReticle ? 'bg-slate-800 text-cyan-300' : 'text-slate-500 hover:text-slate-300'
          }`}
          title="Toggle Crosshairs"
        >
          <Crosshair className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}
