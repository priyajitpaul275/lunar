import * as THREE from 'three';
import { CLPSMission } from '../data/clpsMissions';

export interface SharedLanderMaterials {
  goldMli: THREE.MeshPhysicalMaterial;
  titanium: THREE.MeshStandardMaterial;
  whiteThermal: THREE.MeshStandardMaterial;
  solarCell: THREE.MeshPhysicalMaterial;
  carbonComposite: THREE.MeshStandardMaterial;
  beaconNominal: THREE.MeshStandardMaterial;
  beaconTipped: THREE.MeshStandardMaterial;
  beaconAborted: THREE.MeshStandardMaterial;
  beaconPlanned: THREE.MeshStandardMaterial;
}

export function createSharedLanderMaterials(): SharedLanderMaterials {
  return {
    goldMli: new THREE.MeshPhysicalMaterial({
      color: 0xd4a030,
      metalness: 0.92,
      roughness: 0.24,
      clearcoat: 0.35,
      clearcoatRoughness: 0.25,
    }),
    titanium: new THREE.MeshStandardMaterial({
      color: 0xa8b3c2,
      metalness: 0.85,
      roughness: 0.32,
    }),
    whiteThermal: new THREE.MeshStandardMaterial({
      color: 0xe6ebf2,
      metalness: 0.1,
      roughness: 0.65,
    }),
    solarCell: new THREE.MeshPhysicalMaterial({
      color: 0x0f2547,
      metalness: 0.65,
      roughness: 0.18,
      clearcoat: 0.8,
      clearcoatRoughness: 0.1,
    }),
    carbonComposite: new THREE.MeshStandardMaterial({
      color: 0x1e2430,
      metalness: 0.25,
      roughness: 0.72,
    }),
    beaconNominal: new THREE.MeshStandardMaterial({
      color: 0x10b981,
      emissive: 0x10b981,
      emissiveIntensity: 0.9,
      roughness: 0.3,
    }),
    beaconTipped: new THREE.MeshStandardMaterial({
      color: 0xf59e0b,
      emissive: 0xf59e0b,
      emissiveIntensity: 0.9,
      roughness: 0.3,
    }),
    beaconAborted: new THREE.MeshStandardMaterial({
      color: 0xef4444,
      emissive: 0xef4444,
      emissiveIntensity: 0.9,
      roughness: 0.3,
    }),
    beaconPlanned: new THREE.MeshStandardMaterial({
      color: 0x06b6d4,
      emissive: 0x06b6d4,
      emissiveIntensity: 0.85,
      roughness: 0.3,
    }),
  };
}

function addLandingLegs(
  group: THREE.Group,
  count: number,
  topRadius: number,
  footRadius: number,
  legHeight: number,
  mat: SharedLanderMaterials
) {
  const strutGeo = new THREE.CylinderGeometry(0.035, 0.03, 1, 8);
  const padGeo = new THREE.CylinderGeometry(0.11, 0.14, 0.04, 12);

  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);

    const topPt = new THREE.Vector3(cos * topRadius, legHeight, sin * topRadius);
    const footPt = new THREE.Vector3(cos * footRadius, 0.02, sin * footRadius);

    // Footpad flush on ground (y=0.02)
    const pad = new THREE.Mesh(padGeo, mat.titanium);
    pad.position.copy(footPt);
    group.add(pad);

    // Strut connecting topPt -> footPt
    const dir = new THREE.Vector3().subVectors(topPt, footPt);
    const len = dir.length();
    const strut = new THREE.Mesh(strutGeo, mat.carbonComposite);
    strut.scale.set(1, len, 1);
    strut.position.addVectors(footPt, topPt).multiplyScalar(0.5);
    strut.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
    group.add(strut);
  }
}

/**
 * Builds a composite 6-10 part 3D procedural spacecraft model pivoted at bottom-center (y=0).
 */
