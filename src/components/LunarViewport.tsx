import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { BasemapMode, CLPSMission } from '../data/clpsMissions';
import {
  IAU2015_MOON,
  METERS_TO_SCENE,
  computeLanderQuaternion,
  mcmfToThreeJS,
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

export type CameraPreset = 'global' | 'south-pole' | 'far-side' | 'lander';

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

// Reusable math scratch objects (Zero GC inside render loop)
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
  } | null>(null);

  // One-time WebGL lifecycle
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
    });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.12;
    renderer.setPixelRatio(isSoftwareGl ? 1 : Math.min(window.devicePixelRatio, 2));
    renderer.setSize(width, height);
    renderer.shadowMap.enabled = !isSoftwareGl;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x05070c);

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
    controls.minDistance = 1.08;
    controls.maxDistance = 5.5;
    controls.target.set(0, 0, 0);

    // Lighting rig: Solar Directional Key Light + Cool Earthshine Hemisphere Fill
    const sunLight = new THREE.DirectionalLight(0xfff8ed, 3.1);
    sunLight.castShadow = !isSoftwareGl;
    sunLight.shadow.mapSize.set(1024, 1024);
    sunLight.shadow.bias = -0.0004;
    sunLight.shadow.normalBias = 0.02;
    scene.add(sunLight);

    const hemiFill = new THREE.HemisphereLight(0x2d436e, 0x0a0d14, 0.24);
    scene.add(hemiFill);

    // Starfield backdrop (Points)
    const starCount = 1800;
    const starPos = new Float32Array(starCount * 3);
    for (let i = 0; i < starCount; i++) {
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      const r = 18 + Math.random() * 14;
      starPos[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      starPos[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
      starPos[i * 3 + 2] = r * Math.cos(phi);
    }
    const starGeo = new THREE.BufferGeometry();
    starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
    const starMat = new THREE.PointsMaterial({ color: 0xcbd5e1, size: 0.055, sizeAttenuation: true });
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

    // Inject custom GLSL slope/polar hazard heatmap shader overlay
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
             vec3 safeCol = vec3(0.05, 0.42, 0.48);
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

    // Subtle Selenodetic Graticule (equator + prime meridian + polar circles)
    const graticuleGroup = new THREE.Group();
    const gratMat = new THREE.LineBasicMaterial({ color: 0x334155, transparent: true, opacity: 0.35 });
    const addLatRing = (latDeg: number) => {
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i <= 96; i++) {
        const lon = -180 + (i / 96) * 360;
        pts.push(selenographicToThreeJS(lon, latDeg, 1200));
      }
      graticuleGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), gratMat));
    };
    addLatRing(0);
    addLatRing(-80);
    addLatRing(80);
    // Prime Meridian (0°) & 180°
    const pmPts: THREE.Vector3[] = [];
    for (let i = 0; i <= 96; i++) {
      const lat = -90 + (i / 96) * 180;
      pmPts.push(selenographicToThreeJS(0, lat, 1200));
    }
    graticuleGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pmPts), gratMat));
    scene.add(graticuleGroup);

    // Build Composite 3D CLPS Landers & Pickable Proxy Spheres
    const landerMats = createSharedLanderMaterials();
    const landerGroups = new Map<string, THREE.Group>();
    const pickTargets: THREE.Object3D[] = [];
    const pickProxyGeo = new THREE.SphereGeometry(0.065, 10, 10);
    const pickProxyMat = new THREE.MeshBasicMaterial({ visible: false });

    const LANDER_SCALE = 0.032; // Visual scale on global moon so silhouette & tilt attitude read clearly
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

    // Selected Landing Site Ring Reticle
    const ringGeo = new THREE.RingGeometry(0.038, 0.048, 36);
    ringGeo.rotateX(-Math.PI / 2);
    const ringMat = new THREE.MeshBasicMaterial({ color: 0xf59e0b, side: THREE.DoubleSide });
    const selectedRing = new THREE.Mesh(ringGeo, ringMat);
    scene.add(selectedRing);

    // Special Mission Overlays:
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
      new THREE.LineBasicMaterial({ color: 0xef4444, transparent: true, opacity: 0.78 })
    );
    scene.add(peregrineLine);

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
    scene.add(flipPathLine);

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
      new THREE.LineBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.32 })
    );
    scene.add(relayOrbitLine);

    // Dynamic Far-Side Relay Beams (APEX 1.0 & Blue Ghost 2 -> Relay Satellite)
    const apexPos = selenographicToThreeJS(132.4, -75.0, 0);
    const bg2Pos = selenographicToThreeJS(175.0, -44.0, 0);
    const beamApexGeo = new THREE.BufferGeometry().setFromPoints([apexPos, new THREE.Vector3(0, 0, -1.5)]);
    const beamBg2Geo = new THREE.BufferGeometry().setFromPoints([bg2Pos, new THREE.Vector3(0, 0, -1.5)]);
    const beamMat = new THREE.LineBasicMaterial({ color: 0x22d3ee, transparent: true, opacity: 0.85 });
    const beamApex = new THREE.Line(beamApexGeo, beamMat);
    const beamBg2 = new THREE.Line(beamBg2Geo, beamMat);
    scene.add(beamApex, beamBg2);

    // 4. Blue Ghost 2 Radio-Quiet Shadow Cone (extends on anti-Earth -X far side)
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

    // 5. IM-3 Reiner Gamma Magnetic Dipole Field Arcs
    const magGroup = new THREE.Group();
    const magMat = new THREE.LineBasicMaterial({ color: 0xf59e0b, transparent: true, opacity: 0.72 });
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

    // 6. Quantized Mesh 1.0 Terrain Overlay Group (decoded binary patch + oct-normals)
    const qmOverlayGroup = new THREE.Group();
    scene.add(qmOverlayGroup);

    let activeTileAbort: AbortController | null = null;
    let activeQmAbort: AbortController | null = null;

    const loadQuantizedMeshOverlay = async (mission: CLPSMission, visible: boolean) => {
      // Clear previous overlay meshes
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

        // Reconstruct 3D BufferGeometry in IAU2015_Moon scene coordinates
        const vCount = decoded.vertexCount;
        const posArr = new Float32Array(vCount * 3);
        const normLinesArr = new Float32Array(vCount * 6);

        for (let i = 0; i < vCount; i++) {
          const lon = west + (decoded.u[i] / 32767) * (east - west);
          const lat = south + (decoded.v[i] / 32767) * (north - south);
          const h =
            decoded.header.minimumHeight +
            (decoded.height[i] / 32767) * (decoded.header.maximumHeight - decoded.header.minimumHeight);
          // Exaggerate height visually by 6x at regional scale so Quantized Mesh relief pops crisply
          const p = selenographicToThreeJS(lon, lat, 3500 + (h - mission.elevationM) * 6.0);
          posArr[i * 3] = p.x;
          posArr[i * 3 + 1] = p.y;
          posArr[i * 3 + 2] = p.z;

          // Oct-encoded normal vector transformed from MCMF -> ThreeJS
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
        // Ignore aborted fetch
      }
    };

    // Camera Transition State (exponential damping)
    let transitionActive = false;
    const camGoalPos = new THREE.Vector3().copy(camera.position);
    const camGoalTarget = new THREE.Vector3(0, 0, 0);

    controls.addEventListener('start', () => {
      transitionActive = false;
    });

    // Expose scene methods to React prop effect hooks
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
            callbacksRef.current.onWmtsProgress({ layer: targetLayer, ...info });
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

          // Update far-side relay beams
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
            // If altitude > 5km (in descent or Peregrine aborted arc), keep surface radius scale readable
            const r = grp.position.length();
            if (r > 1.0 && st.id !== 'to2-ab') {
              // Subtle descent visualization scale
              const altBoost = 1 + (r - 1) * 0.28;
              grp.position.normalize().multiplyScalar(altBoost);
            }
          }
        }
      }
      requestRender();
    };

    sceneApiRef.current = {
      setBasemap,
      setSolarLon,
      flyToPreset,
      updateSelectedRing,
      loadQuantizedMeshOverlay,
      applyCzmlStates,
    };

    // Raycasting (Click to select CLPS lander + throttled hover selenodetic coords)
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
        if (mId) callbacksRef.current.onSelectMission(mId);
      }
    };

    const handlePointerMove = (e: PointerEvent) => {
      const now = performance.now();
      if (now - lastMoveCheck < 50) return;
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
        callbacksRef.current.onCursorCoords(threeJSToSelenographic(moonHits[0].point));
      } else {
        callbacksRef.current.onCursorCoords(null);
      }
    };

    renderer.domElement.addEventListener('pointerdown', handlePointerDown);
    renderer.domElement.addEventListener('pointermove', handlePointerMove);

    // WebGL context loss safety
    const handleContextLost = (e: Event) => {
      e.preventDefault();
    };
    renderer.domElement.addEventListener('webglcontextlost', handleContextLost);

    // Render-on-demand scheduler with Software WebGL afterDraw pacing
    let frameId = 0;
    let renderBusy = false;
    let renderDirty = false;
    let lastClockMs = performance.now();

    function afterDraw(cb: () => void) {
      const gl = renderer.getContext() as WebGL2RenderingContext;
      if (!gl || !gl.fenceSync) {
        frameId = window.setTimeout(cb, 80);
        return;
      }
      const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      gl.flush();
      const poll = () => {
        const status = sync && gl.getSyncParameter(sync, gl.SYNC_STATUS);
        if (status === gl.UNSIGNALED) {
          frameId = window.setTimeout(poll, 5);
        } else {
          if (sync) gl.deleteSync(sync);
          frameId = window.setTimeout(cb, 80);
        }
      };
      frameId = window.setTimeout(poll, 5);
    }

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
        if (controlsChanged && controls.enableDamping) {
          renderDirty = true;
        }

        renderer.render(scene, camera);

        const done = () => {
          renderBusy = false;
          if (renderDirty) requestRender();
        };
        if (isSoftwareGl) afterDraw(done);
        else done();
      });
    }

    controls.addEventListener('change', requestRender);

    const handleResize = () => {
      if (!container) return;
      const w = container.clientWidth || window.innerWidth;
      const h = container.clientHeight || window.innerHeight;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
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
    requestRender();

    return () => {
      cancelAnimationFrame(frameId);
      clearTimeout(frameId);
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

  // React prop updates -> Three.js refs
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

  return (
    <div
      ref={mountRef}
      className="absolute inset-0 w-full h-full select-none"
      aria-label="3D IAU2015_Moon CLPS Lunar Viewport"
    />
  );
}