export function buildCLPSLanderModel(
  mission: CLPSMission,
  mat: SharedLanderMaterials
): THREE.Group {
  const group = new THREE.Group();
  group.name = `lander-${mission.id}`;

  const statusMat =
    mission.outcome === 'nominal'
      ? mat.beaconNominal
      : mission.outcome === 'tipped'
        ? mat.beaconTipped
        : mission.outcome === 'aborted'
          ? mat.beaconAborted
          : mat.beaconPlanned;

  if (mission.landerClass === 'Nova-C') {
    // Tall hexagonal cylinder (IM-1, IM-2, IM-3)
    addLandingLegs(group, 6, 0.36, 0.56, 0.48, mat);

    const hull = new THREE.Mesh(new THREE.CylinderGeometry(0.36, 0.36, 1.05, 6), mat.whiteThermal);
    hull.position.y = 0.85;
    group.add(hull);

    const mliCollar = new THREE.Mesh(new THREE.CylinderGeometry(0.37, 0.37, 0.34, 6), mat.goldMli);
    mliCollar.position.y = 0.55;
    group.add(mliCollar);

    const engineBell = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.28, 16, 1, true), mat.titanium);
    engineBell.rotation.x = Math.PI;
    engineBell.position.y = 0.25;
    group.add(engineBell);

    // Side solar panels
    const panelGeo = new THREE.BoxGeometry(0.03, 0.72, 0.36);
    const leftPanel = new THREE.Mesh(panelGeo, mat.solarCell);
    leftPanel.position.set(-0.39, 0.92, 0);
    group.add(leftPanel);

    const rightPanel = new THREE.Mesh(panelGeo, mat.solarCell);
    rightPanel.position.set(0.39, 0.92, 0);
    group.add(rightPanel);

    // Top dome & status beacon
    const topDeck = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.36, 0.12, 6), mat.titanium);
    topDeck.position.y = 1.43;
    group.add(topDeck);

    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.28, 8), mat.titanium);
    mast.position.set(0.14, 1.58, 0);
    group.add(mast);

    const dish = new THREE.Mesh(new THREE.SphereGeometry(0.16, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.45), mat.whiteThermal);
    dish.position.set(0.14, 1.66, 0);
    dish.rotation.x = Math.PI * 0.8;
    group.add(dish);
  } else if (mission.landerClass === 'Blue Ghost') {
    // Wide squat octagonal deck wrapped in gold Kapton MLI
    addLandingLegs(group, 4, 0.52, 0.78, 0.36, mat);

    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.56, 0.6, 0.48, 8), mat.goldMli);
    body.position.y = 0.52;
    group.add(body);

    const topDeck = new THREE.Mesh(new THREE.CylinderGeometry(0.58, 0.58, 0.07, 8), mat.carbonComposite);
    topDeck.position.y = 0.79;
    group.add(topDeck);

    // Dual side solar wings
    const wingGeo = new THREE.BoxGeometry(0.55, 0.03, 0.42);
    const w1 = new THREE.Mesh(wingGeo, mat.solarCell);
    w1.position.set(-0.82, 0.74, 0);
    w1.rotation.z = 0.18;
    group.add(w1);

    const w2 = new THREE.Mesh(wingGeo, mat.solarCell);
    w2.position.set(0.82, 0.74, 0);
    w2.rotation.z = -0.18;
    group.add(w2);

    // Payload instrument boxes on deck
    const box1 = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.22, 0.24), mat.whiteThermal);
    box1.position.set(-0.18, 0.93, 0.12);
    group.add(box1);

    // LISTER drill boom or LuSEE-Night crossed dipole antennas
    if (mission.hasRadioQuietCone) {
      for (let a = 0; a < 4; a++) {
        const ant = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, 0.85, 6), mat.titanium);
        ant.rotation.z = Math.PI * 0.42;
        ant.rotation.y = (a * Math.PI) / 2;
        ant.position.y = 1.05;
        group.add(ant);
      }
    } else {
      const boom = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.65, 8), mat.titanium);
      boom.position.set(0.26, 0.52, 0.28);
      group.add(boom);
    }
  } else if (mission.landerClass === 'Blue Moon MK1') {
    // Tall heavy-cargo cryogenic lander
    addLandingLegs(group, 4, 0.56, 0.95, 0.55, mat);

    const lowerSkirt = new THREE.Mesh(new THREE.CylinderGeometry(0.56, 0.62, 0.48, 16), mat.carbonComposite);
    lowerSkirt.position.y = 0.72;
    group.add(lowerSkirt);

    const cryoTank = new THREE.Mesh(new THREE.CylinderGeometry(0.46, 0.46, 1.08, 20), mat.whiteThermal);
    cryoTank.position.y = 1.48;
    group.add(cryoTank);

    const cargoBay = new THREE.Mesh(new THREE.CylinderGeometry(0.52, 0.48, 0.42, 12), mat.goldMli);
    cargoBay.position.y = 2.18;
    group.add(cargoBay);

    const be7 = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.36, 16, 1, true), mat.titanium);
    be7.rotation.x = Math.PI;
    be7.position.y = 0.32;
    group.add(be7);
  } else {
    // Peregrine, Griffin, APEX 1.0
    addLandingLegs(group, 4, 0.48, 0.74, 0.4, mat);

    const bus = new THREE.Mesh(new THREE.BoxGeometry(0.86, 0.46, 0.86), mat.goldMli);
    bus.position.y = 0.62;
    group.add(bus);

    const upperDeck = new THREE.Mesh(new THREE.BoxGeometry(0.92, 0.08, 0.92), mat.titanium);
    upperDeck.position.y = 0.89;
    group.add(upperDeck);

    const solarTop = new THREE.Mesh(new THREE.BoxGeometry(0.82, 0.03, 0.72), mat.solarCell);
    solarTop.position.set(0, 0.96, 0);
    group.add(solarTop);

    const dishMast = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.34, 8), mat.titanium);
    dishMast.position.set(-0.24, 1.12, 0.2);
    group.add(dishMast);
  }

  // Status Telemetry Beacon Sphere on top for immediate spatial legibility
  const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.11, 14, 14), statusMat);
  beacon.position.set(0, mission.landerClass === 'Blue Moon MK1' ? 2.55 : 1.75, 0);
  beacon.name = 'telemetry-beacon';
  group.add(beacon);

  return group;
}

/**
 * Builds composite ESA Lunar Pathfinder / Elytra Far-Side Relay Satellite
 */
export function buildRelaySatelliteModel(mat: SharedLanderMaterials): THREE.Group {
  const group = new THREE.Group();
  group.name = 'lunar-pathfinder-relay';

  const bus = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.42, 0.48), mat.goldMli);
  group.add(bus);

  const wingGeo = new THREE.BoxGeometry(1.15, 0.025, 0.36);
  const leftWing = new THREE.Mesh(wingGeo, mat.solarCell);
  leftWing.position.set(-0.82, 0, 0);
  group.add(leftWing);

  const rightWing = new THREE.Mesh(wingGeo, mat.solarCell);
  rightWing.position.set(0.82, 0, 0);
  group.add(rightWing);

  const dish = new THREE.Mesh(
    new THREE.ConeGeometry(0.24, 0.16, 16, 1, true),
    mat.whiteThermal
  );
  dish.position.set(0, -0.3, 0);
  group.add(dish);

  const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.1, 12, 12), mat.beaconPlanned);
  beacon.position.set(0, 0.34, 0);
  group.add(beacon);

  return group;
}

/**
 * Builds composite Venturi Astrolab FLIP Rover (for Griffin Mission 1)
 */
export function buildFlipRoverModel(mat: SharedLanderMaterials): THREE.Group {
  const group = new THREE.Group();
  group.name = 'flip-rover';

  const chassis = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.18, 0.56), mat.goldMli);
  chassis.position.y = 0.22;
  group.add(chassis);

  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.28, 8), mat.titanium);
  mast.position.set(0, 0.42, 0.16);
  group.add(mast);

  const wheelGeo = new THREE.CylinderGeometry(0.11, 0.11, 0.09, 14);
  wheelGeo.rotateZ(Math.PI / 2);
  const offsets: [number, number][] = [
    [-0.27, 0.22],
    [0.27, 0.22],
    [-0.27, -0.22],
    [0.27, -0.22],
  ];
  for (const [wx, wz] of offsets) {
    const w = new THREE.Mesh(wheelGeo, mat.carbonComposite);
    w.position.set(wx, 0.11, wz);
    group.add(w);
  }
  return group;
}
